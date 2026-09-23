/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— 事件共鸣与行为 FSM 入口。
 *
 * 自 TownScene3D.ts 抽出:
 *  - handleTownEvent:WS 事件入口(布局同步 / 状态收敛 / 气泡入队 / 共鸣 / 行为决策);
 *  - 事件共鸣可视化(说话扩散环 / 完成光柱 / 错误涟漪;时间基缓动,结束即释放资源);
 *  - 行为驱动的起点(点对点通信/任务投递 → 发送方跑去接收方身边下发;需回复则等待)。
 *
 * 行为状态机本体在 town-scene3d-nodes.ts 的 Agent3D.update 中逐帧执行。
 * 宿主契约:场景类实现 EventHost(只列本模块触达的成员)。
 */
import * as THREE from 'three'
import type { AepEnvelope } from '#shared/workshop-protocol'
import type { ChannelLayout } from '#shared/town-scene-math'
import { mapEnvelopeToIntent, type TownBubbleKind } from '#shared/town-protocol'
import { parseActionFromEnvelope, type ActionContext, type ActionKind } from '#shared/town-behavior'
import type { Agent3D, Block3D } from './town-scene3d-nodes'
import type { TownEventMap } from './town-scene3d-types'

/** 事件模块的宿主契约(一项 = 本模块真正用到的字段/方法) */
export interface EventHost {
  /** 场景根(共鸣环/光柱挂载与摘除) */
  readonly scene: THREE.Scene
  readonly agents: Map<string, Agent3D>
  readonly blocks: Map<string, Block3D>
  /** 频道领地布局(channelId → 放置;他人编辑边界/移入场景 → 本端同步) */
  readonly layouts: Map<string, ChannelLayout>
  /** 任务 ID → assignee 反查(行为决策解析) */
  readonly resolveTaskAssignee: ((taskId: string) => string | null) | null
  /** 脏标记(内容变化 → 重绘) */
  dirty: boolean
  /** 场景 → Vue HUD 事件 */
  emit<K extends keyof TownEventMap>(event: K, e: TownEventMap[K]): void
  /** 登记逐帧回调(渲染循环统一 flush) */
  pushAnim(f: () => void): void
  /** 注入频道领地布局(远端布局事件本地同步) */
  applySceneLayouts(layouts: ChannelLayout[]): void
  /** 频道当前布局(供边界编辑面板初始化) */
  getChannelLayout(channelId: string): ChannelLayout | null
  /** 更新频道布局(编辑边界后本地即时生效) */
  updateChannelLayout(channelId: string, patch: Partial<ChannelLayout>): void
  /** 移除频道放置(从场景撤走领地及其 Agent) */
  removeChannel(channelId: string): void
  /** 实时信息(讲话/交付/错误)入队到目标频道的信息接收器 */
  enqueueBubble(channelId: string, agentId: string | undefined, kind: TownBubbleKind, text: string, ttlMs: number): void
}

// ================================================================
// WS 事件入口(与 2D 同构):布局同步 / 状态收敛 / 气泡入队 / 共鸣 / 行为决策
// ================================================================

export function handleTownEvent(host: EventHost, e: AepEnvelope): void {
  if (e.type === 'channel.snapshot') return
  // 频道布局事件:本地已放同一频道则即时应用(他人编辑边界/移入场景 → 本端同步)
  if (e.type === 'scene.layout.saved') {
    const l = e.payload as ChannelLayout
    if (host.blocks.has(l.channelId)) {
      host.applySceneLayouts([...(host.layouts.values()), l])
      // 更新对应领地几何
      const cur = host.getChannelLayout(l.channelId)
      if (cur) host.updateChannelLayout(l.channelId, l)
    }
    return
  }
  if (e.type === 'scene.layout.removed') {
    const { channelId } = e.payload as { channelId: string }
    host.removeChannel(channelId)
    return
  }
  const intent = mapEnvelopeToIntent(e)
  if (!intent) return
  if (intent.agentId) {
    const asp = host.agents.get(intent.agentId)
    if (asp) {
      if (e.type === 'agent.status') {
        asp.state = (e.payload as { state: 'idle' | 'busy' | 'stopped' }).state
        if (asp.state !== 'busy') asp.progress = null
      }
      if (e.type === 'task.progress') asp.progress = (e.payload as { progress: number }).progress
      host.dirty = true
    }
  }
  if (intent.bubble) host.enqueueBubble(intent.bubble.channelId, intent.bubble.agentId, intent.bubble.kind, intent.bubble.text, intent.bubble.ttlMs)
  emitResonance(host, e)
  const action = parseActionFromEnvelope(e, { resolveTaskAssignee: host.resolveTaskAssignee ?? undefined })
  if (action) startBehavior(host, action)
}

