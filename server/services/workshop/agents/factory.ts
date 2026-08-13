/**
 * Agent 实现工厂 — 按 harness 装配 AgentInterface。
 * mock 立即可用;claude/omp 尚未接入(抛 HARNESS_NOT_IMPLEMENTED);未知 harness 抛 UNKNOWN_HARNESS。
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块 T5。
 */
import { AppError } from '../../../utils/errors'
import type { AgentInfo, AgentInterface } from './agent-interface'
import { MockAgentImpl } from './mock-agent'

export function createAgentImpl(agent: AgentInfo): AgentInterface {
  switch (agent.harness) {
    case 'mock':
      return new MockAgentImpl(agent.config)
    case 'claude':
    case 'omp':
      throw new AppError(501, 'HARNESS_NOT_IMPLEMENTED', `harness ${agent.harness} 待接入`)
    default:
      throw new AppError(400, 'UNKNOWN_HARNESS', `未知 harness: ${agent.harness}`)
  }
}
