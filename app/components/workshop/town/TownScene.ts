/**
 * AgentTeam RPG 小镇(鸣潮·共鸣黄昏版)— Phaser 2D 实时可视化场景。
 *
 * 渲染层职责(只渲染,不决策):
 *  - 背景:原创「共鸣黄昏」场景地图(黄昏天空/山脊/台地),不再是白色方块。
 *  - 每个 Channel → 地图上一片同色「共鸣领地」(环形能场 + 柔光,频道色=领地色);
 *  - 每个 Agent → 一个飘逸「共鸣精魂」sprite,头顶名字/状态环/进度条;
 *  - 同一 Channel 的 Agent 共享同一种领地共鸣色:脚下灵光(aura)颜色一致,一眼可辨"谁属于哪个频道";
 *  - 所有 Agent 均可被用户手动拖动到地图任意位置(拖动期间暂停自动行为,松手后落点即新 home);
 *  - 事件驱动(useTownBus 旁路,与时间线同源)→ 头顶气泡 / 状态环 / 进度 / 行为 FSM;
 *  - `getDebugState()` 暴露渲染态供浏览器断言。
 *
 * 数据源:初始实体来自 Vue 传入 entities 快照;实时增量来自 handleTownEvent(AEP)。
 */
import * as Phaser from 'phaser'
import type { AepEnvelope } from '#shared/workshop-protocol'
import { mapEnvelopeToIntent, type TownBubbleKind } from '#shared/town-protocol'
import { parseActionFromEnvelope, stepToward, type ActionKind, type ActionContext } from '#shared/town-behavior'
import { resolveAnimDef, type ModelAnimSpec } from '#shared/town-anim'

/** 场景 → Vue HUD 事件 */
export type TownEventMap = {
  ready: boolean
  fps: number
  agentCount: number
  blockCount: number
  /** 最后一个气泡(去重去抖动):HUD 显示"此刻谁在说话" */
  lastActivity: { channelId: string, agentName: string, text: string } | null
  /** 行为动作日志(供调试/E2E 断言"角色跑去下发任务") */
  behavior: { agentName: string, action: string, targetName: string | null } | null
}

/** 由 Vue entities store 传入的初始实体基线 */
export interface TownEntityInput {
  channelId: string
  channelName: string
  agents: Array<{
    agentId: string
    name: string
    role: 'lead' | 'worker'
    harness: string
    state: 'idle' | 'busy' | 'stopped'
    currentTaskId?: string | null
    currentTaskTitle?: string | null
    currentTaskProgress?: number | null
    /** 用户给该角色绑定的自定义模型(assetId;缺省用内置精魂) */
    modelRef?: string | null
  }>
}

/** 频道共鸣领地渲染态 */
interface TownBlockDef {
  channelId: string
  name: string
  centerX: number
  centerY: number
  radius: number
  /** 频道共鸣色(number,供 tint) */
  colorNum: number
  /** 频道共鸣色(css rgba,供名字牌) */
  rgba: string
}

/** 角色 sprite 渲染态 */
interface AgentSprite {
  channelId: string
  agentId: string
  name: string
  role: 'lead' | 'worker'
  sprite: Phaser.Physics.Arcade.Sprite
  /** 脚下共鸣灵光(同频道同色) */
  aura: Phaser.GameObjects.Image
  /** 状态环(头顶) */
  statusRing: Phaser.GameObjects.Graphics
  /** 名字标签(头顶) */
  nameLabel: Phaser.GameObjects.Text
  /** 进度标签(busy 时) */
  progressLabel: Phaser.GameObjects.Text
  /** 当前气泡(每 agent 至多一个) */
  bubble: Phaser.GameObjects.Container | null
  bubbleTimer: Phaser.Time.TimerEvent | null
  state: 'idle' | 'busy' | 'stopped'
  progress: number | null
  /** 行为状态机 */
  behavior: BehaviorState
  /** 用户正在拖动此 sprite(拖动期间暂停自动行为) */
  dragging: boolean
  /** 初始身位(成员原生位置,行为结束后回归;用户拖动后更新为落点) */
  homeX: number
  homeY: number
  /** 当前渲染纹理 key(内置 wu-* 或自定义模型) */
  textureKey: string
  /** 用户绑定的自定义模型 id(缺省空字符串=内置) */
  modelRef: string
}

/** 行为状态机(标准 AI 控制:事件→决策→动作) */
type BehaviorMode
  = | 'idle' // 待机(位于 home)
    | 'roam' // 在领地内/附近游走(来回移动)
    | 'approach' // 跑去目标(下发任务/通信)
    | 'wait' // 在目标附近等待回复/执行结果
    | 'returnHome' // 事毕回归出生位

interface BehaviorState {
  mode: BehaviorMode
  /** 游走目标点(来回移动端点) */
  roamTarget: { x: number, y: number } | null
  /** 目标角色(跑去下发/通信对象) */
  targetId: string | null
  /** 等待计时(到点返回) */
  waitUntil: number
  /** 行为动作日志(调试) */
  action?: { kind: ActionKind, taskKind?: string, requireReply: boolean, text: string }
  /** 是否正被他人「跑来下发/通信」(被 approach 或 wait)中 —— 暂停自身游走,驻足配合 */
  engaged: boolean
}

// ---- 世界尺度(大坐标世界:3200×2400) ----
const WORLD_W = 3200
const WORLD_H = 2400
/** 领地带基线(台地可立足区) */
const FIELD_Y = 1760
/** 环形大道布点:街区围绕世界中心围成一圈 */
const WORLD_CX = WORLD_W / 2
const WORLD_CY = FIELD_Y
const RING_RADIUS_X = 980
const RING_RADIUS_Y = 560

/** worker sprite 图集候选(按 agentId 哈希选长相;均为共鸣精魂) */
const WORKER_SHEETS = ['wu-worker-0', 'wu-worker-1', 'wu-worker-2'] as const
const LEAD_SHEET = 'wu-lead'
const WALK_SPEED = 150

/** 角色行为运动速度(下发任务跑动 / 游走) */
const AGENT_SPEED = 96
/** 等待回复/执行结果时长(ms) */
const WAIT_MS = 2600

/** 气泡配色 */
const BUBBLE_STYLE: Record<TownBubbleKind, { bg: number, fg: string }> = {
  info: { bg: 0x1c1917, fg: '#ffffff' },
  artifact: { bg: 0x1c1917, fg: '#9ecb7a' },
  error: { bg: 0x3a1d1c, fg: '#ff9e9e' },
  system: { bg: 0x1c1917, fg: '#c9c4bd' },
}

