/**
 * GameSession — 后端游戏会话(单例,单房间)
 *
 * 职责:
 *  - 持有世界状态:玩家快照(感知用)、Agent 状态、对话状态
 *  - tick(20Hz):装配 AgentContext → brain.think → 动作映射为下行指令 → emit → 广播
 *  - 处理上行输入:玩家移动/交互/位置上报
 *  - 指令合并:移动/朝向在未变化时不重复下发,避免高频刷屏
 *  - execDownlink:MCP/Agent 工具调用入口,与 brain 决议共用 emit 路径
 *
 * 权威边界(本轮):后端不控制玩家,仅感知;Agent 完全由后端驱动。
 * 所有下行指令统一经 emit() 出口 → CMDParser 在消息边界已校验线格式。
 */
import { CMDParser, PROTOCOL, type ParseResult } from '../../../shared/game-protocol'
import {
  AGENT_SPAWN,
  type AgentAction,
  type AgentBrain,
  type AgentMode,
  type ClientToServer,
  type Dir,
  type ServerToClient,
} from '../../types/game'
import { AGENT_SPEED, createBrain } from './agent'

const TICK_MS = 50 // 20Hz

/**
 * 最小 WebSocket peer 接口(h3 2.x 未 re-export crossws 类型,duck typing)
 * 与 defineWebSocketHandler 回调参数运行时兼容
 */
interface WsPeer {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

/** 玩家感知状态(后端不控制,只记录) */
interface PlayerSnapshot {
  dx: -1 | 0 | 1
  dy: -1 | 0 | 1
  x: number
  y: number
  tileX: number
  tileY: number
  lastSeenAt: number | null
}

/** 对话状态(权威在后端) */
interface DialogState {
  active: boolean
  lines: string[]
  index: number
}

export class GameSession {
  private peer: WsPeer | null = null
  private brain: AgentBrain
  private tickNo = 0
  private timer: NodeJS.Timeout | null = null
  /** brain 暂停:Agent 直驱(execDownlink)接管时,自主 brain tick 跳过 */
  private brainPaused = false
  /** 异步 brain 决议挂起中:tick 跳过,避免并发重叠 */
  private thinking = false

  /** brain 注入点:默认由 GAME_BRAIN 环境变量决定(script | sdk-mock) */
  constructor(brain: AgentBrain = createBrain()) {
    this.brain = brain
  }

  private player: PlayerSnapshot = {
    dx: 0, dy: 0,
    x: 0, y: 0, tileX: 0, tileY: 0,
    lastSeenAt: null,
  }

  private agent: { x: number, y: number, dir: Dir, mode: AgentMode } = {
    x: AGENT_SPAWN.x,
    y: AGENT_SPAWN.y,
    dir: 'down',
    mode: 'idle',
  }

  private dialog: DialogState = { active: false, lines: [], index: 0 }
  // 指令合并缓存:移动/朝向未变化不重复下发
  private lastMove: { dir: Dir, expiresAt: number } | null = null
  private lastFace: Dir | null = null

  // ---------------- 连接管理 ----------------

