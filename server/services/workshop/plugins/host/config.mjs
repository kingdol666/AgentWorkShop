/**
 * 模块头 / 懒加载权限与仓储 / 日志 / 路径与插件 i18n 读取
 * (由 server/services/workshop/plugins/host.mjs 按职责拆出;内容逐行原文搬运)
 */
import { existsSync, readFileSync } from 'node:fs'
import { getPluginHost } from './api.mjs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// ============================================================
// AgentWorkShop 插件宿主 —— 发现 / 装载 / 启停状态 / 热重载 / 路由表
// ------------------------------------------------------------
// 目录(与 aw commands 同哲学):
//   project: <repo>/.AgentWorkShop/plugins/<name>/index.mjs
//   user:    ~/.AgentWorkShop/plugins/<name>/index.mjs(同名 project 优先)
// 契约:入口导出普通对象 { name, version?, description?, setup(ctx)?,
//   client?: './client.mjs', routes?: [{method,path,handler}] }
// —— ctx 由宿主注入,插件运行时零导入依赖(sdk/ 供类型与显式糖)。
//
// 启停状态机:<home>/plugins-state.json { version, updatedAt, disabled: string[] }
//   ⚠️ home = $AW_HOME 或 ~/.AgentWorkShop —— **不是**配置根。源码检出下两者不同:
//   configRoot=<repo>/.AgentWorkShop(数据/kv 在这里),home=~/.AgentWorkShop(状态在这里)。
//   全局安装两者重合,所以旧注释写"配置根"时看不出问题。
//   · 装载时跳过 disabled 插件(manifest 仍可见,enabled:false)
//   · 状态文件变化(fs.watch)→ 热重载:全部 dispose/解绑 → 重新装载
//   · CLI(aw plugin enable/disable) 与 Web 设置页均只写状态文件,服务自感知
// 错误隔离:单插件装载/执行失败记入 failures,绝不拖垮主服务。
// ============================================================

// 延迟解析的产线权限服务(esbuild/别名下避免 nitro 打包循环导入;失败降级为拒绝一切)
let permissions = null
let userRepository = null

/**
 * 跨模块只读访问器。
 *
 * 为什么不是 `export let`:原文件里这两者本就是**模块私有**(写入只发生在 loadPermissions 内部),
 * 拆成多文件后由 load.mjs 读取;导出可变绑定会被 `import/no-mutable-exports` 拒绝,
 * 且跨模块可变导出容易被误写 ⇒ 用 getter 暴露当前值。
 */
export function permissionsOf() {
  return permissions
}

export function userRepositoryOf() {
  return userRepository
}
export async function loadPermissions() {
  if (permissions) return
  try {
    permissions = await import('@/server/services/workshop/permissions')
    userRepository = await import('@/server/repositories/user.repository').then(m => m.userRepository)
  }
  catch (err) {
    hostLoggerFallback()?.warn('权限服务加载失败(插件 ctx.permissions 降级):', err?.message)
  }
}
export function hostLoggerFallback() {
  return globalThis.__awPluginHost?.logger ?? console
}

export const g = globalThis

export function log() {
  return {
    debug: (...a) => console.log('[aw-plugins][debug]', ...a),
    info: (...a) => console.log('[aw-plugins]', ...a),
    warn: (...a) => console.warn('[aw-plugins]', ...a),
    error: (...a) => console.error('[aw-plugins]', ...a),
  }
}

export function defaultHome() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return join(home, '.AgentWorkShop')
}

/** 运行模式路径(cwd 为检出根时启用 project 作用域) */
export function modePaths(cwd) {
  const isRepo = existsSync(join(cwd, 'config.yml')) && existsSync(join(cwd, 'nuxt.config.ts'))
  // packageRoot:宿主运行时取 initPluginHost 注入值;冒烟/单测(cwd 在包根)回退 cwd
  const packageRoot = g.__awPluginHost?.packageRoot ?? (isRepo ? cwd : null)
  const builtinDir = packageRoot ? join(packageRoot, 'server', 'plugins-builtin') : null
  return {
    builtinDir: builtinDir && existsSync(builtinDir) ? builtinDir : null,
    projectDir: isRepo ? join(cwd, '.AgentWorkShop', 'plugins') : null,
    userDir: join(process.env.AW_HOME && String(process.env.AW_HOME).trim() ? String(process.env.AW_HOME).trim() : defaultHome(), 'plugins'),
    homeDir: process.env.AW_HOME && String(process.env.AW_HOME).trim() ? String(process.env.AW_HOME).trim() : defaultHome(),
  }
}

export function pathToUrl(p) {
  return pathToFileURL(resolve(p)).href
}

/** 插件根目录 i18n.json 路径(存在才返回;多语言消息包,按 plugin.<name> 命名空间注入前端) */
export function pluginI18nPath(dir) {
  const p = join(dir, 'i18n.json')
  return existsSync(p) ? p : null
}

/** 读取并解析插件 i18n.json(形态 { "<locale>": { key: value } };坏文件返回 null 不阻断) */
export function readPluginI18n(rec) {
  if (!rec?.i18nPath || !existsSync(rec.i18nPath)) return null
  try {
    const obj = JSON.parse(readFileSync(rec.i18nPath, 'utf8'))
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    const out = {}
    for (const [locale, messages] of Object.entries(obj)) {
      if (messages && typeof messages === 'object' && !Array.isArray(messages)) out[locale] = messages
    }
    return Object.keys(out).length ? out : null
  }
  catch {
    return null
  }
}

/**
 * 全部插件的 i18n 消息包(免鉴权只读端点用;仅 UI 文案,插件作者不得放置敏感信息):
 * { "<plugin>": { "<locale>": { key: value } } }
 */
export function pluginI18nBundle() {
  const host = getPluginHost()
  if (!host) return {}
  const out = {}
  for (const rec of host.plugins.values()) {
    if (rec.enabled === false) continue
    const bundle = readPluginI18n(rec)
    if (bundle) out[rec.name] = bundle
  }
  return out
}

// ---- 后端运行时服务面(ctx.services;只读取数优先,跨插件服务带 <plugin>. 前缀) ----
