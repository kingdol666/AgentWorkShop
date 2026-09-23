/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— 信息接收器与聊天气泡。
 *
 * 自 TownScene3D.ts 抽出:每个实例化 Channel 一个接收器(FIFO 逐条消费)——
 *  - WS 实时信息经 townBus → handleTownEvent 入队,渲染到对应 Agent 头顶,像真实对话;
 *  - 事件流 / 最近活动 / 调试气泡即时更新(展示延迟只作用于 3D 气泡);
 *  - 2.5D 工业 HMI 气泡贴图(头部身份条 + 类型印章 + 多行正文 + 尾角)与弹入缓动;
 *  - 逐字符换行(兼容中英混排)。
 *
 * 宿主契约:场景类实现 BubbleHost(只列本模块触达的成员)。
 */
import * as THREE from 'three'
import { BUBBLE_Y, bubbleDisplayMs, drainDisplayMs } from '#shared/town-scene-math'
import type { TownBubbleKind } from '#shared/town-protocol'
import type { Agent3D, Block3D } from './town-scene3d-nodes'
import type { BubbleMsg, ChannelMessageReceiver, TownEventMap } from './town-scene3d-types'

/** 接收器 / 气泡模块的宿主契约(一项 = 本模块真正用到的字段/方法) */
export interface BubbleHost {
  /** 场景根(气泡 Sprite 挂载/摘除) */
  readonly scene: THREE.Scene
  readonly agents: Map<string, Agent3D>
  readonly blocks: Map<string, Block3D>
  /** 频道信息接收器(channelId → FIFO 队列) */
  readonly receivers: Map<string, ChannelMessageReceiver>
  /** 调试气泡(最近事件;getDebugState 读取) */
  readonly dbgBubbles: Array<{ text: string, at: number }>
  /** 最后一个气泡(去重去抖动):HUD 显示"此刻谁在说话" */
  lastActivity: { channelId: string, agentName: string, text: string, at?: number } | null
  /** 最近活动队列(跑马灯) */
  readonly recentActivity: Array<{ channelId: string, agentName: string, text: string, at?: number }>
  /** 已销毁(动画步进中止) */
  readonly disposed: boolean
  /** 场景 → Vue HUD 事件 */
  emit<K extends keyof TownEventMap>(event: K, e: TownEventMap[K]): void
  /** 请求下一帧重绘 */
  markDirty(): void
  /** 登记逐帧回调(渲染循环统一 flush) */
  pushAnim(f: () => void): void
  /** 释放对象树内所有 Canvas 纹理(名牌/气泡 sprite 的独占资源) */
  disposeCanvasTextures(root: THREE.Object3D | null): void
}

/** 实时信息(讲话/交付/错误)入队到目标频道的信息接收器;系统指标即时更新,3D 展示按 FIFO 消费 */
export function enqueueBubble(host: BubbleHost, channelId: string, agentId: string | undefined, kind: TownBubbleKind, text: string, ttlMs: number): void {
  // 事件流 / 最近活动 / 调试气泡即时更新(展示延迟只作用于 3D 气泡)
  host.dbgBubbles.push({ text, at: Date.now() })
  if (host.dbgBubbles.length > 30) host.dbgBubbles.splice(0, host.dbgBubbles.length - 30)
  const speaker = agentId ? host.agents.get(agentId)?.name : undefined
  host.lastActivity = { channelId, agentName: speaker ?? host.blocks.get(channelId)?.name ?? '系统', text, at: Date.now() }
  host.recentActivity.push(host.lastActivity)
  if (host.recentActivity.length > 30) host.recentActivity.splice(0, host.recentActivity.length - 30)
  host.emit('lastActivity', host.lastActivity)
  // 入队(FIFO;超长队列丢最旧,防止异常风暴撑爆内存)
  let rec = host.receivers.get(channelId)
  if (!rec) {
    rec = { channelId, queue: [], current: null, currentUntil: 0 }
    host.receivers.set(channelId, rec)
  }
  if (rec.queue.length >= 24) rec.queue.splice(0, rec.queue.length - 24)
  rec.queue.push({ agentId: agentId ?? null, kind, text, ttlMs })
  host.markDirty()
}

/** 各频道接收器 FIFO 消费:当前条目展示期满 → 清理其气泡并取下一条实时渲染(渲染循环每帧调用)。
 *  队列积压时按 drainDisplayMs 压缩单条时长,让爆发期消息尽快追平。 */
