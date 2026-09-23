/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— 渲染循环与画质阶梯。
 *
 * 自 TownScene3D.ts 抽出:
 *  - startRenderLoop:rAF 主循环(帧预算门控 → 接收器消费 → 行为 FSM/mixer → 名牌/光环跟随 →
 *    链路与薄膜 web → 选中环 → 逐帧动画 flush → 相机解算 → 阴影按需 → 后处理出图 → 墙钟 FPS);
 *  - 质量阶梯(Q_TIERS 自适应 / USER_QUALITY 用户三档):dprScale × 阴影贴图 × Bloom 开关;
 *  - applyPixelRatio:渲染器 + composer 同步尺寸。
 *
 * 宿主契约:场景类实现 RenderLoopHost(继承 CameraHost,相机解算复用同一契约)。
 */
import type * as THREE from 'three'
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { BUBBLE_Y } from '#shared/town-scene-math'
import type { CameraHost } from './town-scene3d-camera'
import { updateCameraFrame } from './town-scene3d-camera'
import type { Agent3D, Block3D, DeviceNode } from './town-scene3d-nodes'
import type { DaqLink, SelectedTarget, TownEventMap } from './town-scene3d-types'

/** 渲染循环模块的宿主契约(一项 = 本模块真正用到的字段/方法) */
export interface RenderLoopHost extends CameraHost {
  /** 舞台 DOM(尺寸回退值来源) */
  readonly el: HTMLDivElement
  readonly composer: EffectComposer
  readonly clock: THREE.Clock
  readonly agents: Map<string, Agent3D>
  readonly blocks: Map<string, Block3D>
  readonly deviceNodes: Map<string, DeviceNode>
  readonly daqLedRings: Map<string, THREE.Mesh>
  readonly daqLinks: DaqLink[]
  /** 逐帧回调队列(本帧 flush 后清空) */
  rafAnims: Array<() => void>
  readonly selected: SelectedTarget | null
  readonly selRing: THREE.Mesh | null
  /** 已销毁(循环中止) */
  readonly disposed: boolean
  /** 脏标记(内容变化 → 重绘阴影/重建链路与薄膜 web) */
  dirty: boolean
  raf: number
  rafCount: number
  frameCount: number
  fpsWinT0: number
  frameAcc: number
  /** 帧预算(ms):渲染节流上限;0 = 不限制 */
  frameBudgetMs: number
  /** 动态分辨率基准(初始 dpr) */
  baseDpr: number
  qTier: number
  qLowStreak: number
  qHighStreak: number
  qualityMode: 'auto' | 'normal' | 'hd' | 'ultra'
  /** 各频道接收器 FIFO 消费(每帧) */
  drainReceivers(now: number): void
  /** 端点跟随:任一端点位移超阈值 → 重建该链路曲线 */
  refreshDaqLinks(): void
  /** 薄膜 web:产线设备增删/移动时重建 */
  rebuildFilmWeb(): void
  /** 设备顶端世界高度 */
  deviceTopY(dev: DeviceNode): number
  /** 场景 → Vue HUD 事件 */
  emit<K extends keyof TownEventMap>(event: K, e: TownEventMap[K]): void
}

/** 质量阶梯:实测 fps 连续 2s < 17 → 降一档;连续 4s ≥ 27(帧预算附近)→ 升一档。
 *  档位 = dprScale × 阴影贴图 × Bloom 开关的组合(Bloom+2048² 阴影是两大单项开销,
 *  重活机器 11fps = 每帧 ~90ms 主线程阻塞)。统一阶梯,避免多套自适应互相打架。 */
export const Q_TIERS = [
  { scale: 1.0, shadow: 2048, bloom: true },
  { scale: 0.8, shadow: 2048, bloom: true },
  { scale: 0.65, shadow: 1024, bloom: true },
  { scale: 0.55, shadow: 1024, bloom: false },
] as const

/** 用户画质三档(超清 = WebGL 全配置:满 DPR/2048² 阴影/Bloom/最大各向异性) */
export const USER_QUALITY = {
  ultra: { scale: 1.0, shadow: 2048, bloom: true },
  hd: { scale: 0.8, shadow: 2048, bloom: true },
  normal: { scale: 0.6, shadow: 1024, bloom: true },
} as const

