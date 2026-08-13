/**
 * 游戏后端事件驱动框架 — 协议类型中枢
 *
 * 职责划分:
 *  - wire 线协议类型(Dir/AgentMode/ClientToServer/ServerToClient/payloads):单一事实来源在
 *    `#shared/game-protocol`(由 JSON 派生 + CMDParser 校验),本文件 re-export 以兼容既有引用。
 *  - 服务端内部决策类型(AgentContext/AgentAction/BrainEvent/AgentBrain)与地图常量:定义于此,
 *    不上线,仅供 GameSession / AgentBrain 消费。
 *
 * 协议原则:
 *  - 下行(server → client)为"指令",前端只执行不决策
 *  - 上行(client → server)为"事实上报",后端只感知不控制玩家(本轮)
 *  - 对话状态机权威在后端,打字机动画在前端
 */
import type { AgentMode, Dir } from '../../shared/game-protocol'
// ---------------------------------------------------------------- wire 协议类型(re-export,权威在 shared)
export type {
  AgentFacePayload,
  AgentMode,
  AgentMovePayload,
  AgentSayPayload,
  AgentStatePayload,
  ClientToServer,
  DialogOpenPayload,
  Dir,
  ServerToClient,
} from '../../shared/game-protocol'

// ---------------------------------------------------------------- 地图常量(与 tuxemon-town.json 对齐)

/** 地图尺寸(tile) */
export const GAME_MAP = {
  width: 40,
  height: 40,
  tile: 32,
} as const

/** Agent 出生点(tile 22,20 → 像素中心) */
export const AGENT_SPAWN = { x: 720, y: 656 } as const

/** 玩家位置上报节流(ms) */
export const PLAYER_POS_THROTTLE = 250

// ---------------------------------------------------------------- Agent 决策接口(服务端内部,不上线)

/** 决策上下文:Agent 每 tick 看到的世界快照 */
export interface AgentContext {
  tick: number
  now: number
  agent: { x: number, y: number, dir: Dir, mode: AgentMode }
  player: { x: number, y: number, lastSeenAt: number | null, distance: number }
  rng: () => number
}

/** 决策产出:一个动作经会话层映射为一条(或一组)下行指令 */
export type AgentAction
  = | { kind: 'state', mode: AgentMode, speed: number }
    | { kind: 'move', dir: Dir, durationMs: number }
    | { kind: 'face', dir: Dir }
    | { kind: 'say', text: string, ttlMs: number }
    | { kind: 'dialog', lines: string[] }
    | { kind: 'dialog.close' }
    | { kind: 'wait', ms: number }

/** 会话层异步事件(Agent 需要感知的世界变化) */
export type BrainEvent = { kind: 'dialog.closed' }

/**
 * Agent 大脑抽象:替换为 LLM / Agent SDK 时只换实现
 *
 * think 支持同步与异步(Promise)返回:
 *  - 同步:脚本化 Agent(如 ScriptBrain),20Hz tick 内即时决策
 *  - 异步:Agent harness SDK(如 Claude Code SDK)决策有网络/推理延迟,
 *    会话层以 thinking 守卫避免并发重叠,决议到达后统一应用
 *
 * 决策驱动方式:
 *  - 时间驱动:ctx.now 即世界时钟,Agent 自行推算动作结束时刻
 *    (如 move 500ms 后自行产出下一动作,无需回调)
 *  - 事件驱动:onEvent 接收会话层异步事件(对话关闭等)
 *
 * MCP/工具驱动(并行接缝):
 *  - 真实 Agent harness 经 MCP 调用 agentCallable 工具 → session.execDownlink(name, payload)
 *    → CMDParser 校验 → emit → 前端渲染。此路径不经过 think,适合请求/响应式 Agent。
 */
export interface AgentBrain {
  readonly name: string
  think(ctx: AgentContext): AgentAction[] | Promise<AgentAction[]>
  /** 会话层事件通知(可选实现) */
  onEvent?(e: BrainEvent): void
}
