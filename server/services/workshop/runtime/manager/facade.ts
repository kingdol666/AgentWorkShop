/**
 * AgentChannelManager —— 组合各分层后的最终门面(组合根)。
 * 公开 API 与拆分前完全一致:构造签名、方法集、工厂与单例函数都原样保留。
 */
import { ManagerInternal } from './internal'
import type { ManagerDeps } from './types'

export class AgentChannelManager extends ManagerInternal {}

/** 工厂:创建 manager(测试与集成均可注入依赖) */
export function createAgentChannelManager(deps: ManagerDeps): AgentChannelManager {
  return new AgentChannelManager(deps)
}

let managerSingleton: AgentChannelManager | null = null

export function initWorkshopManager(deps: ManagerDeps): AgentChannelManager {
  managerSingleton = new AgentChannelManager(deps)
  return managerSingleton
}

export function getWorkshopManagerOrNull(): AgentChannelManager | null {
  return managerSingleton
}
