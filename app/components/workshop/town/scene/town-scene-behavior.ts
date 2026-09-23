/**
 * AgentTeam RPG 小镇(2D Phaser 表现层)— 行为状态机(事件→决策→动作;标准 AI 控制游戏架构)。
 *
 * 自 TownScene.ts 抽出:只通过宿主契约(TownBehaviorHost)触达场景成员;
 * 气泡能力复用 TownBubbleHost(见 town-scene-bubbles.ts)。
 */
import type * as Phaser from 'phaser'
import { stepToward, type ActionContext, type ActionKind } from '#shared/town-behavior'
import { AGENT_SPEED, WAIT_MS, type AgentSprite } from './town-scene-core'
import { showBubble, type TownBubbleHost } from './town-scene-bubbles'

/** 行为状态机宿主(仅声明本模块触达的场景成员;气泡/领地/时间见 TownBubbleHost) */
export interface TownBehaviorHost extends TownBubbleHost {
  /** 已注册动画(playSheetAnim 查 idle/walk/work) */
  readonly anims: Phaser.Animations.AnimationManager
}

// 行为状态机(事件→决策→动作;标准 AI 控制游戏架构)

/** 触发一次「跑去下发」行为:from 跑到 to 身边 */
export function startBehavior(host: TownBehaviorHost, action: ActionContext): void {
  const from = host.agents.get(action.fromId)
  const to = host.agents.get(action.toId)
  if (!from || !to) {
    // 目标 agent 尚未出现在镇上(可能跨块懒装配中):忽略,等实体到达
    return
  }
  // 用户正在拖动的角色不被打断
  if (from.dragging) return
  const b = from.behavior
  b.mode = 'approach'
  b.targetId = to.agentId
  b.action = action
  // 邀请接收方驻足配合(暂停其游走,双方才能对上话;不再互相追逐)
  if (!to.dragging) {
    to.behavior.engaged = true
    to.behavior.roamTarget = null
    ;(to.sprite.body as Phaser.Physics.Arcade.Body).stop()
  }
  if (from.sprite.body) (from.sprite.body as Phaser.Physics.Arcade.Body).stop()
  host.emit('behavior', {
    agentName: from.name,
    action: behaviorActionLabel(host, action.kind),
    targetName: to.name,
  })
}

export function behaviorActionLabel(host: TownBehaviorHost, kind: ActionKind): string {
  return kind === 'task' ? '下发任务' : kind === 'reply' ? '回复' : '发送消息'
}

/**
 * 行为状态机逐帧执行(由 update 调用)。
 * 状态流转:approach(跑到下发对象)→ 到达 → 送达 → wait[需回复]/returnHome[否]→ roam。
 */
