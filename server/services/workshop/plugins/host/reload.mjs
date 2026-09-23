/**
 * 热重载(reloadPluginHost / doReload)
 * (由 server/services/workshop/plugins/host.mjs 按职责拆出;内容逐行原文搬运)
 */
import { createRouteTable } from '@/sdk/index.mjs'
import { getPluginHost, pluginManifest } from './api.mjs'
import { join } from 'node:path'
import { loadAllPlugins } from './load.mjs'
import { modePaths } from './config.mjs'
import { readDisabledSet } from './state.mjs'
import { syncPluginSettings } from './rollback.mjs'

export async function reloadPluginHost() {
  const host = getPluginHost()
  if (!host) return null
  if (host.reloadInFlight) return host.reloadInFlight
  host.reloadInFlight = doReload(host).finally(() => {
    host.reloadInFlight = null
    try {
      const current = readDisabledSet(modePaths(host.cwd).homeDir)
      const prev = host.lastDisabledSnapshot
      const drifted = prev
        ? (current.size !== prev.size || [...current].some(x => !prev.has(x)))
        : false
      host.lastDisabledSnapshot = current
      if (drifted) void reloadPluginHost()
    }
    catch { /* 快照比对失败忽略(下个事件兜底) */ }
  })
  return host.reloadInFlight
}

export async function doReload(host) {
  host.logger.info('热重载插件宿主 ...')
  for (const [name, list] of host.disposables ?? []) {
    for (const fn of list.splice(0)) {
      try {
        await fn()
      }
      catch (err) {
        host.logger.warn(`[${name}] onDispose 失败:`, err?.message)
      }
    }
  }
  for (const offs of (host.hookOffs ?? new Map()).values()) {
    for (const off of offs.splice(0)) {
      try {
        off()
      }
      catch { /* 解绑失败忽略 */ }
    }
  }
  const prevNames = [...host.plugins.keys()]
  // 插件注册的协议驱动(数采读 + 写控)先清空:停用/卸载的插件驱动立即失效,
  // 本轮装载成功的插件经 ctx.daq/ctx.dcw 重新注册(同名幂等)。
  try {
    const daqDrivers = await import('@/server/services/workshop/daq/drivers')
    daqDrivers.clearPluginDrivers()
  }
  catch { /* daq 未装载(桥排队中):注册表为空,无需清 */ }
  try {
    const dcwDrivers = await import('@/server/services/workshop/dcw/drivers')
    dcwDrivers.clearPluginWriteDrivers()
  }
  catch { /* dcw 未装载:同上 */ }
  // 工具注销延后:先装载新集、后清「本轮未再装载」的旧插件工具。
  // 原先在装载前就全部注销 → 重载窗口内(秒级~数十秒)所有插件工具"未知工具",
  // 期间到达的 Agent 工具调用(daq:sample 自动诊断/kb_store 等)被误拒
  // (实测生产闭环 Stage D 撞窗失败)。同名工具装载时按"后注册者胜"覆盖,无残留。
  const ompTools = await import('@/server/services/workshop/agents/plugin-tools').catch(() => null)
  host.plugins.clear()
  host.routes = createRouteTable()
  host.failures = []
  await loadAllPlugins(host, { config: host.config, settingsPath: null, paths: { home: modePaths(host.cwd).homeDir, configRoot: join(host.cwd, '.AgentWorkShop'), dataDir: join(host.cwd, '.AgentWorkShop', 'data') } })
  // 装载中途失败(setup 抛错)的插件可能留下半注册工具,兜底再清一次
  for (const prev of prevNames) {
    if (!host.plugins.has(prev)) {
      try {
        ompTools?.unregisterPluginTools(prev)
      }
      catch { /* 忽略 */ }
    }
  }
  await host.bus.emit('plugins:reloaded', { plugins: pluginManifest() })
  await syncPluginSettings()
  try {
    const m = await import('@/server/services/workshop/scene-events')
    m.broadcastSceneEvent('plugins.reloaded', { plugins: pluginManifest() })
  }
  catch { /* 广播失败不影响重载 */ }
  return host
}

/** 启停单插件(写状态文件;调用方随后 reloadPluginHost 或由 state watcher 触发) */
