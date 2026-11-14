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
  /** 插件供服务(自动加 `<plugin>.` 前缀;同前缀同名覆盖;owner 归属供重载清理) */
  provide(plugin, name, get) {
    this.registry.set(`${plugin}.${String(name)}`, get)
    this.owners.set(`${plugin}.${String(name)}`, String(plugin))
  },
  names() {
    return [...this.registry.keys()]
  },
  /**
   * P1(2026-11-14):按 owner 清理插件供服务 —— 重载/停用后旧插件的
   * services 条目必须消失,否则其他插件仍可经 ctx.services.get 拿到旧资源。
   * 只清理 provide(带 owner)条目;宿主 register 的核心服务不受影响。
   */
  unregisterOwner(plugin) {
    this.owners ??= new Map()
    const prefix = `${String(plugin)}.`
    for (const key of [...this.registry.keys()]) {
      if (key.startsWith(prefix) && this.owners.get(key) === String(plugin)) {
        this.registry.delete(key)
        this.owners.delete(key)
      }
    }
  },
  owners: new Map(),
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
  // 2026-11-14 PR-G:插件代码不能直接 `import('@/server/...')`(插件经动态 import
  // 装载,Nitro 别名不生效 —— 实测 live 下 RSI adapter 注册整段失败)。研究/证据
  // 工厂与审计入口经宿主服务注入,与 context.runtime 同族。
  servicesExt.register('research.kit', async () => {
    const [{ LocalResearchOrchestrator }, { CandidateEvidenceStore }] = await Promise.all([
      import('@/server/services/workshop/research/orchestrator'),
      import('@/server/services/workshop/evidence/candidate-store'),
    ])
    return { LocalResearchOrchestrator, CandidateEvidenceStore }
  })
  servicesExt.register('ops.record', async () => {
    const { recordOps } = await import('@/server/services/workshop/ops/ops')
    return recordOps
  })
  if (servicesExt.registry.has('daq')) {
    if (!servicesExt.registry.has('context.runtime')) {
      servicesExt.register('context.runtime', async () => {
        const host = g.__awPluginHost
        if (host?.contextRuntime) return host.contextRuntime
        const { createContextRuntimeService } = await import('@/server/services/workshop/context/runtime')
        const manager = await import('@/server/plugins/workshop')
        const runtime = createContextRuntimeService({ repos: manager.getWorkshopManager().deps.repos })
        if (host) host.contextRuntime = runtime
        return runtime
      })
      servicesExt.register('context.adapterRegistry', async () => (await servicesExt.get('context.runtime')).registry)
    }
    return
  }
  servicesExt.register('context.runtime', async () => {
    const host = g.__awPluginHost
    if (host?.contextRuntime) return host.contextRuntime
    const { createContextRuntimeService } = await import('@/server/services/workshop/context/runtime')
    const manager = await import('@/server/plugins/workshop')
    const runtime = createContextRuntimeService({ repos: manager.getWorkshopManager().deps.repos })
    if (host) host.contextRuntime = runtime
    return runtime
  })
  servicesExt.register('context.adapterRegistry', async () => (await servicesExt.get('context.runtime')).registry)
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
  // 平台通告面(插件 → Agent 异步结果回执):deliver 投递并唤醒,claim 轮询方认领。
  // 未接线/测试脚手架下 manager 方法返回 false,插件侧降级为仅日志(行为同旧版)。
  servicesExt.register('notify', async () => {
    const m = await import('@/server/plugins/workshop')
    const mgr = m.getWorkshopManager()
    return {
      deliver: notice => mgr.deliverPlatformNotice(notice),
      claim: (tool, jobId) => mgr.claimPlatformNotice(tool, jobId),
    }
  })
  // Agent 可读面(插件侧授权判定):绑定节点 ∪ 频道绑线产线。
  // diag-bridge 等插件在读取产线数据前必须按调用者身份校验,不能拿全局只读面直读任意产线。
  servicesExt.register('agentScope', async () => {
    const m = await import('@/server/services/workshop/agents/industrial/tool-verify')
    return {
      readableLines: agentId => [...m.resolveRefFaces(agentId).readableLines],
      boundNodes: agentId => [...m.resolveRefFaces(agentId).boundNodes],
    }
  })
  servicesExt.register('plugins', async () => pluginManifest())
}

// ---- 启停状态(单一事实源:<home>/plugins-state.json;CLI/Web/宿主三方读写) ----
//  入参 homeDir 由 modePaths().homeDir 给出($AW_HOME 优先),**不是配置根**。