export function runBehavior(host: TownBehaviorHost, asp: AgentSprite, dt: number): void {
  const b = asp.behavior

  // ---------- roam:领地内来回移动(idle 时的默认行为;被邀请时驻足配合) ----------
  if (b.mode === 'idle' || b.mode === 'roam') {
    if (asp.behavior.engaged || asp.dragging) {
      stopAt(host, asp)
      return
    }
    b.mode = 'roam'
    if (!b.roamTarget) {
      const def = host.blocks.get(asp.channelId)
      const range = def?.radius ? def.radius * 0.5 : 80
      b.roamTarget = {
        x: asp.homeX + (Math.random() * 2 - 1) * range,
        y: asp.homeY + (Math.random() * 2 - 1) * range * 0.6,
      }
    }
    const ok = driveToward(host, asp, b.roamTarget, AGENT_SPEED * 0.5, dt)
    if (ok) b.roamTarget = null
    return
  }

  // ---------- approach:跑向下发对象 ----------
  if (b.mode === 'approach') {
    const target = b.targetId ? host.agents.get(b.targetId) : undefined
    if (!target) {
      stopAt(host, asp)
      b.mode = 'idle'
      return
    }
    const pos = { x: target.sprite.x, y: target.sprite.y }
    const arrived = driveToward(host, asp, pos, AGENT_SPEED, dt)
    if (arrived) {
      stopAt(host, asp)
      behaviorDeliver(host, asp, target)
      if (b.action?.requireReply) {
        b.mode = 'wait'
        b.waitUntil = host.time.now + WAIT_MS
      }
      else {
        b.mode = 'returnHome'
        releaseEngaged(host, asp)
        b.targetId = null
      }
    }
    return
  }

  // ---------- wait:在目标附近等待回复/执行结果 ----------
  if (b.mode === 'wait') {
    if (asp.dragging) {
      stopAt(host, asp)
      return
    }
    const target = b.targetId ? host.agents.get(b.targetId) : undefined
    if (target && !target.dragging) {
      const stand = { x: target.sprite.x + 28, y: target.sprite.y + 8 }
      driveToward(host, asp, stand, AGENT_SPEED * 0.6, dt)
    }
    else stopAt(host, asp)
    if (host.time.now >= b.waitUntil) {
      b.mode = 'returnHome'
      releaseEngaged(host, asp)
    }
    return
  }

  // ---------- returnHome:事毕回归出生位(用户拖动后为落点) ----------
  if (b.mode === 'returnHome') {
    if (asp.dragging) {
      stopAt(host, asp)
      return
    }
    const arrived = driveToward(host, asp, { x: asp.homeX, y: asp.homeY }, AGENT_SPEED * 0.7, dt)
    if (arrived) {
      stopAt(host, asp)
      asp.sprite.setPosition(asp.homeX, asp.homeY)
      b.mode = 'idle'
      b.targetId = null
      b.action = undefined
    }
    return
  }
}

/** 释放被本角色邀请(engaged)的目标:让其恢复游走 */
export function releaseEngaged(host: TownBehaviorHost, asp: AgentSprite): void {
  const target = asp.behavior.targetId ? host.agents.get(asp.behavior.targetId) : undefined
  if (target) target.behavior.engaged = false
}

/** 送达:在目标头上弹气泡(下发/通信内容) + 广播行为日志 */
export function behaviorDeliver(host: TownBehaviorHost, asp: AgentSprite, target: AgentSprite): void {
  const text = asp.behavior.action?.text ?? ''
  if (text) {
    showBubble(host, asp.channelId, target.agentId, 'info', text, 2600)
  }
  host.emit('behavior', {
    agentName: asp.name,
    action: behaviorActionLabel(host, asp.behavior.action?.kind ?? 'message'),
    targetName: target.name,
  })
}

/**
 * 驱动角色朝目标移动一步(stepToward 计算方向 → velocity)。
 * 返回是否已到达。速度随距离减速(近目标放缓,站位更自然)。
 */
export function driveToward(host: TownBehaviorHost, asp: AgentSprite, target: { x: number, y: number }, speed: number, dt: number): boolean {
  const body = asp.sprite.body as Phaser.Physics.Arcade.Body
  if (!body.enable) return false
  const cur = { x: asp.sprite.x, y: asp.sprite.y }
  const next = stepToward(cur, target, speed, dt)
  asp.sprite.setFlipX(next.dir === 'left')
  body.setVelocity((next.x - cur.x) / dt, (next.y - cur.y) / dt)
  // 行走态(与静止 bob 区分)
  playSheetAnim(host, asp.sprite, 'walk')
  return next.arrived
}

/** 停止角色运动(velocity=0) */
export function stopAt(host: TownBehaviorHost, asp: AgentSprite): void {
  const body = asp.sprite.body as Phaser.Physics.Arcade.Body | null
  body?.stop()
  playSheetAnim(host, asp.sprite, 'idle')
}

/** 统一播放某纹理的 idle/walk/work 动画;未注册时回退悬停 bob */
export function playSheetAnim(host: TownBehaviorHost, sprite: Phaser.GameObjects.Sprite, state: 'idle' | 'walk' | 'work'): void {
  const key = `${sprite.texture.key}-${state}`
  if (host.anims.exists(key)) {
    if (sprite.anims.currentAnim?.key !== key) sprite.anims.play(key, true)
  }
  else {
    const bobKey = `wu-bob-${sprite.texture.key}`
    if (host.anims.exists(bobKey) && sprite.anims.currentAnim?.key !== bobKey) sprite.anims.play(bobKey, true)
  }
}
