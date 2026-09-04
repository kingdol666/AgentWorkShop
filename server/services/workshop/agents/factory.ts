/**
 * Agent 实现工厂 — 按 harness 装配 AgentInterface。
 * 全部引擎注册于 HARNESS_REGISTRY(registry.ts,单一事实源);
 * 未知 harness 抛 UNKNOWN_HARNESS。
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块 T5。
 */
import type { AgentInfo, AgentInterface } from './agent-interface'
import { createAgentImplByHarness } from './registry'

export function createAgentImpl(agent: AgentInfo): AgentInterface {
  return createAgentImplByHarness(agent)
}
