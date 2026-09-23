/**
 * OmpRpcAgentImpl 的模块级纯工具/常量(原 server/services/workshop/agents/omp-agent.ts 类外声明,含类体之后与类无关的部分)。
 */
import { createLogger } from '../../logger'
import { onPluginToolsChange } from '../plugin-tools'

export const log = createLogger('workshop.omp')

// 兼容再导出(脚本/测试历史导入面;实现在 host-tool-bridge)
export { HOST_TOOLS, hostToolsForRole } from '../host-tool-bridge'

// ===== 配置 =====

/**
 * 在跑实例表只需要"热更新工具面"这一能力。用**结构类型**而不是最终类类型:
 * 否则各分层传 `this` 时类型不匹配(层的 this 不是最终类),工具模块也会被迫反向 import 门面类。
 */
export interface LiveOmpAgent {
  refreshPluginTools(): void
}

export const gLive = globalThis as typeof globalThis & { __ompLiveAgents?: Set<LiveOmpAgent> }
export function liveAgents(): Set<LiveOmpAgent> {
  return gLive.__ompLiveAgents ??= new Set()
}

// 工具注册表变更 → 全部在跑会话热更新工具面
onPluginToolsChange(() => {
  for (const impl of liveAgents()) {
    try {
      impl.refreshPluginTools()
    }
    catch { /* 单实例失败不影响其他 */ }
  }
})

// ===== OmpRpcAgentImpl =====
