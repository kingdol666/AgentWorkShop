/**
 * AgentTeam RPG 小镇(2D Phaser 表现层)— 领地/地标/共鸣绘制。
 *
 * 自 TownScene.ts 抽出:只通过宿主契约(TownVisualHost)触达场景成员,
 * 不直接依赖 TownScene 的其余实现。
 *
 *  - 视差背景(createParallax / updateParallax);
 *  - 频道共鸣领地(环形能场 / 地面柔光 / 色盲徽记 / 名牌)与街区地标塔;
 *  - 世界中心「共鸣核心塔」;
 *  - 事件共鸣可视化(说话脉冲 / 完成光柱 / 错误涟漪 / 频道旗)。
 */
import type * as Phaser from 'phaser'
import type { AepEnvelope } from '#shared/workshop-protocol'
import { WORLD_CX, WORLD_CY, WORLD_H, WORLD_W, type AgentSprite, type TownBlockDef } from './town-scene-core'

/** 领地/地标/共鸣绘制宿主(仅声明本模块触达的场景成员;由 TownScene 提供) */
export interface TownVisualHost {
  /** 频道共鸣领地(按 channelId) */
  readonly blocks: Map<string, TownBlockDef>
  /** 角色渲染态(按 agentId;说话脉冲取共鸣色) */
  readonly agents: Map<string, AgentSprite>
  /** 频道旗(顶球)缓存 */
  readonly flagBy: Map<string, Phaser.GameObjects.Arc>
  /** 视差背景层(远/中);scroll 因子控制不同步平移 */
  farLayer: Phaser.GameObjects.Image
  midLayer: Phaser.GameObjects.Image
  scrollFactorFar: number
  scrollFactorMid: number
  readonly cameras: Phaser.Cameras.Scene2D.CameraManager
  readonly add: Phaser.GameObjects.GameObjectFactory
  readonly tweens: Phaser.Tweens.TweenManager
  /** 登记领地/装饰对象(resetAll 时统一销毁) */
  pushDecor(...objs: Phaser.GameObjects.GameObject[]): void
}

/**
 * 视差背景:远山天空/城市剪影按相机 scroll 因子不同步平移,产生纵深。
 * 层固定在相机上(scrollFactor=0),位置随 update 里相机 scroll 反推。
 */
export function createParallax(host: TownVisualHost): void {
  const cam = host.cameras.main
  // 铺满视野(约 1100x700 @ zoom1),随 zoom 放大
  host.farLayer = host.add.image(WORLD_W / 2, WORLD_H / 2, 'world-far')
    .setScrollFactor(0).setDepth(-1200)
  host.midLayer = host.add.image(WORLD_W / 2, WORLD_H / 2, 'world-middle')
    .setScrollFactor(0).setDepth(-1150)
  // 初始尺寸
  void cam
}

/** 每帧按相机 scroll 让视差层产生缓慢位移(远层更慢) */
export function updateParallax(host: TownVisualHost): void {
  const cam = host.cameras.main
  // 以世界中心为锚:相机偏离中心越多,背景偏移越多(但远层偏移更少 → 相对慢速)
  const dx = (cam.scrollX + cam.width / 2) - WORLD_CX
  const dy = (cam.scrollY + cam.height / 2) - WORLD_CY
  const f = cam.zoom
  host.farLayer.setPosition(cam.width / 2 - dx * host.scrollFactorFar / f, cam.height / 2 - dy * host.scrollFactorFar / f)
  host.midLayer.setPosition(cam.width / 2 - dx * host.scrollFactorMid / f, cam.height / 2 - dy * host.scrollFactorMid / f)
  // 随缩放放大背景(与视野同比例)
  host.farLayer.setScale(Math.max(0.6, 0.6 / f))
  host.midLayer.setScale(Math.max(0.72, 0.72 / f))
}

/** 建一片频道共鸣领地(环形能场 + 柔光 + 频道名牌;无白色方块) */
export function drawBlock(host: TownVisualHost, def: TownBlockDef): void {
  const { centerX: cx, centerY: cy, radius: r, colorNum } = def
  // 地面柔光(大面积低透明,暗示能场)
  const field = host.add.image(cx, cy, 'wu-aura')
    .setScale(r / 56).setTint(colorNum).setAlpha(0.30).setDepth(-20)
  // 环形能场边界(呼吸)
  const ring = host.add.image(cx, cy, 'wu-ring')
    .setScale(r / 128).setTint(colorNum).setAlpha(0.55).setDepth(-19)
  host.tweens.add({
    targets: ring,
    alpha: { from: 0.35, to: 0.6 },
    scale: { from: (r / 128) * 0.96, to: (r / 128) * 1.04 },
    yoyo: true,
    repeat: -1,
    duration: 2400,
    ease: 'sine.inout',
  })
  // 频道名牌(顶部) —— 由 drawLandmark 挂在塔顶
  const stroke = host.add.graphics().setDepth(-18)
  stroke.lineStyle(1.2, colorNum, 0.4)
  stroke.strokeCircle(cx, cy, r)
  // 地面柔软阴影(建筑/领地投影,低透明)
  const shadow = host.add.image(cx, cy + 22, 'wu-aura')
    .setScale(r / 52).setTint(0x0a1410).setAlpha(0.22).setDepth(-17)
  host.pushDecor(field, ring, stroke, shadow)

  drawLandmark(host, def)
}

