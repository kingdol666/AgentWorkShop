/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— 轨道相机与相机交互。
 *
 * 自 TownScene3D.ts 抽出:所有只读写「相机姿态」(注视点/轨道角/缩放距离)的成员 ——
 *  - 坐标互转(世界 ↔ 屏幕/地面拾取)与投影 scratch 单例;
 *  - 视角预设 / 环绕 / 平移 / 滚轮缩放 / 缓动聚焦;
 *  - 每帧相机解算(位置/朝向/裁剪面/天幕跟随/地面跟随/雾距/阴影相机范围)。
 *
 * 宿主契约:场景类实现 CameraHost(只列本模块触达的成员),本模块不反向依赖场景实现。
 */
import * as THREE from 'three'
import { WORLD_CX, WORLD_CZ, WORLD_H, WORLD_W } from '#shared/town-scene-math'
import type { Block3D } from './town-scene3d-nodes'

/** 相机模块的宿主契约(一项 = 本模块真正用到的字段/方法) */
export interface CameraHost {
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly ground: THREE.Mesh
  /** 穹顶天幕(随镜头平移,保证无限视野观感) */
  readonly skyDome: THREE.Mesh | null
  /** 主方向光(阴影相机范围随 dolly 扩,大领地投影不消失) */
  readonly keyLight: THREE.DirectionalLight
  /** 领地节点表(领地染色浓度作用于平台材质) */
  readonly blocks: Map<string, Block3D>
  /** 相机注视目标(拖拽平移它,zoom 微调距离) */
  readonly camTarget: THREE.Vector3
  /** 当前相机缩放(滚轮;作用于 dolly 距离) */
  dolly: number
  /** 自动取景目标 dolly(缩放拖拽期间按范围尺寸计算;渲染循环平滑跟随,拖拽结束清除) */
  autoDolly: number | null
  autoOrbit: boolean
  /** 轨道相机状态机(Blender 规范):yaw 方位角 / pitch 仰角 / radius 半径。
   *  viewTarget 供预设平滑趋近;左键环绕直接改双值(即时跟手)。 */
  viewCur: { yaw: number, pitch: number, radius: number }
  viewTarget: { yaw: number, pitch: number, radius: number }
  /** 请求下一帧重绘 */
  markDirty(): void
  /** 登记逐帧回调(渲染循环统一 flush) */
  pushAnim(f: () => void): void
  /** 是否正在拖曳场景对象(拖拽期间暂停自动环绕) */
  isPointerDragging(): boolean
}

// ===== 投影/拾取 scratch 单例(热路径零分配) =====
const _wDir = new THREE.Vector3()
const _wRel = new THREE.Vector3()
const _wVec = new THREE.Vector3()
const _wVec2 = new THREE.Vector2()
const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const _raycaster = new THREE.Raycaster()

/** 世界坐标 → 屏幕像素(数据标注/悬浮 callout 投影;返回 null = 在相机背后) */
export function worldToScreen(host: CameraHost, x: number, y: number, z: number): { x: number, y: number } | null {
  const rect = host.renderer.domElement.getBoundingClientRect()
  // 相机背后的点 project() 会按负 w 翻转到错误的屏幕位置 → 先用前向点积剔除
  const dir = _wDir
  host.camera.getWorldDirection(dir)
  const rel = _wRel.set(x - host.camera.position.x, y - host.camera.position.y, z - host.camera.position.z)
  if (rel.dot(dir) <= 0.1) return null
  const v = _wVec.set(x, y, z).project(host.camera)
  if (v.z > 1) return null
  // 视锥外过远(NDC ±1.6)的点投影无意义(可能落到数千 px 外)→ 剔除;边缘 ±1 内保留供夹取
  if (Math.abs(v.x) > 1.6 || Math.abs(v.y) > 1.6) return null
  return {
    x: rect.left + (v.x + 1) / 2 * rect.width,
    y: rect.top + (1 - v.y) / 2 * rect.height,
  }
}

