/**
 * Harness Registry —— 执行引擎注册表(单一事实源)。
 *
 * harness 的全部派生点从此处取:factory 装配、manager 白名单校验、
 * GET /api/workshop/harnesses(前端下拉/能力徽标)。新增引擎 = 注册一项 + 实现一个
 * AgentInterface,上层与前端零改动(下拉动态拉取)。
 */
import { AppError } from '../../../utils/errors'
import type { AgentInfo, AgentInterface } from './agent-interface'
import { harnessSettings } from '../settings'
import { MockAgentImpl } from './mock-agent'
import { OmpRpcAgentImpl } from './omp-agent'
import { ClaudeSdkAgentImpl } from './claude-agent'
import { OpenCodeAgentImpl } from './opencode-agent'
import { CodexAgentImpl } from './codex-agent'
import { DshAgentImpl } from './dsh-agent'

/** 引擎能力面(如实声明;前端徽标与上层降级依据) */
export interface HarnessCapabilities {
  /** 同轮 steer 注入(false = 恒 deferred,消息走信箱) */
  steer: boolean
  /** lead 调度回合(prompt 驱动,全引擎可实现) */
  supervise: boolean
  /** 程序化 HITL(权限/审批可经 API 应答) */
  hitl: boolean
  /** /monitor 原始终端镜像 */
  terminal: boolean
  /** 上下文用量快照(getContextStats) */
  contextStats: boolean
  /** 平台可主动触发压缩(onTurnSettled 门控) */
  compact: boolean
}

export interface HarnessDef {
  id: string
  label: string
  description: string
  capabilities: HarnessCapabilities
  create(config: Record<string, unknown>, agent: AgentInfo): AgentInterface
  /** 可用性探测面(harness-availability.ts 消费;缺省 = 进程内引擎,恒可用) */
  probe?: HarnessProbe
}

/** 引擎环境探测声明:进程内引擎无外部依赖;进程型引擎声明将拉起的命令(与真实 spawn 同源) */
export interface HarnessProbe {
  /** 进程内引擎(mock/claude SDK 骨架):无外部 CLI,恒可用 */
  inprocess?: boolean
  /** 解析将拉起的可执行命令(实例 config.command 覆盖 → 运行时设置缺省 → 内置默认) */
  command?: (config?: Record<string, unknown>) => string
}

const mockCaps: HarnessCapabilities = {
  steer: true, supervise: false, hitl: false, terminal: false, contextStats: false, compact: false,
}
const ompCaps: HarnessCapabilities = {
  steer: true, supervise: true, hitl: true, terminal: true, contextStats: true, compact: true,
}
const opencodeCaps: HarnessCapabilities = {
  steer: true, supervise: true, hitl: true, terminal: false, contextStats: true, compact: true,
}
const codexCaps: HarnessCapabilities = {
  steer: true, supervise: true, hitl: true, terminal: false, contextStats: true, compact: true,
}
const dshCaps: HarnessCapabilities = {
  steer: false, supervise: true, hitl: true, terminal: false, contextStats: true, compact: false,
}
const claudeCaps: HarnessCapabilities = {
  steer: false, supervise: false, hitl: false, terminal: false, contextStats: false, compact: false,
}

/** 实例 config.command 覆盖提取(与各 impl 的 `config.command ?? 缺省` 同规则;空串回缺省) */
const cmdFrom = (config: Record<string, unknown> | undefined): string =>
  typeof config?.command === 'string' && config.command.trim() !== '' ? config.command.trim() : ''

export const HARNESS_REGISTRY: Record<string, HarnessDef> = {
  mock: {
    id: 'mock',
    label: 'mock(测试)',
    description: '进程内模拟引擎:联调/测试,无 LLM 调用',
    capabilities: mockCaps,
    probe: { inprocess: true },
    create: (config, agent) => new MockAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  omp: {
    id: 'omp',
    label: 'omp(真实 LLM)',
    description: 'omp 子进程(RPC 模式),默认推荐引擎',
    capabilities: ompCaps,
    probe: { command: c => cmdFrom(c) || 'omp' },
    create: (config, agent) => new OmpRpcAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  opencode: {
    id: 'opencode',
    label: 'opencode',
    description: 'OpenCode 引擎(serve 进程 + HTTP/SSE),权限审批走 HITL',
    capabilities: opencodeCaps,
    probe: { command: c => cmdFrom(c) || harnessSettings().opencode_command },
    create: (config, agent) => new OpenCodeAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  codex: {
    id: 'codex',
    label: 'codex',
    description: 'OpenAI Codex CLI(app-server JSON-RPC),命令审批走 HITL',
    capabilities: codexCaps,
    probe: { command: c => cmdFrom(c) || harnessSettings().codex_command },
    create: (config, agent) => new CodexAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  dsh: {
    id: 'dsh',
    label: 'dsh(DeepSeek)',
    description: 'DeepSeek Harness(ACP 协议);无同轮 steer,审批走 HITL',
    capabilities: dshCaps,
    probe: { command: c => cmdFrom(c) || harnessSettings().dsh_command },
    create: (config, agent) => new DshAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  claude: {
    id: 'claude',
    label: 'claude',
    description: 'Claude Agent SDK(骨架,待接入)',
    capabilities: claudeCaps,
    probe: { inprocess: true },
    create: config => new ClaudeSdkAgentImpl(config),
  },
}

export function knownHarnesses(): string[] {
  return Object.keys(HARNESS_REGISTRY)
}

export function isKnownHarness(harness: string): boolean {
  return harness in HARNESS_REGISTRY
}

/** registry 元信息(前端下拉/能力徽标;不含实现) */
export function harnessMetas(): Array<{ id: string, label: string, description: string, capabilities: HarnessCapabilities }> {
  return Object.values(HARNESS_REGISTRY).map(({ id, label, description, capabilities }) => ({ id, label, description, capabilities }))
}

/** 按 harness 装配 AgentInterface(未知 harness 抛 UNKNOWN_HARNESS) */
export function createAgentImplByHarness(agent: AgentInfo): AgentInterface {
  const def = HARNESS_REGISTRY[agent.harness]
  if (!def) {
    throw new AppError(400, 'UNKNOWN_HARNESS', `未知 harness: ${agent.harness}(可选 ${knownHarnesses().join('/')})`)
  }
  return def.create(agent.config ?? {}, agent)
}
