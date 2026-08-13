/**
 * Tuxemon Town — 2D 自由探索 RPG demo 场景(Phaser 4,后端事件驱动)
 *
 * 渲染层职责(不决策):
 *  - 渲染: tilemap / 玩家 / 金币 / 静态 NPC / Agent(后端指令驱动)
 *  - 输入采样:玩家本地即时移动(手感)+ 节流上报后端(感知)
 *  - 执行下行指令:handleCommand() 驱动 Agent 移动/朝向/气泡/对话
 *  - 与 Vue HUD 通过事件总线通信
 *
 * 权威边界: 玩家控制权在前端,Agent 控制权在后端。
 */
import Phaser from 'phaser'
import { PLAYER_POS_THROTTLE, type AgentMode, type ClientToServer, type Dir, type ServerToClient } from './protocol'

/** 场景 -> Vue HUD 事件(泛型分发) */
export type RpgEventMap = {
  pos: { x: number, y: number, tileX: number, tileY: number }
  fps: number
  coins: number
  agentState: { mode: AgentMode, speed: number }
  dialog: { agentName: string, lines: string[] } | null
  dialogAdvance: boolean
  dialogClose: boolean
  gameError: { code: string, message: string }
  ready: boolean
}

/** 金币摆放坐标(由地图可走区域 + BFS 连通性验证生成,像素坐标,位于 tile 中心) */
const COIN_SPOTS: ReadonlyArray<readonly [number, number]> = [
  [624, 592], [752, 592], [112, 720], [240, 720],
  [112, 336], [240, 336], [368, 336], [496, 336], [624, 336], [752, 336],
  [112, 464], [112, 592], [240, 592], [368, 592],
]

/** 静态装饰 NPC(无对话,仅待机动画;对话由后端 Agent 提供) */
const NPC_DEFS = [
  { key: 'npc-tux', sheet: 'npc-tux', frames: [0, 1, 2, 3, 4, 5, 6, 7], x: 496, y: 592 },
  { key: 'npc-rockitten', sheet: 'npc-rockitten', frames: [8, 9, 10, 11, 12, 13, 14, 15], x: 880, y: 592 },
  { key: 'npc-boltnu', sheet: 'npc-boltnu', frames: [0, 1, 2, 3, 4, 5, 6, 7], x: 112, y: 880 },
] as const

const WALK_SPEED = 165
const PLAYER_FRAME_W = 16
const PLAYER_FRAME_H = 32

/** 下行移动指令的方向向量 */
const DIR_VEC: Record<Dir, { dx: number, dy: number }> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
}

