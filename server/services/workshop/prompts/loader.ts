/**
 * Prompt 外置化管理 — `.AgentWorkShop/prompts/` 下的 md 文件为唯一 prompt 事实源。
 *
 * 设计:
 *  - 后端代码零硬编码 prompt:所有注入 harness 的指令文本均从外置文件加载
 *  - 模板变量:{{var}} 占位(容忍 {{ var }} 空白变体);缺省变量渲染为空串
 *  - 缓存:mtime 感知(文件修改即刻生效,dev/HMR 友好;stat 开销可忽略)
 *  - host-tools.json:结构化工具定义(name/label/description/parameters),
 *    JSON 承载 schema,与叙事型 md 并置同一目录统一管理
 *  - 目录解析(hardening 后的规约,与配置根优先级同族):
 *      ① AW_PROMPTS_DIR 环境变量(显式覆盖,兼容旧约定)
 *      ② 项目内 <cwd 向上>/.AgentWorkShop/prompts 真实存在 → 项目内优先
 *      ③ 否则 ~/.AgentWorkShop/prompts —— 首次解析时从包内资产播种初始文件
 *        (只补缺失文件,绝不覆盖已有内容 → 用户在 Home 的定制即权威版本);
 *        播种源 = AW_PACKAGE_ROOT(启动器注入的包根)/.AgentWorkShop/prompts
 *    启动即校验(缺文件 fail-fast,防静默降级为无 prompt 裸跑)
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { awHome, findLocalConfigRoot } from '../../../../shared/config/home.mjs'
import { AppError } from '../../../utils/errors'

/** 模板变量值(字符串化注入) */
export type PromptVars = Record<string, string | number | boolean | undefined | null>

interface CacheEntry {
  mtimeMs: number
  content: string
}

const cache = new Map<string, CacheEntry>()

/** 包内资产 prompts 目录(播种源;不存在返回 null) */
function packagedPromptsDir(): string | null {
  const packageRoot = process.env.AW_PACKAGE_ROOT
    ? resolve(process.env.AW_PACKAGE_ROOT)
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const candidate = join(packageRoot, '.AgentWorkShop', 'prompts')
  return existsSync(candidate) ? candidate : null
}

/** 首次解析时把包内初始 prompts 播种到 ~/.AgentWorkShop/prompts(只补缺,不覆盖) */
function seedHomePrompts(homePrompts: string): void {
  const src = packagedPromptsDir()
  if (!src || resolve(src) === resolve(homePrompts)) return
  mkdirSync(homePrompts, { recursive: true })
  let seeded = 0
  for (const f of readdirSync(src)) {
    const dst = join(homePrompts, f)
    if (existsSync(dst)) continue
    try {
      copyFileSync(join(src, f), dst)
      seeded++
    }
    catch { /* 单文件失败不阻断播种 */ }
  }
  if (seeded > 0) console.log(`[prompts] 已向 ${homePrompts} 播种 ${seeded} 个初始提示词文件`)
}

/**
 * prompts 目录解析:显式覆盖 > 项目内(存在即用) > ~/.AgentWorkShop/prompts(自动播种)。
 * 失败 fail-fast —— 外置 prompt 为必需,防静默降级为无 prompt 裸跑。
 */
export function promptsDir(): string {
  // ① 显式覆盖(兼容既有部署约定)
  if (process.env.AW_PROMPTS_DIR) {
    const base = resolve(process.env.AW_PROMPTS_DIR)
    if (!existsSync(base)) {
      throw new AppError(500, 'PROMPTS_DIR_MISSING', `prompts 目录不存在: ${base}(AW_PROMPTS_DIR 指定)`)
    }
    return base
  }

  // ~/.AgentWorkShop/prompts:默认兜底目录,首次解析自动播种初始文件(只补缺,不覆盖用户定制)
  const homePrompts = join(awHome(process.env), 'prompts')
  if (!existsSync(homePrompts)) seedHomePrompts(homePrompts)

  // ② 项目内 ./.AgentWorkShop/prompts 真实存在 → 项目内优先
  const localConfigRoot = findLocalConfigRoot(process.cwd())
  if (localConfigRoot) {
    const candidate = join(localConfigRoot, 'prompts')
    if (existsSync(candidate)) return candidate
  }

  // ③ ~/.AgentWorkShop/prompts
  if (existsSync(homePrompts)) return homePrompts
  throw new AppError(500, 'PROMPTS_DIR_MISSING', `prompts 目录不存在(已尝试自动播种): ${homePrompts};可用 AW_PROMPTS_DIR 指定`)
}

/** 读取 md 原文(mtime 缓存;文件缺失 fail-fast) */
export function loadPrompt(name: string): string {
  const file = join(promptsDir(), `${name}.md`)
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  }
  catch {
    throw new AppError(500, 'PROMPT_FILE_MISSING', `prompt 文件缺失: ${file}`)
  }
  const hit = cache.get(name)
  if (hit && hit.mtimeMs === mtimeMs) return hit.content
  const content = readFileSync(file, 'utf-8')
  cache.set(name, { mtimeMs, content })
  return content
}

/**
 * 渲染 prompt:{{var}} 替换(缺省变量 → 空串);规范化首尾空白。
 * 变量值中的 $ 具有字面义(替换用函数形式,不解释 $ 模式)。
 */
export function renderPrompt(name: string, vars: PromptVars = {}): string {
  const raw = loadPrompt(name)
  return raw
    .replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, key: string) => {
      const v = vars[key]
      return v === undefined || v === null ? '' : String(v)
    })
    .replace(/^\s+|\s+$/g, '')
}

/** 全部 prompt 名(去 .md 后缀;测试与自检用) */
export function listPromptNames(): string[] {
  const dir = promptsDir()
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => f.slice(0, -3))
    .sort()
}

// ===== host tools 结构化定义(host-tools.json) =====

export interface HostToolDef {
  name: string
  label?: string
  description: string
  parameters: Record<string, unknown>
  hidden?: boolean
}

let hostToolsCache: { mtimeMs: number, tools: HostToolDef[] } | null = null

/** 加载 host 工具定义(name/label/description/parameters;缺文件 fail-fast) */
export function loadHostToolDefs(): HostToolDef[] {
  const file = join(promptsDir(), 'host-tools.json')
  let mtimeMs: number
  try {
    mtimeMs = statSync(file).mtimeMs
  }
  catch {
    throw new AppError(500, 'HOST_TOOLS_MISSING', `host 工具定义缺失: ${file}`)
  }
  if (hostToolsCache && hostToolsCache.mtimeMs === mtimeMs) return hostToolsCache.tools
  const parsed = JSON.parse(readFileSync(file, 'utf-8')) as HostToolDef[]
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new AppError(500, 'HOST_TOOLS_INVALID', 'host-tools.json 必须为非空数组')
  }
  for (const t of parsed) {
    if (!t.name || !t.description || !t.parameters) {
      throw new AppError(500, 'HOST_TOOLS_INVALID', `host 工具定义不完整: ${JSON.stringify(t).slice(0, 80)}`)
    }
  }
  hostToolsCache = { mtimeMs, tools: parsed }
  return parsed
}
