/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— 渲染核心初始化。
 *
 * 自 TownScene3D.ts 抽出:`initRenderer` 的全部构建与事件安装 ——
 *  - 渲染器(阴影按需重绘 / ACES 色调映射 / info 手动 reset)+ ResizeObserver 跟随宿主尺寸;
 *  - 场景根 / PMREM 环境光 / 穹顶天幕 / 地面 / 绑定链路层与薄膜 web 层;
 *  - 灯光组(环境 + 半球 + 主方向光阴影 + 补光 + 轮廓光);
 *  - 边界手柄 / Agent 活动范围手柄 / 选中高亮环 / 相机 / Blender 式变换手柄;
 *  - 点击与双击语义(点选 Agent/设备/信标/领地;平移手势守卫);
 *  - 后处理管线(RenderPass → UnrealBloom → OutputPass)与地面贴图应用。
 *
 * 生命周期钩子(globalThis 探针登记、渲染循环启动)仍留在场景类,保证顺序不变。
 * 宿主契约:场景类实现 RendererHost(只列本模块触达的成员)。
 */
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { WORLD_CX, WORLD_CZ, WORLD_H, WORLD_W } from '#shared/town-scene-math'
import { applyGroundTexture, makeSkyDome } from './town-scene3d-factory'
import type { Agent3D, Block3D, DeviceNode } from './town-scene3d-nodes'
import type {
  AgentRangeHandle, ChannelResizeHandle, PointerDragState, ScaledTarget, SelectedTarget,
  TownScene3DMode,
} from './town-scene3d-types'

/** 渲染核心初始化宿主契约(一项 = 本模块真正用到的字段/方法) */
export interface RendererHost {
  /** 舞台 DOM(渲染器 canvas 挂载点 + 尺寸来源) */
  readonly el: HTMLDivElement
  renderer: THREE.WebGLRenderer
  composer: EffectComposer
  camera: THREE.PerspectiveCamera
  scene: THREE.Scene
  ground: THREE.Mesh
  /** 穹顶天幕(随镜头平移,保证无限视野观感) */
  skyDome: THREE.Mesh | null
  /** 主方向光(阴影相机范围随 dolly 扩,大领地投影不消失) */
  keyLight: THREE.DirectionalLight
  /** Blender 式变换手柄(选中设备;G 移动 / R 旋转 / S 缩放) */
  tControls: TransformControls | null
  /** 选中高亮环(琥珀色动效环,跟随当前选中设备/角色;渲染循环驱动) */
  selRing: THREE.Mesh | null
  /** 舞台尺寸观察器 */
  resizeOb: ResizeObserver | null
  /** 边界缩放手柄(编辑模式选中频道时显示;拖拽手柄调整 radiusX/radiusZ) */
  readonly resizeHandles: ChannelResizeHandle[]
  /** Agent 活动范围缩放手柄(编辑模式选中带范围角色时显示;拖拽调整该 Agent 范围大小) */
  readonly agentRangeHandles: AgentRangeHandle[]
  /** 数采→设备 绑定链路层(虚线贝塞尔 + 流动脉冲) */
  readonly daqLinkGroup: THREE.Group
  /** 薄膜 web 层(产线设备之间的半透明膜) */
  readonly filmWebGroup: THREE.Group
  readonly agents: Map<string, Agent3D>
  readonly blocks: Map<string, Block3D>
  readonly deviceNodes: Map<string, DeviceNode>
  readonly scalables: Map<string, ScaledTarget>
  /** 当前选中(kind:id) */
  readonly selected: SelectedTarget | null
  /** 正在拖曳的场景对象(编辑模式) */
  readonly pointerDrag: PointerDragState
  /** 编辑 / 浏览模式 */
  readonly mode: TownScene3DMode
  /** 当前选中频道 */
  readonly selectedChannel: string | null
  /** 请求下一帧重绘 */
  markDirty(): void
  /** 页面坐标 → 世界 xz(经 canvas rect + 相机射线打在 y=0 平面) */
  screenToWorld(clientX: number, clientY: number): { x: number, z: number }
  /** 命中频道信标(中心 ±34 单位) */
  pickBeacon(x: number, z: number): { cid: string, x: number, z: number } | null
  /** 以世界坐标 hit 一个 Agent 或设备节点 */
  pickAt(x: number, z: number): { kind: 'agent' | 'device', id: string } | null
  /** 点选频道:返回包含该点的频道 id */
  pickChannel(x: number, z: number): string | null
  setSelected(sel: SelectedTarget | null): void
  selectChannel(channelId: string | null): void
  focusTo(x: number, z: number): void
  /** 设备 transform 防抖落库 */
  persistDeviceTransform(id: string): void
  /** 场景内缩放(Agent / 设备) */
  setModelScale(id: string, scale: number, kind?: 'agent' | 'device'): void
}