/**
 * 街区地标建筑(2.5D 挤出:顶面 + 侧壁,侧壁随朝向变暗 → 有体积)。
 * 用 wu-ring 作底座 + wu-aura 作顶面辉光,叠加成一座低模塔;无真实 tile 也能有"人工建筑"体积感。
 */
export function drawLandmark(host: TownVisualHost, def: TownBlockDef): void {
  const { centerX: cx, centerY: cy, radius: r, colorNum } = def
  const baseY = cy - r * 0.55
  // 底座(地面投影)
  const base = host.add.ellipse(cx, baseY, r * 0.5, r * 0.2, colorNum, 0.55).setDepth(-16)
  // 塔身(侧壁,深色→体积,受夕阳侧光:右亮左暗)
  const body = host.add.rectangle(cx, baseY - 42, r * 0.34, 88, colorNum, 0.85).setDepth(baseY - 20).setOrigin(0.5, 1)
  body.setStrokeStyle(1.5, colorNum, 0.6)
  // 顶面(略亮,承接天光)
  const top = host.add.ellipse(cx, baseY - 84, r * 0.4, r * 0.16, 0xffffff, 0.28).setDepth(baseY - 20)
  top.setStrokeStyle(1.5, colorNum, 0.6)
  // 顶面光柱(呼吸)
  const beam = host.add.image(cx, baseY - 120, 'wu-aura')
    .setScale(0.9).setTint(0xfff0cf).setAlpha(0.5).setDepth(baseY - 20)
  host.tweens.add({ targets: beam, alpha: { from: 0.3, to: 0.6 }, scale: { from: 0.7, to: 1.05 }, yoyo: true, repeat: -1, duration: 1800, ease: 'sine.inout' })
  // 频道名牌(挂在塔顶)
  const plaque = host.add.text(cx, baseY - 128, def.name, {
    fontFamily: 'Geist, PingFang SC, sans-serif',
    fontSize: '13px',
    fontStyle: '600',
    color: '#fff',
    padding: { x: 10, y: 4 },
    backgroundColor: 'rgba(18,20,30,0.6)',
  }).setOrigin(0.5).setDepth(baseY - 19)
  // 色盲徽记:频道用几何形状区分(不单靠色相),置于名牌上方
  const emblem = drawEmblem(host, cx, baseY - 148, colorNum, def.channelId)
  host.pushDecor(base, body, top, beam, plaque, emblem)
}

/** 频道几何徽记(色盲友好:形状+色双通道);形状由 channelId 哈希稳定决定 */
export function drawEmblem(host: TownVisualHost, cx: number, cy: number, colorNum: number, channelId: string): Phaser.GameObjects.Graphics {
  const g = host.add.graphics().setDepth(cy + 1000)
  const s = 9
  g.lineStyle(2, colorNum, 0.95)
  g.fillStyle(colorNum, 0.35)
  const shape = Math.abs(channelId.split('').reduce((h, c) => h * 31 + c.charCodeAt(0), 0)) % 5
  if (shape === 0) g.strokeCircle(cx, cy, s) // 圆
  else if (shape === 1) { // 三角
    g.beginPath()
    g.moveTo(cx, cy - s)
    g.lineTo(cx + s, cy + s)
    g.lineTo(cx - s, cy + s)
    g.closePath()
    g.strokePath()
  }
  else if (shape === 2) { // 方块
    g.strokeRect(cx - s, cy - s, s * 2, s * 2)
  }
  else if (shape === 3) { // 菱形
    g.beginPath()
    g.moveTo(cx, cy - s)
    g.lineTo(cx + s, cy)
    g.lineTo(cx, cy + s)
    g.lineTo(cx - s, cy)
    g.closePath()
    g.strokePath()
  }
  else { // 五边
    g.beginPath()
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5
      const px = cx + Math.cos(a) * s
      const py = cy + Math.sin(a) * s
      if (i === 0) g.moveTo(px, py)
      else g.lineTo(px, py)
    }
    g.closePath()
    g.strokePath()
  }
  return g
}

/**
 * 世界中心「共鸣核心塔」(= workspace 本体):高耸能量柱,随全局活动呼吸。
 * 街区沿大道环绕它分布,一眼可辨世界中心。
 */
