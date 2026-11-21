/**
 * 外部 MCP 受管目录与调用 broker。
 *
 * 关键约束：
 *  - discovery 只产生 pending 工具；admin 审阅 + shared-safe + read 才能批准；
 *  - endpoint/credential/protocol/tool schema 变化 → 相关工具回到 pending；
 *  - 每次 call 重新检查 enabled/review/shared-safe/schema freshness 与调用时授权；
 *  - 拒绝路径绝不建立连接；调用超时/未知效果不自动重试；审计不含 secret/无界响应。
 */
import { randomUUID } from 'node:crypto'
import type {
  McpCallContext,
  McpCallResult,
  McpConnection,
  McpServerManifest,
  McpToolRecord,
} from './types'
import {
  ensureUniqueExposedNames,
  hashSchema,
  listManifests,
  newManifest,
  readManifest,
  redactManifest,
  removeManifest,
  validateCredentialRef,
  validateMcpEndpoint,
  writeManifest,
} from './config'
import { connectMcpServer } from './client'
import { AppError } from '../../../utils/errors'

export interface McpBrokerOptions {
  configRoot: string
  /** 测试注入；生产默认 connectMcpServer */
  connect?: (manifest: McpServerManifest) => Promise<McpConnection>
  now?: () => number
  callTimeoutMs?: number
  maxResultChars?: number
}

export interface McpServerPatch {
  label?: string
  endpoint?: string
  credentialRef?: string | null
  enabled?: boolean
  dataSharing?: unknown
  maxDiscoveryAgeMs?: number
}

export interface McpReviewInput {
  status: 'approved' | 'rejected'
  classification?: 'read' | 'write'
}

