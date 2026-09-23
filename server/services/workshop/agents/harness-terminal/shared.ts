/**
 * 模块头 / 会话与 hub 状态类型 / 全局 hub
 * (由 server/services/workshop/agents/harness-terminal.ts 按职责拆出;内容逐行原文搬运)
 */
import type { OmpRpcClient } from '../adapters/omp-rpc-client'
import type { TermFrame, TermSessionMeta, TerminalHitlDialog, TerminalServerMessage } from '../../../../../shared/terminal-protocol'
import { createLogger } from '../../logger'

/**
 * Harness 终端 Hub —— omp 子进程的原生会话流镜像 + Human-in-the-loop 控制。
 *
 * 每个 omp(`--mode rpc-ui`)子进程在 ensureClient 时挂一个原始帧 tap
 * (OmpRpcClient.onRawFrame):全部 JSONL 帧(会话事件 / host_tool_call /
 * extension_ui_request)经净化后写入 per-pid 环形缓冲,并微批广播给 WS 订阅者
 * (前端 xterm TUI 渲染)。反向通道:WS 输入 → steer/follow_up 注入会话;
 * abort 中止回合;ui_response 应答 HITL 对话框(extension_ui_response)。
 *
 * HITL 语义:extension_ui_request(select/confirm/input/editor)到达时
 *  - 有 WS 订阅者(有人在看终端)→ 等待人类应答,无超时(真 HITL);
 *  - 无订阅者 → park 至 hitl-registry 并启动倒计时(security.hitl_timeout_ms,
 *    默认 180s;倒计时仅在零订阅期间进行,任一客户端接入终端即暂停)——
 *    到期自动 cancelled(等价 TUI 按 Esc;agent 的 ask 回合中止),并落一条
 *    notice 帧让事后接入的观众可见。TTL 配 0 恢复旧的"无人即秒取消"行为。
 *    待办全局可见性/应答路由由 hitl-registry + /api/workshop/hitl/* 承接。
 *
 * 定位:模块级单例(globalThis 跨 HMR 存活,与 workshop ws hub 同风格);
 * omp-agent 装配时 attach,manager 监控层读取 hasTerminalSession 标记进程行。
 */

export const log = createLogger('workshop.harness-terminal')

/**
 * 会话 meta:本 hub 只接纳已完成身份绑定的 harness 进程(attachTerminalTap 的入参全为非空字符串),
 * 故内部用比协议层更窄的类型 —— TermSessionMeta 允许 null 是为了容忍"未绑定进程"的通用视图,
 * 而此处消费方(hitl-registry.register 要求 agentId: string)不必被迫处理不存在的 null。
 * 纯类型收窄:任何写入本字段的值本来就只有 attachTerminalTap 一处,且其中无 null。
 */
export type BoundSessionMeta = Omit<TermSessionMeta, 'agentId' | 'channelId' | 'name' | 'role'> & {
  agentId: string
  channelId: string
  name: string
  role: 'lead' | 'worker'
}

/** 终端会话(一个 pid 一份;进程退出后保留缓冲供事后查看) */
export interface TerminalSession {
  meta: BoundSessionMeta
  client: OmpRpcClient
  seq: number
  ring: TermFrame[]
  /** WS 订阅者(收到微批后的 term.frames / term.state / term.notice) */
  listeners: Set<(msg: TerminalServerMessage) => void>
  /** 回合状态(agent_start..agent_end 终态) */
  running: boolean
  /** 流式状态(当前回合是否正在输出 —— steer 生效窗口) */
  streaming: boolean
  alive: boolean
  exitCode: number | null
  pendingHitl: TerminalHitlDialog | null
  /** 零订阅 park 倒计时(有人接入即清除;到期自动取消待答对话框) */
  parkTimer: NodeJS.Timeout | null
  unsubRaw: (() => void) | null
  /** 微批缓冲 + 定时器(50ms 合并 delta 帧,防 WS 洪泛) */
  batch: TermFrame[]
  batchTimer: ReturnType<typeof setTimeout> | null
}

export interface HubState {
  sessions: Map<number, TerminalSession>
}
export const hubGlobal = globalThis as typeof globalThis & { __harnessTerminalHub?: HubState }
export const hub: HubState = hubGlobal.__harnessTerminalHub
  ?? (hubGlobal.__harnessTerminalHub = { sessions: new Map() })
export const sessions = hub.sessions