/** 页面坐标 → 世界 xz(经 canvas rect + 相机射线打在 y=0 平面) */
export function screenToWorld(host: CameraHost, clientX: number, clientY: number): { x: number, z: number } {
  const rect = host.renderer.domElement.getBoundingClientRect()
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1
  const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1
  const raycaster = _raycaster
  raycaster.setFromCamera(_wVec2.set(ndcX, ndcY), host.camera)
  const pt = _wVec
  raycaster.ray.intersectPlane(_groundPlane, pt)
  return pt ? { x: pt.x, z: pt.z } : { x: host.camera.position.x, z: host.camera.position.z }
}

/** 平移相机(拖拽):移动 camTarget(相机位置由 loop 据 target+dolly 推导) */
export function panBy(host: CameraHost, dxWorld: number, dzWorld: number): void {
  host.camTarget.x -= dxWorld
  host.camTarget.z -= dzWorld
}

/** 范围半轴 → 容纳它的 dolly(基线几何:水平半幅 ≈ 613*aspect*d,地面纵深 ≈ 950*d) */
export function fitDollyFor(host: CameraHost, rx: number, rz: number): number {
  const aspect = host.camera.aspect || 1.6
  return Math.max(rx / (0.82 * 613 * aspect), rz / (0.82 * 950))
}

/** 缩放过程中调用:范围超出当前视野 → 相机自动拉远(只放大不缩小,收敛于拖拽结束) */
export function autoFrameTo(host: CameraHost, rx: number, rz: number): void {
  const fit = fitDollyFor(host, rx, rz)
  if (fit > host.dolly) host.autoDolly = Math.min(40, fit * 1.18)
}

/** 滚轮缩放(改变 dolly 距离) */
/** 视角预设(设计稿 angle-chip):std 标准 / top 俯视 / front 前视 / side 侧视。
 *  轨道参数:yaw 方位 / pitch 仰角(rad) / radius 半径(再乘 dolly)。 */
export function setViewPreset(host: CameraHost, p: 'std' | 'top' | 'front' | 'side'): void {
  const presets: Record<string, { yaw: number, pitch: number, radius: number }> = {
    std: { yaw: 0, pitch: 0.70, radius: 1178 },
    top: { yaw: 0, pitch: 1.51, radius: 2400 },
    front: { yaw: 0, pitch: 0.09, radius: 1510 },
    side: { yaw: Math.PI / 2, pitch: 0.33, radius: 1320 },
  }
  const t = presets[p] ?? presets.std!
  host.viewTarget = { ...t }
  // 预设切换走平滑趋近;环绕拖拽则是即时双写
}

/** 左键环绕(设计稿 OrbitLite 语义):theta -= dx·0.0052(拖右=场景右转,内容跟手不反向);
 *  phi -= dy·0.0052(拖上=压低视角看地平,拖下=抬升俯视),夹在仰角安全区间 */
/** 环绕(设计稿 OrbitLite 1:1):theta -= dx·0.0052;仰角 += dy·0.0052
 *  (设计稿 phi -= dy·0.0052,phi 为极角 → 仰角随 dy 增大:往下拖 = 相机升向俯视) */
export function orbitBy(host: CameraHost, dxPx: number, dyPx: number): void {
  const yaw = host.viewCur.yaw - dxPx * 0.0052
  const pitch = Math.min(1.52, Math.max(0.06, host.viewCur.pitch + dyPx * 0.0052))
  host.viewCur = { yaw, pitch, radius: host.viewCur.radius }
  host.viewTarget = { ...host.viewCur }
  host.markDirty()
}

/** 自动环绕(设计稿 tOrbit):渲染循环缓转 yaw;orbitBy 拖拽时暂停 */
export function setAutoOrbit(host: CameraHost, on: boolean): void {
  host.autoOrbit = on
}