export function startRenderLoop(host: RenderLoopHost): void {
  const animate = (): void => {
    if (host.disposed) return
    host.raf = requestAnimationFrame(animate)
    host.rafCount += 1
    const rawDt = host.clock.getDelta()
    // 帧预算门控:数据消费与帧率解耦 —— WS 帧直写实时缓冲(消费层,不受此门控),
    // 渲染循环每帧只取「当前最新值」上屏(展示层);budget 0 = 不限制(用户可选 60/120/∞)。
    // 后台标签页 rAF 自动停摆;回前台 rawDt 巨大 → 钳制单步 ≤100ms 防动画跳变
    if (host.frameBudgetMs > 0) {
      host.frameAcc += rawDt * 1000
      if (host.frameAcc < host.frameBudgetMs - 0.5) return
      host.frameAcc = 0
    }
    const dt = Math.min(rawDt, 0.1)
    const t = host.clock.elapsedTime
    // 频道信息接收器:FIFO 逐条消费实时消息(每帧检查,展示期满取下一条)
    host.drainReceivers(performance.now())
    // 行为 FSM
    for (const asp of host.agents.values()) {
      if (asp.state !== 'stopped' && !asp.dragging) asp.update(dt)
    }
    // mixer 更新
    for (const asp of host.agents.values()) {
      if (asp.mixer) asp.mixer.update(dt)
    }
    // 频道信标缓转(顶标菱形旋转,中心定位销的生命感)
    for (const b of host.blocks.values()) b.beacon.rotation.y += dt * 0.4
    // 名字/气泡跟随 + 光环呼吸 + 逐帧动画(脉冲/光柱/缓动)
    for (const asp of host.agents.values()) {
      asp.nameSprite.position.set(asp.root.position.x, 48, asp.root.position.z)
      if (asp.bubble) {
        asp.bubble.position.set(asp.root.position.x, BUBBLE_Y + 22 + Math.max(0, asp.model.scale.y - 1) * 22, asp.root.position.z)
      }
      if (asp.auraMats.length) {
        const br = 0.8 + 0.2 * Math.sin(t * 2.2 + asp.auraPhase)
        for (const m of asp.auraMats) m.opacity = (m.userData.baseOp as number) * br
      }
    }
    // 设备节点:名牌跟随(状态环是 root 子节点自动跟随;颜色由 updateRing 在状态变化时刷新)+ 运行弧缓转
    for (const dev of host.deviceNodes.values()) {
      dev.label.position.set(dev.root.position.x, 60, dev.root.position.z)
      if (dev.arc?.visible) dev.arc.rotation.z += dt * 1.6
    }
    // 数采节点 LED 环:缓转 + 呼吸(绑定链路的信号生命感)
    for (const ring of host.daqLedRings.values()) {
      ring.rotation.z += dt * 1.2
      const s = 1 + Math.sin(t * 3.2) * 0.08
      ring.scale.setScalar(s)
    }
    // 绑定链路:端点位移时重建曲线(dirty 门控;脉冲仍逐帧行走)
    if (host.daqLinks.length) {
      if (host.dirty) host.refreshDaqLinks()
      for (const l of host.daqLinks) {
        l.pt = (l.pt + dt * 0.3) % 1
        l.pulse.position.copy(l.curve.getPoint(l.pt))
      }
    }
    // 薄膜 web:产线设备增删/移动时重建(dirty 门控;免每帧签名字符串分配)
    if (host.dirty) host.rebuildFilmWeb()
    // 选中高亮环:跟随选中目标(角色按用户缩放、设备按顶高定半径;慢转活性)
    if (host.selRing) {
      const sel = host.selected
      let sx = 0
      let sz = 0
      let sr = 0
      if (sel?.kind === 'agent') {
        const a = host.agents.get(sel.id)
        if (a) {
          sx = a.root.position.x
          sz = a.root.position.z
          sr = 46 * Math.max(0.6, a.model.scale.y)
        }
      }
      else if (sel?.kind === 'device') {
        const d = host.deviceNodes.get(sel.id)
        if (d) {
          sx = d.root.position.x
          sz = d.root.position.z
          sr = Math.max(34, host.deviceTopY(d) * 0.42)
        }
      }
      host.selRing.visible = sr > 0
      if (sr > 0) {
        host.selRing.position.set(sx, 0.5, sz)
        host.selRing.scale.setScalar(sr)
        host.selRing.rotation.z += dt * 0.9
      }
    }
    const anims = host.rafAnims
    host.rafAnims = []
    for (const f of anims) f()
    updateCameraFrame(host, dt)
    // 阴影按需:内容变化(dirty)或有动画角色(mixer 驱动蒙皮位移)才重绘阴影贴图
    let shadowAnimated = false
    for (const asp of host.agents.values()) {
      if (asp.mixer) {
        shadowAnimated = true
        break
      }
    }
    host.renderer.shadowMap.needsUpdate = host.dirty || shadowAnimated
    // 后处理管线出图(RenderPass → Bloom → OutputPass;替代直渲染)
    host.renderer.info.reset()
    host.composer.render(dt)
    host.dirty = false
    // FPS(墙钟 1000ms 窗口:performance.now 真实时钟;原 dt 累计在长任务饿死 rAF 时虚高)
    host.frameCount += 1
    const wallNow = performance.now()
    if (host.fpsWinT0 === 0) host.fpsWinT0 = wallNow
    if (wallNow - host.fpsWinT0 >= 1000) {
      const fps = Math.round((host.frameCount * 1000) / (wallNow - host.fpsWinT0))
      host.emit('fps', fps)
      adaptQuality(host, fps)
      // 仪表化快照(1Hz;e2e/性能回归经 window.__townStats 读取,免再猜渲染真相)
      const info = host.renderer.info
      ;(globalThis as typeof globalThis & { __townStats?: Record<string, number> }).__townStats = {
        fps,
        rafHz: host.rafCount,
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        tier: host.qTier,
        dpr: +host.renderer.getPixelRatio().toFixed(2),
        frameBudgetMs: +host.frameBudgetMs.toFixed(2),
        agents: host.agents.size,
        devices: host.deviceNodes.size,
      }
      host.frameCount = 0
      host.rafCount = 0
      host.fpsWinT0 = wallNow
    }
  }
  animate()
}