/** 触发一次「跑去下发」行为:from 跑到 to 身边(行为 FSM 由 Agent3D 每帧推进) */
export function startBehavior(host: EventHost, action: ActionContext): void {
  const from = host.agents.get(action.fromId)
  const to = host.agents.get(action.toId)
  if (!from || !to || from.dragging) return
  from.behavior.mode = 'approach'
  from.behavior.targetId = to.agentId
  from.behavior.action = action
  if (!to.dragging) {
    to.behavior.engaged = true
    to.behavior.roamTarget = null
  }
  host.emit('behavior', { agentName: from.name, action: behaviorActionLabel(action.kind), targetName: to.name })
}

export function behaviorActionLabel(kind: ActionKind): string {
  return kind === 'task' ? '下发任务' : '回复'
}

export function emitResonance(host: EventHost, e: AepEnvelope): void {
  const b = host.blocks.get(e.channelId)
  const asp = e.agentId ? host.agents.get(e.agentId) : undefined
  const x = asp?.root.position.x ?? b?.x
  const z = asp?.root.position.z ?? b?.z
  if (x === undefined || z === undefined) return
  if (e.type === 'agent.message' || e.type === 'agent.status.message' || e.type === 'a2a.message') {
    pulseRing(host, x, z, asp ? 0x41c8f4 : (b?.color ?? 0x41c8f4))
  }
  else if (e.type === 'error' || (e.type === 'task.status' && ((e.payload as { state?: string }).state === 'failed' || (e.payload as { state?: string }).state === 'canceled'))) {
    pulseRing(host, x, z, 0xff6b6b)
  }
  else if (e.type === 'task.status' && (e.payload as { state?: string }).state === 'completed') {
    lightColumn(host, x, z, 0x35e0a0)
  }
}

/** 事件共鸣扩散环(时间基:800ms 缓出扩散 + 淡出;帧率无关,结束即释放资源) */
export function pulseRing(host: EventHost, x: number, z: number, color: number): void {
  const ring = new THREE.Mesh(new THREE.RingGeometry(10, 22, 24), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }))
  ring.rotation.x = -Math.PI / 2
  ring.position.set(x, 0.4, z)
  host.scene.add(ring)
  const start = performance.now()
  const dur = 800
  const step = () => {
    const k = Math.min(1, (performance.now() - start) / dur)
    const e = 1 - Math.pow(1 - k, 3)
    ring.scale.setScalar(1 + e * 1.6)
    ;(ring.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - e)
    if (k >= 1) {
      host.scene.remove(ring)
      ring.geometry.dispose()
      ;(ring.material as THREE.MeshBasicMaterial).dispose()
      return
    }
    host.pushAnim(step)
  }
  host.pushAnim(step)
}

/** 交付光柱(时间基:底部锚定向上生长 + 淡出;几何上移锚定,修复旧零高度柱不可见的缺陷) */
export function lightColumn(host: EventHost, x: number, z: number, color: number): void {
  const geo = new THREE.CylinderGeometry(6, 12, 120, 16)
  geo.translate(0, 60, 0)
  const beam = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false }))
  beam.position.set(x, 0, z)
  beam.scale.y = 0.01
  host.scene.add(beam)
  const start = performance.now()
  const dur = 900
  const step = () => {
    const k = Math.min(1, (performance.now() - start) / dur)
    const e = 1 - Math.pow(1 - k, 2)
    beam.scale.y = 0.01 + e * 0.99
    ;(beam.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - k)
    if (k >= 1) {
      host.scene.remove(beam)
      beam.geometry.dispose()
      ;(beam.material as THREE.MeshBasicMaterial).dispose()
      return
    }
    host.pushAnim(step)
  }
  host.pushAnim(step)
}