export function getAutoOrbit(host: CameraHost): boolean {
  return host.autoOrbit
}

/** 滚轮缩放(改变 dolly 距离) */

/** 平移(设计稿 OrbitLite 1:1):target += (−right·dx + up·dy)·s。
 *  right=(cosY,0,−sinY),up 地面分量 = −sinP·(sinY,cosY);panBy 内部取负 → 注视点
 *  拖右时沿 −right 移动 = 相机左扫 = 内容跟随光标(抓取语义,与设计稿逐项一致)。 */
export function panByScreen(host: CameraHost, dxPx: number, dyPx: number): void {
  const r = host.viewCur.radius * host.dolly
  const k = r * 0.0011
  const sinY = Math.sin(host.viewCur.yaw)
  const cosY = Math.cos(host.viewCur.yaw)
  const sinP = Math.sin(host.viewCur.pitch)
  const dxw = (cosY * dxPx + sinP * sinY * dyPx) * k
  const dzw = (-sinY * dxPx + sinP * cosY * dyPx) * k
  panBy(host, dxw, dzw)
}

/** 飞往预设视角(平滑;设计稿 flyTo) */
export function flyToPreset(host: CameraHost, p: 'std' | 'top' | 'front' | 'side', _dur = 900): void {
  setViewPreset(host, p)
}

/** 相机即时状态(导航地图/callout 距离显隐;世界坐标) */
export function getCameraPose(host: CameraHost): { pos: { x: number, y: number, z: number }, target: { x: number, z: number }, yaw: number, dolly: number } {
  return {
    pos: { x: host.camera.position.x, y: host.camera.position.y, z: host.camera.position.z },
    target: { x: host.camTarget.x, z: host.camTarget.z },
    yaw: host.viewCur.yaw,
    dolly: host.dolly,
  }
}

/** 导航地图拖拽平移:世界位移直接作用于注视点与相机位置(设计稿 minimap drag) */
export function panWorldBy(host: CameraHost, dxw: number, dzw: number): void {
  host.camTarget.x -= dxw
  host.camTarget.z -= dzw
  host.camera.position.x -= dxw
  host.camera.position.z -= dzw
  host.markDirty()
}

/** 重置视角(注视世界中心,标准轨道,基准 dolly) */
export function resetView(host: CameraHost): void {
  host.dolly = 1
  host.autoDolly = null
  tweenCamTo(host, WORLD_CX, WORLD_CZ)
  setViewPreset(host, 'std')
}

export function zoomBy(host: CameraHost, f: number): void {
  host.autoDolly = null
  host.dolly = Math.min(1000, Math.max(0.001, host.dolly + f))
}

/** 缓动聚焦某世界点(移动 camTarget) */
/** 缓动聚焦某世界点(移动 camTarget) */
export function focusTo(host: CameraHost, x: number, z: number): void {
  tweenCamTo(host, x, z)
}

export function tweenCamTo(host: CameraHost, x: number, z: number): void {
  const start = performance.now()
  const sx = host.camTarget.x
  const sz = host.camTarget.z
  const dur = 600
  const step = (): void => {
    const t = Math.min(1, (performance.now() - start) / dur)
    const e = 1 - Math.pow(1 - t, 3)
    host.camTarget.x = sx + (x - sx) * e
    host.camTarget.z = sz + (z - sz) * e
    if (t < 1) host.pushAnim(step)
  }
  host.pushAnim(step)
}

/**
 * 每帧相机解算(自渲染循环抽出,调用顺序与抽出前逐行一致):
 * 自动 dolly 阻尼 → 轨道角阻尼 → 自动环绕 → 相机摆放/裁剪面 → 天幕跟随 →
 * 地面跟随(UV 反向补偿)→ 雾距 → 阴影相机范围。
 */
