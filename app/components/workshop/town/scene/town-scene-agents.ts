/**
 * AgentTeam RPG 小镇(2D Phaser 表现层)— 角色(员工/居民)sprite。
 *
 * 自 TownScene.ts 抽出(建模 / 拖动 / 换装 / 落地生成 / 状态环),
 * 只通过宿主契约(TownAgentHost)触达场景成员。
 */
import type * as Phaser from 'phaser'
import { LEAD_SHEET, WORKER_SHEETS, channelColorNum, type AgentSprite, type TownBlockDef, type TownEventMap } from './town-scene-core'

/** 角色 sprite 生成入参(实体基线里的角色子集;缺省字段容错) */
export interface AgentSpawnInput {
  channelId: string
  agentId: string
  name: string
  role: 'lead' | 'worker'
  state: 'idle' | 'busy' | 'stopped'
  currentTaskProgress?: number | null
  modelRef?: string | null
}

/** 角色宿主(仅声明本模块触达的场景成员;由 TownScene 提供) */
export interface TownAgentHost {
  /** 角色渲染态(按 agentId) */
  readonly agents: Map<string, AgentSprite>
  /** 频道共鸣领地(按 channelId;共鸣色来源) */
  readonly blocks: Map<string, TownBlockDef>
  readonly add: Phaser.GameObjects.GameObjectFactory
  readonly tweens: Phaser.Tweens.TweenManager
  readonly textures: Phaser.Textures.TextureManager
  readonly physics: Phaser.Physics.Arcade.ArcadePhysics
  /** 世界高度(拖动时抬到最前的深度基准) */
  readonly worldYMax: number
  /** 角色数(新建后刷新并广播 agentCount) */
  agentCount: number
  emit<K extends keyof TownEventMap>(event: K, e: TownEventMap[K]): void
}

/** 确保某 agent 的 sprite 存在(不存在则建);返回是否新建 */
export function ensureAgentSprite(
  host: TownAgentHost,
  a: AgentSpawnInput,
  cx?: number,
  cy?: number,
): boolean {
  const key = a.agentId
  if (host.agents.has(key)) {
    host.agents.get(key)!.state = a.state
    return false
  }
  const def = host.blocks.get(a.channelId)
  const colorNum = def?.colorNum ?? channelColorNum(a.channelId)
  const builtinSheet = a.role === 'lead' ? LEAD_SHEET : WORKER_SHEETS[Math.abs(a.agentId.split('').reduce((h, c) => h * 31 + c.charCodeAt(0), 0)) % WORKER_SHEETS.length]!
  // 模型绑定:若该角色绑定了自定义模型且纹理已注册,则用之;否则回退内置员工模型
  const sheet = a.modelRef && host.textures.exists(a.modelRef) ? a.modelRef : builtinSheet
  const bx = def?.centerX ?? cx ?? 400
  const by = def?.centerY ?? cy ?? 300
  // 领地成员沿中线横向排布:首个(lead)居中,其余左右展开
  const inBlock = [...host.agents.values()].filter(s => s.channelId === a.channelId).length
  const colSlot = Math.floor(inBlock / 2)
  const x = bx + (inBlock === 0 ? 0 : (inBlock % 2 === 0 ? -1 : 1) * (colSlot > 0 ? colSlot * 54 : 54))
  const y = by + 12 + Math.floor(inBlock / 2) * 16

  const sprite = host.physics.add.sprite(x, y, sheet, 0)
  const sbody = sprite.body as Phaser.Physics.Arcade.Body
  sbody.setSize(18, 18)
  sbody.setOffset(15, 66)
  sprite.setCollideWorldBounds(true)
  sprite.setDepth(y)
  sprite.anims.play(`wu-bob-${sheet}`, true)

  // 共鸣灵光:同频道同色(频道共鸣色 tint),居中于角色身体,形成"周身散发同色光"的环绕感
  const aura = host.add.image(x, y, 'wu-aura')
    .setTint(colorNum).setAlpha(0.42).setDepth(y - 10).setScale(1.5)
  host.tweens.add({ targets: aura, alpha: { from: 0.30, to: 0.56 }, scale: { from: 1.35, to: 1.65 }, yoyo: true, repeat: -1, duration: 2200, ease: 'sine.inout' })

  // 头顶:状态环 + 名字 + 进度(名字牌用频道共鸣色)
  const statusRing = host.add.graphics().setDepth(y + 200)
  const nameLabel = host.add.text(x, y - 30, a.name, {
    fontFamily: 'Geist, PingFang SC, sans-serif',
    fontSize: '10.5px',
    fontStyle: '600',
    color: '#ffffff',
    padding: { x: 6, y: 2 },
  }).setOrigin(0.5, 1).setDepth(y + 200)
  nameLabel.setStyle({ backgroundColor: `rgba(18,20,30,0.62)`, color: '#fff' })
  const progressLabel = host.add.text(x, y - 44, '', {
    fontFamily: 'Geist Mono, monospace',
    fontSize: '9px',
    color: '#4c8f63',
    backgroundColor: 'rgba(255,255,255,0.85)',
    padding: { x: 4, y: 1 },
  }).setOrigin(0.5, 1).setDepth(y + 200)

  host.agents.set(key, {
    channelId: a.channelId,
    agentId: a.agentId,
    name: a.name,
    role: a.role,
    sprite,
    aura,
    statusRing,
    nameLabel,
    progressLabel,
    bubble: null,
    bubbleTimer: null,
    state: a.state,
    progress: a.currentTaskProgress ?? null,
    dragging: false,
    homeX: x,
    homeY: y,
    textureKey: sheet,
    modelRef: a.modelRef ?? '',
    behavior: {
      mode: 'idle',
      roamTarget: null,
      targetId: null,
      waitUntil: 0,
      engaged: false,
    },
  })
  // 所有角色都允许用户手动拖动到地图任意位置
  enableDraggable(host, host.agents.get(key)!)
  host.agentCount = host.agents.size
  host.emit('agentCount', host.agentCount)
  return true
}

