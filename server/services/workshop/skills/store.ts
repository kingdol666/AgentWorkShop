/**
 * 平台受管 Skill 存储（不可变 revision + 原子导入）。
 *
 * 目录：<configRoot>/skills/<name>/<contentHash>/
 *  - 只复制源 Skill 的普通文件；symlink/越界/超限一律拒绝；
 *  - 导入使用 staging + rename，失败不留下半成品；
 *  - 启用状态是独立 state（默认 false，导入不等于启用），不写入源目录；
 *  - 不执行任何 Skill 内容。
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseSkillMarkdown } from './frontmatter'
import type { ManagedSkillRevision, SkillDiagnostic, SkillImportResult, SkillRecord, SkillScanLimits } from './types'
import { DEFAULT_SKILL_LIMITS } from './discovery'
import { AppError } from '../../../utils/errors'

interface StoredManifest {
  name: string
  contentHash: string
  source: string
  sourcePath: string
  importedAt: string
  importedBy: string
  fileCount: number
  totalBytes: number
  diagnostics: SkillDiagnostic[]
}

interface SkillStateEntry {
  enabled: boolean
  updatedAt: string
  updatedBy: string
}

type SkillState = Record<string, SkillStateEntry>

const MANIFEST = 'manifest.json'
const STATE_FILE = 'skills-state.json'
const STAGING = '.staging'

export function managedSkillsRoot(configRoot: string): string {
  return join(configRoot, 'skills')
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function hashOf(name: string, hash: string): string {
  return `${name}@${hash.slice(0, 12)}`
}

function parseManagedId(id: string): { name: string, prefix: string } {
  const at = id.lastIndexOf('@')
  if (at <= 0 || at === id.length - 1) throw new AppError(400, 'VALIDATION_ERROR', `无效的 Skill revision id：${id}`)
  return { name: id.slice(0, at), prefix: id.slice(at + 1) }
}

function readState(configRoot: string): SkillState {
  const file = join(managedSkillsRoot(configRoot), STATE_FILE)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as SkillState : {}
  }
  catch {
    return {}
  }
}

function writeState(configRoot: string, state: SkillState): void {
  const root = managedSkillsRoot(configRoot)
  mkdirSync(root, { recursive: true })
  const target = join(root, STATE_FILE)
  const tmp = `${target}.${randomUUID()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, target)
}

function readManifest(revisionDir: string): StoredManifest | null {
  const file = join(revisionDir, MANIFEST)
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StoredManifest
    if (!parsed || typeof parsed !== 'object' || !parsed.name || !parsed.contentHash) return null
    return parsed
  }
  catch {
    return null
  }
}

/** 列出受管 revision（目录扫描 + manifest；损坏条目跳过） */
export function listManagedRevisions(configRoot: string): ManagedSkillRevision[] {
  const root = managedSkillsRoot(configRoot)
  if (!existsSync(root)) return []
  const state = readState(configRoot)
  const out: ManagedSkillRevision[] = []
  for (const nameEntry of readdirSync(root, { withFileTypes: true })) {
    if (!nameEntry.isDirectory() || nameEntry.name === STAGING) continue
    const nameDir = join(root, nameEntry.name)
    for (const hashEntry of readdirSync(nameDir, { withFileTypes: true })) {
      if (!hashEntry.isDirectory()) continue
      const dir = join(nameDir, hashEntry.name)
      const manifest = readManifest(dir)
      if (!manifest) continue
      const id = hashOf(manifest.name, manifest.contentHash)
      out.push({
        id,
        name: manifest.name,
        revision: manifest.contentHash,
        contentHash: manifest.contentHash,
        source: manifest.source as ManagedSkillRevision['source'],
        sourcePath: manifest.sourcePath,
        enabled: state[id]?.enabled ?? false,
        importedAt: manifest.importedAt,
        importedBy: manifest.importedBy,
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
        diagnostics: manifest.diagnostics ?? [],
      })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.importedAt.localeCompare(b.importedAt))
}

/** 按 `name@hashPrefix` 定位唯一 revision；前缀有歧义/不存在时 404 */
export function findManagedRevision(configRoot: string, id: string): ManagedSkillRevision {
  const { name, prefix } = parseManagedId(id)
  const matches = listManagedRevisions(configRoot).filter(r => r.name === name && r.contentHash.startsWith(prefix))
  if (matches.length === 0) throw new AppError(404, 'NOT_FOUND', `Skill revision 不存在：${id}`)
  if (matches.length > 1) throw new AppError(409, 'AMBIGUOUS_SKILL_ID', `Skill revision 前缀不唯一：${id}`)
  return matches[0]!
}

interface CopyStats {
  fileCount: number
  totalBytes: number
  diagnostics: SkillDiagnostic[]
}

/** 受控复制：仅普通文件，拒绝 symlink/越界/超限 */
function copySkillTree(sourceDir: string, targetDir: string, limits: SkillScanLimits): CopyStats {
  const realSource = realpathSync(sourceDir)
  const stats: CopyStats = { fileCount: 0, totalBytes: 0, diagnostics: [] }

  const walk = (src: string, dst: string, depth: number): void => {
    if (depth > limits.maxDepth) {
      throw new AppError(400, 'SKILL_LIMIT_EXCEEDED', `Skill 目录深度超过 ${limits.maxDepth}`)
    }
    mkdirSync(dst, { recursive: true })
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') {
        stats.diagnostics.push({ level: 'warn', code: 'ENTRY_SKIPPED', message: `跳过 ${entry.name}` })
        continue
      }
      const srcPath = join(src, entry.name)
      const dstPath = join(dst, entry.name)
      if (entry.isSymbolicLink()) {
        throw new AppError(400, 'SKILL_SYMLINK_REJECTED', `Skill 包含符号链接，拒绝导入：${relative(realSource, srcPath)}`)
      }
      if (entry.isDirectory()) {
        const real = realpathSync(srcPath)
        if (!isInside(realSource, real)) throw new AppError(400, 'SKILL_ROOT_ESCAPE', 'Skill 子目录逃逸出源根')
        walk(srcPath, dstPath, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const size = statSync(srcPath).size
      if (size > limits.maxFileBytes) throw new AppError(400, 'SKILL_FILE_TOO_LARGE', `文件超过 ${limits.maxFileBytes} 字节：${relative(realSource, srcPath)}`)
      stats.fileCount += 1
      stats.totalBytes += size
      if (stats.fileCount > limits.maxFilesPerSkill) throw new AppError(400, 'SKILL_FILE_COUNT_EXCEEDED', `文件数超过 ${limits.maxFilesPerSkill}`)
      if (stats.totalBytes > limits.maxTotalBytes) throw new AppError(400, 'SKILL_TOTAL_SIZE_EXCEEDED', `总大小超过 ${limits.maxTotalBytes} 字节`)
      copyFileSync(srcPath, dstPath)
    }
  }

  walk(realSource, targetDir, 0)
  return stats
}

/**
 * 从发现目录导入一个不可变 revision。
 * 只接受发现结果中的 sourcePath（不接受客户端任意路径），并重新按严格目录名解析。
 */
export function importManagedRevision(input: {
  configRoot: string
  record: SkillRecord
  actorId: string
  limits?: SkillScanLimits
}): SkillImportResult {
  const limits = input.limits ?? DEFAULT_SKILL_LIMITS
  if (input.record.source === 'managed') {
    throw new AppError(400, 'ALREADY_MANAGED', '该 Skill 已在平台受管目录中')
  }
  const sourceDir = dirname(resolve(input.record.sourcePath))
  if (!existsSync(input.record.sourcePath)) throw new AppError(404, 'NOT_FOUND', 'Skill 源文件已不存在，请重新发现')
  const markdown = readFileSync(input.record.sourcePath, 'utf8')
  const parsed = parseSkillMarkdown(markdown, input.record.name, { strictDirectory: true })
  const contentHash = createHash('sha256').update(markdown, 'utf8').digest('hex')
  if (contentHash !== input.record.contentHash) {
    throw new AppError(409, 'SKILL_SOURCE_CHANGED', 'Skill 源内容在发现后已变化，请重新发现并审阅')
  }

  const root = managedSkillsRoot(input.configRoot)
  const target = join(root, parsed.name, contentHash)
  const existing = readManifest(target)
  if (existing) {
    const id = hashOf(existing.name, existing.contentHash)
    const state = readState(input.configRoot)
    return {
      existing: true,
      revision: {
        id,
        name: existing.name,
        revision: existing.contentHash,
        contentHash: existing.contentHash,
        source: existing.source as ManagedSkillRevision['source'],
        sourcePath: existing.sourcePath,
        enabled: state[id]?.enabled ?? false,
        importedAt: existing.importedAt,
        importedBy: existing.importedBy,
        fileCount: existing.fileCount,
        totalBytes: existing.totalBytes,
        diagnostics: existing.diagnostics ?? [],
      },
    }
  }

  const staging = join(root, STAGING, randomUUID())
  try {
    const stats = copySkillTree(sourceDir, staging, limits)
    const manifest: StoredManifest = {
      name: parsed.name,
      contentHash,
      source: input.record.source,
      sourcePath: input.record.sourcePath,
      importedAt: new Date().toISOString(),
      importedBy: input.actorId,
      fileCount: stats.fileCount,
      totalBytes: stats.totalBytes,
      diagnostics: [...parsed.diagnostics, ...stats.diagnostics],
    }
    writeFileSync(join(staging, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    mkdirSync(join(root, parsed.name), { recursive: true })
    if (existsSync(target)) {
      rmSync(staging, { recursive: true, force: true })
    }
    else {
      renameSync(staging, target)
    }
  }
  catch (err) {
    rmSync(staging, { recursive: true, force: true })
    throw err
  }

  return {
    existing: false,
    revision: findManagedRevision(input.configRoot, hashOf(parsed.name, contentHash)),
  }
}

/** 启用/停用 revision（审计由 route 记录；这里只做状态与显式错误） */
export function setManagedRevisionEnabled(configRoot: string, id: string, enabled: boolean, actorId: string): ManagedSkillRevision {
  const revision = findManagedRevision(configRoot, id)
  const state = readState(configRoot)
  state[revision.id] = { enabled, updatedAt: new Date().toISOString(), updatedBy: actorId }
  writeState(configRoot, state)
  return { ...revision, enabled }
}

/** 删除 revision 目录与状态（历史引用将由调用方失效；不做物理恢复） */
export function removeManagedRevision(configRoot: string, id: string): void {
  const revision = findManagedRevision(configRoot, id)
  const dir = join(managedSkillsRoot(configRoot), revision.name, revision.contentHash)
  if (!existsSync(dir)) throw new AppError(404, 'NOT_FOUND', `Skill revision 目录不存在：${id}`)
  rmSync(dir, { recursive: true, force: true })
  const state = readState(configRoot)
  const nextState: SkillState = {}
  for (const [key, value] of Object.entries(state)) {
    if (key !== revision.id) nextState[key] = value
  }
  writeState(configRoot, nextState)
}

/** 读取受管 revision 内的相对资源文件（文本、限长、拒绝穿越/symlink） */
export function readManagedRevisionFile(configRoot: string, id: string, relativePath: string): string {
  const revision = findManagedRevision(configRoot, id)
  const root = join(managedSkillsRoot(configRoot), revision.name, revision.contentHash)
  const target = resolve(root, relativePath)
  if (!isInside(root, target) || target === root) throw new AppError(400, 'PATH_TRAVERSAL', '资源路径必须位于 Skill revision 内')
  const stat = (() => {
    try {
      return lstatSync(target)
    }
    catch {
      throw new AppError(404, 'NOT_FOUND', 'Skill 资源文件不存在')
    }
  })()
  if (stat.isSymbolicLink() || !stat.isFile()) throw new AppError(400, 'INVALID_SKILL_FILE', '只允许读取普通文件')
  if (stat.size > DEFAULT_SKILL_LIMITS.maxFileBytes) throw new AppError(400, 'SKILL_FILE_TOO_LARGE', '资源文件超过大小限制')
  const buffer = readFileSync(target)
  if (buffer.includes(0)) throw new AppError(400, 'BINARY_FILE', '资源不是文本文件')
  return buffer.toString('utf8')
}