  connect(peer: WsPeer): void {
    this.peer = peer
    this.emit({ type: 'session.ready', payload: { agentName: this.brain.name, spawn: { ...AGENT_SPAWN } } })
    this.emit({ type: 'agent.state', payload: { mode: this.agent.mode, speed: AGENT_SPEED } })
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), TICK_MS)
    }
  }

  disconnect(): void {
    this.peer = null
    // 玩家断开:重置感知与对话,Agent 继续独立运行
    this.player = { dx: 0, dy: 0, x: 0, y: 0, tileX: 0, tileY: 0, lastSeenAt: null }
    if (this.dialog.active) {
      this.dialog.active = false
      this.brain.onEvent?.({ kind: 'dialog.closed' })
    }
  }

  /** 处理上行消息(已在 ws.ts 经 CMDParser 校验) */
  handleInput(msg: ClientToServer): void {
    switch (msg.type) {
      case 'session.join':
        // 重置对话状态(重连后以服务端为准)
        if (this.dialog.active) {
          this.emit({ type: 'dialog.close', payload: {} })
        }
        break
      case 'input.move':
        this.player.dx = msg.payload.dx
        this.player.dy = msg.payload.dy
        break
      case 'player.pos':
        this.player.x = msg.payload.x
        this.player.y = msg.payload.y
        this.player.tileX = msg.payload.tileX
        this.player.tileY = msg.payload.tileY
        this.player.lastSeenAt = Date.now()
        break
      case 'agent.pos':
        // 渲染层事实上报:客户端物理是移动执行的真相,大脑据此计算真实距离
        this.agent.x = msg.payload.x
        this.agent.y = msg.payload.y
        break
      case 'input.interact':
        this.handleInteract()
        break
    }
  }

  /** 玩家交互:对话推进(权威在后端) */
  private handleInteract(): void {
    if (!this.dialog.active) {
      return
    }
    this.dialog.index += 1
    if (this.dialog.index >= this.dialog.lines.length) {
      // emit 统一处理:清对话态 + 通知 brain + 下发 dialog.close
      this.emit({ type: 'dialog.close', payload: {} })
      return
    }
    this.emit({ type: 'dialog.advance', payload: {} })
  }

  // ---------------- 主循环 ----------------

  private tick(): void {
    // brain 暂停(Agent 直驱接管):跳过自主决策,只保留 execDownlink 注入路径
    if (this.brainPaused) {
      return
    }
    // 异步 brain 决议挂起中:跳过本 tick,等待 Promise 落地
    if (this.thinking) {
      return
    }
    this.tickNo += 1
    const now = Date.now()
    const ctx = {
      tick: this.tickNo,
      now,
      agent: { ...this.agent },
      player: {
        x: this.player.x,
        y: this.player.y,
        lastSeenAt: this.player.lastSeenAt,
        distance: this.player.lastSeenAt === null
          ? Infinity
          : Math.hypot(this.player.x - this.agent.x, this.player.y - this.agent.y),
      },
      rng: Math.random,
    }
    const actions = this.brain.think(ctx)
    if (actions instanceof Promise) {
      this.thinking = true
      actions
        .then((resolved) => {
          this.thinking = false
          for (const action of resolved) {
            this.applyAction(action)
          }
        })
        .catch((err) => {
          this.thinking = false
          console.error('[game] brain.think rejected:', err)
        })
      return
    }
    for (const action of actions) {
      this.applyAction(action)
    }
  }

  /** brain 动作 → 下行指令映射,再经 emit 唯一出口下发(带合并) */
  private applyAction(action: AgentAction): void {
    const cmd = this.actionToCommand(action)
    if (cmd) {
      this.emit(cmd)
    }
  }

  /** AgentAction(内部决策语义)→ ServerToClient(线协议),wait 不产生指令 */
  private actionToCommand(action: AgentAction): ServerToClient | null {
    switch (action.kind) {
      case 'state':
        return { type: 'agent.state', payload: { mode: action.mode, speed: action.speed } }
      case 'move':
        return { type: 'agent.move', payload: { dir: action.dir, durationMs: action.durationMs } }
      case 'face':
        return { type: 'agent.face', payload: { dir: action.dir } }
      case 'say':
        return { type: 'agent.say', payload: { text: action.text, ttlMs: action.ttlMs } }
      case 'dialog':
        return { type: 'dialog.open', payload: { agentName: this.brain.name, lines: action.lines } }
      case 'dialog.close':
        return { type: 'dialog.close', payload: {} }
      case 'wait':
        return null
    }
  }

  /**
   * 下行指令唯一权威出口:统一执行状态簿记、指令合并与发送。
   *  - brain 决议(tick)与 MCP 工具调用(execDownlink)均经此路径
   *  - 移动/朝向合并:同向未到期或同朝向不重复下发
   *  - 对话开/关在此维护权威对话态
   */
  private emit(cmd: ServerToClient): void {
    switch (cmd.type) {
      case 'agent.state':
        this.agent.mode = cmd.payload.mode
        this.send(cmd)
        break
      case 'agent.move': {
        const now = Date.now()
        // 合并:同向且未到期 → 不重复下发
        if (this.lastMove && this.lastMove.dir === cmd.payload.dir && this.lastMove.expiresAt > now) {
          return
        }
        this.lastMove = { dir: cmd.payload.dir, expiresAt: now + cmd.payload.durationMs }
        this.agent.dir = cmd.payload.dir
        this.send(cmd)
        break
      }
      case 'agent.face':
        if (this.lastFace === cmd.payload.dir) {
          return
        }
        this.lastFace = cmd.payload.dir
        this.agent.dir = cmd.payload.dir
        this.send(cmd)
        break
      case 'dialog.open':
        this.dialog = { active: true, lines: cmd.payload.lines, index: 0 }
        this.send(cmd)
        break
      case 'dialog.close':
        // 对话关闭:始终下发到客户端(权威指令,Agent 主动关闭必须生效);
        // 仅本地账记与 brain 事件做幂等(未在对话中则不重复通知 brain)
        if (this.dialog.active) {
          this.dialog.active = false
          this.brain.onEvent?.({ kind: 'dialog.closed' })
        }
        this.send(cmd)
        break
      // session.ready / dialog.advance / error / agent.say:无状态副作用,直接下发
      default:
        this.send(cmd)
    }
  }

  /**
   * MCP / Agent 工具调用入口(sendmsg 接缝)。
   * 真实 Agent harness(omp / Claude Code)经 MCP 调用 agentCallable 工具 → 此方法
   * 经 CMDParser 权威校验后注入下行指令,走与 brain 决议同一的 emit 路径 → 前端实时渲染。
   * 仅 downlink 中 agentCallable=true 的指令允许调用(会话生命周期指令除外)。
   */
  execDownlink(type: string, payload: unknown): ParseResult<ServerToClient> {
    const res = CMDParser.parseDownlink({ type, payload })
    if (!res.ok) {
      return res
    }
    if (PROTOCOL.downlink[type]?.agentCallable !== true) {
      return { ok: false, error: { code: 'FORBIDDEN', message: `"${type}" 不是 Agent 可调用指令` } }
    }
    this.emit(res.value)
    return res
  }

  /**
   * 暂停自主 brain tick — Agent harness 经 execDownlink 接管控制权时调用。
   * 暂停期间仅 execDownlink 注入路径生效,自主决策(游荡/追逐/自发对话)停止。
   */
  pauseBrain(): void {
    this.brainPaused = true
  }

  /** 恢复自主 brain tick(Agent 释放控制权) */
  resumeBrain(): void {
    this.brainPaused = false
  }

  /** 停止主循环(测试与 brain 热替换用);再次 connect 会重启 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private send(cmd: ServerToClient): void {
    if (!this.peer) {
      return
    }
    try {
      this.peer.send(JSON.stringify(cmd))
    }
    catch {
      // 连接可能已断开,交由 close 事件清理
    }
  }
}

/** 全局单例(单房间 demo;多房间扩展点:Map<roomId, GameSession>) */
export const gameSession = new GameSession()
