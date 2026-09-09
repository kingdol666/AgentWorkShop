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
import { GeminiAgentImpl } from './gemini-agent'
import { CopilotAgentImpl } from './copilot-agent'
import { CursorAgentImpl } from './cursor-agent'
import { CrushAgentImpl } from './crush-agent'
import { GooseAgentImpl } from './goose-agent'
import { QwenAgentImpl } from './qwen-agent'
import { PiAgentImpl } from './pi-agent'
import { HermesAgentImpl } from './hermes-agent'

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
  /** 官网/安装入口(前端「未安装」态跳转用;空 = 无外部页面) */
  homepage: string
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
  steer: true, supervise: true, hitl: true, terminal: false, contextStats: true, compact: true,
}
const geminiCaps: HarnessCapabilities = {
  steer: false, supervise: true, hitl: false, terminal: false, contextStats: true, compact: false,
}
const copilotCaps: HarnessCapabilities = {
  steer: false, supervise: true, hitl: false, terminal: false, contextStats: false, compact: false,
}
const cursorCaps: HarnessCapabilities = {
  steer: false, supervise: true, hitl: false, terminal: false, contextStats: false, compact: false,
}
const crushCaps: HarnessCapabilities = {
  steer: false, supervise: true, hitl: false, terminal: false, contextStats: true, compact: false,
}
const gooseCaps: HarnessCapabilities = {
  steer: false, supervise: true, hitl: false, terminal: false, contextStats: true, compact: false,
}
const qwenCaps: HarnessCapabilities = {
  steer: false, supervise: true, hitl: true, terminal: false, contextStats: false, compact: false,
}
const piCaps: HarnessCapabilities = {
  steer: false, supervise: true, hitl: false, terminal: false, contextStats: true, compact: false,
}
const hermesCaps: HarnessCapabilities = {
  steer: false, supervise: true, hitl: true, terminal: false, contextStats: true, compact: false,
}

/** 实例 config.command 覆盖提取(与各 impl 的 `config.command ?? 缺省` 同规则;空串回缺省) */
const cmdFrom = (config: Record<string, unknown> | undefined): string =>
  typeof config?.command === 'string' && config.command.trim() !== '' ? config.command.trim() : ''

