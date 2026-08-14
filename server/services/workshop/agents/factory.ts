/**
 * Agent 实现工厂 — 按 harness 装配 AgentInterface。
 * mock:进程内 mock(联调/测试);omp:真实 omp 子进程(默认推荐);
 * claude:Claude Agent SDK(待接入);未知 harness 抛 UNKNOWN_HARNESS。
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块 T5。
 */
import { AppError } from '../../../utils/errors'
import type { AgentInfo, AgentInterface } from './agent-interface'
import { MockAgentImpl } from './mock-agent'
import { OmpRpcAgentImpl } from './omp-agent'
import { ClaudeSdkAgentImpl } from './claude-agent'

export function createAgentImpl(agent: AgentInfo): AgentInterface {
  switch (agent.harness) {
    case 'mock':
      return new MockAgentImpl(agent.config)
    case 'omp':
      return new OmpRpcAgentImpl({ ...agent.config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId })
    case 'claude':
      return new ClaudeSdkAgentImpl(agent.config)
    default:
      throw new AppError(400, 'UNKNOWN_HARNESS', `未知 harness: ${agent.harness}`)
  }
}
