/**
 * 装载失败回滚 / 自身 origin / 设置同步
 * (由 server/services/workshop/plugins/host.mjs 按职责拆出;内容逐行原文搬运)
 */
import { getPluginHost } from './api.mjs'
import { hostLoggerFallback } from './config.mjs'

export function rollbackPartialLoad(host, name) {
  if (!name) return
  try {
    const removed = host.routes.unregisterPlugin?.(name) ?? 0
    const disposables = host.disposables.get(name) ?? []
    for (const d of disposables.splice(0)) {
      try {
        d?.()
      }
      catch (e) {
        host.logger.warn(`[插件回滚] dispose 失败 ${name}:`, e?.message ?? e)
      }
    }
    host.disposables.delete(name)
    for (const off of (host.hookOffs.get(name) ?? []).splice(0)) {
      try {
        off?.()
      }
      catch { /* 解绑失败不影响回滚 */ }
    }
    host.hookOffs.delete(name)
    // omp 桥:把已入 pending 未注入的工具摘掉(bridge 未挂载时为空操作)
    const bridge = globalThis.__ompPluginToolsBridge
    if (bridge?.pending) {
      bridge.pending = bridge.pending.filter(p => p.plugin !== name)
    }
    host.plugins.delete(name)
    // 设置的描述符与配置分组都挂在 rec 上 → 随 rec 一并消失;重算一次让设置页立即收敛
    void syncPluginSettings()
    if (removed > 0) host.logger.warn(`[插件回滚] ${name}:已卸下 ${removed} 条半注册路由`)
  }
  catch (e) {
    host.logger.error(`[插件回滚] ${name} 回滚自身异常:`, e?.message ?? e)
  }
}

export function selfOriginRef(host) {
  return host.selfOrigin()
}

/** 插件设置声明 + 配置分组声明 → SystemConfigService
 *  (合并进平台描述符:前端设置页渲染 + PATCH 校验 + 热生效;分组供设置页分区渲染) */
export async function syncPluginSettings() {
  try {
    const { getSystemConfigService } = await import('@/server/services/system-config')
    const host = getPluginHost()
    const descs = []
    const groups = []
    const labels = new Map()
    for (const rec of host?.plugins.values() ?? []) {
      if (rec.enabled === false) continue
      labels.set(rec.name, rec.label ?? rec.name)
      descs.push(...(rec.settings ?? []))
      groups.push(...(rec.groups ?? []))
    }
    getSystemConfigService().setPluginDescriptors(descs, groups, labels)
  }
  catch (err) {
    hostLoggerFallback()?.warn('插件设置同步失败(设置页将不渲染插件配置):', err?.message)
  }
}

/** 热重载:全部 dispose/解绑 → 重新装载(跳过停用)→ 广播 plugins.reloaded(并发合并)。
 *  竞态防护:重装载期间状态文件再变化(如 disable→enable 连击)时,去抖回调会撞上
 *  in-flight 守卫被吞 —— 装载结束后比对禁用集快照,有差异自动补跑一次,事件绝不丢失。 */