// ---- 频道共鸣色(稳定,同频道同色) ----
function hashHue(id: string): number {
  if (!id) return 200
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}
function channelColorNum(channelId: string): number {
  const c = Phaser.Display.Color.HSLToColor(hashHue(channelId) / 360, 0.58, 0.6)
  return c.color
}
function channelRGBA(channelId: string, alpha = 1): string {
  const c = Phaser.Display.Color.HSLToColor(hashHue(channelId) / 360, 0.58, 0.6)
  return `rgba(${c.red},${c.green},${c.blue},${alpha})`
}

export class TownScene extends Phaser.Scene {
  private blocks = new Map<string, TownBlockDef>()
  private agents = new Map<string, AgentSprite>()
  /** 领地/装饰(game objects),resetAll 时销毁 */
  private blockDecor: Phaser.GameObjects.GameObject[] = []
  private mapBg!: Phaser.GameObjects.Image
  /** 视差背景层(远/中);scroll 因子控制不同步平移 */
  private farLayer!: Phaser.GameObjects.Image
  private midLayer!: Phaser.GameObjects.Image
  private scrollFactorFar = 0.06
  private scrollFactorMid = 0.14
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys
  private keyW!: Phaser.Input.Keyboard.Key
  private keyA!: Phaser.Input.Keyboard.Key
  private keyS!: Phaser.Input.Keyboard.Key
  private keyD!: Phaser.Input.Keyboard.Key
  private player!: Phaser.Physics.Arcade.Sprite
  private facing: 'down' | 'left' | 'right' | 'up' = 'down'
  private dirty = true
  private dbgBubbles: Array<{ text: string, at: number }> = []
  private dbgActivity: { channelId: string, agentName: string, text: string } | null = null
  /** 最近活动队列(跑马灯,上限 6) */
  private recentActivity: Array<{ channelId: string, agentName: string, text: string }> = []
  private agentCount = 0
  private blockCount = 0

  private frameCount = 0
  private fpsAccum = 0
  private readonly bus = new Phaser.Events.EventEmitter()
  /** 已注册的自定义模型(id → file),供拖拽换装/生成用 */
  private modelsById = new Map<string, { id: string, file: string, name: string, spec?: ModelAnimSpec }>()
  /** 任务 ID → assignee 反查(由 Vue 注入;mock 任务投递缺 target-agent 时用) */
  resolveTaskAssignee: ((taskId: string) => string | null) | null = null

  constructor(seed?: TownEntityInput[]) {
    super('town')
    if (seed) this._seed = seed
  }

  on<K extends keyof TownEventMap>(event: K, fn: (e: TownEventMap[K]) => void): () => void {
    this.bus.on(event, fn)
    return () => this.bus.off(event, fn)
  }

  private emit<K extends keyof TownEventMap>(event: K, e: TownEventMap[K]): void {
    this.bus.emit(event, e)
  }

  /** 初始化实体基线(挂载后、场景 create 前调用;快照未到时为空) */
  seedEntities(channels: TownEntityInput[]): void {
    this._seed = channels
  }

  /** 快照后重建:全量替换领地与角色(丢弃旧树) */
  rebuild(channels: TownEntityInput[]): void {
    this.resetAll()
    this._seed = channels
    this.buildBlocks()
  }

  /** 聚焦某频道领地(传送玩家 + 镜头;用于深链/截图稳定) */
  focusChannel(channelId: string): void {
    const def = this.blocks.get(channelId)
    if (!def) return
    this.player.setPosition(def.centerX, def.centerY + 70)
    ;(this.player.body as Phaser.Physics.Arcade.Body).reset(def.centerX, def.centerY + 70)
    this.cameras.main.centerOn(def.centerX, def.centerY + 70)
  }

  private _seed: TownEntityInput[] = []

  preload(): void {
    // 大世界分层背景(远山天空 / 中景城市 / 近景台地)
    this.load.image('world-far', '/assets/game/wuwa/world-far.png')
    this.load.image('world-middle', '/assets/game/wuwa/world-middle.png')
    this.load.image('world-near', '/assets/game/wuwa/world-near.png')
    // 辉光/环/飘带(运行时 tint 成频道共鸣色)
    this.load.image('wu-aura', '/assets/game/wuwa/wu-aura.png')
    this.load.image('wu-ring', '/assets/game/wuwa/wu-ring.png')
    this.load.image('wu-slash', '/assets/game/wuwa/wu-slash.png')
    // 共鸣精魂 sprite(4 帧悬停 bob;48x88 → 192x88)
    const fr = { frameWidth: 48, frameHeight: 88 }
    this.load.spritesheet(LEAD_SHEET, '/assets/game/wuwa/wu-lead.png', fr)
    this.load.spritesheet('wu-worker-0', '/assets/game/wuwa/wu-worker-0.png', fr)
    this.load.spritesheet('wu-worker-1', '/assets/game/wuwa/wu-worker-1.png', fr)
    this.load.spritesheet('wu-worker-2', '/assets/game/wuwa/wu-worker-2.png', fr)
    // 角色模型库(可拖拽加载的自定义模型;与内置同帧布局,textures 在 create 前就绪)
    this.load.spritesheet('knight', '/assets/game/character/knight.png', fr)
    this.load.spritesheet('mage', '/assets/game/character/mage.png', fr)
    this.load.spritesheet('bot', '/assets/game/character/bot.png', fr)
  }