/** 渲染器 / 场景 / 相机 / 灯光 / 手柄 / 交互监听 的一次性构建(顺序与抽出前逐行一致)。 */
export function initRendererCore(host: RendererHost): void {
  host.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
  host.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  host.renderer.setSize(host.el.clientWidth || 1100, host.el.clientHeight || 700)
  host.renderer.shadowMap.enabled = true
  host.renderer.shadowMap.type = THREE.PCFSoftShadowMap
  // 阴影按需重绘:渲染循环里仅场景内容变化(dirty)或角色动画在跑时置 needsUpdate,
  // 静态场景(总览/无动画)不再每帧全量重绘阴影贴图(2048² PCFSoft 是最大单项 GPU 开销)
  host.renderer.shadowMap.autoUpdate = false
  host.renderer.outputColorSpace = THREE.SRGBColorSpace
  // 电影级色调映射:高光滚降 + 中间调层次,GLB 材质不再"平板曝光"
  host.renderer.toneMapping = THREE.ACESFilmicToneMapping
  host.renderer.toneMappingExposure = 1.12
  // 统计跨 pass 累计(composer 多 pass 直渲染时 info 每次自动清零,只会读到末 pass 的 1 次调用):
  // 每帧渲染前手动 reset,render() 累加,__townStats 拿到的才是整帧真实 drawCalls/triangles
  host.renderer.info.autoReset = false
  host.el.appendChild(host.renderer.domElement)
  // 舞台尺寸跟随宿主(网格布局/抽屉/全屏切换都会改变宿主尺寸)
  host.resizeOb = new ResizeObserver(() => {
    const w = host.el.clientWidth
    const h = host.el.clientHeight
    if (w < 2 || h < 2) return
    host.renderer.setSize(w, h)
    host.composer.setSize(w, h)
    host.camera.aspect = w / h
    host.camera.updateProjectionMatrix()
    host.markDirty()
  })
  host.resizeOb.observe(host.el)
  // 选中:点击 Agent/设备 → 弹缩放/旋转滑杆(经 on('select') 通知 Vue);拖拽释放不触发
  // 点击语义守卫:记录按下位置;松手位移大 = 相机平移手势 → 不触发点选(含信标)
  let clickDownAt: { x: number, y: number } | null = null
  host.renderer.domElement.addEventListener('pointerdown', (e: PointerEvent) => {
    clickDownAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null
  })
  host.renderer.domElement.addEventListener('pointerup', (e: PointerEvent) => {
    if (e.button !== 0 || host.pointerDrag || host.tControls?.dragging) return
    // 平移手势(按下后移动超 8px)→ 不作点选
    if (clickDownAt && Math.hypot(e.clientX - clickDownAt.x, e.clientY - clickDownAt.y) > 8) {
      clickDownAt = null
      return
    }
    clickDownAt = null
    const w = host.screenToWorld(e.clientX, e.clientY)
    // 频道信标优先(领队驻扎中心与信标重叠;中心 ±34 内点=信标,按住拖=Agent:
    // 拖拽手势在 pointerup 时因 pointerDrag 存在提前返回,不会误触信标)
    const beacon = host.pickBeacon(w.x, w.z)
    if (beacon) {
      host.setSelected(null)
      host.selectChannel(beacon.cid)
      host.focusTo(beacon.x, beacon.z)
      return
    }
    const hit = host.pickAt(w.x, w.z)
    if (hit) {
      host.setSelected(hit)
      // 点中角色/设备时清除频道选中(避免与边界面板混用)
      if (host.selectedChannel) host.selectChannel(null)
      return
    }
    // 未命中 agent/设备 → 尝试点选频道领地(打开边界编辑面板)
    const cid = host.pickChannel(w.x, w.z)
    host.setSelected(null)
    if (cid && host.mode === 'edit') host.selectChannel(cid)
  })
  // 双击 Agent/设备:缓动聚焦(指挥官镜头;不打断选择语义)
  host.renderer.domElement.addEventListener('dblclick', (e: MouseEvent) => {
    if (host.pointerDrag) return
    const w = host.screenToWorld(e.clientX, e.clientY)
    const hit = host.pickAt(w.x, w.z)
    if (hit?.kind === 'agent') {
      const a = host.agents.get(hit.id)
      if (a) host.focusTo(a.root.position.x, a.root.position.z)
    }
    else if (hit?.kind === 'device') {
      const d = host.deviceNodes.get(hit.id)
      if (d) host.focusTo(d.root.position.x, d.root.position.z)
    }
    else {
      // 双击领地(非 Agent/设备落点)→ 对焦该 Channel 中心并选中
      // (浏览模式:边界面板即刻可用调节范围;编辑模式:缩放手柄同时显示,可拖拽控制)
      const cid = host.pickChannel(w.x, w.z)
      const b = cid ? host.blocks.get(cid) : undefined
      if (b) {
        host.selectChannel(cid)
        host.focusTo(b.x, b.z)
      }
    }
  })

  host.scene = new THREE.Scene()
  host.scene.background = new THREE.Color(0x0a0f18)
  // 大气纵深:雾把远处柔化进夜色,2.5D 场景立刻有工业孪生的空间感
  host.scene.fog = new THREE.Fog(0x1b2836, 1400, 8800)
  // PBR 环境光照:PMREM 室内环境 → 金属/粗糙 GLB 材质获得真实反射与 specular 生命;
  // 低强度保留夜景工业气氛(只在材质细节里"呼吸",不提亮全场)
  try {
    const pmrem = new THREE.PMREMGenerator(host.renderer)
    host.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    host.scene.environmentIntensity = 0.42
    pmrem.dispose()
  }
  catch { /* 环境贴图失败:退回纯灯光方案 */ }

  // 穹顶渐变天幕(深空蓝黑 → 地平线工业暖灰;BackSide 大球,随镜头平移)
  host.skyDome = makeSkyDome()
  host.scene.add(host.skyDome)

  // 边界缩放手柄(编辑模式选中频道时显示;4 个:椭圆轴点 / 矩形角点)
  for (let i = 0; i < 4; i++) {
    const h = new THREE.Mesh(
      new THREE.TorusGeometry(16, 6, 8, 20),
      new THREE.MeshBasicMaterial({ color: 0xf6c453, transparent: true, opacity: 0.95, depthTest: false }),
    )
    h.rotation.x = Math.PI / 2
    h.position.y = 1.4
    h.visible = false
    host.scene.add(h)
    host.resizeHandles.push({ mesh: h, cid: '', handle: i })
  }
  // Agent 活动范围缩放手柄(编辑模式选中带范围角色时显示;4 个:椭圆轴点 / 矩形角点)
  for (let i = 0; i < 4; i++) {
    const h = new THREE.Mesh(
      new THREE.TorusGeometry(10, 4, 8, 16),
      new THREE.MeshBasicMaterial({ color: 0x41c8f4, transparent: true, opacity: 0.95, depthTest: false }),
    )
    h.rotation.x = Math.PI / 2
    h.position.y = 1.2
    h.visible = false
    host.scene.add(h)
    host.agentRangeHandles.push({ mesh: h, agentId: '', handle: i })
  }

  // 选中高亮环:单位几何 + 每帧按目标缩放(琥珀 #f6c453,加性发光,慢转活性)
  const selRing = new THREE.Mesh(
    new THREE.RingGeometry(0.92, 1.0, 56),
    new THREE.MeshBasicMaterial({ color: 0xf6c453, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
  )
  selRing.rotation.x = -Math.PI / 2
  selRing.position.y = 0.5
  selRing.visible = false
  selRing.renderOrder = 5
  host.scene.add(selRing)
  host.selRing = selRing

  // 相机:斜俯视 2.5D(FOV 55 + 远距框景,整个园区一块入画)
  host.camera = new THREE.PerspectiveCamera(55, (host.el.clientWidth || 1100) / (host.el.clientHeight || 700), 1, 12000)
  host.camera.position.set(WORLD_CX, 760, WORLD_CZ + 900)
  host.camera.lookAt(WORLD_CX, 20, WORLD_CZ)

  // Blender 式变换手柄:选中设备时出现(移动 G / 旋转 R / 缩放 S;UI 分段钮 + 键盘同源)
  const tc = new TransformControls(host.camera, host.renderer.domElement)
  tc.size = 0.85
  tc.setMode('translate')
  tc.showY = false
  tc.addEventListener('dragging-changed', (e) => {
    // 手柄拖拽期间压制场景点选/相机平移;松手后设备 transform 落库
    if (!e.value) {
      const sel = host.selected
      if (sel?.kind === 'device' && host.deviceNodes.has(sel.id)) host.persistDeviceTransform(sel.id)
    }
  })
  tc.addEventListener('objectChange', () => {
    const sel = host.selected
    if (!sel || sel.kind !== 'device') return
    const dev = host.deviceNodes.get(sel.id)
    if (!dev) return
    // 缩放转移:gizmo 对 root 的缩放倍率转移到模型 holder(免得环/铭牌跟着变大),root 复位
    if (tc.mode === 'scale' && Math.abs(dev.root.scale.x - 1) > 1e-4) {
      const reg = host.scalables.get(`device:${sel.id}`)
      const cur = reg?.userScale ?? 1
      host.setModelScale(sel.id, Math.min(50, Math.max(0.02, cur * dev.root.scale.x)), 'device')
      dev.root.scale.set(1, 1, 1)
    }
    host.markDirty()
  })
  host.tControls = tc
  host.scene.add(tc.getHelper())

  // 灯光:为 ACES 配平(整体提亮补偿 filmic 滚降;normalBias 消除模型自阴影痤疮)
  host.scene.add(new THREE.AmbientLight(0xd0e4ee, 1.6))
  const hemi = new THREE.HemisphereLight(0x9fc7e8, 0x3a2f25, 0.7)
  host.scene.add(hemi)
  const key = new THREE.DirectionalLight(0xfff4e0, 3.2)
  key.position.set(WORLD_CX + 500, 900, WORLD_CZ + 300)
  key.castShadow = true
  host.keyLight = key
  // 高分辨率软影:2048 map + 大 radius(PCSS 观感),贴地阴影是真实感的核心来源
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.left = -1400
  key.shadow.camera.right = 1400
  key.shadow.camera.top = 2000
  key.shadow.camera.bottom = -2000
  key.shadow.normalBias = 2
  key.shadow.bias = -0.0002
  key.shadow.radius = 6
  host.scene.add(key)
  const fill = new THREE.DirectionalLight(0x88bbff, 0.75)
  fill.position.set(WORLD_CX - 1200, 900, WORLD_CZ - 800)
  host.scene.add(fill)
  // 设计稿光系补光:青色轮廓光(金属切边高光)+ 绿色低位补光(孪生绿氛围)
  const rim = new THREE.DirectionalLight(0x41c8f4, 1.4)
  rim.position.set(WORLD_CX - 1400, 620, WORLD_CZ - 1000)
  host.scene.add(rim)
  const green = new THREE.DirectionalLight(0x35e0a0, 0.4)
  green.position.set(WORLD_CX + 700, 380, WORLD_CZ + 900)
  host.scene.add(green)

  // 地面(大平面,无限观感:7× 世界尺寸 + 高重复贴图)——夜航深蓝地坪;低反射让网格退为纹理
  const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62, metalness: 0.3, envMapIntensity: 0.42 })
  host.ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_W * 16, WORLD_H * 16), groundMat)
  host.ground.rotation.x = -Math.PI / 2
  host.ground.receiveShadow = true
  host.scene.add(host.ground)

  // 绑定链路层 + 薄膜 web 层(syncDaqLinks / 产线设备增删移动时重建)
  host.scene.add(host.daqLinkGroup, host.filmWebGroup)

  // 后处理:RenderPass → UnrealBloom(夜航辉光只作用于 HDR 顶端:阈值 3.0 =
  // 本灯光系下漫反射亮面(2~2.5 线性)不起晕,只留指示灯/金属高光;LED 等指示件
  // 已按 ×4.5~6 提为 HDR)→ OutputPass(tone mapping + sRGB 收尾;setExposure
  // 经 OutputPass 透传仍实时生效)。MSAA 目标保住抗锯齿(EffectComposer 默认无 MSAA)。
  const bloomTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 })
  host.composer = new EffectComposer(host.renderer, bloomTarget)
  host.composer.setPixelRatio(host.renderer.getPixelRatio())
  host.composer.setSize(host.el.clientWidth || 1100, host.el.clientHeight || 700)
  host.composer.addPass(new RenderPass(host.scene, host.camera))
  host.composer.addPass(new UnrealBloomPass(new THREE.Vector2(host.el.clientWidth || 1100, host.el.clientHeight || 700), 0.32, 0.35, 3.0))
  host.composer.addPass(new OutputPass())

  if (applyGroundTexture(host.ground, host.renderer)) host.markDirty()
}
