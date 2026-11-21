/**
 * SKILL.md frontmatter 解析与校验（Agent Skills 规范）。
 *
 * 只解析元数据与正文：不执行 scripts/*，不读取 references/assets（按需由受管文件读取）。
 * 名称/描述遵循规范；目录名默认必须与 name 一致（strictDirectory=false 时仅告警，
 * 用于兼容其他客户端已安装的 Skill）。
 */
import { createHash } from 'node:crypto'
import YAML from 'js-yaml'
import type { ParsedSkill, SkillDiagnostic } from './types'

/** 规范名称：小写字母/数字/单连字符，1-64 字符 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SKILL_NAME_MAX = 64
export const SKILL_DESCRIPTION_MAX = 1024

export class SkillValidationError extends Error {
  readonly diagnostics: SkillDiagnostic[]

  constructor(message: string, diagnostics: SkillDiagnostic[]) {
    super(message)
    this.name = 'SkillValidationError'
    this.diagnostics = diagnostics
  }
}

interface FrontmatterSplit {
  yamlSource: string
  body: string
}

/** 拆分 `---` frontmatter 与正文；缺失/未闭合时返回 null */
function splitFrontmatter(normalized: string): FrontmatterSplit | null {
  if (!normalized.startsWith('---\n')) return null
  const rest = normalized.slice(4)
  const closing = rest.indexOf('\n---')
  if (closing < 0) return null
  const after = rest.slice(closing + 4)
  // 结束分隔符后只允许换行/文件结束；否则视为正文的一部分（规范常见写法是 `---\n`）
  if (after.length > 0 && !after.startsWith('\n')) return null
  return { yamlSource: rest.slice(0, closing), body: after.replace(/^\n+/, '') }
}

/**
 * 容错修复：description/compatibility 中未加引号的冒号是跨客户端最常见的非法 YAML。
 * 只在首次解析失败时逐行引用该值，不做任意代码/类型转换。
 */
function repairUnquotedColon(yamlSource: string): string {
  return yamlSource.split('\n').map((line) => {
    const matched = line.match(/^(\s*)(description|compatibility):\s*(.*)$/)
    if (!matched) return line
    const raw = matched[3]!.trim()
    if (!raw || /^["'|>]/.test(raw) || !raw.includes(':')) return line
    return `${matched[1]}${matched[2]}: ${JSON.stringify(raw)}`
  }).join('\n')
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * 解析 SKILL.md。
 * @param markdown 原始文件内容（UTF-8）
 * @param directoryName Skill 目录名（规范要求与 name 一致）
 * @param opts.strictDirectory 默认 true；false 时目录不一致只告警
 */
export function parseSkillMarkdown(
  markdown: string,
  directoryName: string,
  opts: { strictDirectory?: boolean } = {},
): ParsedSkill {
  const strictDirectory = opts.strictDirectory !== false
  const contentHash = createHash('sha256').update(markdown, 'utf8').digest('hex')
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const split = splitFrontmatter(normalized)
  const diagnostics: SkillDiagnostic[] = []

  if (!split) {
    throw new SkillValidationError('SKILL.md 缺少合法 frontmatter（应以 --- 开始并有结束分隔符）', [
      { level: 'error', code: 'FRONTMATTER_MISSING', message: '缺少 --- 包裹的 YAML frontmatter' },
    ])
  }

  let raw: unknown
  try {
    raw = YAML.load(split.yamlSource)
  }
  catch (firstErr) {
    try {
      raw = YAML.load(repairUnquotedColon(split.yamlSource))
      diagnostics.push({
        level: 'warn',
        code: 'YAML_REPAIRED',
        message: `frontmatter 含未引用冒号，已按字符串容错解析：${firstErr instanceof Error ? firstErr.message : String(firstErr)}`,
      })
    }
    catch (secondErr) {
      throw new SkillValidationError('SKILL.md frontmatter 不是合法 YAML', [
        { level: 'error', code: 'YAML_INVALID', message: secondErr instanceof Error ? secondErr.message : String(secondErr) },
      ])
    }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SkillValidationError('SKILL.md frontmatter 必须是 YAML 对象', [
      { level: 'error', code: 'YAML_NOT_OBJECT', message: 'frontmatter 顶层不是对象' },
    ])
  }
  const data = raw as Record<string, unknown>
  const name = asString(data.name)?.trim() ?? ''
  const description = asString(data.description)?.trim() ?? ''

  if (!name) {
    throw new SkillValidationError('SKILL.md 缺少 name', [
      { level: 'error', code: 'NAME_MISSING', message: 'name 必填' },
    ])
  }
  if (name.length > SKILL_NAME_MAX || !SKILL_NAME_RE.test(name)) {
    throw new SkillValidationError('SKILL.md name 不符合规范', [
      { level: 'error', code: 'NAME_INVALID', message: `name 必须为 1-${SKILL_NAME_MAX} 个小写字母/数字/单连字符：${name}` },
    ])
  }
  if (name !== directoryName) {
    const diag: SkillDiagnostic = {
      level: strictDirectory ? 'error' : 'warn',
      code: 'NAME_DIRECTORY_MISMATCH',
      message: `name「${name}」与目录名「${directoryName}」不一致`,
    }
    diagnostics.push(diag)
    if (strictDirectory) {
      throw new SkillValidationError('SKILL.md name 必须与目录名一致', diagnostics)
    }
  }
  if (!description) {
    throw new SkillValidationError('SKILL.md 缺少 description', [
      { level: 'error', code: 'DESCRIPTION_MISSING', message: 'description 必填且非空' },
    ])
  }
  if (description.length > SKILL_DESCRIPTION_MAX) {
    throw new SkillValidationError('SKILL.md description 过长', [
      { level: 'error', code: 'DESCRIPTION_TOO_LONG', message: `description 最多 ${SKILL_DESCRIPTION_MAX} 字符` },
    ])
  }

  const metadata: Record<string, string> = {}
  if (data.metadata !== undefined) {
    if (data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)) {
      for (const [key, value] of Object.entries(data.metadata as Record<string, unknown>)) {
        if (typeof value === 'string') metadata[key] = value
        else if (typeof value === 'number' || typeof value === 'boolean') metadata[key] = String(value)
        else diagnostics.push({ level: 'warn', code: 'METADATA_VALUE_IGNORED', message: `metadata.${key} 不是字符串，已忽略` })
      }
    }
    else {
      diagnostics.push({ level: 'warn', code: 'METADATA_INVALID', message: 'metadata 应为字符串键值映射，已忽略' })
    }
  }

  const compatibility = asString(data.compatibility)
  const license = asString(data.license)
  const allowedTools = asString(data['allowed-tools'])
  if (allowedTools) {
    diagnostics.push({
      level: 'warn',
      code: 'ALLOWED_TOOLS_INFORMATIONAL',
      message: 'allowed-tools 是实验性声明，仅展示；不会授予或扩大平台工具权限',
    })
  }

  return {
    name,
    description,
    body: split.body.trim(),
    metadata,
    compatibility,
    license,
    allowedTools,
    contentHash,
    diagnostics,
  }
}
