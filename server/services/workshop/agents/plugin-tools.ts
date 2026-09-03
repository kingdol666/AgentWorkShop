/**
 * OMP 插件工具注册表 —— 插件经 ctx.omp.registerTool 注册自定义 host 工具,
 * 注入 omp agent 会话(tool schema + handler 分发)。
 *
 *  - 注册期:插件宿主(nitro plugin)先于 omp 模块装载 → 注册项进 pending 队列,
 *    本模块 attachOmpPluginBridge() 被调用时接管并回放(与 daq plugin-bridge 同构)。
 *  - 注入期:hostToolsForRole() 合并插件工具;omp-agent 在 ensureClient 时随
 *    set_host_tools 下发;注册表变更(onChange)→ 通知全部在跑 agent 实例
 *    **热重发 set_host_tools**(运行时注入,无需重启/重spawn 子进程)。
 *  - 分发期:handleHostTool 对未内置的 toolName 查本注册表,以 agent 上下文
 *    (agentId/channelId/role/name)回调插件 handler。
 */
import { createLogger } from '../logger'

const log = createLogger('workshop.plugin-tools')

export type OmpPluginToolRole = 'lead' | 'worker'

export interface OmpPluginAgentContext {
  agentId: string
  channelId: string
  role: OmpPluginToolRole
  name: string
}

export interface OmpPluginTool {
  /** 工具名(与内置 host tool 冲突时内置优先,注册被忽略并告警) */
  name: string
  label?: string
  description: string
  /** JSON Schema(properties/required);omp 端可见的参数面 */
  parameters: Record<string, unknown>
  /** 可用角色(缺省 lead+worker 均可) */
  roles?: OmpPluginToolRole[]
  /** 执行体:返回文本结果(isError=true → omp 端按工具错误呈现) */
  handler: (args: Record<string, unknown>, agent: OmpPluginAgentContext) => Promise<{ text: string, isError?: boolean }> | { text: string, isError?: boolean }
}

export interface OmpPluginToolDef {
  plugin: string
  tool: OmpPluginTool
}

interface OmpToolsBridge {
  pending: OmpPluginToolDef[]
  /** 回放槽(drain 接管后设置;注册即时回调) */
  _drain?: () => void
  register(plugin: string, tool: OmpPluginTool): void
  drain(onTool: (def: OmpPluginToolDef) => void): void
}

const g = globalThis as typeof globalThis & {
  __ompPluginTools?: { byPlugin: Map<string, OmpPluginTool>, byName: Map<string, OmpPluginTool>, listeners: Set<() => void> }
}

function state() {
  return g.__ompPluginTools ??= { byPlugin: new Map(), byName: new Map(), listeners: new Set() }
}

/** 插件工具注册(同名覆盖;与内置 host tool 同名时忽略并告警)。变更后热通知全部在跑 agent。 */
export function registerPluginTool(plugin: string, tool: OmpPluginTool): void {
  if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) {
    log.warn(`[${plugin}] 插件工具缺少 name,忽略`)
    return
  }
  const st = state()
  if (st.byName.has(tool.name)) {
    const prev = st.byName.get(tool.name)!
    if (prev === tool) return // 热重载重复注册幂等
    log.warn(`[omp-tools] 工具「${tool.name}」被插件 ${plugin} 覆盖(原注册方仍在表中,后注册者胜)`)
  }
  // 旧注册清理(同插件同名)
  const prevByPlugin = st.byPlugin.get(`${plugin}:${tool.name}`)
  if (prevByPlugin) {
    st.byName.delete(prevByPlugin.name)
  }
  st.byPlugin.set(`${plugin}:${tool.name}`, tool)
  st.byName.set(tool.name, tool)
  log.info(`[omp-tools] 插件工具注册:「${tool.name}」(${plugin})`)
  notifyToolChange()
}

/** 插件卸载/停用时移除其全部工具 */
export function unregisterPluginTools(plugin: string): void {
  const st = state()
  for (const [k, tool] of [...st.byPlugin.entries()]) {
    if (k.startsWith(`${plugin}:`)) {
      st.byPlugin.delete(k)
      if (st.byName.get(tool.name) === tool) st.byName.delete(tool.name)
    }
  }
}

/** 全部插件工具(工具名 → 定义;hostToolsForRole 合并与分发用) */
export function listPluginTools(): Map<string, OmpPluginTool> {
  return state().byName
}

/** 注册表变更订阅(omp-agent 模块加载时接管 pending 并订阅热注入) */
export function onPluginToolsChange(fn: () => void): () => void {
  const st = state()
  st.listeners.add(fn)
  return () => st.listeners.delete(fn)
}

function notifyToolChange(): void {
  for (const fn of state().listeners) {
    try {
      fn()
    }
    catch (err) {
      log.warn('[omp-tools] 变更通知失败:', err instanceof Error ? err.message : err)
    }
  }
}

/** 接管 host.mjs 的排队桥(装载顺序无关:桥不存在则自建;幂等) */
let attached = false

function makeOmpBridge(): OmpToolsBridge {
  return {
    pending: [],
    register(plugin, tool) {
      this.pending.push({ plugin, tool })
      this._drain?.()
    },
    drain(onTool) {
      this._drain = () => {
        for (const def of this.pending.splice(0)) onTool(def)
      }
      this._drain()
    },
  }
}

export function attachOmpPluginBridge(): void {
  if (attached) return
  attached = true
  const g = globalThis as typeof globalThis & { __ompPluginToolsBridge?: OmpToolsBridge }
  const bridge: OmpToolsBridge = g.__ompPluginToolsBridge ?? makeOmpBridge()
  g.__ompPluginToolsBridge = bridge
  bridge.drain((def) => {
    registerPluginTool(def.plugin, def.tool)
  })
}