export function setQualityMode(host: RenderLoopHost, mode: 'auto' | 'normal' | 'hd' | 'ultra'): void {
  host.qualityMode = mode
  if (mode === 'auto') {
    applyQuality(host)
    return
  }
  const q = USER_QUALITY[mode]
  applyPixelRatio(host, Math.max(0.5, host.baseDpr * q.scale))
  const key = host.keyLight
  if ((key.shadow.mapSize.x ?? 0) !== q.shadow) {
    key.shadow.mapSize.set(q.shadow, q.shadow)
    key.shadow.map?.dispose()
    key.shadow.map = null
    host.renderer.shadowMap.needsUpdate = true
  }
  const bloomPass = host.composer.passes.find(p => p instanceof UnrealBloomPass)
  if (bloomPass) bloomPass.enabled = q.bloom
}

export function adaptQuality(host: RenderLoopHost, fps: number): void {
  if (host.qualityMode !== 'auto') return
  const maxTier = Q_TIERS.length - 1
  if (fps < 17 && host.qTier < maxTier) {
    if (++host.qLowStreak >= 2) {
      host.qTier++
      applyQuality(host)
      host.qLowStreak = 0
      host.qHighStreak = 0
    }
  }
  else if (fps >= 27 && host.qTier > 0) {
    if (++host.qHighStreak >= 4) {
      host.qTier--
      applyQuality(host)
      host.qHighStreak = 0
      host.qLowStreak = 0
    }
  }
  else {
    host.qLowStreak = 0
    host.qHighStreak = 0
  }
}

export function applyQuality(host: RenderLoopHost): void {
  const tier = Q_TIERS[host.qTier]!
  applyPixelRatio(host, Math.max(0.5, host.baseDpr * tier.scale))
  // 阴影贴图缩容:置空 map 让 three 按新尺寸重分配(渲染循环按需重绘阴影)
  const key = host.keyLight
  if ((key.shadow.mapSize.x ?? 0) !== tier.shadow) {
    key.shadow.mapSize.set(tier.shadow, tier.shadow)
    key.shadow.map?.dispose()
    key.shadow.map = null
    host.renderer.shadowMap.needsUpdate = true
  }
  // Bloom 开关:Pass.enabled=false 跳过该 pass(RenderPass→OutputPass 直通)
  const bloomPass = host.composer.passes.find(p => p instanceof UnrealBloomPass)
  if (bloomPass) bloomPass.enabled = tier.bloom
}

export function applyPixelRatio(host: RenderLoopHost, next: number): void {
  host.renderer.setPixelRatio(next)
  host.composer.setPixelRatio(next)
  const w = host.el.clientWidth || 1100
  const h = host.el.clientHeight || 700
  host.renderer.setSize(w, h)
  host.composer.setSize(w, h)
}