export const HARNESS_REGISTRY: Record<string, HarnessDef> = {
  mock: {
    id: 'mock',
    label: 'mock(测试)',
    description: '进程内模拟引擎:联调/测试,无 LLM 调用',
    homepage: '',
    capabilities: mockCaps,
    probe: { inprocess: true },
    create: (config, agent) => new MockAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  omp: {
    id: 'omp',
    label: 'omp(真实 LLM)',
    description: 'omp 子进程(RPC 模式),默认推荐引擎',
    homepage: 'https://github.com/acidsugarx/oh-my-pi',
    capabilities: ompCaps,
    probe: { command: c => cmdFrom(c) || 'omp' },
    create: (config, agent) => new OmpRpcAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  opencode: {
    id: 'opencode',
    label: 'opencode',
    description: 'OpenCode 引擎(serve 进程 + HTTP/SSE),权限审批走 HITL',
    homepage: 'https://opencode.ai',
    capabilities: opencodeCaps,
    probe: { command: c => cmdFrom(c) || harnessSettings().opencode_command },
    create: (config, agent) => new OpenCodeAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  codex: {
    id: 'codex',
    label: 'codex',
    description: 'OpenAI Codex CLI(app-server JSON-RPC),命令审批走 HITL',
    homepage: 'https://github.com/openai/codex',
    capabilities: codexCaps,
    probe: { command: c => cmdFrom(c) || harnessSettings().codex_command },
    create: (config, agent) => new CodexAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  dsh: {
    id: 'dsh',
    label: 'dsh(DeepSeek)',
    description: 'DeepSeek Harness(ACP 协议);无同轮 steer,审批走 HITL',
    homepage: 'https://github.com/deepseek-ai/DeepSeek-Harness',
    capabilities: dshCaps,
    probe: { command: c => cmdFrom(c) || harnessSettings().dsh_command },
    create: (config, agent) => new DshAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  claude: {
    id: 'claude',
    label: 'claude',
    description: 'Claude Agent SDK(进程内常驻会话),canUseTool 审批走 HITL,支持同轮 steer',
    homepage: 'https://code.claude.com',
    capabilities: claudeCaps,
    probe: { inprocess: true },
    create: (config, agent) => new ClaudeSdkAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  gemini: {
    id: 'gemini',
    label: 'gemini',
    description: 'Google Gemini CLI(stream-json 无头);无同轮 steer/程序化审批,AW 工具走 MCP 白名单',
    homepage: 'https://github.com/google-gemini/gemini-cli',
    capabilities: geminiCaps,
    probe: { command: c => cmdFrom(c) || harnessSettings().gemini_command },
    create: (config, agent) => new GeminiAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  copilot: {
    id: 'copilot',
    label: 'copilot',
    description: 'GitHub Copilot CLI(JSONL 无头);--allow-tool 白名单制(默认仅 AW 桥)',
    homepage: 'https://docs.github.com/en/copilot/how-tos/copilot-cli',
    capabilities: copilotCaps,
    probe: { command: c => cmdFrom(c) || harnessSettings().copilot_command },
    create: (config, agent) => new CopilotAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  cursor: {
    id: 'cursor',
    label: 'cursor',
    description: 'Cursor CLI(stream-json 无头);默认无 --force(文件变更只提案)',
    homepage: 'https://cursor.com/cli',
    capabilities: cursorCaps,
    probe: { command: c => cmdFrom(c) || harnessSettings().cursor_command },
    create: (config, agent) => new CursorAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  crush: {
    id: 'crush',
    label: 'crush',
    description: 'Charm Crush(run 非交互模式);provider 走 crushrc(智谱 openai-compat)',
    homepage: 'https://github.com/charmbracelet/crush',
    capabilities: crushCaps,
    probe: { command: c => cmdFrom(c) || harnessSettings().crush_command },
    create: (config, agent) => new CrushAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  goose: {
    id: 'goose',
    label: 'goose',
    description: 'Block Goose(run stream-json 无头);per-agent 命名会话可 --resume',
    homepage: 'https://blockgoose.io',
    capabilities: gooseCaps,
    probe: { command: c => cmdFrom(c) || harnessSettings().goose_command },
    create: (config, agent) => new GooseAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  qwen: {
    id: 'qwen',
    label: 'qwen',
    description: 'Qwen Code(experimental-acp);工具确认走 HITL,OpenAI 兼容网关鉴权',
    homepage: 'https://github.com/QwenLM/qwen-code',
    capabilities: qwenCaps,
    probe: { command: c => cmdFrom(c) || harnessSettings().qwen_command },
    create: (config, agent) => new QwenAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  pi: {
    id: 'pi',
    label: 'pi',
    description: 'pi coding agent(-p --mode json);AW 工具经扩展注册,自定义 provider 走 models.json',
    homepage: 'https://github.com/badlogic/pi-mono',
    capabilities: piCaps,
    probe: { command: c => cmdFrom(c) || harnessSettings().pi_command },
    create: (config, agent) => new PiAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
  hermes: {
    id: 'hermes',
    label: 'hermes',
    description: 'Hermes Agent(NousResearch,acp 模式);权限确认走 HITL,zai provider 接 GLM',
    homepage: 'https://github.com/NousResearch/hermes-agent',
    capabilities: hermesCaps,
    probe: { command: c => cmdFrom(c) || harnessSettings().hermes_command },
    create: (config, agent) => new HermesAgentImpl({ ...config, agentId: agent.id, name: agent.name, role: agent.role, channelId: agent.channelId, token: agent.token }),
  },
}

export function knownHarnesses(): string[] {
  return Object.keys(HARNESS_REGISTRY)
}

export function isKnownHarness(harness: string): boolean {
  return harness in HARNESS_REGISTRY
}

/** registry 元信息(前端下拉/能力徽标;不含实现) */
export function harnessMetas(): Array<{ id: string, label: string, description: string, capabilities: HarnessCapabilities, homepage: string }> {
  return Object.values(HARNESS_REGISTRY).map(({ id, label, description, capabilities, homepage }) => ({ id, label, description, capabilities, homepage }))
}

/** 按 harness 装配 AgentInterface(未知 harness 抛 UNKNOWN_HARNESS) */
export function createAgentImplByHarness(agent: AgentInfo): AgentInterface {
  const def = HARNESS_REGISTRY[agent.harness]
  if (!def) {
    throw new AppError(400, 'UNKNOWN_HARNESS', `未知 harness: ${agent.harness}(可选 ${knownHarnesses().join('/')})`)
  }
  return def.create(agent.config ?? {}, agent)
}