export function drainReceivers(host: BubbleHost, now: number): void {
  for (const rec of host.receivers.values()) {
    if (rec.current) {
      if (now < rec.currentUntil) continue
      clearReceiverBubble(host, rec.channelId, rec.current)
      rec.current = null
    }
    const msg = rec.queue.shift()
    if (!msg) continue
    rec.current = msg
    rec.currentUntil = now + drainDisplayMs(msg.text, rec.queue.length)
    renderReceiverBubble(host, rec.channelId, msg)
  }
}

/** 清除接收器条目对应的场景气泡(不同说话人衔接时避免叠泡) */
export function clearReceiverBubble(host: BubbleHost, channelId: string, msg: BubbleMsg): void {
  if (!msg.agentId) return
  const asp = host.agents.get(msg.agentId)
  if (asp?.bubble) {
    host.scene.remove(asp.bubble)
    asp.bubble = null
    asp.bubbleText = null
    if (asp.bubbleTimer) {
      clearTimeout(asp.bubbleTimer)
      asp.bubbleTimer = null
    }
  }
}

/** 将接收器消息渲染为 2.5D 聊天气泡(说话 Agent 头顶;无对应用户则挂频道名牌上方) */
export function renderReceiverBubble(host: BubbleHost, channelId: string, msg: BubbleMsg): void {
  const asp = msg.agentId ? host.agents.get(msg.agentId) : undefined
  const b = host.blocks.get(channelId)
  // 频道未放置且无对应用户 → 暂不渲染(队列保留,放置/用户出现后补显)
  if (!asp && !b) return
  const name = asp?.name ?? b?.name ?? '系统'
  const accent = asp
    ? asp.colorNum
    : (b?.color ?? 0x41c8f4)
  const text = (msg.kind === 'artifact' && !msg.text.startsWith('📦') ? `📦 ${msg.text}` : msg.text) || '…'
  const sprite = makeChatBubble(text, name, accent, msg.kind)
  const x = asp?.root.position.x ?? b!.x
  const z = asp?.root.position.z ?? b!.z
  // 放大气泡后锚点整体抬升(避免压到 48 处名牌)
  sprite.position.set(x, asp ? BUBBLE_Y + 22 + Math.max(0, asp.model.scale.y - 1) * 22 : 64, z)
  host.scene.add(sprite)
  if (!asp) {
    // 频道级(系统)气泡:展示期满自行移除
    window.setTimeout(() => {
      host.scene.remove(sprite)
    }, bubbleDisplayMs(msg.text) + 500)
    return
  }
  if (asp.bubble) {
    host.scene.remove(asp.bubble)
    host.disposeCanvasTextures(asp.bubble)
    asp.bubbleText = null
  }
  asp.bubble = sprite
  asp.bubbleText = text
  popInSprite(host, sprite)
  host.markDirty()
}

