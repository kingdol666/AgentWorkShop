/**
 * Skill 发现（只读、受限、不执行）。
 *
 * 根目录：
 *  - builtin：随包发布的只读 assets（packageRoot/skills）
 *  - managed：<configRoot>/skills（平台导入目标）
 *  - global：~/.agent/skills（用户要求兼容）、~/.agents/skills、$XDG_CONFIG_HOME/agents/skills
 *  - configured：AW_SKILL_ROOTS 显式追加（path.delimiter 分隔）
 *
 * 只扫描根目录的直接子目录中的 SKILL.md；拒绝 symlink 逃逸/目录 symlink；
 * 不读取或执行 scripts/references/assets，只做有上限的文件计数。
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseSkillMarkdown, SkillValidationError } from './frontmatter'
import type { SkillDiagnostic, SkillRecord, SkillRoot, SkillScanLimits } from './types'

export const DEFAULT_SKILL_LIMITS: SkillScanLimits = {
  maxSkills: 200,
  maxFilesPerSkill: 500,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 20 * 1024 * 1024,
  maxDepth: 4,
}

const SKILL_FILE = 'SKILL.md'

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** 路径必须在 root 内（按 path.relative 判定，跨平台） */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function diagnostic(level: SkillDiagnostic['level'], code: string, message: string): SkillDiagnostic {
  return { level, code, message }
}

export interface DefaultRootOptions {
  configRoot: string
  homeDir?: string
  packageRoot?: string
  env?: NodeJS.ProcessEnv
}