  create(): void {
    // ---------- 世界地面(近景台地,随相机滚动) ----------
    this.mapBg = this.add.image(WORLD_W / 2, WORLD_H / 2, 'world-near')
      .setDisplaySize(WORLD_W, WORLD_H)
      .setDepth(-1000)
    this.physics.world.setBounds(0, 0, WORLD_W, WORLD_H)

    // ---------- 视差背景(远山天空/城市剪影:相机固定,轻微不同步 → 纵深) ----------
    this.scrollFactorFar = 0.06
    this.scrollFactorMid = 0.14
    this.createParallax()

    this.createAnimations()

    // ---------- 玩家(镜头跟随;WASD/方向键漫游;滚轮缩放) ----------
    this.viewer = this.physics.add.sprite(WORLD_W / 2, FIELD_Y, LEAD_SHEET, 0)
    this.viewer.setScale(1.05)
    const vbody = this.viewer.body as Phaser.Physics.Arcade.Body
    vbody.setSize(18, 18)
    vbody.setOffset(15, 66)
    this.viewer.setCollideWorldBounds(true)
    this.viewer.setDepth(this.viewer.y)
    this.viewer.anims.play(`wu-bob-${LEAD_SHEET}`, true)
    // 玩家脚下微光(与频道区分:中性暖白)
    this.playerAura = this.add.image(this.viewer.x, this.viewer.y, 'wu-aura')
      .setTint(0xffe9c4).setAlpha(0.45).setDepth(this.viewer.y - 10).setScale(1.3)

    const cam = this.cameras.main
    cam.setBounds(0, 0, WORLD_W, WORLD_H)
    cam.startFollow(this.viewer, true, 0.09, 0.09)
    cam.setRoundPixels(true)
    cam.setZoom(1.0)
    this.input.on('wheel', (_p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => {
      const nz = cam.zoom + (dy < 0 ? 0.06 : -0.06)
      cam.setZoom(Phaser.Math.Clamp(nz, 0.7, 1.4))
    })

    // ---------- 输入 ----------
    this.cursors = this.input.keyboard!.createCursorKeys()
    this.keyW = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W)
    this.keyA = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A)
    this.keyS = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S)
    this.keyD = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D)

    // ---------- 领地 + 角色 ----------
    this.buildBlocks()
    this.drawCore()

    // 镜头聚焦镇中心:玩家传送到第一领地附近
    const firstDef = this.blocks.values().next().value
    if (firstDef) {
      this.viewer.setPosition(firstDef.centerX, firstDef.centerY + 70)
      ;(this.viewer.body as Phaser.Physics.Arcade.Body).reset(firstDef.centerX, firstDef.centerY + 70)
      cam.centerOn(firstDef.centerX, firstDef.centerY + 70)
    }
    this.emit('ready', true)
  }

  private viewer!: Phaser.Physics.Arcade.Sprite
  private playerAura!: Phaser.GameObjects.Image

  /**
   * 视差背景:远山天空/城市剪影按相机 scroll 因子不同步平移,产生纵深。
   * 层固定在相机上(scrollFactor=0),位置随 update 里相机 scroll 反推。
   */
  private createParallax(): void {
    const cam = this.cameras.main
    // 铺满视野(约 1100x700 @ zoom1),随 zoom 放大
    this.farLayer = this.add.image(WORLD_W / 2, WORLD_H / 2, 'world-far')
      .setScrollFactor(0).setDepth(-1200)
    this.midLayer = this.add.image(WORLD_W / 2, WORLD_H / 2, 'world-middle')
      .setScrollFactor(0).setDepth(-1150)
    // 初始尺寸
    void cam
  }

  /** 每帧按相机 scroll 让视差层产生缓慢位移(远层更慢) */
  private updateParallax(): void {
    const cam = this.cameras.main
    // 以世界中心为锚:相机偏离中心越多,背景偏移越多(但远层偏移更少 → 相对慢速)
    const dx = (cam.scrollX + cam.width / 2) - WORLD_CX
    const dy = (cam.scrollY + cam.height / 2) - WORLD_CY
    const f = cam.zoom
    this.farLayer.setPosition(cam.width / 2 - dx * this.scrollFactorFar / f, cam.height / 2 - dy * this.scrollFactorFar / f)
    this.midLayer.setPosition(cam.width / 2 - dx * this.scrollFactorMid / f, cam.height / 2 - dy * this.scrollFactorMid / f)
    // 随缩放放大背景(与视野同比例)
    this.farLayer.setScale(Math.max(0.6, 0.6 / f))
    this.midLayer.setScale(Math.max(0.72, 0.72 / f))
  }

  /** 依据实体基线建领地与角色(围绕世界中心的环形大道布点) */
  buildBlocks(): void {
    const seeds = this._seed ?? []
    const count = Math.max(1, seeds.length)
    const RING_X = RING_RADIUS_X
    const RING_Y = RING_RADIUS_Y
    const radius = count <= 1 ? 210 : Math.min(210, 300 - count * 8)

    seeds.forEach((ch, i) => {
      // 环形布点:沿椭圆等分角度,中心对称、有机不呆板
      const ang = i === 0 ? -Math.PI / 2 : -Math.PI / 2 + (i * 2 * Math.PI) / count
      const cx = WORLD_CX + Math.cos(ang) * RING_X
      const cy = WORLD_CY + Math.sin(ang) * RING_Y
      const def: TownBlockDef = {
        channelId: ch.channelId,
        name: ch.channelName,
        centerX: Math.round(cx),
        centerY: Math.round(cy),
        radius,
        colorNum: channelColorNum(ch.channelId),
        rgba: channelRGBA(ch.channelId, 0.9),
      }
      this.blocks.set(ch.channelId, def)
      this.drawBlock(def)
      for (const a of ch.agents) {
        this.ensureAgentSprite({ ...a, channelId: ch.channelId }, def.centerX, def.centerY)
      }
    })
    this.blockCount = this.blocks.size
    this.agentCount = this.agents.size
    this.dirty = true
    this.emit('blockCount', this.blockCount)
    this.emit('agentCount', this.agentCount)
  }

  /** 建一片频道共鸣领地(环形能场 + 柔光 + 频道名牌;无白色方块) */
  private drawBlock(def: TownBlockDef): void {
    const { centerX: cx, centerY: cy, radius: r, colorNum } = def
    // 地面柔光(大面积低透明,暗示能场)
    const field = this.add.image(cx, cy, 'wu-aura')
      .setScale(r / 56).setTint(colorNum).setAlpha(0.30).setDepth(-20)
    // 环形能场边界(呼吸)
    const ring = this.add.image(cx, cy, 'wu-ring')
      .setScale(r / 128).setTint(colorNum).setAlpha(0.55).setDepth(-19)
    this.tweens.add({
      targets: ring,
      alpha: { from: 0.35, to: 0.6 },
      scale: { from: (r / 128) * 0.96, to: (r / 128) * 1.04 },
      yoyo: true,
      repeat: -1,
      duration: 2400,
      ease: 'sine.inout',
    })
    // 频道名牌(顶部) —— 由 drawLandmark 挂在塔顶
    const stroke = this.add.graphics().setDepth(-18)
    stroke.lineStyle(1.2, colorNum, 0.4)
    stroke.strokeCircle(cx, cy, r)
    // 地面柔软阴影(建筑/领地投影,低透明)
    const shadow = this.add.image(cx, cy + 22, 'wu-aura')
      .setScale(r / 52).setTint(0x0a1410).setAlpha(0.22).setDepth(-17)
    this.blockDecor.push(field, ring, stroke, shadow)

    this.drawLandmark(def)
  }

  /**
   * 街区地标建筑(2.5D 挤出:顶面 + 侧壁,侧壁随朝向变暗 → 有体积)。
   * 用 wu-ring 作底座 + wu-aura 作顶面辉光,叠加成一座低模塔;无真实 tile 也能有"人工建筑"体积感。
   */
  private drawLandmark(def: TownBlockDef): void {
    const { centerX: cx, centerY: cy, radius: r, colorNum } = def
    const baseY = cy - r * 0.55
    // 底座(地面投影)
    const base = this.add.ellipse(cx, baseY, r * 0.5, r * 0.2, colorNum, 0.55).setDepth(-16)
    // 塔身(侧壁,深色→体积,受夕阳侧光:右亮左暗)
    const body = this.add.rectangle(cx, baseY - 42, r * 0.34, 88, colorNum, 0.85).setDepth(baseY - 20).setOrigin(0.5, 1)
    body.setStrokeStyle(1.5, colorNum, 0.6)
    // 顶面(略亮,承接天光)
    const top = this.add.ellipse(cx, baseY - 84, r * 0.4, r * 0.16, 0xffffff, 0.28).setDepth(baseY - 20)
    top.setStrokeStyle(1.5, colorNum, 0.6)
    // 顶面光柱(呼吸)
    const beam = this.add.image(cx, baseY - 120, 'wu-aura')
      .setScale(0.9).setTint(0xfff0cf).setAlpha(0.5).setDepth(baseY - 20)
    this.tweens.add({ targets: beam, alpha: { from: 0.3, to: 0.6 }, scale: { from: 0.7, to: 1.05 }, yoyo: true, repeat: -1, duration: 1800, ease: 'sine.inout' })
    // 频道名牌(挂在塔顶)
    const plaque = this.add.text(cx, baseY - 128, def.name, {
      fontFamily: 'Geist, PingFang SC, sans-serif',
      fontSize: '13px',
      fontStyle: '600',
      color: '#fff',
      padding: { x: 10, y: 4 },
      backgroundColor: 'rgba(18,20,30,0.6)',
    }).setOrigin(0.5).setDepth(baseY - 19)
    // 色盲徽记:频道用几何形状区分(不单靠色相),置于名牌上方
    const emblem = this.drawEmblem(cx, baseY - 148, colorNum, def.channelId)
    this.blockDecor.push(base, body, top, beam, plaque, emblem)
  }

  /** 频道几何徽记(色盲友好:形状+色双通道);形状由 channelId 哈希稳定决定 */
  private drawEmblem(cx: number, cy: number, colorNum: number, channelId: string): Phaser.GameObjects.Graphics {
    const g = this.add.graphics().setDepth(cy + 1000)
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
  private drawCore(): void {
    const cx = WORLD_CX
    const cy = WORLD_CY
    // 塔基能量场(大面积)
    const field = this.add.image(cx, cy, 'wu-aura').setScale(6).setTint(0x9fe8d4).setAlpha(0.28).setDepth(-20)
    // 塔身(多层收窄的能量柱)
    const body = this.add.rectangle(cx, cy - 90, 120, 300, 0x8fe8d4, 0.7).setOrigin(0.5, 1).setDepth(cy - 22)
    body.setStrokeStyle(2, 0xd8fff2, 0.6)
    const body2 = this.add.rectangle(cx, cy - 220, 70, 180, 0xc4f4e8, 0.75).setOrigin(0.5, 1).setDepth(cy - 21)
    // 顶部光球(呼吸)
    const orb = this.add.image(cx, cy - 320, 'wu-aura').setScale(1.4).setTint(0xeafff8).setAlpha(0.9).setDepth(cy - 20)
    this.tweens.add({ targets: orb, alpha: { from: 0.7, to: 1 }, scale: { from: 1.2, to: 1.6 }, yoyo: true, repeat: -1, duration: 1600, ease: 'sine.inout' })
    // 塔名
    const label = this.add.text(cx, cy - 360, '共鸣核心', {
      fontFamily: 'Geist, PingFang SC, sans-serif',
      fontSize: '14px',
      fontStyle: '600',
      color: '#fff',
      padding: { x: 12, y: 5 },
      backgroundColor: 'rgba(18,20,30,0.6)',
    }).setOrigin(0.5).setDepth(cy - 19)
    this.blockDecor.push(field, body, body2, orb, label)
  }

  /** 确保某 agent 的 sprite 存在(不存在则建);返回是否新建 */
  private ensureAgentSprite(
    a: { channelId: string, agentId: string, name: string, role: 'lead' | 'worker', state: 'idle' | 'busy' | 'stopped', currentTaskProgress?: number | null, modelRef?: string | null },
    cx?: number,
    cy?: number,
  ): boolean {
    const key = a.agentId
    if (this.agents.has(key)) {
      this.agents.get(key)!.state = a.state
      return false
    }
    const def = this.blocks.get(a.channelId)
    const colorNum = def?.colorNum ?? channelColorNum(a.channelId)
    const builtinSheet = a.role === 'lead' ? LEAD_SHEET : WORKER_SHEETS[Math.abs(a.agentId.split('').reduce((h, c) => h * 31 + c.charCodeAt(0), 0)) % WORKER_SHEETS.length]!
    // 模型绑定:若该角色绑定了自定义模型且纹理已注册,则用之;否则回退内置精魂
    const sheet = a.modelRef && this.textures.exists(a.modelRef) ? a.modelRef : builtinSheet
    const bx = def?.centerX ?? cx ?? 400
    const by = def?.centerY ?? cy ?? 300
    // 领地成员沿中线横向排布:首个(lead)居中,其余左右展开
    const inBlock = [...this.agents.values()].filter(s => s.channelId === a.channelId).length
    const colSlot = Math.floor(inBlock / 2)
    const x = bx + (inBlock === 0 ? 0 : (inBlock % 2 === 0 ? -1 : 1) * (colSlot > 0 ? colSlot * 54 : 54))
    const y = by + 12 + Math.floor(inBlock / 2) * 16

    const sprite = this.physics.add.sprite(x, y, sheet, 0)
    const sbody = sprite.body as Phaser.Physics.Arcade.Body
    sbody.setSize(18, 18)
    sbody.setOffset(15, 66)
    sprite.setCollideWorldBounds(true)
    sprite.setDepth(y)
    sprite.anims.play(`wu-bob-${sheet}`, true)

    // 共鸣灵光:同频道同色(频道共鸣色 tint),居中于角色身体,形成"周身散发同色光"的环绕感
    const aura = this.add.image(x, y, 'wu-aura')
      .setTint(colorNum).setAlpha(0.42).setDepth(y - 10).setScale(1.5)
    this.tweens.add({ targets: aura, alpha: { from: 0.30, to: 0.56 }, scale: { from: 1.35, to: 1.65 }, yoyo: true, repeat: -1, duration: 2200, ease: 'sine.inout' })

    // 头顶:状态环 + 名字 + 进度(名字牌用频道共鸣色)
    const statusRing = this.add.graphics().setDepth(y + 200)
    const nameLabel = this.add.text(x, y - 30, a.name, {
      fontFamily: 'Geist, PingFang SC, sans-serif',
      fontSize: '10.5px',
      fontStyle: '600',
      color: '#ffffff',
      padding: { x: 6, y: 2 },
    }).setOrigin(0.5, 1).setDepth(y + 200)
    nameLabel.setStyle({ backgroundColor: `rgba(18,20,30,0.62)`, color: '#fff' })
    const progressLabel = this.add.text(x, y - 44, '', {
      fontFamily: 'Geist Mono, monospace',
      fontSize: '9px',
      color: '#4c8f63',
      backgroundColor: 'rgba(255,255,255,0.85)',
      padding: { x: 4, y: 1 },
    }).setOrigin(0.5, 1).setDepth(y + 200)

    this.agents.set(key, {
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
    this.enableDraggable(this.agents.get(key)!)
    this.agentCount = this.agents.size
    this.emit('agentCount', this.agentCount)
    return true
  }

  /** 让全部角色可被用户拖动(手动定位到地图任意位置) */
  private enableDraggable(asp: AgentSprite): void {
    const sprite = asp.sprite
    sprite.setInteractive({ draggable: true, useHandCursor: true })
    sprite.on('dragstart', () => {
      asp.dragging = true
      // 拖动期间暂停自动行为与物理
      ;(sprite.body as Phaser.Physics.Arcade.Body).setEnable(false)
      asp.behavior.engaged = false
      sprite.setDepth(this.worldYMax + 500)
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

  private get worldYMax(): number { return WORLD_H }

  // ================================================================
  // 模型库 → 场景(拖拽加载 / 换装 / 落地生成)
  // ================================================================

  /** 批量注册模型库清单(由 Vue 从 useCharacterAssets 注入;幂等) */
  registerModelsFromList(list: Array<{ id: string, file: string, name: string, spec?: ModelAnimSpec }>) {
    for (const m of list) {
      if (!this.modelsById.has(m.id)) {
        this.modelsById.set(m.id, { id: m.id, file: m.file, name: m.name, spec: m.spec })
      }
      if (m.spec) this.animSpecs.set(m.id, m.spec)
      // 注意:此处不得调用 ensureSheetAnims —— 场景尚未挂到 game,this.anims/this.textures 未初始化。
      // 动画统一在 create()/createAnimations() 里建(那时 game 已挂载)。
    }
  }

  /**
   * 注册一个自定义模型(按 assetId 从模型库清单查 file);幂等。
   * 记录元信息 + 帧布局,加载纹理动画。成功返回 true。
   */
  registerModelFromId(id: string, file: string, name: string, spec?: ModelAnimSpec): boolean {
    if (!this.modelsById.has(id)) this.modelsById.set(id, { id, file, name, spec })
    if (spec) this.animSpecs.set(id, spec)
    if (this.textures.exists(id)) {
      this.ensureSheetAnims(id)
      return true
    }
    return false
  }

  /**
   * HTML5 拖拽落下 → 落到某个角色上则「换装」该角色,否则在落点「生成一个居民」。
   * assetId 由 AssetLibrary 的 dragstart 写入 dataTransfer。
   */
  dropModelOnWorld(worldX: number, worldY: number, assetId: string): { mode: 'rebind' | 'spawn', agentId?: string, textureKey: string, x: number, y: number } {
    // 就近找落点 80px 内的角色
    const near = this.nearestAgent(worldX, worldY, 80)
    const model = this.modelsById.get(assetId)
    const texKey = model?.id ?? assetId
    // 若纹理未注册,先按模型库 file 加载(无则回退 assetId,可能为空 → 显示原纹理)
    if (model && !this.textures.exists(texKey)) this.registerModelFromId(assetId, model.file, model.name)
    if (near) {
      // 换装:直接改该角色所用纹理 + 动画 key
      this.swapTexture(near, texKey)
      this.showBubble(near.channelId, near.agentId, 'info', `换装 → ${model?.name ?? assetId}`, 2200)
      return { mode: 'rebind', agentId: near.agentId, textureKey: texKey, x: Math.round(near.sprite.x), y: Math.round(near.sprite.y) }
    }
    // 落点生成一个"居民"(可拖拽、可游走的装饰性角色;无实际 agent 绑定)
    if (this.textures.exists(texKey)) {
      this.spawnResident(worldX, worldY, texKey, model?.name ?? assetId)
      return { mode: 'spawn', textureKey: texKey, x: Math.round(worldX), y: Math.round(worldY) }
    }
    return { mode: 'rebind', textureKey: texKey, x: Math.round(worldX), y: Math.round(worldY) }
  }

  /** 就近角色(落点 80px 内) */
  private nearestAgent(x: number, y: number, maxDist: number): AgentSprite | undefined {
    let best: AgentSprite | undefined
    let bestD = maxDist
    for (const a of this.agents.values()) {
      const d = Math.hypot(a.sprite.x - x, a.sprite.y - y)
      if (d < bestD) {
        best = a
        bestD = d
      }
    }
    return best
  }

  /** 换装:改纹理 key + 重播动画 + 记录 modelRef */
  private swapTexture(asp: AgentSprite, texKey: string): void {
    if (!this.textures.exists(texKey)) return
    asp.sprite.setTexture(texKey)
    asp.sprite.anims.play(`wu-bob-${texKey}`, true)
    asp.textureKey = texKey
    // 仅当 texKey 是自定义模型 id 时记录;内置精魂不回写(避免覆盖引导)
    asp.modelRef = texKey
  }

  /** 在落点生成一个可拖拽居民(无 agent 绑定;纯装饰,游走于频道外) */
  private spawnResident(x: number, y: number, texKey: string, name: string): void {
    const sprite = this.physics.add.sprite(x, y, texKey, 0)
    const sbody = sprite.body as Phaser.Physics.Arcade.Body
    sbody.setSize(18, 18)
    sbody.setOffset(15, 66)
    sprite.setCollideWorldBounds(true)
    sprite.setDepth(y)
    sprite.anims.play(`wu-bob-${texKey}`, true)
    const aura = this.add.image(x, y, 'wu-aura').setTint(0xffe9c4).setAlpha(0.35).setDepth(y - 10).setScale(1.2)
    this.tweens.add({ targets: aura, alpha: { from: 0.25, to: 0.5 }, scale: { from: 1.05, to: 1.4 }, yoyo: true, repeat: -1, duration: 2400, ease: 'sine.inout' })
    const label = this.add.text(x, y - 30, name, {
      fontFamily: 'Geist, PingFang SC, sans-serif',
      fontSize: '10px', fontStyle: '600', color: '#fff', padding: { x: 6, y: 2 },
    }).setOrigin(0.5, 1).setDepth(y + 200).setStyle({ backgroundColor: 'rgba(18,20,30,0.62)' })
    // 作为轻量"居民"注册进 agents,便于拖动/显示(标记为 decor 角色,不入 agentCount 统计语义)
    const statusRing = this.add.graphics().setDepth(y + 200)
    const progressLabel = this.add.text(x, y - 44, '', {
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
    this.agents.set(decor.agentId, decor)
    this.enableDraggable(decor)
  }

  // ================================================================
  // 事件驱动入口(useTownBus 订阅转发)
  // ================================================================

  handleTownEvent(e: AepEnvelope): void {
    // channel.snapshot:实体基线重建(丢弃旧领地/角色,按新快照重建)
    if (e.type === 'channel.snapshot') {
      this.resetAll()
      return
    }
    const intent = mapEnvelopeToIntent(e)
    if (!intent) return

    // 角色状态/进度刷新
    if (intent.agentId) {
      const asp = this.agents.get(intent.agentId)
      if (asp) {
        if (e.type === 'agent.status') {
          asp.state = (e.payload as { state: 'idle' | 'busy' | 'stopped' }).state
          if (asp.state !== 'busy') asp.progress = null
        }
        if (e.type === 'task.progress') {
          asp.progress = (e.payload as { progress: number }).progress
        }
        this.dirty = true
      }
    }
    // 气泡
    if (intent.bubble) this.showBubble(intent.bubble.channelId, intent.bubble.agentId, intent.bubble.kind, intent.bubble.text, intent.bubble.ttlMs)

    // 事件共鸣可视化(说话脉冲 / 任务完成光柱 / 错误红涟漪 / 频道旗)
    this.emitResonance(e)

    // 行为驱动:点对点通信/任务投递 → 发送方跑去接收方身边下发;需回复则等待
    const action = parseActionFromEnvelope(e, { resolveTaskAssignee: this.resolveTaskAssignee ?? undefined })
    if (action) this.startBehavior(action)
  }

  /**
   * 事件 → 视觉共鸣(把目光吸过去,但不打断):
   *  - 消息类 → 说话者身上扩散一圈共鸣波纹(speaking pulse)
   *  - task.status(完成) → 频道领地冲出一道光柱 + 星星粒子
   *  - error → 该频道一圈红色涟漪 + 频道旗变红
   *  - task.status(其它/进行中) → 频道旗变黄(busy)
   */
  private emitResonance(e: AepEnvelope): void {
    const def = this.blocks.get(e.channelId)
    const asp = e.agentId ? this.agents.get(e.agentId) : undefined
    const cx = asp?.sprite.x ?? def?.centerX
    const cy = asp?.sprite.y ?? def?.centerY
    if (cx === undefined || cy === undefined) return

    if (e.type === 'agent.message' || e.type === 'agent.status.message' || e.type === 'a2a.message') {
      this.pulseRing(cx, cy, asp?.aura.tintTopLeft ?? def?.colorNum ?? 0xffffff, 0x9fe8d4)
    }
    else if (e.type === 'error') {
      this.pulseRing(cx, cy, 0xff6b6b, 0xff6b6b)
      this.setFlag(e.channelId, 'danger')
    }
    else if (e.type === 'task.status') {
      const state = (e.payload as { state?: string }).state
      if (state === 'completed') {
        this.lightColumn(cx, cy, 0xd8fff2)
      }
      else if (state === 'working' || state === 'assigned') {
        this.setFlag(e.channelId, 'busy')
      }
      else if (state === 'failed' || state === 'canceled') {
        this.pulseRing(cx, cy, 0xff9e6b, 0xff9e6b)
        this.setFlag(e.channelId, 'danger')
      }
      else if (state === 'waiting') {
        this.setFlag(e.channelId, 'wait')
      }
    }
  }

  /** 一个扩散共鸣波纹(圆环放大并淡出) */
  private pulseRing(x: number, y: number, color: number, _glow: number): void {
    const ring = this.add.image(x, y, 'wu-ring').setTint(color).setAlpha(0.8).setDepth(y + 300).setScale(0.3)
    this.tweens.add({
      targets: ring,
      scale: 2.2,
      alpha: 0,
      duration: 700,
      ease: 'sine.out',
      onComplete: () => ring.destroy(),
    })
  }

  /** 高频光柱(交付/完成时从频道领地冲天) */
  private lightColumn(x: number, y: number, color: number): void {
    const beam = this.add.image(x, y - 40, 'wu-aura').setTint(color).setAlpha(0.9).setDepth(y + 320).setScale(0, 6)
    this.tweens.add({
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
  private setFlag(channelId: string, state: 'busy' | 'wait' | 'danger'): void {
    const def = this.blocks.get(channelId)
    if (!def) return
    const color = state === 'danger' ? 0xff6b6b : state === 'wait' ? 0xf0c05a : 0x8fe8d4
    // 在塔顶光球处再放一个呼吸旗(轻量;若已存在则复用)
    let flag = this.flagBy.get(channelId)
    if (!flag) {
      flag = this.add.circle(def.centerX, def.centerY - 150, 10, color, 0.9).setDepth(def.centerY - 10)
      this.flagBy.set(channelId, flag)
      this.blockDecor.push(flag)
    }
    flag.setFillStyle(color, 0.9)
    this.tweens.add({ targets: flag, alpha: { from: 0.6, to: 1 }, yoyo: true, repeat: -1, duration: 800 })
  }

  /** 频道旗(顶球)缓存 */
  private flagBy = new Map<string, Phaser.GameObjects.Arc>()

  // ================================================================
  // 行为状态机(事件→决策→动作;标准 AI 控制游戏架构)
  // ================================================================

  /** 触发一次「跑去下发」行为:from 跑到 to 身边 */
  private startBehavior(action: ActionContext): void {
    const from = this.agents.get(action.fromId)
    const to = this.agents.get(action.toId)
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
    this.emit('behavior', {
      agentName: from.name,
      action: this.behaviorActionLabel(action.kind),
      targetName: to.name,
    })
  }

  private behaviorActionLabel(kind: ActionKind): string {
    return kind === 'task' ? '下发任务' : kind === 'reply' ? '回复' : '发送消息'
  }

  /**
   * 行为状态机逐帧执行(由 update 调用)。
   * 状态流转:approach(跑到下发对象)→ 到达 → 送达 → wait[需回复]/returnHome[否]→ roam。
   */
  private runBehavior(asp: AgentSprite, dt: number): void {
    const b = asp.behavior

    // ---------- roam:领地内来回移动(idle 时的默认行为;被邀请时驻足配合) ----------
    if (b.mode === 'idle' || b.mode === 'roam') {
      if (asp.behavior.engaged || asp.dragging) {
        this.stopAt(asp)
        return
      }
      b.mode = 'roam'
      if (!b.roamTarget) {
        const def = this.blocks.get(asp.channelId)
        const range = def?.radius ? def.radius * 0.5 : 80
        b.roamTarget = {
          x: asp.homeX + (Math.random() * 2 - 1) * range,
          y: asp.homeY + (Math.random() * 2 - 1) * range * 0.6,
        }
      }
      const ok = this.driveToward(asp, b.roamTarget, AGENT_SPEED * 0.5, dt)
      if (ok) b.roamTarget = null
      return
    }

    // ---------- approach:跑向下发对象 ----------
    if (b.mode === 'approach') {
      const target = b.targetId ? this.agents.get(b.targetId) : undefined
      if (!target) {
        this.stopAt(asp)
        b.mode = 'idle'
        return
      }
      const pos = { x: target.sprite.x, y: target.sprite.y }
      const arrived = this.driveToward(asp, pos, AGENT_SPEED, dt)
      if (arrived) {
        this.stopAt(asp)
        this.behaviorDeliver(asp, target)
        if (b.action?.requireReply) {
          b.mode = 'wait'
          b.waitUntil = this.time.now + WAIT_MS
        }
        else {
          b.mode = 'returnHome'
          this.releaseEngaged(asp)
          b.targetId = null
        }
      }
      return
    }

    // ---------- wait:在目标附近等待回复/执行结果 ----------
    if (b.mode === 'wait') {
      if (asp.dragging) {
        this.stopAt(asp)
        return
      }
      const target = b.targetId ? this.agents.get(b.targetId) : undefined
      if (target && !target.dragging) {
        const stand = { x: target.sprite.x + 28, y: target.sprite.y + 8 }
        this.driveToward(asp, stand, AGENT_SPEED * 0.6, dt)
      }
      else this.stopAt(asp)
      if (this.time.now >= b.waitUntil) {
        b.mode = 'returnHome'
        this.releaseEngaged(asp)
      }
      return
    }

    // ---------- returnHome:事毕回归出生位(用户拖动后为落点) ----------
    if (b.mode === 'returnHome') {
      if (asp.dragging) {
        this.stopAt(asp)
        return
      }
      const arrived = this.driveToward(asp, { x: asp.homeX, y: asp.homeY }, AGENT_SPEED * 0.7, dt)
      if (arrived) {
        this.stopAt(asp)
        asp.sprite.setPosition(asp.homeX, asp.homeY)
        b.mode = 'idle'
        b.targetId = null
        b.action = undefined
      }
      return
    }
  }

  /** 释放被本角色邀请(engaged)的目标:让其恢复游走 */
  private releaseEngaged(asp: AgentSprite): void {
    const target = asp.behavior.targetId ? this.agents.get(asp.behavior.targetId) : undefined
    if (target) target.behavior.engaged = false
  }

  /** 送达:在目标头上弹气泡(下发/通信内容) + 广播行为日志 */
  private behaviorDeliver(asp: AgentSprite, target: AgentSprite): void {
    const text = asp.behavior.action?.text ?? ''
    if (text) {
      this.showBubble(asp.channelId, target.agentId, 'info', text, 2600)
    }
    this.emit('behavior', {
      agentName: asp.name,
      action: this.behaviorActionLabel(asp.behavior.action?.kind ?? 'message'),
      targetName: target.name,
    })
  }

  /**
   * 驱动角色朝目标移动一步(stepToward 计算方向 → velocity)。
   * 返回是否已到达。速度随距离减速(近目标放缓,站位更自然)。
   */
  private driveToward(asp: AgentSprite, target: { x: number, y: number }, speed: number, dt: number): boolean {
    const body = asp.sprite.body as Phaser.Physics.Arcade.Body
    if (!body.enable) return false
    const cur = { x: asp.sprite.x, y: asp.sprite.y }
    const next = stepToward(cur, target, speed, dt)
    asp.sprite.setFlipX(next.dir === 'left')
    body.setVelocity((next.x - cur.x) / dt, (next.y - cur.y) / dt)
    // 行走态(与静止 bob 区分)
    this.playSheetAnim(asp.sprite, 'walk')
    return next.arrived
  }

  /** 停止角色运动(velocity=0) */
  private stopAt(asp: AgentSprite): void {
    const body = asp.sprite.body as Phaser.Physics.Arcade.Body | null
    body?.stop()
    this.playSheetAnim(asp.sprite, 'idle')
  }

  /** 统一播放某纹理的 idle/walk/work 动画;未注册时回退悬停 bob */
  private playSheetAnim(sprite: Phaser.GameObjects.Sprite, state: 'idle' | 'walk' | 'work'): void {
    const key = `${sprite.texture.key}-${state}`
    if (this.anims.exists(key)) {
      if (sprite.anims.currentAnim?.key !== key) sprite.anims.play(key, true)
    }
    else {
      const bobKey = `wu-bob-${sprite.texture.key}`
      if (this.anims.exists(bobKey) && sprite.anims.currentAnim?.key !== bobKey) sprite.anims.play(bobKey, true)
    }
  }

  // ================================================================
  // 头顶气泡(每 agent 至多一个;SLACK 白卡样式)
  // ================================================================

  private showBubble(channelId: string, agentId: string | undefined, kind: TownBubbleKind, text: string, ttlMs: number): void {
    const asp = agentId ? this.agents.get(agentId) : undefined
    const anchor = asp?.sprite
    // 无具体 agent 的气泡:挂到频道领地上方
    const def = this.blocks.get(channelId)
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

    const bg = this.add.rectangle(0, 0, 12, 12, style.bg, 0.94)
    const label = this.add.text(0, 0, text, {
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
    const container = this.add.container(ax, ay, [bg, label])
    container.setDepth(500)
    container.setAlpha(0)
    container.setScale(0.92)
    this.tweens.add({ targets: container, alpha: 1, y: ay - 6, scale: 1, duration: 180, ease: 'back.out' })

    this.dbgBubbles.push({ text, at: Date.now() })
    this.dbgActivity = { channelId, agentName: asp?.name ?? def?.name ?? '系统', text }
    this.recentActivity.push({ channelId, agentName: asp?.name ?? def?.name ?? '系统', text })
    if (this.recentActivity.length > 6) this.recentActivity.splice(0, this.recentActivity.length - 6)
    this.emit('lastActivity', this.dbgActivity)

    if (asp) {
      asp.bubble = container
      asp.bubbleTimer = this.time.delayedCall(ttlMs, () => {
        this.tweens.add({
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
      this.time.delayedCall(ttlMs, () => {
        this.tweens.add({ targets: container, alpha: 0, y: container.y - 8, duration: 220, onComplete: () => container.destroy() })
      })
    }
  }

  /** channel.snapshot 后重建(清空旧树,由 Vue 重新 seedEntities + buildBlocks) */
  resetAll(): void {
    for (const decor of this.blockDecor) decor.destroy()
    this.blockDecor = []
    for (const asp of this.agents.values()) {
      asp.sprite.destroy()
      asp.aura.destroy()
      asp.statusRing.destroy()
      asp.nameLabel.destroy()
      asp.progressLabel.destroy()
      if (asp.bubble) asp.bubble.destroy()
    }
    this.agents.clear()
    this.blocks.clear()
    this.flagBy.clear()
    // 通知 Vue 重建(快照携带完整实体)
    this.events.emit('town-reset')
  }

  // ================================================================
  // 调试/E2E 钩子
  // ================================================================

  getDebugState(): {
    blocks: number
    agents: Array<{ agentId: string, name: string, role: string, channelId: string, state: string, progress: number | null, x: number, y: number, visible: boolean, draggable: boolean, auraColor: number, behavior: string, targetId: string | null, homeX: number, homeY: number, textureKey: string, modelRef: string, decorated: boolean }>
    bubbles: Array<{ text: string, at: number }>
    activity: { channelId: string, agentName: string, text: string } | null
    player: { x: number, y: number }
  } {
    return {
      blocks: this.blocks.size,
      agents: [...this.agents.values()].map(a => ({
        agentId: a.agentId,
        name: a.name,
        role: a.role,
        channelId: a.channelId,
        state: a.state,
        progress: a.progress,
        x: Math.round(a.sprite.x),
        y: Math.round(a.sprite.y),
        visible: a.sprite.visible,
        draggable: a.sprite.input?.enabled ?? false,
        auraColor: a.aura.tintTopLeft,
        behavior: a.behavior.mode,
        targetId: a.behavior.targetId,
        homeX: a.homeX,
        homeY: a.homeY,
        textureKey: a.textureKey,
        modelRef: a.modelRef,
        decorated: !a.channelId,
      })),
      bubbles: this.dbgBubbles.slice(-8),
      activity: this.dbgActivity,
      player: { x: Math.round(this.viewer.x), y: Math.round(this.viewer.y) },
    }
  }

  /** 迷你地图数据:归一化(0~1)的领地/角色/玩家坐标 + 色相,供 Vue HUD 渲染缩略图 */
  getMinimapState(): {
    world: { w: number, h: number }
    blocks: Array<{ x: number, y: number, color: number, name: string }>
    agents: Array<{ x: number, y: number, color: number, busy: boolean }>
    player: { x: number, y: number }
  } {
    const nx = (x: number) => x / WORLD_W
    const ny = (y: number) => y / WORLD_H
    return {
      world: { w: WORLD_W, h: WORLD_H },
      blocks: [...this.blocks.values()].map(b => ({ x: nx(b.centerX), y: ny(b.centerY), color: b.colorNum, name: b.name })),
      agents: [...this.agents.values()].map(a => ({ x: nx(a.sprite.x), y: ny(a.sprite.y), color: a.aura.tintTopLeft, busy: a.state === 'busy' })),
      player: { x: nx(this.viewer.x), y: ny(this.viewer.y) },
    }
  }

  /** HUD 跑马灯数据:最近事件队列(上限 6) */
  getRecentActivity(): Array<{ channelId: string, agentName: string, text: string }> {
    return [...this.recentActivity]
  }

  private createAnimations(): void {
    const sheets = [...WORKER_SHEETS, LEAD_SHEET, 'knight', 'mage', 'bot']
    for (const sheet of sheets) {
      this.ensureSheetAnims(sheet)
    }
  }

  /** 为某纹理 key 建 idle/walk/work 三态动画(幂等);内置与自定义模型统一接口 */
  private ensureSheetAnims(key: string): void {
    const def = resolveAnimDef(key, this.animSpecs.get(key))
    for (const state of ['idle', 'walk', 'work'] as const) {
      const a = def[state]
      const animKey = a.key
      if (!this.anims.exists(animKey)) {
        this.anims.create({
          key: animKey,
          frames: this.anims.generateFrameNumbers(key, { start: a.start, end: a.end }),
          frameRate: a.frameRate,
          repeat: a.repeat,
        })
      }
    }
    // 兼容旧播放名 wu-bob-<key>(仍能播悬停)
    if (!this.anims.exists(`wu-bob-${key}`)) {
      this.anims.create({
        key: `wu-bob-${key}`,
        frames: this.anims.generateFrameNumbers(key, { start: 0, end: (this.animSpecs.get(key)?.frames ?? 4) - 1 }),
        frameRate: 3,
        repeat: -1,
      })
    }
  }

  /** 已声明帧布局的动画规格(自定义模型经 registerModelFromId 注入) */
  private animSpecs = new Map<string, ModelAnimSpec>()

  override update(_t: number, delta: number): void {
    // 玩家移动(漫游)
    let dx = 0
    let dy = 0
    if (this.cursors.left.isDown || this.keyA.isDown) dx -= 1
    if (this.cursors.right.isDown || this.keyD.isDown) dx += 1
    if (this.cursors.up.isDown || this.keyW.isDown) dy -= 1
    if (this.cursors.down.isDown || this.keyS.isDown) dy += 1
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy)
      this.viewer.setVelocity((dx / len) * WALK_SPEED, (dy / len) * WALK_SPEED)
      const next: typeof this.facing = dx < 0
        ? 'left'
        : dx > 0
          ? 'right'
          : dy < 0
            ? 'up'
            : 'down'
      if (next !== this.facing) {
        this.facing = next
        this.viewer.setFlipX(next === 'left')
        this.viewer.anims.play(`wu-bob-${LEAD_SHEET}`, true)
      }
    }
    else {
      this.viewer.setVelocity(0, 0)
    }

    // 深度排序 + 头顶标签跟随 + 行为状态机 + 视差
    this.updateParallax()
    this.viewer.setDepth(this.viewer.y)
    this.playerAura.setPosition(this.viewer.x, this.viewer.y)
    this.playerAura.setDepth(this.viewer.y - 10)
    for (const asp of this.agents.values()) {
      // 防御:snapshot 重建中 sprite 可能正被销毁(ensureAgentSprite/rebuild 竞态),跳过不崩溃
      if (!asp || !asp.sprite || !asp.sprite.body) continue
      // 行为驱动:stopped 成员不游走/不下发(保持静止);拖动中暂停;其余按 FSM 运动
      if (asp.state !== 'stopped' && !asp.dragging) {
        this.runBehavior(asp, delta / 1000)
      }
      else {
        this.stopAt(asp)
      }
      asp.sprite.setDepth(asp.sprite.y)
      asp.aura.setPosition(asp.sprite.x, asp.sprite.y)
      asp.aura.setDepth(asp.sprite.y - 10)
      asp.nameLabel.setPosition(asp.sprite.x, asp.sprite.y - 30)
      asp.nameLabel.setDepth(asp.sprite.y + 200)
      asp.progressLabel.setPosition(asp.sprite.x, asp.sprite.y - 44)
      asp.progressLabel.setDepth(asp.sprite.y + 200)
      // 状态环
      this.drawStatusRing(asp)
      // 进度标签
      if (asp.state === 'busy' && asp.progress != null) {
        asp.progressLabel.setText(`${asp.progress}%`)
        asp.progressLabel.setColor('#4c8f63')
        asp.progressLabel.setVisible(true)
      }
      else {
        asp.progressLabel.setVisible(false)
      }
    }

    // FPS
    this.frameCount += 1
    this.fpsAccum += delta
    if (this.fpsAccum >= 1000) {
      this.emit('fps', this.frameCount)
      this.frameCount = 0
      this.fpsAccum = 0
    }
  }

  private drawStatusRing(asp: AgentSprite): void {
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
}
