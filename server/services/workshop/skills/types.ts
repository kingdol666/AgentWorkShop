/**
 * Agent Skills（SKILL.md 标准）服务端类型。
 *
 * 发现/导入/启用/读取都是平台管理面；这里只描述数据形状，不执行 Skill 内脚本，
 * 也不把 `allowed-tools` 当作权限声明。
 */

/** Skill 来源：内置 / 平台受管 / 兼容全局目录 / 显式配置目录 */
export type SkillSource = 'builtin' | 'managed' | 'global' | 'configured'

export type SkillDiagnosticLevel = 'warn' | 'error'

export interface SkillDiagnostic {
  level: SkillDiagnosticLevel
  code: string
  message: string
}

/** 一个可扫描的 Skill 根（managed 根可写，其余只读发现） */
export interface SkillRoot {
  id: string
  path: string
  source: SkillSource
  /** true = 平台受管存储（<configRoot>/skills），导入目标 */
  managed: boolean
}

export interface SkillScanLimits {
  /** 单次扫描最多收录的 Skill 数 */
  maxSkills: number
  /** 单个 Skill 目录最多文件数 */
  maxFilesPerSkill: number
  /** 单个文件最大字节数 */
  maxFileBytes: number
  /** 单个 Skill 目录总字节数 */
  maxTotalBytes: number
  /** 目录遍历最大深度（相对 Skill 根） */
  maxDepth: number
}

/** 解析后的 Skill（正文已剥离 frontmatter） */
export interface ParsedSkill {
  name: string
  description: string
  body: string
  metadata: Record<string, string>
  compatibility?: string
  license?: string
  /** 实验性声明：仅展示，不映射为工具授权 */
  allowedTools?: string
  /** 原始 SKILL.md 内容（UTF-8）的 sha256 */
  contentHash: string
  diagnostics: SkillDiagnostic[]
}

/** 发现目录中的一条 Skill 记录（含诊断，不改变源目录） */
export interface SkillRecord {
  id: string
  name: string
  description: string
  source: SkillSource
  /** 规范化后的 SKILL.md 绝对路径（只读展示/导入来源） */
  sourcePath: string
  contentHash: string
  compatibility?: string
  diagnostics: SkillDiagnostic[]
  fileCount: number
  totalBytes: number
}

/** 平台受管不可变 revision */
export interface ManagedSkillRevision {
  /** `${name}@${hash.slice(0,12)}` */
  id: string
  name: string
  /** 完整 content hash（用于固定引用/审计） */
  revision: string
  contentHash: string
  source: SkillSource
  sourcePath: string
  enabled: boolean
  importedAt: string
  importedBy: string
  fileCount: number
  totalBytes: number
  diagnostics: SkillDiagnostic[]
}

export interface SkillImportResult {
  revision: ManagedSkillRevision
  /** true = 该 hash 已存在，未重复复制 */
  existing: boolean
}