/** 解析默认根（只使用服务进程身份/配置，不使用网页访问者的 home） */
export function buildDefaultSkillRoots(opts: DefaultRootOptions): SkillRoot[] {
  const home = opts.homeDir ?? homedir()
  const env = opts.env ?? process.env
  const packageRoot = opts.packageRoot ?? env.AW_PACKAGE_ROOT ?? process.cwd()
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, '.config')
  const roots: SkillRoot[] = [
    { id: 'builtin', path: join(packageRoot, 'skills'), source: 'builtin', managed: false },
    { id: 'managed', path: join(opts.configRoot, 'skills'), source: 'managed', managed: true },
    { id: 'global-agent-compat', path: join(home, '.agent', 'skills'), source: 'global', managed: false },
    { id: 'global-agents', path: join(home, '.agents', 'skills'), source: 'global', managed: false },
    { id: 'global-xdg', path: join(xdg, 'agents', 'skills'), source: 'global', managed: false },
  ]
  const configured = (env.AW_SKILL_ROOTS ?? '').split(delimiter).map(x => x.trim()).filter(Boolean)
  configured.forEach((path, index) => {
    roots.push({ id: `configured-${index + 1}`, path, source: 'configured', managed: false })
  })
  // 同一真实路径只保留第一个来源（builtin > managed > global > configured 的顺序由上面的数组决定）
  const seen = new Set<string>()
  return roots.filter((root) => {
    const key = resolve(root.path).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

interface TreeStats {
  fileCount: number
  totalBytes: number
  withinLimits: boolean
  diagnostics: SkillDiagnostic[]
}

/** 有上限的目录遍历：只统计，不读取文件内容；symlink 一律跳过 */
function inspectTree(root: string, limits: SkillScanLimits): TreeStats {
  const diagnostics: SkillDiagnostic[] = []
  let fileCount = 0
  let totalBytes = 0
  let withinLimits = true

  const walk = (dir: string, depth: number): void => {
    if (!withinLimits) return
    if (depth > limits.maxDepth) {
      diagnostics.push(diagnostic('warn', 'DEPTH_LIMIT', `目录深度超过 ${limits.maxDepth}，剩余内容未扫描`))
      withinLimits = false
      return
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    }
    catch (err) {
      diagnostics.push(diagnostic('warn', 'DIR_UNREADABLE', `${dir}: ${err instanceof Error ? err.message : String(err)}`))
      return
    }
    for (const entry of entries) {
      if (!withinLimits) return
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        diagnostics.push(diagnostic('warn', 'SYMLINK_SKIPPED', `跳过符号链接：${relative(root, full)}`))
        continue
      }
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const size = statSync(full).size
      if (size > limits.maxFileBytes) {
        diagnostics.push(diagnostic('error', 'FILE_TOO_LARGE', `${relative(root, full)} 超过 ${limits.maxFileBytes} 字节`))
        withinLimits = false
        return
      }
      fileCount += 1
      totalBytes += size
      if (fileCount > limits.maxFilesPerSkill) {
        diagnostics.push(diagnostic('error', 'FILE_COUNT_LIMIT', `文件数超过 ${limits.maxFilesPerSkill}`))
        withinLimits = false
        return
      }
      if (totalBytes > limits.maxTotalBytes) {
        diagnostics.push(diagnostic('error', 'TOTAL_SIZE_LIMIT', `总大小超过 ${limits.maxTotalBytes} 字节`))
        withinLimits = false
        return
      }
    }
  }

  walk(root, 0)
  return { fileCount, totalBytes, withinLimits, diagnostics }
}

function invalidRecord(input: {
  root: SkillRoot
  dirPath: string
  name: string
  contentHash: string
  diagnostics: SkillDiagnostic[]
  tree: TreeStats
}): SkillRecord {
  return {
    id: sha256(`${input.root.source}:${input.dirPath}`).slice(0, 16),
    name: input.name,
    description: '',
    source: input.root.source,
    sourcePath: join(input.dirPath, SKILL_FILE),
    contentHash: input.contentHash,
    diagnostics: [...input.diagnostics, ...input.tree.diagnostics],
    fileCount: input.tree.fileCount,
    totalBytes: input.tree.totalBytes,
  }
}

/** 发现全部 Skill；写入/执行零副作用 */
export async function discoverSkills(
  roots: SkillRoot[],
  limits: SkillScanLimits = DEFAULT_SKILL_LIMITS,
): Promise<SkillRecord[]> {
  const records: SkillRecord[] = []
  const seenRealPaths = new Set<string>()

  for (const root of roots) {
    if (records.length >= limits.maxSkills) break
    if (!existsSync(root.path)) continue
    let realRoot: string
    try {
      realRoot = realpathSync(root.path)
      if (!statSync(realRoot).isDirectory()) continue
    }
    catch {
      continue
    }

    let entries
    try {
      entries = readdirSync(realRoot, { withFileTypes: true })
    }
    catch {
      continue
    }

    for (const entry of entries) {
      if (records.length >= limits.maxSkills) break
      const dirPath = join(realRoot, entry.name)
      if (entry.isSymbolicLink()) {
        const tree = { fileCount: 0, totalBytes: 0, withinLimits: false, diagnostics: [] as SkillDiagnostic[] }
        records.push(invalidRecord({
          root,
          dirPath,
          name: entry.name,
          contentHash: '',
          diagnostics: [diagnostic('error', 'SYMLINK_SKILL_DIR', 'Skill 目录不能是符号链接')],
          tree,
        }))
        continue
      }
      if (!entry.isDirectory()) continue

      // 目录真实路径必须在根内（防御 junction/挂载点）
      let realDir: string
      try {
        realDir = realpathSync(dirPath)
      }
      catch {
        continue
      }
      if (!isInside(realRoot, realDir)) {
        const tree = { fileCount: 0, totalBytes: 0, withinLimits: false, diagnostics: [] as SkillDiagnostic[] }
        records.push(invalidRecord({
          root,
          dirPath,
          name: entry.name,
          contentHash: '',
          diagnostics: [diagnostic('error', 'ROOT_ESCAPE', 'Skill 目录真实路径逃逸出配置根')],
          tree,
        }))
        continue
      }
      if (seenRealPaths.has(realDir)) continue
      seenRealPaths.add(realDir)

      const skillFile = join(realDir, SKILL_FILE)
      if (!existsSync(skillFile)) continue
      const fileStat = lstatSync(skillFile)
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        const tree = inspectTree(realDir, limits)
        records.push(invalidRecord({
          root,
          dirPath: realDir,
          name: entry.name,
          contentHash: '',
          diagnostics: [diagnostic('error', 'SKILL_FILE_SYMLINK', 'SKILL.md 必须是普通文件，不能是符号链接')],
          tree,
        }))
        continue
      }
      if (fileStat.size > limits.maxFileBytes) {
        const tree = inspectTree(realDir, limits)
        records.push(invalidRecord({
          root,
          dirPath: realDir,
          name: entry.name,
          contentHash: '',
          diagnostics: [diagnostic('error', 'SKILL_FILE_TOO_LARGE', `SKILL.md 超过 ${limits.maxFileBytes} 字节`)],
          tree,
        }))
        continue
      }

      const markdown = readFileSync(skillFile, 'utf8')
      const tree = inspectTree(realDir, limits)
      try {
        const parsed = parseSkillMarkdown(markdown, entry.name, { strictDirectory: false })
        if (!tree.withinLimits) {
          records.push(invalidRecord({
            root,
            dirPath: realDir,
            name: parsed.name,
            contentHash: parsed.contentHash,
            diagnostics: [...parsed.diagnostics, ...tree.diagnostics],
            tree,
          }))
          continue
        }
        records.push({
          id: sha256(`${root.source}:${realDir}`).slice(0, 16),
          name: parsed.name,
          description: parsed.description,
          source: root.source,
          sourcePath: skillFile,
          contentHash: parsed.contentHash,
          compatibility: parsed.compatibility,
          // 目录名不一致在发现阶段只告警（兼容他人已安装 Skill）；导入时严格校验
          diagnostics: [...parsed.diagnostics, ...tree.diagnostics],
          fileCount: tree.fileCount,
          totalBytes: tree.totalBytes,
        })
      }
      catch (err) {
        const diagnostics = err instanceof SkillValidationError
          ? err.diagnostics
          : [diagnostic('error', 'PARSE_FAILED', err instanceof Error ? err.message : String(err))]
        records.push(invalidRecord({
          root,
          dirPath: realDir,
          name: entry.name,
          contentHash: sha256(markdown),
          diagnostics: [...diagnostics, ...tree.diagnostics],
          tree,
        }))
      }
    }
  }

  // 同名冲突：保留全部记录，逐条告警（不静默覆盖）
  const byName = new Map<string, SkillRecord[]>()
  for (const record of records) {
    const list = byName.get(record.name) ?? []
    list.push(record)
    byName.set(record.name, list)
  }
  for (const [name, list] of byName) {
    if (list.length < 2) continue
    const sources = list.map(x => `${x.source}:${x.sourcePath}`).join(' | ')
    for (const record of list) {
      record.diagnostics.push(diagnostic('warn', 'NAME_CONFLICT', `同名 Skill「${name}」存在多处：${sources}`))
    }
  }

  // 稳定排序（来源优先级 + 名称 + 路径），便于 UI/审计比对
  const sourceRank: Record<string, number> = { builtin: 0, managed: 1, global: 2, configured: 3 }
  return records.sort((a, b) => (sourceRank[a.source] ?? 9) - (sourceRank[b.source] ?? 9)
    || a.name.localeCompare(b.name)
    || a.sourcePath.localeCompare(b.sourcePath))
}