export function updateCameraFrame(host: CameraHost, dt: number): void {
  // 相机:围绕 camTarget 按 dolly 距离摆放(拖拽平移 camTarget,滚轮调 dolly,tween 平移 camTarget);
  // 基线 1250/760 + FOV55 = 全园区电影化 2.5D 框景;穹顶随镜头平移(无限视野观感)
  // 指数阻尼(帧率无关:1-e^(-λ·dt);60fps 下与旧每帧系数 0.12/0.08 等效,高刷屏不再加速)
  const kDolly = 1 - Math.exp(-dt * 7.2)
  if (host.autoDolly !== null) {
    host.dolly += (host.autoDolly - host.dolly) * kDolly
    if (Math.abs(host.autoDolly - host.dolly) < 0.01) host.autoDolly = null
  }
  const kView = 1 - Math.exp(-dt * 4.8)
  for (const k of ['yaw', 'pitch', 'radius'] as const) {
    host.viewCur[k] += (host.viewTarget[k] - host.viewCur[k]) * kView
  }
  // 自动环绕(设计稿 tOrbit):缓转方位角(dt 基 ≈ 24s/圈;指针按住场景时暂停)
  if (host.autoOrbit && !host.isPointerDragging()) {
    host.viewCur.yaw -= dt * 0.156
    host.viewTarget.yaw = host.viewCur.yaw
  }
  const r = host.viewCur.radius * host.dolly
  const cp = Math.cos(host.viewCur.pitch)
  host.camera.position.set(
    host.camTarget.x + r * cp * Math.sin(host.viewCur.yaw),
    20 + r * Math.sin(host.viewCur.pitch),
    host.camTarget.z + r * cp * Math.cos(host.viewCur.yaw),
  )
  host.camera.lookAt(host.camTarget.x, 20, host.camTarget.z)
  // 无级缩放:近/远裁剪面随 dolly 伸缩(贴脸到星野全程不裁剪)
  const near = Math.max(0.05, 1.2 * host.dolly)
  const far = 16000 * host.dolly
  if (Math.abs(host.camera.near - near) > 0.005 || Math.abs(host.camera.far - far) > 1) {
    host.camera.near = near
    host.camera.far = far
    host.camera.updateProjectionMatrix()
  }
  if (host.skyDome) {
    host.skyDome.position.set(host.camTarget.x, 0, host.camTarget.z)
    // 穹顶随 dolly 缩放:高空拉远时相机始终在穹内,无硬地平线
    host.skyDome.scale.setScalar(Math.max(1, host.dolly * 1.3))
  }
  // 地面跟随镜头滑动(重复纹理 = 无限地面;高空不见地面边缘);
  // UV 偏移反向补偿平面位移 → 网格钉死世界坐标(否则纹理跟平面一起滑,平移时有"冰面漂移"感)
  host.ground.position.set(host.camTarget.x, 0, host.camTarget.z)
  const gmap = (host.ground.material as THREE.MeshStandardMaterial).map
  if (gmap) {
    gmap.offset.set(
      host.camTarget.x / ((WORLD_W * 16) / gmap.repeat.x),
      -host.camTarget.z / ((WORLD_H * 16) / gmap.repeat.y),
    )
  }
  // 雾距/阴影范围随 dolly 缩放:任意 zoom 层级下取景内容都不被雾吞、投影不消失
  const fog = host.scene.fog
  if (fog instanceof THREE.Fog) {
    fog.near = 1400 * host.dolly
    fog.far = 8800 * host.dolly
  }
  const sc = host.keyLight.shadow.camera
  const ext = 1600 * Math.max(1, host.dolly)
  if (Math.abs(sc.right - ext) > 1) {
    sc.left = -ext
    sc.right = ext
    sc.top = 2300 * Math.max(1, host.dolly)
    sc.bottom = -2300 * Math.max(1, host.dolly)
    sc.updateProjectionMatrix()
    host.renderer.shadowMap.needsUpdate = true
  }
}
