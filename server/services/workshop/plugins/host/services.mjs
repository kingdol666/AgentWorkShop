/**
 * 插件运行时服务种子(ctx.* 懒绑定)
 * (由 server/services/workshop/plugins/host.mjs 按职责拆出;内容逐行原文搬运)
 */
import { g } from './config.mjs'
import { pluginManifest } from './api.mjs'

export const servicesExt = (g.__awPluginServices ??= {
  registry: new Map(),
  /** 核心服务注册(name → 惰性 getter);宿主启动期 seed */
  register(name, get) {
    this.registry.set(String(name), get)
  },
  /** 插件供服务(自动加 `<plugin>.` 前缀;同前缀同名覆盖) */
  provide(plugin, name, get) {
    this.registry.set(`${plugin}.${String(name)}`, get)
  },
  names() {
    return [...this.registry.keys()]
  },
  /** 取运行时服务对象(惰性求值并缓存;失败抛错由调用方兜底) */
  async get(name) {
    const get = this.registry.get(String(name))
    if (!get) throw new Error(`未知运行时服务: ${name}(可用: ${this.names().join(', ')})`)
    get._cache ??= get()
    return await get._cache
  },
})

/** 插件可获取的后端运行时对象(只读取数面;懒加载避免循环导入,失败即抛由插件兜底) */
export async function seedRuntimeServices() {
  if (servicesExt.registry.has('daq')) return
  servicesExt.register('daq', async () => {
    const storage = await import('@/server/services/workshop/daq/storage/index')
    const nodes = await import('@/server/services/workshop/daq/daq-node.repo')
    return {
      query: q => storage.getTsdb().queryTagged(q),
      nodes: () => nodes.getDaqNodeRepo().snapshot(),
    }
  })
  servicesExt.register('lines', async () => {
    const m = await import('@/server/services/workshop/dcw/dcw-line.repo')
    const repo = m.getDcwLineRepo()
    return { list: () => repo.all(), byId: id => repo.byId(id) }
  })
  servicesExt.register('channels', async () => {
    const m = await import('@/server/plugins/workshop')
    const mgr = m.getWorkshopManager()
    return {
      list: () => mgr.deps.repos.channels.list(),
      agents: channelId => mgr.deps.repos.channelAgents.listByChannel(channelId),
    }
  })
  servicesExt.register('plugins', async () => pluginManifest())
}

// ---- 启停状态(单一事实源:<home>/plugins-state.json;CLI/Web/宿主三方读写) ----
//  入参 homeDir 由 modePaths().homeDir 给出($AW_HOME 优先),**不是配置根**。