export class RpgScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite
  private npcs: Phaser.Physics.Arcade.Sprite[] = []
  private coins!: Phaser.Physics.Arcade.StaticGroup
  private worldLayer!: Phaser.Tilemaps.TilemapLayer
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys
  private keyW!: Phaser.Input.Keyboard.Key
  private keyA!: Phaser.Input.Keyboard.Key
  private keyS!: Phaser.Input.Keyboard.Key
  private keyD!: Phaser.Input.Keyboard.Key
  private keySpace!: Phaser.Input.Keyboard.Key
  private keyR!: Phaser.Input.Keyboard.Key

  // ---- Agent(后端指令驱动) ----
  private agent!: Phaser.Physics.Arcade.Sprite
  private agentSpeed = 120
  private agentMode: AgentMode = 'idle'
  private agentMoveTimer: Phaser.Time.TimerEvent | null = null
  private agentMoveCount = 0
  private agentBubble: Phaser.GameObjects.Container | null = null
  private agentBubbleTimer: Phaser.Time.TimerEvent | null = null
  private lastBubble: { text: string, at: number } | null = null

  // ---- 玩家感知状态 ----
  private facing: 'down' | 'left' | 'right' | 'up' = 'down'
  private lastInputDx: -1 | 0 | 1 = 0
  private lastInputDy: -1 | 0 | 1 = 0
  private coinsCollected = 0
  private dialogOpen = false
  private lastPosEmit = 0
  private lastAgentEmit = 0
  private debugMove: { dx: -1 | 0 | 1, dy: -1 | 0 | 1 } | null = null

  /** E2E 注入移动方向(null 恢复键盘;走完整物理/碰撞/上报链路) */
  setDebugMove(move: { dx: -1 | 0 | 1, dy: -1 | 0 | 1 } | null): void {
    this.debugMove = move
  }

  /**
   * E2E 注入:传送玩家到像素坐标并立即上报位置。
   * 走真实 player.pos 上行链路,由后端大脑感知距离触发对话——
   * 使对话协议闭环测试摆脱导航不确定性(生产无调用)。
   */
  setDebugPos(x: number, y: number): void {
    this.player.setPosition(x, y)
    ;(this.player.body as Phaser.Physics.Arcade.Body).reset(x, y)
    this.send({ type: 'player.pos', payload: this.readPos() })
  }

  /** 上行传输(由 Vue 注入 GameClient.send) */
  private transport: ((msg: ClientToServer) => void) | null = null

  private readonly bus = new Phaser.Events.EventEmitter()
  private lastEmit = 0
  private frameCount = 0
  private fpsAccum = 0

  /** 场景外部(Vue)订阅事件 */
  on<K extends keyof RpgEventMap>(event: K, fn: (e: RpgEventMap[K]) => void): () => void {
    this.bus.on(event, fn)
    return () => this.bus.off(event, fn)
  }

  /** 注入上行传输(WS 客户端) */
  setTransport(send: (msg: ClientToServer) => void): void {
    this.transport = send
  }

  private send(msg: ClientToServer): void {
    this.transport?.(msg)
  }

  preload(): void {
    this.load.tilemapTiledJSON('town', '/assets/game/tuxemon-town.json')
    this.load.image('tileset', '/assets/game/tuxmon-sample-32px-extruded.png')
    this.load.spritesheet('misa', '/assets/game/player-sheet.png', {
      frameWidth: PLAYER_FRAME_W,
      frameHeight: PLAYER_FRAME_H,
    })
    this.load.image('coin', '/assets/game/coin.png')
    this.load.spritesheet('npc-tux', '/assets/game/npc/tux-sheet.png', { frameWidth: 16, frameHeight: 44 })
    this.load.spritesheet('npc-rockitten', '/assets/game/npc/rockitten-sheet.png', { frameWidth: 16, frameHeight: 44 })
    this.load.spritesheet('npc-boltnu', '/assets/game/npc/boltnu-sheet.png', { frameWidth: 16, frameHeight: 44 })
    this.load.spritesheet('npc-fluttaflap', '/assets/game/npc/fluttaflap-sheet.png', { frameWidth: 16, frameHeight: 44 })
  }

  create(): void {
    // ---------- 地图 ----------
    const map = this.make.tilemap({ key: 'town' })
    const tileset = map.addTilesetImage('tuxmon-sample-32px-extruded', 'tileset')
    if (!tileset) {
      throw new Error('tileset 加载失败')
    }
    map.createLayer('Below Player', tileset, 0, 0)
    this.worldLayer = map.createLayer('World', tileset, 0, 0) as Phaser.Tilemaps.TilemapLayer
    const above = map.createLayer('Above Player', tileset, 0, 0)
    above?.setDepth(100)

    this.worldLayer.setCollisionByProperty({ collides: true })

    // ---------- 出生点 ----------
    const spawn = map.findObject('Objects', o => o.name === 'Spawn Point') ?? { x: 352, y: 1216 }
    const worldW = map.widthInPixels
    const worldH = map.heightInPixels

    // ---------- 玩家 ----------
    this.player = this.physics.add.sprite(spawn.x as number, spawn.y as number, 'misa', 0)
    const body = this.player.body as Phaser.Physics.Arcade.Body
    body.setSize(12, 14)
    body.setOffset(2, 18)
    this.player.setDepth(spawn.y as number)

    this.physics.world.setBounds(0, 0, worldW, worldH)
    this.player.setCollideWorldBounds(true)

    this.createAnimations()
    this.player.anims.play('misa-down-idle')
    this.physics.add.collider(this.player, this.worldLayer)

    // ---------- 金币 ----------
    this.coins = this.physics.add.staticGroup()
    for (const [x, y] of COIN_SPOTS) {
      const coin = this.coins.create(x, y, 'coin') as Phaser.Physics.Arcade.Sprite
      coin.setDepth(y)
      this.tweens.add({
        targets: coin,
        scale: { from: 0.9, to: 1.05 },
        duration: 600,
        yoyo: true,
        repeat: -1,
        ease: 'sine.inout',
      })
    }
    this.physics.add.overlap(this.player, this.coins, (_p, c) => {
      const coin = c as Phaser.Physics.Arcade.Sprite
      coin.disableBody(true, true)
      this.coinsCollected += 1
      this.burstParticles(coin.x, coin.y)
      this.bus.emit('coins', this.coinsCollected)
    })

    // ---------- 静态装饰 NPC ----------
    for (const def of NPC_DEFS) {
      const npc = this.physics.add.sprite(def.x, def.y, def.sheet, def.frames[0])
      const npcBody = npc.body as Phaser.Physics.Arcade.Body
      npcBody.setSize(12, 14)
      npcBody.setOffset(2, 30)
      npc.setImmovable(true)
      npc.setDepth(def.y)
      npc.anims.play(`npc-${def.key}`, true)
      this.tweens.add({
        targets: npc,
        y: def.y - 2,
        duration: 800 + NPC_DEFS.indexOf(def) * 200,
        yoyo: true,
        repeat: -1,
        ease: 'sine.inout',
      })
      this.npcs.push(npc)
      this.physics.add.collider(this.player, npc)
    }

    // ---------- Agent 精灵(等待后端 session.ready 放置) ----------
    this.agent = this.physics.add.sprite(0, 0, 'npc-fluttaflap', 8)
    const agentBody = this.agent.body as Phaser.Physics.Arcade.Body
    agentBody.setSize(12, 14)
    agentBody.setOffset(2, 30)
    this.agent.setImmovable(true)
    this.agent.setVisible(false)
    this.agent.setDepth(0)
    // 初始禁用 body:占位 (0,0) 可能与碰撞 tile 重叠,激活的 body 会污染物理世界
    agentBody.enable = false
    this.agent.setCollideWorldBounds(true)
    // Agent 与地图碰撞(物理上可被地形阻挡),但玩家可穿过 Agent:
    // Agent 是后端驱动的伙伴而非障碍,推挤玩家会破坏前后端位置一致性
    this.physics.add.collider(this.agent, this.worldLayer)

    // ---------- 相机 ----------
    const cam = this.cameras.main
    cam.setBounds(0, 0, worldW, worldH)
    cam.startFollow(this.player, true, 0.09, 0.09)
    cam.setRoundPixels(true)

    // ---------- 输入 ----------
    this.cursors = this.input.keyboard!.createCursorKeys()
    this.keyW = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W)
    this.keyA = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A)
    this.keyS = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S)
    this.keyD = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D)
    this.keySpace = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE)
    this.keyR = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.R)
    this.input.keyboard!.addCapture([Phaser.Input.Keyboard.KeyCodes.SPACE, Phaser.Input.Keyboard.KeyCodes.UP, Phaser.Input.Keyboard.KeyCodes.DOWN, Phaser.Input.Keyboard.KeyCodes.LEFT, Phaser.Input.Keyboard.KeyCodes.RIGHT])

    // 交互请求上行:对话推进由后端权威决定
    this.input.keyboard!.on('keydown-SPACE', () => this.send({ type: 'input.interact', payload: {} }))
    this.input.keyboard!.on('keydown-ENTER', () => this.send({ type: 'input.interact', payload: {} }))

    // R:重置金币(本地)
    this.keyR.on('down', () => {
      this.coinsCollected = 0
      this.bus.emit('coins', 0)
      this.coins.getChildren().forEach((c) => {
        const coin = c as Phaser.Physics.Arcade.Sprite
        coin.enableBody(true, coin.x, coin.y, true, true)
      })
    })

    // ---------- 就绪 ----------
    this.events.once('shutdown', () => console.log('[rpg] scene shutdown'))
    this.events.once('stop', () => console.log('[rpg] scene stopped'))
    this.events.once('destroy', () => console.log('[rpg] scene destroyed'))
    this.bus.emit('ready', true)
  }

  // ================================================================
  // 下行指令执行层(后端事件驱动入口)
  // ================================================================

  handleCommand(cmd: ServerToClient): void {
    switch (cmd.type) {
      case 'session.ready': {
        const { spawn } = cmd.payload
        this.agent.setPosition(spawn.x, spawn.y)
        this.agent.setVisible(true)
        this.agent.setDepth(spawn.y)
        ;(this.agent.body as Phaser.Physics.Arcade.Body).enable = true
        this.agent.anims.play('npc-fluttaflap', true)
        break
      }
      case 'agent.state':
        this.agentMode = cmd.payload.mode
        this.agentSpeed = cmd.payload.speed
        this.bus.emit('agentState', { mode: this.agentMode, speed: this.agentSpeed })
        break
      case 'agent.move': {
        const { dir, durationMs } = cmd.payload
        const v = DIR_VEC[dir]
        this.agentMoveCount += 1
        if (this.agentMoveTimer) {
          this.agentMoveTimer.remove(false)
          this.agentMoveTimer = null
        }
        this.agent.setVelocity(v.dx * this.agentSpeed, v.dy * this.agentSpeed)
        this.agent.setFlipX(dir === 'left')
        this.agentMoveTimer = this.time.delayedCall(durationMs, () => {
          this.agent.setVelocity(0, 0)
          this.agentMoveTimer = null
        })
        break
      }
      case 'agent.face':
        this.agent.setFlipX(cmd.payload.dir === 'left')
        break
      case 'agent.say':
        this.showBubble(cmd.payload.text, cmd.payload.ttlMs)
        break
      case 'dialog.open':
        this.dialogOpen = true
        this.player.setVelocity(0, 0)
        this.player.anims.play(`misa-${this.facing}-idle`, true)
        this.bus.emit('dialog', { agentName: cmd.payload.agentName, lines: cmd.payload.lines })
        break
      case 'dialog.advance':
        this.bus.emit('dialogAdvance', true)
        break
      case 'dialog.close':
        this.dialogOpen = false
        this.bus.emit('dialogClose', true)
        break
      case 'error':
        this.bus.emit('gameError', cmd.payload)
        break
    }
  }

  /** Agent 头顶气泡 */
  private showBubble(text: string, ttlMs: number): void {
    this.lastBubble = { text, at: Date.now() }
    if (this.agentBubble) {
      this.agentBubble.destroy()
      this.agentBubble = null
    }
    if (this.agentBubbleTimer) {
      this.agentBubbleTimer.remove(false)
      this.agentBubbleTimer = null
    }
    const bg = this.add.rectangle(0, 0, 10, 10, 0x000000, 0.75)
    const label = this.add.text(0, 0, text, {
      fontFamily: 'Segoe UI, PingFang SC, Microsoft YaHei, sans-serif',
      fontSize: '11px',
      color: '#ffffff',
      padding: { x: 8, y: 4 },
    })
    const w = label.width + 16
    const h = label.height + 8
    bg.setSize(w, h)
    const container = this.add.container(this.agent.x, this.agent.y - 38, [bg, label])
    container.setDepth(200)
    container.setAlpha(0)
    this.tweens.add({ targets: container, alpha: 1, y: this.agent.y - 42, duration: 160 })
    this.agentBubble = container
    this.agentBubbleTimer = this.time.delayedCall(ttlMs, () => {
      this.tweens.add({
        targets: container,
        alpha: 0,
        y: container.y - 6,
        duration: 200,
        onComplete: () => container.destroy(),
      })
      this.agentBubble = null
      this.agentBubbleTimer = null
    })
  }

  /** 调试钩子(E2E 断言用) */
  getDebugState(): {
    agent: { x: number, y: number, mode: AgentMode, visible: boolean, moveCount: number }
    lastBubble: { text: string, at: number } | null
    dialogOpen: boolean
  } {
    return {
      agent: {
        x: Math.round(this.agent.x),
        y: Math.round(this.agent.y),
        mode: this.agentMode,
        visible: this.agent.visible,
        moveCount: this.agentMoveCount,
      },
      lastBubble: this.lastBubble,
      dialogOpen: this.dialogOpen,
    }
  }

  /** 金币收集粒子爆发 */
  private burstParticles(x: number, y: number): void {
    const emitter = this.add.particles(x, y, 'coin', {
      speed: { min: 40, max: 120 },
      angle: { min: 210, max: 330 },
      scale: { start: 0.6, end: 0 },
      lifespan: 420,
      quantity: 10,
      emitting: false,
    })
    emitter.explode(10)
    this.time.delayedCall(600, () => emitter.destroy())
  }

  private createAnimations(): void {
    const mk = (name: string, start: number) => {
      this.anims.create({
        key: `misa-${name}-walk`,
        frames: this.anims.generateFrameNumbers('misa', { start: start + 1, end: start + 4 }),
        frameRate: 8,
        repeat: -1,
      })
      this.anims.create({
        key: `misa-${name}-idle`,
        frames: [{ key: 'misa', frame: start }],
        frameRate: 1,
        repeat: -1,
      })
    }
    mk('down', 0)
    mk('left', 5)
    mk('right', 10)
    mk('up', 15)

    for (const def of NPC_DEFS) {
      this.anims.create({
        key: `npc-${def.key}`,
        frames: def.frames.map(f => ({ key: def.sheet, frame: f })),
        frameRate: 8,
        repeat: -1,
      })
    }
    this.anims.create({
      key: 'npc-fluttaflap',
      frames: [8, 9, 10, 11, 12, 13, 14, 15].map(f => ({ key: 'npc-fluttaflap', frame: f })),
      frameRate: 8,
      repeat: -1,
    })
  }

  private readPos(): { x: number, y: number, tileX: number, tileY: number } {
    return {
      x: Math.round(this.player.x),
      y: Math.round(this.player.y),
      tileX: Math.floor(this.player.x / 32),
      tileY: Math.floor(this.player.y / 32),
    }
  }

  override update(_t: number, delta: number): void {
    if (!Number.isFinite(this.player.x)) {
      const b = this.player.body as Phaser.Physics.Arcade.Body
      console.warn('[rpg] player NaN!', JSON.stringify({
        x: this.player.x,
        y: this.player.y,
        body: { x: b.x, y: b.y, enable: b.enable, vx: b.velocity.x, vy: b.velocity.y, blocked: { ...b.blocked } },
        keys: { w: this.keyW.isDown, a: this.keyA.isDown, s: this.keyS.isDown, d: this.keyD.isDown, up: this.cursors.up.isDown },
        dialog: this.dialogOpen,
        debugMove: this.debugMove,
        agent: { x: this.agent.x, y: this.agent.y },
      }))
    }
    // ---------- 玩家移动(本地即时 + 输入状态变化上报) ----------
    let dx = 0
    let dy = 0
    if (this.debugMove) {
      dx = this.debugMove.dx
      dy = this.debugMove.dy
    }
    else {
      if (this.cursors.left.isDown || this.keyA.isDown) dx -= 1
      if (this.cursors.right.isDown || this.keyD.isDown) dx += 1
      if (this.cursors.up.isDown || this.keyW.isDown) dy -= 1
      if (this.cursors.down.isDown || this.keyS.isDown) dy += 1
    }

    if (!this.dialogOpen) {
      const moving = dx !== 0 || dy !== 0
      if (moving) {
        const len = Math.hypot(dx, dy)
        this.player.setVelocity((dx / len) * WALK_SPEED, (dy / len) * WALK_SPEED)
        const next: typeof this.facing = dx < 0 ? 'left' : dx > 0 ? 'right' : dy < 0 ? 'up' : 'down'
        if (next !== this.facing) {
          this.facing = next
          this.player.anims.play(`misa-${this.facing}-walk`, true)
        }
        else if (!this.player.anims.isPlaying) {
          this.player.anims.play(`misa-${this.facing}-walk`, true)
        }
      }
      else {
        this.player.setVelocity(0, 0)
        const idleKey = `misa-${this.facing}-idle`
        if (this.player.anims.currentAnim?.key !== idleKey) {
          this.player.anims.play(idleKey, true)
        }
      }
    }

    // 输入状态变化 → 上行(input.move)
    const nx = dx as -1 | 0 | 1
    const ny = dy as -1 | 0 | 1
    if (nx !== this.lastInputDx || ny !== this.lastInputDy) {
      this.lastInputDx = nx
      this.lastInputDy = ny
      this.send({ type: 'input.move', payload: { dx: nx, dy: ny } })
    }

    // 位置节流上报(供 Agent 感知玩家)
    this.lastPosEmit += delta
    if (this.lastPosEmit >= PLAYER_POS_THROTTLE) {
      this.lastPosEmit = 0
      this.send({ type: 'player.pos', payload: this.readPos() })
    }

    // Agent 渲染位置事实上报(服务端大脑据此计算真实距离;物理碰撞在客户端)
    this.lastAgentEmit += delta
    if (this.lastAgentEmit >= PLAYER_POS_THROTTLE && this.agent.visible) {
      this.lastAgentEmit = 0
      this.send({
        type: 'agent.pos',
        payload: { x: Math.round(this.agent.x), y: Math.round(this.agent.y) },
      })
    }
    // ---------- 深度排序 ----------
    this.player.setDepth(this.player.y)
    for (const npc of this.npcs) {
      npc.setDepth(npc.y)
    }
    if (this.agent.visible) {
      this.agent.setDepth(this.agent.y)
    }

    // ---------- HUD 节流推送 ----------
    this.frameCount += 1
    this.fpsAccum += delta
    if (this.fpsAccum >= 1000) {
      this.bus.emit('fps', this.frameCount)
      this.frameCount = 0
      this.fpsAccum = 0
    }
    this.lastEmit += delta
    if (this.lastEmit >= 60) {
      this.lastEmit = 0
      this.bus.emit('pos', this.readPos())
    }
  }
}