export function createMcpBroker(opts: McpBrokerOptions) {
  const now = opts.now ?? Date.now
  const callTimeoutMs = opts.callTimeoutMs ?? 30_000
  const maxResultChars = opts.maxResultChars ?? 64 * 1024
  const connect = opts.connect ?? (manifest => connectMcpServer(manifest))
  const refreshing = new Map<string, Promise<McpServerManifest>>()

  function getOrThrow(id: string): McpServerManifest {
    const manifest = readManifest(opts.configRoot, id)
    if (!manifest) throw new AppError(404, 'NOT_FOUND', `MCP server 不存在：${id}`)
    return manifest
  }

  function persist(manifest: McpServerManifest): McpServerManifest {
    manifest.updatedAt = new Date(now()).toISOString()
    writeManifest(opts.configRoot, manifest)
    return manifest
  }

  function findTool(manifest: McpServerManifest, ref: string): McpToolRecord | undefined {
    return manifest.tools.find(t => t.id === ref || t.exposedName === ref || t.upstreamName === ref)
  }

  function isFresh(manifest: McpServerManifest): boolean {
    if (!manifest.lastDiscoveredAt) return false
    const at = Date.parse(manifest.lastDiscoveredAt)
    if (!Number.isFinite(at)) return false
    return now() - at <= manifest.maxDiscoveryAgeMs
  }

  async function doDiscover(id: string): Promise<McpServerManifest> {
    const manifest = getOrThrow(id)
    let connection: McpConnection | null = null
    try {
      connection = await connect(manifest)
      const snapshot = await connection.discover()
      const oldByName = new Map(manifest.tools.map(t => [t.upstreamName, t]))
      const candidates = snapshot.tools.map((tool) => {
        const old = oldByName.get(tool.upstreamName)
        const schemaHash = tool.schemaHash || hashSchema(tool.inputSchema)
        const changed = !old || old.schemaHash !== schemaHash
        return {
          serverId: manifest.id,
          upstreamName: tool.upstreamName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          schemaHash,
          // 默认 write：admin 必须显式审阅为 read 才能批准（不靠名称/注解猜测）
          classification: old?.classification ?? 'write' as const,
          reviewStatus: changed ? 'pending' as const : old!.reviewStatus,
          reviewedAt: changed ? undefined : old?.reviewedAt,
          reviewedBy: changed ? undefined : old?.reviewedBy,
        }
      })
      manifest.tools = ensureUniqueExposedNames(manifest.id, candidates)
      manifest.lastDiscoveredAt = new Date(now()).toISOString()
      manifest.lastProtocolEra = snapshot.protocolEra
      manifest.lastError = ''
      return persist(manifest)
    }
    catch (err) {
      manifest.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 400)
      persist(manifest)
      throw new AppError(502, 'MCP_DISCOVERY_FAILED', `MCP 服务发现失败：${manifest.lastError}`)
    }
    finally {
      await connection?.close().catch(() => {})
    }
  }

  function discover(id: string): Promise<McpServerManifest> {
    const running = refreshing.get(id)
    if (running) return running
    const task = doDiscover(id).finally(() => refreshing.delete(id))
    refreshing.set(id, task)
    return task
  }

  function auditDenied(ctx: McpCallContext, serverId: string, toolId: string, requestId: string, detail: string): McpCallResult {
    ctx.audit?.({ action: 'mcp.tool.call', agentId: ctx.agentId, serverId, toolId, outcome: 'denied', durationMs: 0, requestId, detail })
    return { text: `FORBIDDEN: ${detail}`, isError: true, requestId }
  }

  return {
    list(): Array<McpServerManifest & { hasCredential: boolean }> {
      return listManifests(opts.configRoot).map(redactManifest)
    },

    get(id: string) {
      return redactManifest(getOrThrow(id))
    },

    create(input: {
      id: string
      label: string
      endpoint: string
      credentialRef?: string
      dataSharing: unknown
      maxDiscoveryAgeMs?: number
    }) {
      if (readManifest(opts.configRoot, input.id)) throw new AppError(409, 'CONFLICT', `MCP server 已存在：${input.id}`)
      const manifest = newManifest(input, new Date(now()).toISOString())
      persist(manifest)
      return redactManifest(manifest)
    },

    patch(id: string, patch: McpServerPatch) {
      const manifest = getOrThrow(id)
      const beforeEndpoint = manifest.endpoint
      const beforeCredential = manifest.credentialRef
      const beforeSharing = manifest.dataSharing
      if (patch.label !== undefined) {
        const label = patch.label.trim()
        if (!label || label.length > 80) throw new AppError(400, 'VALIDATION_ERROR', 'label 必须为 1-80 字符')
        manifest.label = label
      }
      if (patch.endpoint !== undefined) manifest.endpoint = validateMcpEndpoint(patch.endpoint)
      if (patch.credentialRef !== undefined) manifest.credentialRef = validateCredentialRef(patch.credentialRef)
      if (patch.enabled !== undefined) manifest.enabled = Boolean(patch.enabled)
      if (patch.dataSharing !== undefined) {
        if (patch.dataSharing !== 'shared-safe' && patch.dataSharing !== 'project-private' && patch.dataSharing !== 'unknown') {
          throw new AppError(400, 'VALIDATION_ERROR', 'dataSharing 必须是 shared-safe/project-private/unknown')
        }
        manifest.dataSharing = patch.dataSharing
      }
      if (patch.maxDiscoveryAgeMs !== undefined) {
        const age = Number(patch.maxDiscoveryAgeMs)
        if (!Number.isFinite(age) || age < 60_000 || age > 24 * 60 * 60_000) {
          throw new AppError(400, 'VALIDATION_ERROR', 'maxDiscoveryAgeMs 必须在 1 分钟到 24 小时之间')
        }
        manifest.maxDiscoveryAgeMs = Math.floor(age)
      }
      const identityChanged = manifest.endpoint !== beforeEndpoint
        || manifest.credentialRef !== beforeCredential
        || manifest.dataSharing !== beforeSharing
      if (identityChanged) {
        manifest.credentialGeneration += 1
        manifest.lastDiscoveredAt = undefined
        manifest.tools = manifest.tools.map(tool => ({
          ...tool,
          reviewStatus: 'pending',
          reviewedAt: undefined,
          reviewedBy: undefined,
        }))
      }
      persist(manifest)
      return redactManifest(manifest)
    },

    remove(id: string) {
      getOrThrow(id)
      removeManifest(opts.configRoot, id)
    },

    discover,

    review(id: string, toolRef: string, input: McpReviewInput, actorId: string) {
      const manifest = getOrThrow(id)
      const tool = findTool(manifest, toolRef)
      if (!tool) throw new AppError(404, 'NOT_FOUND', `MCP tool 不存在：${toolRef}`)
      if (input.status === 'approved') {
        if (manifest.dataSharing !== 'shared-safe') {
          throw new AppError(409, 'MCP_DATA_DOMAIN_NOT_SHARED', '只有 shared-safe 数据域的工具可批准给 Agent 使用')
        }
        const classification = input.classification ?? tool.classification
        if (classification !== 'read') {
          throw new AppError(409, 'MCP_WRITE_TOOL_NOT_ALLOWED', '首版只允许批准只读工具（需显式 classification=read）')
        }
        tool.classification = 'read'
        tool.reviewStatus = 'approved'
      }
      else {
        tool.reviewStatus = 'rejected'
        if (input.classification) tool.classification = input.classification
      }
      tool.reviewedAt = new Date(now()).toISOString()
      tool.reviewedBy = actorId
      persist(manifest)
      return { server: redactManifest(manifest), tool: { ...tool } }
    },

    async call(agentId: string, toolId: string, args: Record<string, unknown>, ctx: Omit<McpCallContext, 'agentId'>): Promise<McpCallResult> {
      const requestId = randomUUID()
      const context: McpCallContext = { ...ctx, agentId }
      const started = now()
      const manifests = listManifests(opts.configRoot)
      let manifest: McpServerManifest | undefined
      let tool: McpToolRecord | undefined
      for (const candidate of manifests) {
        const found = findTool(candidate, toolId)
        if (found) {
          manifest = candidate
          tool = found
          break
        }
      }
      if (!manifest || !tool) return auditDenied(context, '', toolId, requestId, 'MCP 工具不存在或未发布')
      if (!manifest.enabled) return auditDenied(context, manifest.id, tool.id, requestId, 'MCP server 已停用')
      if (tool.reviewStatus !== 'approved') return auditDenied(context, manifest.id, tool.id, requestId, 'MCP 工具未通过审阅')
      if (tool.classification !== 'read') return auditDenied(context, manifest.id, tool.id, requestId, '首版只允许已审阅只读工具')
      if (manifest.dataSharing !== 'shared-safe') return auditDenied(context, manifest.id, tool.id, requestId, 'MCP 数据域不是 shared-safe')

      if (!isFresh(manifest)) {
        try {
          manifest = await discover(manifest.id)
        }
        catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          context.audit?.({ action: 'mcp.tool.call', agentId, serverId: manifest.id, toolId: tool.id, outcome: 'error', durationMs: now() - started, requestId, detail: detail.slice(0, 200) })
          return { text: `MCP_ERROR: ${detail}`, isError: true, requestId }
        }
        const refreshed = findTool(manifest, tool.id)
        if (!refreshed) return auditDenied(context, manifest.id, tool.id, requestId, 'MCP 工具在刷新后不存在')
        tool = refreshed
        if (tool.reviewStatus !== 'approved' || tool.classification !== 'read') {
          return auditDenied(context, manifest.id, tool.id, requestId, 'MCP 工具 schema/身份变化后需重新审阅')
        }
      }

      const allowed = await context.authorize({ serverId: manifest.id, tool })
      if (!allowed) return auditDenied(context, manifest.id, tool.id, requestId, '当前 Agent/Channel/Project 无权调用该 MCP 工具')

      let connection: McpConnection | null = null
      try {
        connection = await connect(manifest)
        const timeout = new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new AppError(504, 'MCP_CALL_TIMEOUT', 'MCP 调用超时（未自动重试）')), callTimeoutMs)
          timer.unref?.()
        })
        const raw = await Promise.race([connection.callTool(tool.upstreamName, args), timeout])
        const normalized = normalizeCallResult(raw, maxResultChars)
        context.audit?.({ action: 'mcp.tool.call', agentId, serverId: manifest.id, toolId: tool.id, outcome: normalized.isError ? 'error' : 'ok', durationMs: now() - started, requestId })
        return { ...normalized, requestId }
      }
      catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 300)
        context.audit?.({ action: 'mcp.tool.call', agentId, serverId: manifest.id, toolId: tool.id, outcome: 'error', durationMs: now() - started, requestId, detail: message })
        return { text: `MCP_ERROR: ${message}`, isError: true, requestId }
      }
      finally {
        await connection?.close().catch(() => {})
      }
    },
  }
}

/** MCP result → bounded platform text；兼容 structuredContent */
export function normalizeCallResult(raw: unknown, maxChars: number): { text: string, isError?: boolean } {
  if (raw && typeof raw === 'object') {
    const obj = raw as { content?: unknown, structuredContent?: unknown, isError?: unknown }
    if (Array.isArray(obj.content)) {
      const text = obj.content
        .map((part) => {
          if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
            return String((part as { text?: unknown }).text ?? '')
          }
          return ''
        })
        .filter(Boolean)
        .join('\n')
      if (text) return { text: text.slice(0, maxChars), ...(obj.isError === true ? { isError: true } : {}) }
    }
    if (obj.structuredContent !== undefined) {
      return { text: JSON.stringify(obj.structuredContent).slice(0, maxChars), ...(obj.isError === true ? { isError: true } : {}) }
    }
  }
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  return { text: String(text ?? '').slice(0, maxChars) }
}
