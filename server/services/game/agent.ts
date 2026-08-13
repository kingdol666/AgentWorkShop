/**
 * Agent 大脑抽象 + 模拟 Agent(ScriptBrain)
 *
 * AgentBrain 接口是后端与"Agent harness SDK"(如 Claude Code SDK)的接缝:
 *  - think(ctx): 每个 tick 决策,产出动作(即下行指令)
 *  - onEvent(e): 会话层异步事件通知(如对话关闭)
 * 后续接入真实 Agent 时仅需实现同一接口,替换 scriptBrain 实例。
 */
import type { AgentAction, AgentBrain, AgentContext, AgentMode, BrainEvent, Dir } from '../../types/game'

/** 与地图网格对齐的方向向量 */
const DIR_VEC: Record<Dir, { dx: number, dy: number }> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
}
const ALL_DIRS = Object.keys(DIR_VEC) as Dir[]

/** 到达判定阈值(px) */
const APPROACH_RADIUS = 6 * 32 // 玩家 6 tiles 内 -> 迎上去
const TALK_RADIUS = 3 * 32 // 玩家 3 tiles 内 -> 搭话
/** 对话台词(占位,后续由真实 Agent 生成) */
const TALK_LINES = [
  '你好呀,我是图克斯镇的精灵向导!',
  '这片草地上藏着不少金币,朝发光的地方走就能找到。',
  '听说镇子东边的湖泊最近很热闹,去看看吧!',
]
const WANDER_SAYS = ['啾?', '今天天气真好~', '那边好像有什么东西…']

/** Agent 默认速度(px/s,与 session 初始 agent.state 一致) */
export const AGENT_SPEED = 120

interface WalkPlan {
  dir: Dir
  until: number
}

/**
 * 模拟 Agent:有限状态机 idle → wander → approach → talk → wait
 * 行为为占位演示,集中于此文件,便于整体替换。
 */
export class ScriptBrain implements AgentBrain {
  readonly name = 'script-demo'

  private mode: AgentMode = 'idle'
  private dir: Dir = 'down'
  private walk: WalkPlan | null = null
  private waitUntil = 0
  private talkStarted = false
  private sayCooldownUntil = 0

  think(ctx: AgentContext): AgentAction[] {
    const actions: AgentAction[] = []
    const { player, now } = ctx
    const dist = player.lastSeenAt === null ? Infinity : player.distance
    const seesPlayer = player.lastSeenAt !== null && dist < APPROACH_RADIUS

    // ---- 对话中:Agent 静止,等会话层推进 ----
    if (this.mode === 'talk') {
      return this.facePlayer(actions, ctx)
    }

    // ---- 等待(对话结束后冷却;时长由 ctx.now 驱动,便于测试与回放) ----
    if (this.mode === 'wait') {
      if (this.waitUntil === 0) {
        this.waitUntil = now + 4000
        actions.push({ kind: 'state', mode: 'wait', speed: AGENT_SPEED })
      }
      else if (now >= this.waitUntil) {
        this.waitUntil = 0
        actions.push({ kind: 'state', mode: 'wander', speed: AGENT_SPEED })
        this.mode = 'wander'
      }
      return actions
    }

    // ---- 追逐玩家(保持 2 tiles 距离,不顶撞玩家) ----
    if (seesPlayer && dist > TALK_RADIUS) {
      if (this.mode !== 'approach') {
        actions.push({ kind: 'state', mode: 'approach', speed: AGENT_SPEED })
        this.mode = 'approach'
      }
      if (dist < 2 * 32) {
        // 已贴近:停下等待玩家主动靠近,避免把玩家挤向墙角
        this.walk = null
        return this.facePlayer(actions, ctx)
      }
      const dir = dirToTarget(ctx.agent, player)
      actions.push({ kind: 'move', dir, durationMs: 500 })
      this.walk = { dir, until: now + 500 }
      this.dir = dir
      return actions
    }

    // ---- 玩家贴脸:发起对话 ----
    if (seesPlayer && dist <= TALK_RADIUS && !this.talkStarted) {
      this.talkStarted = true
      this.mode = 'talk'
      this.walk = null
      return [
        ...this.facePlayer(actions, ctx),
        { kind: 'dialog', lines: [...TALK_LINES] },
      ]
    }
    // 玩家离开视线但曾见过:重置,避免对话死锁
    if (!seesPlayer) {
      this.talkStarted = false
    }

    // ---- 游荡(含说闲话) ----
    if (this.mode !== 'wander') {
      actions.push({ kind: 'state', mode: 'wander', speed: AGENT_SPEED })
      this.mode = 'wander'
    }
    if (now >= this.sayCooldownUntil && ctx.rng() < 0.2) {
      this.sayCooldownUntil = now + 6000
      const texts = WANDER_SAYS
      actions.push({
        kind: 'say',
        text: texts[Math.floor(ctx.rng() * texts.length)] ?? '…',
        ttlMs: 2200,
      })
    }
    const wander = this.wanderAction(ctx)
    actions.push(wander)
    return actions
  }