/** 2.5D 聊天气泡:工业 HMI 风格 —— 头部身份条(等宽名牌 + 类型印章)+ 多行正文 + 尾角 */
export function makeChatBubble(text: string, name: string, accent: number, kind: TownBubbleKind): THREE.Sprite {
  const accentHex = `#${accent.toString(16).padStart(6, '0')}`
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  // 超大字号会话气泡:正文 18px / 头名 13px / 最多 6 行 / 宽 ≤ 680px —— 实时信息一眼可读
  const bodyFont = '18px Geist, "PingFang SC", sans-serif'
  const headFont = '600 13px "Geist Mono", Geist, "PingFang SC", monospace'
  const tagFont = '600 10px "Geist Mono", Geist, monospace'
  const maxTextW = 470
  const padX = 18
  const padY = 12
  const nameH = 26
  const lineH = 24
  const tailH = 13
  ctx.font = bodyFont
  const lines = wrapBubbleLines(ctx, text.replace(/\s+/g, ' ').trim() || '…', maxTextW, 6)
  const textW = Math.max(...lines.map(l => ctx.measureText(l).width))
  const bw = Math.min(680, Math.max(140, Math.ceil(textW) + padX * 2))
  const bodyH = nameH + lines.length * lineH + padY * 2
  const bh = bodyH + tailH
  canvas.width = bw
  canvas.height = bh
  ctx.clearRect(0, 0, bw, bh)
  // 方角矩形 + 底部中央尾角(指向说话人;HMI 直角配方)
  const r = 4
  const cx = bw / 2
  const t = Math.min(24, bw * 0.32)
  const path = () => {
    ctx.beginPath()
    ctx.moveTo(r, 0)
    ctx.lineTo(bw - r, 0)
    ctx.quadraticCurveTo(bw, 0, bw, r)
    ctx.lineTo(bw, bodyH - r)
    ctx.quadraticCurveTo(bw, bodyH, bw - r, bodyH)
    ctx.lineTo(cx + t / 2, bodyH)
    ctx.lineTo(cx, bodyH + tailH)
    ctx.lineTo(cx - t / 2, bodyH)
    ctx.lineTo(r, bodyH)
    ctx.quadraticCurveTo(0, bodyH, 0, bodyH - r)
    ctx.lineTo(0, r)
    ctx.quadraticCurveTo(0, 0, r, 0)
    ctx.closePath()
  }
  // 柔和投影 → 深色面板底
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.55)'
  ctx.shadowBlur = 14
  ctx.shadowOffsetY = 4
  path()
  ctx.fillStyle = 'rgba(14,18,27,0.94)'
  ctx.fill()
  ctx.restore()
  // 头部数据带(轻微抬升 + 发丝底边)
  ctx.save()
  path()
  ctx.clip()
  ctx.fillStyle = 'rgba(255,255,255,0.045)'
  ctx.fillRect(0, 0, bw, padY + nameH)
  ctx.restore()
  ctx.globalAlpha = 0.28
  ctx.fillStyle = '#fff'
  ctx.fillRect(padX, padY + 18, bw - padX * 2, 1)
  ctx.globalAlpha = 1
  // 发丝描边 + 左缘身份色数据条
  path()
  ctx.lineWidth = 1.2
  ctx.strokeStyle = 'rgba(140,170,195,0.4)'
  ctx.stroke()
  ctx.save()
  path()
  ctx.clip()
  ctx.fillStyle = accentHex
  ctx.fillRect(0, 0, 3, bodyH)
  ctx.restore()
  // 头牌:等宽名牌(身份色)+ 右侧类型印章(交付/异常)
  ctx.font = headFont
  ctx.fillStyle = accentHex
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText(name, padX, padY + 10)
  const tag = kind === 'artifact' ? 'ARTIFACT' : kind === 'error' ? 'FAULT' : ''
  if (tag) {
    const tw = ctx.measureText(tag).width + 12
    ctx.font = tagFont
    ctx.fillStyle = kind === 'error' ? '#ff8d80' : '#9fc3e8'
    ctx.strokeStyle = kind === 'error' ? 'rgba(255,141,128,0.55)' : 'rgba(159,195,232,0.45)'
    ctx.lineWidth = 1
    const tx = bw - padX - tw
    const ty = padY + 2
    const th = 16
    ctx.beginPath()
    ctx.rect(tx, ty, tw, th)
    ctx.fill()
    ctx.stroke()
    ctx.textAlign = 'center'
    ctx.fillText(tag, tx + tw / 2, ty + th / 2 + 0.5)
  }
  // 正文(错误微红)
  ctx.font = bodyFont
  ctx.fillStyle = kind === 'error' ? '#ff9d9d' : '#eef2fb'
  ctx.textAlign = 'left'
  lines.forEach((l, i) => ctx.fillText(l, padX, padY + nameH + 10 + i * lineH))
  // Sprite(纹理按 1/2.4 缩放到世界单位 —— 放大气泡后保持更大可见尺度)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }))
  const k = 2.4
  sprite.scale.set(bw / k, bh / k, 1)
  return sprite
}

/** 气泡弹入动画:0.62 → 1.0 缓出(180ms,2.5D 手感) */
export function popInSprite(host: BubbleHost, sprite: THREE.Sprite): void {
  const tx = sprite.scale.x
  const ty = sprite.scale.y
  sprite.scale.set(tx * 0.62, ty * 0.62, 1)
  const start = performance.now()
  const dur = 180
  const step = () => {
    if (host.disposed) return
    const t = Math.min(1, (performance.now() - start) / dur)
    const s = 0.62 + 0.38 * (1 - Math.pow(1 - t, 3))
    sprite.scale.set(tx * s, ty * s, 1)
    if (t < 1) host.pushAnim(step)
  }
  host.pushAnim(step)
}

/** 按宽度逐字符换行(兼容中英混排);超 maxLines 行末加省略号 */
export function wrapBubbleLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxW && line) {
      lines.push(line)
      line = ch
      if (lines.length >= maxLines) {
        lines[maxLines - 1] = `${lines[maxLines - 1] ?? ''}…`
        return lines
      }
    }
    else {
      line += ch
    }
  }
  if (line) lines.push(line)
  if (lines.length === 0) lines.push('…')
  return lines
}
