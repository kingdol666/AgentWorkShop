/**
 * 插件热重载的原子化辅助（WP-C0）。
 *
 * 问题：旧实现在装载前 `clearPluginDrivers/clearDecoders/clearPluginWriteDrivers`，
 * 在「清空 → 装载完成」窗口内（秒级~数十秒）插件驱动全部消失，期间的数据采集/
 * 写控调用会以「未知驱动」失败（生产闭环曾撞窗）。
 *
 * 新语义（load-then-prune，先装后剪）：
 *  1. 装载前只**快照**注册表名字，不清空；同名驱动装载时幂等覆盖（后注册者胜）；
 *  2. 装载成功后按差集剪除「本轮未再注册」的旧驱动/解码器 —— 停用插件立即失效，
 *     但窗口内始终有一套可用驱动（旧版或新版）；
 *  3. 装载失败 → 恢复旧插件表快照（宁可保留旧版，也不留半装载状态）。
 *
 * 本模块只提供纯函数，便于单测；副作用调用留在 reload.mjs。
 */

/**
 * 计算需要剪除的名字：装载前存在、装载后不再存在。
 * @param {string[]} before 装载前的注册名
 * @param {string[]} after 装载后的注册名
 * @returns {string[]} 需要 delete 的名字
 */
export function staleNames(before, after) {
  const now = new Set(after)
  return [...new Set(before)].filter(name => !now.has(name))
}

/**
 * 对 Map 注册表执行剪除（in-place）；返回实际删除数量。
 * 失败静默（注册表可能已被其他路径清理）。
 * @param {Map<string, unknown>} registry
 * @param {string[]} names
 */
export function pruneRegistry(registry, names) {
  let removed = 0
  for (const name of names) {
    try {
      if (registry.delete(name)) removed += 1
    }
    catch { /* 单条删除失败不影响其余 */ }
  }
  return removed
}

/**
 * 快照 + 清空（供 reload.mjs 在装载前调用，保留回滚材料）。
 * 返回 `{ plugins, failures, routes }`；routes 由调用方重新赋值后旧表仅作回滚参考。
 * @param {{ plugins: Map<string, unknown>, failures?: unknown[], routes?: unknown }} host
 */
export function snapshotPluginState(host) {
  return {
    plugins: new Map(host.plugins ?? []),
    failures: Array.isArray(host.failures) ? [...host.failures] : [],
    routes: host.routes,
  }
}

/**
 * 装载失败时回滚到快照（保留旧版插件可用，而不是留下半装载状态）。
 * @param {{ plugins: Map<string, unknown>, failures?: unknown[], routes?: unknown }} host
 * @param {ReturnType<typeof snapshotPluginState>} snapshot
 */
export function restorePluginState(host, snapshot) {
  host.plugins.clear()
  for (const [name, plugin] of snapshot.plugins) host.plugins.set(name, plugin)
  host.failures = snapshot.failures
  if (snapshot.routes) host.routes = snapshot.routes
}
