/**
 * Tuxemon Town — 2D 自由探索 RPG demo 场景(Phaser 4)
 *
 * 核心系统:
 *  - Tiled tilemap 三层渲染 + tileset 属性碰撞
 *  - Arcade 物理:玩家移动 / 金币收集 / NPC 近身交互
 *  - 相机平滑跟随 + 地图边界约束
 *  - 4 方向行走动画状态机 + 深度排序
 *  - 与 Vue HUD 通过事件总线通信
 */
import Phaser from 'phaser'

/** 场景 -> Vue HUD 事件(泛型分发) */
export type RpgEventMap = {
  pos: { x: number, y: number, tileX: number, tileY: number }
  fps: number
  coins: number
  npcNear: { id: number, name: string } | null
  dialog: { npcId: number, npcName: string, lines: string[] } | null
  ready: boolean
}

/** 金币摆放坐标(由地图可走区域分析生成,像素坐标,位于 tile 中心) */
const COIN_SPOTS: ReadonlyArray<readonly [number, number]> = [
  [1040, 144], [1168, 176], [976, 272], [1168, 304],
  [112, 336], [240, 336], [368, 336], [496, 336], [624, 336], [752, 336],
  [112, 464], [112, 592], [240, 592], [368, 592],
]

/** NPC 定义:sheet 资源、动画帧范围、位置、名字、台词 */
const NPC_DEFS = [
  {
    key: 'npc-tux',
    sheet: 'npc-tux',
    frames: [0, 1, 2, 3, 4, 5, 6, 7],
    x: 496, y: 592,
    name: '图克斯',
    lines: ['欢迎来到图克斯镇!', '前方草丛里藏着野生图克斯兽。', '收集金币,和它们交朋友吧!'],
  },
  {
    key: 'npc-rockitten',
    sheet: 'npc-rockitten',
    frames: [8, 9, 10, 11, 12, 13, 14, 15],
    x: 880, y: 592,
    name: '岩石猫',
    lines: ['喵呜……(岩石构成的尾巴在发光)'],
  },
  {
    key: 'npc-boltnu',
    sheet: 'npc-boltnu',
    frames: [0, 1, 2, 3, 4, 5, 6, 7],
    x: 112, y: 880,
    name: '电光兽',
    lines: ['滋滋……小心!', '镇子东边的湖泊是它的地盘。'],
  },
] as const