export function drawCore(host: TownVisualHost): void {
  const cx = WORLD_CX
  const cy = WORLD_CY
  // 塔基能量场(大面积)
  const field = host.add.image(cx, cy, 'wu-aura').setScale(6).setTint(0x4da3ff).setAlpha(0.28).setDepth(-20)
  // 塔身(多层收窄的能量柱)
  const body = host.add.rectangle(cx, cy - 90, 120, 300, 0x57d29a, 0.7).setOrigin(0.5, 1).setDepth(cy - 22)
  body.setStrokeStyle(2, 0xd8fff2, 0.6)
  const body2 = host.add.rectangle(cx, cy - 220, 70, 180, 0xc4f4e8, 0.75).setOrigin(0.5, 1).setDepth(cy - 21)
  // 顶部光球(呼吸)
  const orb = host.add.image(cx, cy - 320, 'wu-aura').setScale(1.4).setTint(0xeafff8).setAlpha(0.9).setDepth(cy - 20)
  host.tweens.add({ targets: orb, alpha: { from: 0.7, to: 1 }, scale: { from: 1.2, to: 1.6 }, yoyo: true, repeat: -1, duration: 1600, ease: 'sine.inout' })
  // 塔名
  const label = host.add.text(cx, cy - 360, '共鸣核心', {
    fontFamily: 'Geist, PingFang SC, sans-serif',
    fontSize: '14px',
    fontStyle: '600',
    color: '#fff',
    padding: { x: 12, y: 5 },
    backgroundColor: 'rgba(18,20,30,0.6)',
  }).setOrigin(0.5).setDepth(cy - 19)
  host.pushDecor(field, body, body2, orb, label)
}

/**
 * 事件 → 视觉共鸣(把目光吸过去,但不打断):
 *  - 消息类 → 说话者身上扩散一圈共鸣波纹(speaking pulse)
 *  - task.status(完成) → 频道领地冲出一道光柱 + 星星粒子
 *  - error → 该频道一圈红色涟漪 + 频道旗变红
 *  - task.status(其它/进行中) → 频道旗变黄(busy)
 */
export function emitResonance(host: TownVisualHost, e: AepEnvelope): void {
  const def = host.blocks.get(e.channelId)
  const asp = e.agentId ? host.agents.get(e.agentId) : undefined
  const cx = asp?.sprite.x ?? def?.centerX
  const cy = asp?.sprite.y ?? def?.centerY
  if (cx === undefined || cy === undefined) return

  if (e.type === 'agent.message' || e.type === 'agent.status.message' || e.type === 'a2a.message') {
    pulseRing(host, cx, cy, asp?.aura.tintTopLeft ?? def?.colorNum ?? 0xffffff, 0x4da3ff)
  }
  else if (e.type === 'error') {
    pulseRing(host, cx, cy, 0xff6b5c, 0xff6b5c)
    setFlag(host, e.channelId, 'danger')
  }
  else if (e.type === 'task.status') {
    const state = (e.payload as { state?: string }).state
    if (state === 'completed') {
      lightColumn(host, cx, cy, 0xd8fff2)
    }
    else if (state === 'working' || state === 'assigned') {
      setFlag(host, e.channelId, 'busy')
    }
    else if (state === 'failed' || state === 'canceled') {
      pulseRing(host, cx, cy, 0xff9e6b, 0xff9e6b)
      setFlag(host, e.channelId, 'danger')
    }
    else if (state === 'waiting') {
      setFlag(host, e.channelId, 'wait')
    }
  }
}

/** 一个扩散共鸣波纹(圆环放大并淡出) */
export function pulseRing(host: TownVisualHost, x: number, y: number, color: number, _glow: number): void {
  const ring = host.add.image(x, y, 'wu-ring').setTint(color).setAlpha(0.8).setDepth(y + 300).setScale(0.3)
  host.tweens.add({
    targets: ring,
    scale: 2.2,
    alpha: 0,
    duration: 700,
    ease: 'sine.out',
    onComplete: () => ring.destroy(),
  })
}

/** 高频光柱(交付/完成时从频道领地冲天) */
export function lightColumn(host: TownVisualHost, x: number, y: number, color: number): void {
  const beam = host.add.image(x, y - 40, 'wu-aura').setTint(color).setAlpha(0.9).setDepth(y + 320).setScale(0, 6)
  host.tweens.add({
    targets: beam,
    scaleX: 1.1,
    scaleY: 2.2,
    alpha: 0,
    duration: 900,
    ease: 'power2.out',
    onComplete: () => beam.destroy(),
  })
}

/** 频道状态旗(地标塔顶变色;busy/wait/danger) */
export function setFlag(host: TownVisualHost, channelId: string, state: 'busy' | 'wait' | 'danger'): void {
  const def = host.blocks.get(channelId)
  if (!def) return
  const color = state === 'danger' ? 0xff6b5c : state === 'wait' ? 0xf5a742 : 0x57d29a
  // 在塔顶光球处再放一个呼吸旗(轻量;若已存在则复用)
  let flag = host.flagBy.get(channelId)
  if (!flag) {
    flag = host.add.circle(def.centerX, def.centerY - 150, 10, color, 0.9).setDepth(def.centerY - 10)
    host.flagBy.set(channelId, flag)
    host.pushDecor(flag)
  }
  flag.setFillStyle(color, 0.9)
  host.tweens.add({ targets: flag, alpha: { from: 0.6, to: 1 }, yoyo: true, repeat: -1, duration: 800 })
}