/** 让全部角色可被用户拖动(手动定位到地图任意位置) */
export function enableDraggable(host: TownAgentHost, asp: AgentSprite): void {
  const sprite = asp.sprite
  sprite.setInteractive({ draggable: true, useHandCursor: true })
  sprite.on('dragstart', () => {
    asp.dragging = true
    // 拖动期间暂停自动行为与物理
    ;(sprite.body as Phaser.Physics.Arcade.Body).setEnable(false)
    asp.behavior.engaged = false
    sprite.setDepth(host.worldYMax + 500)
    sprite.setAlpha(0.96)
    sprite.setScale(1.12)
  })
  sprite.on('drag', (_p: Phaser.Input.Pointer, dragX: number, dragY: number) => {
    sprite.setPosition(dragX, dragY)
    asp.aura.setPosition(dragX, dragY)
    asp.nameLabel.setPosition(dragX, dragY - 30)
    asp.progressLabel.setPosition(dragX, dragY - 44)
    asp.statusRing.setPosition(dragX, dragY - 18)
    asp.sprite.setDepth(dragY)
    asp.aura.setDepth(dragY - 10)
  })
  sprite.on('dragend', () => {
    asp.dragging = false
    sprite.setScale(1)
    sprite.setAlpha(1)
    ;(sprite.body as Phaser.Physics.Arcade.Body).setEnable(true)
    ;(sprite.body as Phaser.Physics.Arcade.Body).stop()
    ;(sprite.body as Phaser.Physics.Arcade.Body).reset(sprite.x, sprite.y)
    // 落点即新 home:行为结束后回归用户放置的位置
    asp.homeX = sprite.x
    asp.homeY = sprite.y
    asp.behavior.mode = 'idle'
    asp.behavior.roamTarget = null
    asp.behavior.targetId = null
    asp.behavior.engaged = false
  })
}