const WALK_SPEED = 165
const PLAYER_FRAME_W = 16
const PLAYER_FRAME_H = 32

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

  private facing: 'down' | 'left' | 'right' | 'up' = 'down'
  private coinsCollected = 0
  private dialogOpen = false
  private nearNpc: { id: number, name: string } | null = null

  private readonly bus = new Phaser.Events.EventEmitter()
  private lastEmit = 0
  private frameCount = 0
  private fpsAccum = 0

  /** 场景外部(Vue)订阅事件 */
  on<K extends keyof RpgEventMap>(event: K, fn: (e: RpgEventMap[K]) => void): () => void {
    this.bus.on(event, fn)
    return () => this.bus.off(event, fn)
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
    // 树冠等"Above Player"层遮挡角色: 动态 depth,保持其在玩家上方
    above?.setDepth(100)

    // tileset 属性碰撞: collides=true 的 tile 参与物理
    this.worldLayer.setCollisionByProperty({ collides: true })

    // ---------- 出生点 ----------
    const spawn = map.findObject('Objects', o => o.name === 'Spawn Point') ?? { x: 352, y: 1216 }
    const worldW = map.widthInPixels
    const worldH = map.heightInPixels

    // ---------- 玩家 ----------
    this.player = this.physics.add.sprite(spawn.x as number, spawn.y as number, 'misa', 0)
    // 碰撞盒: 脚底 12x14,视觉 16x32
    const body = this.player.body as Phaser.Physics.Arcade.Body
    body.setSize(12, 14)
    body.setOffset(2, 18)
    this.player.setDepth(spawn.y as number)

    this.physics.world.setBounds(0, 0, worldW, worldH)
    this.player.setCollideWorldBounds(true)

    this.createAnimations()
    this.player.anims.play('misa-down-idle')

    // ---------- 碰撞:玩家 vs 地图 ----------
    this.physics.add.collider(this.player, this.worldLayer)

    // ---------- 金币 ----------
    this.coins = this.physics.add.staticGroup()
    for (const [x, y] of COIN_SPOTS) {
      const coin = this.coins.create(x, y, 'coin') as Phaser.Physics.Arcade.Sprite
      coin.setDepth(y)
      // 轻微旋转呼吸动画
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

    // ---------- NPC ----------
    for (const def of NPC_DEFS) {
      const npc = this.physics.add.sprite(def.x, def.y, def.sheet, def.frames[0])
      ;(npc.body as Phaser.Physics.Arcade.Body).setSize(12, 14)
      ;(npc.body as Phaser.Physics.Arcade.Body).setOffset(2, 30)
      npc.setImmovable(true)
      npc.setDepth(def.y)
      npc.setData('npcId', NPC_DEFS.indexOf(def))
      npc.setData('npcName', def.name)
      npc.setData('npcLines', def.lines)
      npc.anims.play(`npc-${def.key}`, true)
      // 待机微浮动
      this.tweens.add({
        targets: npc,
        y: def.y - 2,
        duration: 800 + NPC_DEFS.indexOf(def) * 200,
        yoyo: true,
        repeat: -1,
        ease: 'sine.inout',
      })
      this.npcs.push(npc)
    }
    // 玩家与 NPC 保持碰撞(NPC 不可推动,形成阻挡)
    for (const npc of this.npcs) {
      this.physics.add.collider(this.player, npc)
    }

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

    // 空格/回车:对话推进(仅在下一条出现时触发一次)
    this.input.keyboard!.on('keydown-SPACE', () => this.requestInteraction())
    this.input.keyboard!.on('keydown-ENTER', () => this.requestInteraction())

    // R:重置收集进度
    this.keyR.on('down', () => {
      this.coinsCollected = 0
      this.bus.emit('coins', 0)
      this.coins.getChildren().forEach((c) => {
        const coin = c as Phaser.Physics.Arcade.Sprite
        coin.enableBody(true, coin.x, coin.y, true, true)
      })
    })

    // ---------- 就绪 ----------
    this.bus.emit('ready', true)
    this.bus.emit('pos', this.readPos())
  }

  /** 交互入口:对话打开时推进台词,否则检测 NPC 触发对话 */
  private requestInteraction(): void {
    if (this.dialogOpen) {
      this.bus.emit('dialog', null) // Vue 侧负责"下一句/关闭"后回调 unlock
      return
    }
    if (this.nearNpc) {
      const def = NPC_DEFS[this.nearNpc.id]
      if (!def) {
        return
      }
      this.dialogOpen = true
      this.player.setVelocity(0, 0)
      this.player.anims.stop()
      this.player.setFrame(this.idleFrame())
      this.bus.emit('dialog', { npcId: this.nearNpc.id, npcName: def.name, lines: [...def.lines] })
    }
  }

  /** Vue 在对话框关闭时调用 */
  closeDialog(): void {
    this.dialogOpen = false
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
      // 每行 5 帧: 0=idle, 1-4=walk
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
  }

  private idleFrame(): number {
    const base = { down: 0, left: 5, right: 10, up: 15 }[this.facing]
    return base
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
    if (this.dialogOpen) {
      return
    }

    // ---------- 移动输入 ----------
    let dx = 0
    let dy = 0
    if (this.cursors.left.isDown || this.keyA.isDown) dx -= 1
    if (this.cursors.right.isDown || this.keyD.isDown) dx += 1
    if (this.cursors.up.isDown || this.keyW.isDown) dy -= 1
    if (this.cursors.down.isDown || this.keyS.isDown) dy += 1

    const moving = dx !== 0 || dy !== 0
    if (moving) {
      const len = Math.hypot(dx, dy)
      this.player.setVelocity((dx / len) * WALK_SPEED, (dy / len) * WALK_SPEED)
      // 朝向:优先横向(经典俯视角习惯)
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

    // ---------- 深度排序(俯视角: y 越大越靠前) ----------
    this.player.setDepth(this.player.y)
    for (const npc of this.npcs) {
      npc.setDepth(npc.y)
    }

    // ---------- NPC 近身检测 ----------
    const range = 40
    let near: { id: number, name: string } | null = null
    for (const npc of this.npcs) {
      if (Math.abs(npc.x - this.player.x) < range && Math.abs(npc.y - this.player.y) < range) {
        near = { id: npc.getData('npcId') as number, name: npc.getData('npcName') as string }
        break
      }
    }
    if (JSON.stringify(near) !== JSON.stringify(this.nearNpc)) {
      this.nearNpc = near
      this.bus.emit('npcNear', near)
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
