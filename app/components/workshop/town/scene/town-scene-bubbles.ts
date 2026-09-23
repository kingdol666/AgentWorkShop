/**
 * AgentTeam RPG 小镇(2D Phaser 表现层)— 头顶气泡。
 *
 * 自 TownScene.ts 抽出:只通过宿主契约(TownBubbleHost)触达场景成员。
 */
import type * as Phaser from 'phaser'
import type { TownBubbleKind } from '#shared/town-protocol'
import { BUBBLE_STYLE, type AgentSprite, type TownBlockDef, type TownEventMap } from './town-scene-core'

/** 头顶气泡宿主(仅声明本模块触达的场景成员;由 TownScene 提供) */
export interface TownBubbleHost {
  /** 角色渲染态(按 agentId) */
  readonly agents: Map<string, AgentSprite>
  /** 频道共鸣领地(按 channelId;无 agent 的气泡挂到领地) */
  readonly blocks: Map<string, TownBlockDef>
  readonly add: Phaser.GameObjects.GameObjectFactory
  readonly tweens: Phaser.Tweens.TweenManager
  readonly time: Phaser.Time.Clock
  /** 调试气泡队列(E2E 断言用) */
  readonly dbgBubbles: Array<{ text: string, at: number }>
  /** 最后一个气泡(去重去抖动) */
  dbgActivity: { channelId: string, agentName: string, text: string } | null
  /** 最近活动队列(跑马灯,上限 6) */
  readonly recentActivity: Array<{ channelId: string, agentName: string, text: string }>
  emit<K extends keyof TownEventMap>(event: K, e: TownEventMap[K]): void
}

// 头顶气泡(每 agent 至多一个;SLACK 白卡样式)

export function showBubble(host: TownBubbleHost, channelId: string, agentId: string | undefined, kind: TownBubbleKind, text: string, ttlMs: number): void {
  const asp = agentId ? host.agents.get(agentId) : undefined
  const anchor = asp?.sprite
  // 无具体 agent 的气泡:挂到频道领地上方
  const def = host.blocks.get(channelId)
  const ax = anchor?.x ?? def?.centerX ?? 400
  const ay = (anchor?.y ?? def?.centerY ?? 300) - 34
  const style = BUBBLE_STYLE[kind] ?? BUBBLE_STYLE.info

  const destroyPrev = (): void => {
    if (asp?.bubble) {
      asp.bubble.destroy()
      asp.bubble = null
      if (asp.bubbleTimer) {
        asp.bubbleTimer.remove(false)
        asp.bubbleTimer = null
      }
    }
  }
  destroyPrev()

  const bg = host.add.rectangle(0, 0, 12, 12, style.bg, 0.94)
  const label = host.add.text(0, 0, text, {
    fontFamily: 'Geist, PingFang SC, sans-serif',
    fontSize: '11px',
    color: style.fg,
    padding: { x: 9, y: 5 },
    wordWrap: { width: 220 },
    align: 'left',
  })
  const w = Math.min(240, label.width + 18)
  const h = label.height + 10
  bg.setSize(w, h)
  const container = host.add.container(ax, ay, [bg, label])
  container.setDepth(500)
  container.setAlpha(0)
  container.setScale(0.92)
  host.tweens.add({ targets: container, alpha: 1, y: ay - 6, scale: 1, duration: 180, ease: 'back.out' })

  host.dbgBubbles.push({ text, at: Date.now() })
  host.dbgActivity = { channelId, agentName: asp?.name ?? def?.name ?? '系统', text }
  host.recentActivity.push({ channelId, agentName: asp?.name ?? def?.name ?? '系统', text })
  if (host.recentActivity.length > 6) host.recentActivity.splice(0, host.recentActivity.length - 6)
  host.emit('lastActivity', host.dbgActivity)

  if (asp) {
    asp.bubble = container
    asp.bubbleTimer = host.time.delayedCall(ttlMs, () => {
      host.tweens.add({
        targets: container,
        alpha: 0,
        y: container.y - 8,
        duration: 220,
        onComplete: () => {
          container.destroy()
          if (asp) asp.bubble = null
        },
      })
      if (asp) asp.bubbleTimer = null
    })
  }
  else {
    host.time.delayedCall(ttlMs, () => {
      host.tweens.add({ targets: container, alpha: 0, y: container.y - 8, duration: 220, onComplete: () => container.destroy() })
    })
  }
}