/** 就近角色(落点 80px 内) */
export function nearestAgent(host: TownAgentHost, x: number, y: number, maxDist: number): AgentSprite | undefined {
  let best: AgentSprite | undefined
  let bestD = maxDist
  for (const a of host.agents.values()) {
    const d = Math.hypot(a.sprite.x - x, a.sprite.y - y)
    if (d < bestD) {
      best = a
      bestD = d
    }
  }
  return best
}

/** 换装:改纹理 key + 重播动画 + 记录 modelRef */
export function swapTexture(host: TownAgentHost, asp: AgentSprite, texKey: string): void {
  if (!host.textures.exists(texKey)) return
  asp.sprite.setTexture(texKey)
  asp.sprite.anims.play(`wu-bob-${texKey}`, true)
  asp.textureKey = texKey
  // 仅当 texKey 是自定义模型 id 时记录;内置员工模型不回写(避免覆盖引导)
  asp.modelRef = texKey
}

/** 在落点生成一个可拖拽居民(无 agent 绑定;纯装饰,游走于频道外) */
export function spawnResident(host: TownAgentHost, x: number, y: number, texKey: string, name: string): void {
  const sprite = host.physics.add.sprite(x, y, texKey, 0)
  const sbody = sprite.body as Phaser.Physics.Arcade.Body
  sbody.setSize(18, 18)
  sbody.setOffset(15, 66)
  sprite.setCollideWorldBounds(true)
  sprite.setDepth(y)
  sprite.anims.play(`wu-bob-${texKey}`, true)
  const aura = host.add.image(x, y, 'wu-aura').setTint(0xffe9c4).setAlpha(0.35).setDepth(y - 10).setScale(1.2)
  host.tweens.add({ targets: aura, alpha: { from: 0.25, to: 0.5 }, scale: { from: 1.05, to: 1.4 }, yoyo: true, repeat: -1, duration: 2400, ease: 'sine.inout' })
  const label = host.add.text(x, y - 30, name, {
    fontFamily: 'Geist, PingFang SC, sans-serif',
    fontSize: '10px', fontStyle: '600', color: '#fff', padding: { x: 6, y: 2 },
  }).setOrigin(0.5, 1).setDepth(y + 200).setStyle({ backgroundColor: 'rgba(18,20,30,0.62)' })
  // 作为轻量"居民"注册进 agents,便于拖动/显示(标记为 decor 角色,不入 agentCount 统计语义)
  const statusRing = host.add.graphics().setDepth(y + 200)
  const progressLabel = host.add.text(x, y - 44, '', {
    fontFamily: 'Geist Mono, monospace',
    fontSize: '9px',
    color: '#4c8f63',
    backgroundColor: 'rgba(255,255,255,0.85)',
    padding: { x: 4, y: 1 },
  }).setOrigin(0.5, 1).setDepth(y + 200)
  const decor: AgentSprite = {
    channelId: '',
    agentId: `resident-${Date.now().toString(36)}`,
    name,
    role: 'worker',
    sprite,
    aura,
    statusRing,
    nameLabel: label,
    progressLabel,
    bubble: null,
    bubbleTimer: null,
    state: 'idle',
    progress: null,
    dragging: false,
    homeX: x,
    homeY: y,
    textureKey: texKey,
    modelRef: texKey,
    behavior: { mode: 'idle', roamTarget: null, targetId: null, waitUntil: 0, engaged: false },
  }
  host.agents.set(decor.agentId, decor)
  enableDraggable(host, decor)
}

export function drawStatusRing(asp: AgentSprite): void {
  const g = asp.statusRing
  g.clear()
  // 状态点放在名字牌左侧边缘(不遮挡):y 轴与 nameLabel 底对齐
  const labelW = asp.nameLabel.width
  const x = asp.sprite.x - labelW / 2 - 5
  const y = asp.sprite.y - 20
  const color = asp.state === 'busy' ? 0xefb56a : asp.state === 'stopped' ? 0xc25a4e : 0x9ecb7a
  g.fillStyle(color, 1)
  g.fillCircle(x, y, 3)
  if (asp.state === 'busy') {
    g.lineStyle(1.5, 0xefb56a, 0.6)
    g.strokeCircle(x, y, 6)
  }
}