  /** 会话层事件 */
  onEvent(e: BrainEvent): void {
    if (e.kind === 'dialog.closed') {
      this.talkStarted = false
      this.mode = 'wait'
      this.waitUntil = 0 // 下一个 think 用 ctx.now 计算冷却
    }
  }

  // ---------------- 内部 ----------------

  private facePlayer(actions: AgentAction[], ctx: AgentContext): AgentAction[] {
    const d = dirToTarget(ctx.agent, ctx.player)
    if (d !== this.dir) {
      this.dir = d
      actions.push({ kind: 'face', dir: d })
    }
    return actions
  }

  /** 游荡:当前走完则随机新方向走 1~3 tiles */
  private wanderAction(ctx: AgentContext): AgentAction {
    if (this.walk && ctx.now < this.walk.until) {
      return { kind: 'move', dir: this.walk.dir, durationMs: Math.max(0, this.walk.until - ctx.now) }
    }
    const pick = (): Dir => ALL_DIRS[Math.floor(ctx.rng() * ALL_DIRS.length)] ?? 'down'
    const edge = 2 * 32 // 距地图边缘 2 tiles 内调头
    const margin = 1280 - edge
    let dir = pick()
    const v = DIR_VEC[dir]
    if ((ctx.agent.x < edge && v.dx < 0) || (ctx.agent.x > margin && v.dx > 0)
      || (ctx.agent.y < edge && v.dy < 0) || (ctx.agent.y > margin && v.dy > 0)) {
      dir = pick()
    }
    const tiles = 1 + Math.floor(ctx.rng() * 3)
    const durationMs = (tiles * 32 / AGENT_SPEED) * 1000
    this.walk = { dir, until: ctx.now + durationMs }
    this.dir = dir
    return { kind: 'move', dir, durationMs }
  }
}

/** 由 Agent 位置到目标位置的 4 方向(横向优先,与玩家习惯一致) */
function dirToTarget(from: { x: number, y: number }, to: { x: number, y: number }): Dir {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? 'right' : 'left'
  }
  return dy >= 0 ? 'down' : 'up'
}

/**
 * 模拟 Agent SDK 大脑:走与真实 SDK 一致的异步决策路径
 *
 * 每个 think 模拟 SDK 推理延迟后,委托 ScriptBrain 决策。
 * 行为与 ScriptBrain 一致,但决议经 Promise 到达——用于验证
 * 会话层异步守卫与决议应用逻辑,以及演示 SDK 接缝的用法
 * (GAME_BRAIN=sdk-mock)。
 */
export class MockSdkBrain implements AgentBrain {
  readonly name = 'sdk-mock'

  private readonly inner = new ScriptBrain()

  /** 模拟推理延迟区间 [min, max] ms;测试可传 [0, 0] 消除等待 */
  constructor(private readonly latencyMs: readonly [number, number] = [250, 750]) {}

  async think(ctx: AgentContext): Promise<AgentAction[]> {
    const [min, max] = this.latencyMs
    const ms = min + Math.floor(ctx.rng() * Math.max(0, max - min))
    const { promise, resolve } = Promise.withResolvers<undefined>()
    setTimeout(resolve, ms)
    await promise
    return this.inner.think(ctx)
  }

  onEvent(e: BrainEvent): void {
    this.inner.onEvent?.(e)
  }
}

/**
 * Agent 大脑工厂 — 单一注入点(GameSession 构造默认值)
 *
 * 选择规则(GAME_BRAIN 环境变量):
 *  - script(默认): 确定性脚本演示 Agent
 *  - sdk-mock:     异步路径模拟 Agent SDK
 *
 * 后续接入真实 Agent harness SDK 时:新增实现 + 在此注册,如
 *  - claude:       Claude Code SDK Agent(由 SDK 生成动作)
 * 会话层与协议无需任何改动。
 */
export function createBrain(kind?: string): AgentBrain {
  const brainKind = kind ?? process.env.GAME_BRAIN ?? 'script'
  switch (brainKind) {
    case 'sdk-mock':
      return new MockSdkBrain()
    case 'script':
      return new ScriptBrain()
    default:
      console.warn(`[game] unknown GAME_BRAIN "${brainKind}", fallback to script`)
      return new ScriptBrain()
  }
}
