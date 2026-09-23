/**
 * AgentTeam RPG 小镇(鸣潮·共鸣黄昏版)— Phaser 2D 实时可视化场景。
 *
 * 渲染层职责(只渲染,不决策):
 *  - 背景:原创「共鸣黄昏」场景地图(黄昏天空/山脊/台地),不再是白色方块。
 *  - 每个 Channel → 地图上一片同色「共鸣领地」(环形能场 + 柔光,频道色=领地色);
 *  - 每个 Agent → 一个「员工」sprite(Leader/Worker 职务章),头顶名字/状态环/进度条;
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
import { parseActionFromEnvelope, type ActionContext } from '#shared/town-behavior'
import type { ModelAnimSpec } from '#shared/town-anim'
// 类型 / 世界常量 / 频道配色纯函数(自本文件抽出,细节定义见 town-scene-core.ts)
import {
  FIELD_Y, LEAD_SHEET, RING_RADIUS_X, RING_RADIUS_Y,
  WALK_SPEED, WORLD_CX, WORLD_CY, WORLD_H, WORLD_W,
  channelColorNum, channelRGBA,
  type AgentSprite, type TownBlockDef, type TownEntityInput, type TownEventMap,
} from './scene/town-scene-core'
// 表现 / 行为 / 气泡 / 角色 / 模型库模块(自本文件抽出;各模块只依赖宿主契约面,见各自文件头注释)
import { createParallax, drawBlock, drawCore, emitResonance, updateParallax } from './scene/town-scene-visuals'
import { runBehavior, startBehavior, stopAt } from './scene/town-scene-behavior'
import { showBubble } from './scene/town-scene-bubbles'
import { drawStatusRing, ensureAgentSprite, type AgentSpawnInput } from './scene/town-scene-agents'
import { createAnimations, dropModelOnWorld, registerModelFromId, registerModelsFromList, type ModelRegistryEntry } from './scene/town-scene-models'

export type { AgentSprite, TownBlockDef, TownEntityInput, TownEventMap } from './scene/town-scene-core'

export class TownScene extends Phaser.Scene {
  // ---- 宿主契约面:下列成员由 scene/town-scene-*.ts 模块经宿主接口读写(放宽可见性) ----
  //      blocks / agents / flagBy / farLayer / midLayer / scrollFactorFar / scrollFactorMid /
  //      dbgBubbles / dbgActivity / recentActivity / modelsById / animSpecs / worldYMax / emit / pushDecor
  blocks = new Map<string, TownBlockDef>()
  agents = new Map<string, AgentSprite>()
  /** 领地/装饰(game objects),resetAll 时销毁 */
  private blockDecor: Phaser.GameObjects.GameObject[] = []
  private mapBg!: Phaser.GameObjects.Image
  /** 视差背景层(远/中);scroll 因子控制不同步平移 */
  farLayer!: Phaser.GameObjects.Image
  midLayer!: Phaser.GameObjects.Image
  scrollFactorFar = 0.06
  scrollFactorMid = 0.14
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys
  private keyW!: Phaser.Input.Keyboard.Key
  private keyA!: Phaser.Input.Keyboard.Key
  private keyS!: Phaser.Input.Keyboard.Key
  private keyD!: Phaser.Input.Keyboard.Key
  private player!: Phaser.Physics.Arcade.Sprite
  private facing: 'down' | 'left' | 'right' | 'up' = 'down'
  private dirty = true
  dbgBubbles: Array<{ text: string, at: number }> = []
  dbgActivity: { channelId: string, agentName: string, text: string } | null = null
  /** 最近活动队列(跑马灯,上限 6) */
  recentActivity: Array<{ channelId: string, agentName: string, text: string }> = []
  agentCount = 0
  private blockCount = 0

  private frameCount = 0
  private fpsAccum = 0
  private readonly bus = new Phaser.Events.EventEmitter()
  /** 已注册的自定义模型(id → file),供拖拽换装/生成用 */
  modelsById = new Map<string, ModelRegistryEntry>()
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

  emit<K extends keyof TownEventMap>(event: K, e: TownEventMap[K]): void {
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
    // 员工 sprite(4 帧悬停 bob;48x88 → 192x88)
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

  get worldYMax(): number { return WORLD_H }

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

  /** 频道旗(顶球)缓存 */
  flagBy = new Map<string, Phaser.GameObjects.Arc>()

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
    devices: Array<{ x: number, y: number, color: number, state: string }>
    player: { x: number, y: number }
  } {
    const nx = (x: number) => x / WORLD_W
    const ny = (y: number) => y / WORLD_H
    return {
      world: { w: WORLD_W, h: WORLD_H },
      blocks: [...this.blocks.values()].map(b => ({ x: nx(b.centerX), y: ny(b.centerY), color: b.colorNum, name: b.name })),
      agents: [...this.agents.values()].map(a => ({ x: nx(a.sprite.x), y: ny(a.sprite.y), color: a.aura.tintTopLeft, busy: a.state === 'busy' })),
      devices: [],
      player: { x: nx(this.viewer.x), y: ny(this.viewer.y) },
    }
  }

  /** HUD 跑马灯数据:最近事件队列(上限 6) */
  getRecentActivity(): Array<{ channelId: string, agentName: string, text: string }> {
    return [...this.recentActivity]
  }

  /** 已声明帧布局的动画规格(自定义模型经 registerModelFromId 注入) */
  animSpecs = new Map<string, ModelAnimSpec>()

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

  // ================================================================
  // 抽出模块的薄委托(宿主契约面;实现见 scene/town-scene-*.ts)
  // ================================================================

  private createParallax(): void { createParallax(this) }
  private updateParallax(): void { updateParallax(this) }
  private drawCore(): void { drawCore(this) }
  private drawBlock(def: TownBlockDef): void { drawBlock(this, def) }
  private emitResonance(e: AepEnvelope): void { emitResonance(this, e) }
  private startBehavior(action: ActionContext): void { startBehavior(this, action) }
  private runBehavior(asp: AgentSprite, dt: number): void { runBehavior(this, asp, dt) }
  private stopAt(asp: AgentSprite): void { stopAt(this, asp) }
  private showBubble(channelId: string, agentId: string | undefined, kind: TownBubbleKind, text: string, ttlMs: number): void { showBubble(this, channelId, agentId, kind, text, ttlMs) }
  private drawStatusRing(asp: AgentSprite): void { drawStatusRing(asp) }
  private ensureAgentSprite(a: AgentSpawnInput, cx?: number, cy?: number): boolean { return ensureAgentSprite(this, a, cx, cy) }
  private createAnimations(): void { createAnimations(this) }

  /** 登记领地/装饰对象(resetAll 时统一销毁) */
  pushDecor(...objs: Phaser.GameObjects.GameObject[]): void {
    this.blockDecor.push(...objs)
  }

  // ---- 模型库公开 API 薄委托(实现 + 原文档注释见 scene/town-scene-models.ts) ----

  /** 批量注册模型库清单(由 Vue 从 useCharacterAssets 注入;幂等) */
  registerModelsFromList(list: Array<{ id: string, file: string, name: string, spec?: ModelAnimSpec }>): void {
    registerModelsFromList(this, list)
  }

  /** 注册一个自定义模型(按 assetId 从模型库清单查 file);幂等;纹理已就绪返回 true */
  registerModelFromId(id: string, file: string, name: string, spec?: ModelAnimSpec): boolean {
    return registerModelFromId(this, id, file, name, spec)
  }

  /** HTML5 拖拽落下 → 落到某个角色上则「换装」该角色,否则在落点「生成一个居民」 */
  dropModelOnWorld(worldX: number, worldY: number, assetId: string): { mode: 'rebind' | 'spawn', agentId?: string, textureKey: string, x: number, y: number } {
    return dropModelOnWorld(this, worldX, worldY, assetId)
  }
}
