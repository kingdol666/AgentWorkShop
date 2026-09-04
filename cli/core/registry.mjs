// ============================================================
// AgentWorkShop CLI — 指令注册表（Command Registry）
// ------------------------------------------------------------
// 指令注册机制（三层扫描，同名后扫描者覆盖 → 项目级 > 用户级 > 内建）：
//   1. 内建指令   ：<packageRoot>/cli/commands/*.mjs（随包发布，永远存在）
//   2. 用户级指令 ：~/.agentworkshop/commands/*.mjs（经 aw register --global 注册）
//   3. 项目级指令 ：<projectRoot>/.agentworkshop/commands/*.mjs（经 aw register 注册）
// 任何 .mjs 文件只需导出 { meta, run } 即自动成为一条指令：
//   export const meta = { name, summary, usage, group, aliases?, needsProject? }
//   export async function run(argv, ctx) { ... }
// 这是「约定优于配置」的注册模型：放文件即注册，无需任何登记的集中式清单。
// ============================================================
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export class CommandRegistry {
  constructor({ dirs = [] } = {}) {
    this.dirs = dirs
    this.commands = new Map() // name → { meta, run, source }
    this.aliases = new Map() // alias → name
    this.failures = [] // 扫描失败的模块（不阻断其他指令）
  }

  /** 注册一个命令模块（meta + run） */
  register(mod, source = 'builtin') {
    if (!mod?.meta?.name || typeof mod.run !== 'function') {
      this.failures.push({ source, error: '模块缺少 meta.name 或 run()' })
      return false
    }
    const meta = { ...mod.meta, group: mod.meta.group ?? 'other' }
    this.commands.set(meta.name, { meta, run: mod.run, source })
    for (const alias of meta.aliases ?? []) this.aliases.set(alias, meta.name)
    return true
  }

  /** 从单个文件注册（动态 import） */
  async registerFile(file) {
    const url = pathToFileURL(file).href
    try {
      const mod = await import(url)
      const candidate = mod.default?.meta && typeof mod.default.run === 'function' ? mod.default : mod
      if (this.register(candidate, file)) return true
    }
    catch (err) {
      this.failures.push({ source: file, error: String(err?.message ?? err) })
    }
    return false
  }

  /** 扫描一批目录下的可执行命令文件（*.mjs / *.js / *.cjs） */
  async scanDirs(dirs) {
    for (const dir of dirs) {
      let entries
      try {
        entries = readdirSync(dir)
      }
      catch {
        continue // 目录不存在 → 跳过
      }
      const files = entries
        .filter(name => /\.(mjs|js|cjs)$/.test(name) && !name.startsWith('_'))
        .map(name => join(dir, name))
        .filter((path) => {
          try {
            return statSync(path).isFile()
          }
          catch {
            return false // 失效符号链接等,跳过不阻断
          }
        })
      for (const file of files) {
        await this.registerFile(file)
      }
    }
  }

  /** 查找指令（名字或别名） */
  find(name) {
    return this.commands.get(name) ?? this.commands.get(this.aliases.get(name))
  }

  has(name) {
    return this.find(name) !== undefined
  }

  /** 全量指令（含别名信息），可按 group 分组 */
  list() {
    return [...this.commands.values()]
  }

  groups() {
    const out = new Map()
    for (const cmd of this.list()) {
      if (!out.has(cmd.meta.group)) out.set(cmd.meta.group, [])
      out.get(cmd.meta.group).push(cmd)
    }
    return out
  }
}

/** 拼接指令扫描目录清单（内建 → 用户级 → 项目级;配合同名后者覆盖,项目级优先级最高）
 *  目录名与 shared/config/home.mjs 的 HOME_DIRNAME 保持一致(.AgentWorkShop):
 *  Windows 大小写不敏感无感,Linux/macOS 下小写目录会导致注册的指令永远扫描不到。 */
export function commandDirs({ packageRoot, projectRoot, homeDir }) {
  const dirs = []
  if (packageRoot) dirs.push(join(packageRoot, 'cli', 'commands'))
  if (homeDir) dirs.push(join(homeDir, '.AgentWorkShop', 'commands'))
  if (projectRoot) dirs.push(join(projectRoot, '.AgentWorkShop', 'commands'))
  return dirs
}

export default CommandRegistry
