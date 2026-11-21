/**
 * 外部 MCP server manifest 的校验与原子存取（<configRoot>/mcp/servers）。
 * manifest 不含 secret；credentialRef 仅允许 AW_MCP_* 环境变量名。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpDataSharing, McpServerManifest, McpToolRecord } from './types'
import { AppError } from '../../../utils/errors'

const SERVER_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/
const CREDENTIAL_REF_RE = /^AW_MCP_[A-Z0-9_]{1,60}$/
const MAX_TOOLS = 200

export function mcpServersDir(configRoot: string): string {
  return join(configRoot, 'mcp', 'servers')
}

/** 排序键的 canonical JSON（去 undefined；对象键排序） */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().filter(k => obj[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
}

export function hashSchema(schema: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(schema), 'utf8').digest('hex')
}

export function assertServerId(id: string): string {
  const value = id.trim()
  if (!SERVER_ID_RE.test(value)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'server id 必须为 2-32 位小写字母/数字/连字符，且以字母或数字开头')
  }
  return value
}

export function validateCredentialRef(ref: string | undefined | null): string | undefined {
  if (ref === undefined || ref === null || ref.trim() === '') return undefined
  const value = ref.trim()
  if (!CREDENTIAL_REF_RE.test(value)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'credentialRef 必须是 AW_MCP_* 环境变量名（不保存凭据值）')
  }
  return value
}

/** 仅 https、无 URL 凭据/查询/片段（避免把 secret 写进 URL 或审计） */
export function validateMcpEndpoint(raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  }
  catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'MCP endpoint 不是合法 URL')
  }
  if (url.protocol !== 'https:') throw new AppError(400, 'MCP_HTTPS_REQUIRED', 'MCP endpoint 仅支持 https')
  if (url.username || url.password) throw new AppError(400, 'VALIDATION_ERROR', 'MCP endpoint 不能内嵌凭据')
  if (url.search) throw new AppError(400, 'VALIDATION_ERROR', 'MCP endpoint 不允许查询参数（避免 secret 进入 URL/日志）')
  if (url.hash) throw new AppError(400, 'VALIDATION_ERROR', 'MCP endpoint 不允许片段')
  return url.toString()
}

export function assertDataSharing(value: unknown): McpDataSharing {
  if (value === 'shared-safe' || value === 'project-private' || value === 'unknown') return value
  throw new AppError(400, 'VALIDATION_ERROR', 'dataSharing 必须是 shared-safe/project-private/unknown')
}

/** 读取全部 manifest；损坏/非法文件跳过（不阻断其他服务） */
export function listManifests(configRoot: string): McpServerManifest[] {
  const dir = mcpServersDir(configRoot)
  if (!existsSync(dir)) return []
  const out: McpServerManifest[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry.name), 'utf8')) as McpServerManifest
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') out.push(parsed)
    }
    catch { /* 损坏条目跳过 */ }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export function readManifest(configRoot: string, id: string): McpServerManifest | undefined {
  const file = join(mcpServersDir(configRoot), `${assertServerId(id)}.json`)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as McpServerManifest
  }
  catch {
    throw new AppError(500, 'MCP_MANIFEST_CORRUPT', `MCP server manifest 损坏：${id}`)
  }
}

export function writeManifest(configRoot: string, manifest: McpServerManifest): void {
  const dir = mcpServersDir(configRoot)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, `${assertServerId(manifest.id)}.json`)
  const tmp = `${target}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  renameSync(tmp, target)
}

export function removeManifest(configRoot: string, id: string): void {
  const target = join(mcpServersDir(configRoot), `${assertServerId(id)}.json`)
  if (!existsSync(target)) throw new AppError(404, 'NOT_FOUND', `MCP server 不存在：${id}`)
  rmSync(target, { force: true })
}

export function newManifest(input: {
  id: string
  label: string
  endpoint: string
  credentialRef?: string
  dataSharing: unknown
  maxDiscoveryAgeMs?: number
}, now = new Date().toISOString()): McpServerManifest {
  const id = assertServerId(input.id)
  const label = input.label.trim()
  if (!label || label.length > 80) throw new AppError(400, 'VALIDATION_ERROR', 'label 必须为 1-80 字符')
  const credentialRef = validateCredentialRef(input.credentialRef)
  const age = Number(input.maxDiscoveryAgeMs ?? 15 * 60_000)
  if (!Number.isFinite(age) || age < 60_000 || age > 24 * 60 * 60_000) {
    throw new AppError(400, 'VALIDATION_ERROR', 'maxDiscoveryAgeMs 必须在 1 分钟到 24 小时之间')
  }
  return {
    id,
    label,
    transport: 'streamable-http',
    endpoint: validateMcpEndpoint(input.endpoint),
    credentialRef,
    credentialGeneration: 1,
    enabled: false,
    protocolPolicy: 'auto',
    maxDiscoveryAgeMs: Math.floor(age),
    dataSharing: assertDataSharing(input.dataSharing),
    tools: [],
    createdAt: now,
    updatedAt: now,
  }
}

/** 对外投影：凭据只有引用名和是否存在，永不返回值 */
export function redactManifest(manifest: McpServerManifest): McpServerManifest & { hasCredential: boolean } {
  return {
    ...manifest,
    credentialRef: manifest.credentialRef,
    tools: manifest.tools.map(tool => ({ ...tool })),
    hasCredential: Boolean(manifest.credentialRef),
  }
}

/** 同一 server 内 exposedName 去重；冲突时追加 schema 短 hash */
export function ensureUniqueExposedNames(serverId: string, tools: Omit<McpToolRecord, 'id' | 'exposedName'>[]): McpToolRecord[] {
  const serverPart = serverId.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'srv'
  const used = new Set<string>()
  const out: McpToolRecord[] = []
  for (const tool of tools.slice(0, MAX_TOOLS)) {
    const toolPart = tool.upstreamName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28) || 'tool'
    let exposed = `mcp_${serverPart}_${toolPart}`.slice(0, 64)
    if (used.has(exposed)) exposed = `mcp_${serverPart}_${toolPart}_${tool.schemaHash.slice(0, 6)}`.slice(0, 64)
    let suffix = 1
    const base = exposed
    while (used.has(exposed)) {
      exposed = `${base.slice(0, 58)}_${suffix++}`
    }
    used.add(exposed)
    out.push({ ...tool, exposedName: exposed, id: exposed })
  }
  return out
}
