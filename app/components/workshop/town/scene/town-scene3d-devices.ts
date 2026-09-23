/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— 数字孪生设备节点层。
 *
 * 自 TownScene3D.ts 抽出:设备节点的创建 / 收敛 / 重建 / 移除与 transform 落库 ——
 *  - spawnDeviceNode:拖 dev 模型进场景生成节点 + 落一个 device twin(临时 ID → 服务端 ID 原子迁移);
 *  - syncDevices:与设备孪生清单对齐(新增重建 / 已有收敛 / 服务端已删移除;含 pending 再仲裁);
 *  - recreateDeviceNode / recreateDaqNode:持久化恢复(常规 GLB 设备 / 程序化数采传感网格 + 产线光晕);
 *  - 改名 / 换模型 / 状态遥测 / 名称与型号查询 / 删除;
 *  - persistDeviceTransform / persistAllDevices:transform 防抖落库。
 *
 * 宿主契约:场景类实现 DeviceLayerHost(只列本模块触达的成员)。
 */
import * as THREE from 'three'
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GROUND_Y, UNITS, WORLD_CX, WORLD_CZ } from '#shared/town-scene-math'
import { makeDaqMesh, makeDeviceRing, makeLabel } from './town-scene3d-factory'
import { deviceTopY } from './town-scene3d-links'
import { loadGltfToGroup } from './town-scene3d-models'
import { DeviceNode } from './town-scene3d-nodes'
import type {
  DeviceApi, DeviceTwinSync, ModelInfo, PointerDragState, ScaledTarget, SelectedTarget,
} from './town-scene3d-types'

/** 设备层模块的宿主契约(一项 = 本模块真正用到的字段/方法) */
export interface DeviceLayerHost {
  /** 场景根(节点挂载/摘除) */
  readonly scene: THREE.Scene
  /** 数字孪生设备节点(twinId → node) */
  readonly deviceNodes: Map<string, DeviceNode>
  /** 数采节点顶端 LED 环(twinId → 环;渲染循环缓转呼吸) */
  readonly daqLedRings: Map<string, THREE.Mesh>
  /** 服务端已有但模型资产尚未注册的设备孪生,资产到达后补建节点。 */
  readonly pendingDeviceTwins: Map<string, DeviceTwinSync>
  /** 尚未取得服务端 ID 的本地设备节点(临时 ID → 创建请求初始状态)。 */
  readonly pendingDeviceCreates: Map<string, { name: string, modelRef: string, posX: number, posZ: number }>
  /** 用户在创建设备完成前删除的临时节点,创建完成后补偿删除服务端记录。 */
  readonly cancelledDeviceCreates: Set<string>
  readonly pendingSaveTimers: Map<string, ReturnType<typeof setTimeout>>
  /** 场景内可缩放目标(Agent 或设备) */
  readonly scalables: Map<string, ScaledTarget>
  /** 已登记模型(id → file) */
  readonly modelsById: Map<string, ModelInfo>
  readonly selected: SelectedTarget | null
  readonly pointerDrag: PointerDragState
  /** 已销毁(异步创建回调中止) */
  readonly disposed: boolean
  /** GLTF 加载器(设备模型装配经 loadGltfToGroup 使用) */
  readonly gltfLoader: GLTFLoader
  daqLinkSig: string
  filmWebSig: string
  readonly daqLinksWanted: Array<{ daqId: string, deviceId: string }>
  /** 数字孪生设备 API(由 TownView 注入 useDeviceTwins 适配器) */
  devices: DeviceApi | null
  setSelected(sel: SelectedTarget | null): void
  /** 组装可缩放目标并恢复初始化缩放 */
  registerScalable(kind: 'agent' | 'device', id: string, holder: THREE.Group, initialScale?: number): void
  /** 释放单个设备节点的实例资源(状态环 + 运行弧 + LED 环 + 名牌) */
  disposeDeviceAssets(dev: DeviceNode): void
  /** 请求下一帧重绘 */
  markDirty(): void
  /** 场景保存状态广播 */
  emitSaveState(state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error', at?: number): void
  /** 设备改名:重建名牌 Sprite */
  renameDeviceSprite(dev: DeviceNode, name: string): void
  /** 设备换模型:按 modelRef 重挂 GLB 到 holder */
  swapDeviceModelSprite(dev: DeviceNode, modelRef: string): void
  /** 设备节点就位后重仲裁绑定链路 */
  syncDaqLinks(links: Array<{ daqId: string, deviceId: string }>): void
}

/** 设备改名:重建名牌 Sprite(由 DeviceNode.applyTwin 委托) */
export function renameDeviceSprite(host: DeviceLayerHost, dev: DeviceNode, name: string): void {
  dev.name = name.trim()
  host.scene.remove(dev.label)
  dev.label = makeLabel(host.scene, `⚙ ${dev.name}`, dev.root.position.x, 60, dev.root.position.z)
  host.markDirty()
}

/** 设备换模型:按 modelRef 重挂 GLB 到 holder(由 DeviceNode.applyTwin 委托)。 */
export function swapDeviceModelSprite(host: DeviceLayerHost, dev: DeviceNode, modelRef: string): void {
  const info = host.modelsById.get(modelRef)
  if (!info?.file) return
  if (dev.modelRef === modelRef && dev.holder.userData.modelFile === info.file) return
  dev.modelRef = modelRef
  dev.holder.clear()
  dev.holder.userData.modelFile = info.file
  void loadGltfToGroup(host, info.file, dev.holder, UNITS * 1.6)
  host.markDirty()
}

/**
 * 数字孪生设备节点:拖 dev 模型进场景生成。
 * - 3D:挂 device GLB + 设备名牌 + 状态环(telemetry 驱动颜色);
 * - 数据:经 devices.create 落一个 device twin,与 modelRef 绑定;
 * - state 驱动:alarm→红环,running→青环,offline→灰环,idle→亮环。
 */
export function spawnDeviceNode(host: DeviceLayerHost, x: number, z: number, texKey: string, file: string, name: string): string {
  const tempId = `dev-${Date.now().toString(36)}`
  const root = new THREE.Group()
  root.position.set(x, GROUND_Y, z)
  const { ring, arc } = makeDeviceRing()
  root.add(ring, arc)
  const holder = new THREE.Group()
  root.add(holder)
  holder.userData.modelFile = file
  const label = makeLabel(host.scene, `⚙ ${name}`, x, 60, z)
  host.scene.add(root)
  const twin = new DeviceNode({ twinId: tempId, name, modelRef: texKey, root, holder, ring, label, state: 'idle', telemetry: {} })
  twin.host = host
  twin.arc = arc
  twin.updateRing()
  host.deviceNodes.set(tempId, twin)
  host.registerScalable('device', tempId, holder)
  void loadGltfToGroup(host, file, holder, UNITS * 1.6)
  const st = host.scalables.get(`device:${tempId}`)
  const createPromise = host.devices?.create({
    name, modelRef: texKey, kind: 'device', controls: ['power_on', 'power_off', 'set_speed'],
    posX: Math.round(x * 10) / 10,
    posZ: Math.round(z * 10) / 10,
    scale: st ? Math.round(st.userScale * 100) / 100 : 1,
  })
  if (!createPromise) return tempId
  host.pendingDeviceCreates.set(tempId, { name, modelRef: texKey, posX: x, posZ: z })
  void createPromise
    .then((created) => {
      const cancelled = host.cancelledDeviceCreates.delete(tempId)
      host.pendingDeviceCreates.delete(tempId)
      if (cancelled) {
        void host.devices?.remove?.(created.id).catch(() => {})
        return
      }
      if (host.disposed) return
      adoptDeviceNode(host, tempId, created.id)
    })
    .catch(() => {
      host.cancelledDeviceCreates.delete(tempId)
      host.pendingDeviceCreates.delete(tempId)
    })
  return tempId
}

/** 将本地临时设备原子迁移到服务端 ID，避免后续更新/删除命中旧键。 */
export function adoptDeviceNode(host: DeviceLayerHost, tempId: string, realId: string): void {
  host.pendingDeviceCreates.delete(tempId)
  const node = host.deviceNodes.get(tempId)
  if (!node) return
  const duplicate = host.deviceNodes.get(realId)
  if (duplicate && duplicate !== node) {
    removeDeviceNode(host, tempId)
    if (host.selected?.kind === 'device' && host.selected.id === tempId) host.setSelected({ kind: 'device', id: realId })
    return
  }
  host.deviceNodes.delete(tempId)
  node.twinId = realId
  host.deviceNodes.set(realId, node)
  const scalable = host.scalables.get(`device:${tempId}`)
  host.scalables.delete(`device:${tempId}`)
  if (scalable) {
    scalable.id = realId
    host.scalables.set(`device:${realId}`, scalable)
  }
  const timer = host.pendingSaveTimers.get(tempId)
  host.pendingSaveTimers.delete(tempId)
  if (timer) host.pendingSaveTimers.set(realId, timer)
  if (host.pointerDrag?.kind === 'device' && host.pointerDrag.id === tempId) host.pointerDrag.id = realId
  if (host.selected?.kind === 'device' && host.selected.id === tempId) host.setSelected({ kind: 'device', id: realId })
  persistDeviceTransform(host, realId)
}

/** 更新设备节点状态/遥测(由 useDeviceTwins 轮询或控制反馈驱动;数据驱动渲染状态环) */
export function updateDeviceNode(host: DeviceLayerHost, twinId: string, state: DeviceNode['state'], telemetry?: Record<string, number | string | boolean>): void {
  const dev = host.deviceNodes.get(twinId)
  if (!dev) return
  if (state) {
    dev.state = state
    dev.updateRing()
  }
  if (telemetry) dev.telemetry = { ...dev.telemetry, ...telemetry }
  host.markDirty()
}

/** 设备改名(重建名牌 Sprite + 落库由 TownView 走 devices.update) */
export function renameDevice(host: DeviceLayerHost, id: string, name: string): void {
  const dev = host.deviceNodes.get(id)
  if (!dev || !name.trim() || name.trim() === dev.name) return
  host.renameDeviceSprite(dev, name)
}

/** 设备换模型(按 modelRef 重挂 GLB 到 holder;持久化由 TownView 走 devices.update) */
export function swapDeviceModel(host: DeviceLayerHost, id: string, modelRef: string): void {
  const dev = host.deviceNodes.get(id)
  if (!dev) return
  host.swapDeviceModelSprite(dev, modelRef)
}

/** 设备当前名称(供属性面板初始化) */
export function getDeviceName(host: DeviceLayerHost, id: string): string {
  return host.deviceNodes.get(id)?.name ?? ''
}

/** 设备当前绑定模型 id(供模型下拉高亮) */
export function getDeviceModelRef(host: DeviceLayerHost, id: string): string {
  return host.deviceNodes.get(id)?.modelRef ?? ''
}

/** 删除设备实例:落库删除 + 移除场景节点(由 TownView 触发;失败仅移除本地节点)。 */
export async function removeDevice(host: DeviceLayerHost, id: string): Promise<void> {
  const dev = host.deviceNodes.get(id)
  if (!dev) return
  if (host.pendingDeviceCreates.has(id)) {
    host.cancelledDeviceCreates.add(id)
    removeDeviceNode(host, id)
    return
  }
  try {
    await host.devices?.remove?.(id)
  }
  catch { /* 服务端失败仍移除本地节点(尽力同步) */ }
  removeDeviceNode(host, id)
}

/** 设备节点列表(供 HUD/E2E;topY = 模型顶面世界高度,callout 锚定用) */
export function getDeviceNodes(host: DeviceLayerHost): Array<{ twinId: string, name: string, x: number, z: number, topY: number, state: string, telemetry: Record<string, number | string | boolean> }> {
  return [...host.deviceNodes.values()].map(d => ({
    twinId: d.twinId,
    name: d.name,
    x: Math.round(d.root.position.x),
    z: Math.round(d.root.position.z),
    topY: Math.round(deviceTopY(d)),
    state: d.state,
    telemetry: d.telemetry,
  }))
}

/** 持久化设备 transform(位置/朝向/缩放一次写入;防抖 350ms,不逐帧写库) */
export function persistDeviceTransform(host: DeviceLayerHost, id: string): void {
  const dev = host.deviceNodes.get(id)
  if (!dev || !host.devices?.update || host.pendingDeviceCreates.has(id)) return
  const st = host.scalables.get(`device:${id}`)
  const prev = host.pendingSaveTimers.get(id)
  if (prev) clearTimeout(prev)
  host.pendingSaveTimers.set(id, setTimeout(() => {
    host.pendingSaveTimers.delete(id)
    if (host.disposed || host.pendingDeviceCreates.has(id)) return
    host.emitSaveState('saving')
    void host.devices!.update(id, {
      posX: Math.round(dev.root.position.x * 10) / 10,
      posZ: Math.round(dev.root.position.z * 10) / 10,
      rotationY: Math.round(THREE.MathUtils.radToDeg(dev.root.rotation.y) * 10) / 10,
      scale: st ? Math.round(st.userScale * 100) / 100 : undefined,
    })
      .then(() => host.emitSaveState('saved', Date.now()))
      .catch(() => host.emitSaveState('error'))
  }, 350))
  host.emitSaveState('dirty')
}

/** 保存全部设备节点(「保存布局」按钮:强制全量落库) */
export function persistAllDevices(host: DeviceLayerHost): void {
  for (const id of [...host.deviceNodes.keys()]) persistDeviceTransform(host, id)
}

/**
 * 与设备孪生清单对齐:
 *  - 服务端有落点且本地无节点 → 按保存的 transform 重建节点(刷新后恢复);
 *  - 已存在 → 收敛状态/遥测,并在未拖拽时收敛 transform(他人编辑即时跟随);
 *  - 服务端已删除 → 移除本地节点。
 * TownView 在 device.* 事件与轮询时调用;轮询兜底多客户端同步。
 */
export function syncDevices(host: DeviceLayerHost, twins: DeviceTwinSync[]): void {
  const serverIds = new Set(twins.map(t => t.id))
  for (const id of [...host.deviceNodes.keys()]) {
    if (!serverIds.has(id) && !host.pendingDeviceCreates.has(id)) removeDeviceNode(host, id)
  }
  for (const t of twins) {
    let existing = host.deviceNodes.get(t.id)
    if (!existing) {
      const pending = [...host.pendingDeviceCreates.entries()].find(([, p]) =>
        p.name === t.name && p.modelRef === t.modelRef,
      )
      if (pending) {
        adoptDeviceNode(host, pending[0], t.id)
        existing = host.deviceNodes.get(t.id)
      }
    }
    if (!existing) {
      // 数采/智控节点走程序化路径(无 GLB 也可实例化);设备需模型可解析 + 已入场景
      const isDaq = t.kind === 'daq' || (t.modelRef ?? '').startsWith('daq-') || (t.modelRef ?? '').startsWith('dcw-')
      const resolvable = isDaq || !!resolveDeviceModel(host, t.modelRef)?.file
      if (resolvable && typeof t.posX === 'number' && typeof t.posZ === 'number') recreateDeviceNode(host, t)
      else host.pendingDeviceTwins.set(t.id, t)
      continue
    }
    host.pendingDeviceTwins.delete(t.id)
    existing.applyTwin(t)
    if (host.pointerDrag?.id !== t.id) {
      const moved = (typeof t.posX === 'number' && t.posX !== existing.root.position.x)
        || (typeof t.posZ === 'number' && t.posZ !== existing.root.position.z)
      if (typeof t.posX === 'number') existing.root.position.x = t.posX
      if (typeof t.posZ === 'number') existing.root.position.z = t.posZ
      if (typeof t.rotationY === 'number') existing.root.rotation.y = t.rotationY * Math.PI / 180
      const st = host.scalables.get(`device:${t.id}`)
      if (typeof t.scale === 'number' && st) {
        st.userScale = t.scale
        st.holder.scale.setScalar(t.scale)
      }
      if (moved) host.markDirty()
    }
    host.markDirty()
  }
  // 设备节点就位后重仲裁绑定链路(链路期望先于节点到达的时序兜底)
  if (host.daqLinksWanted.length) host.syncDaqLinks(host.daqLinksWanted)
  for (const id of [...host.pendingDeviceTwins.keys()]) {
    if (!serverIds.has(id)) host.pendingDeviceTwins.delete(id)
  }
}

/** 按设备孪生记录重建场景节点(持久化恢复:pos/rotation/scale;模型缺失则跳过) */
/** 设备模型解析:精确 id → `dev-folder-<ref>` 前缀 → `-<ref>` 后缀(兼容旧数据短 modelRef) */
export function resolveDeviceModel(host: DeviceLayerHost, ref: string): { id: string, file: string, hFactor: number } | null {
  const direct = host.modelsById.get(ref)
  if (direct?.file) return { id: direct.id, file: direct.file, hFactor: direct.hFactor ?? 1 }
  for (const [id, m] of host.modelsById) {
    if (m.kind !== 'dev' || !m.file) continue
    if (id === `dev-folder-${ref}` || id.endsWith(`-${ref}`)) return { id, file: m.file, hFactor: m.hFactor ?? 1 }
  }
  return null
}

export function recreateDeviceNode(host: DeviceLayerHost, t: DeviceTwinSync): void {
  // 数采/智控节点:程序化传感网格(基座 + 传感头 + 信号环),不依赖 GLB 资产
  // (modelRef 前缀兜底:旧数据 kind 落成 'device' 的数采实例同样走程序化路径)
  if (t.kind === 'daq' || (t.modelRef ?? '').startsWith('daq-') || (t.modelRef ?? '').startsWith('dcw-')) {
    recreateDaqNode(host, t)
    return
  }
  const model = resolveDeviceModel(host, t.modelRef)
  const file = model?.file ?? ''
  if (!file) return
  const x = typeof t.posX === 'number' ? t.posX : WORLD_CX
  const z = typeof t.posZ === 'number' ? t.posZ : WORLD_CZ
  const root = new THREE.Group()
  root.position.set(x, GROUND_Y, z)
  root.rotation.y = typeof t.rotationY === 'number' ? t.rotationY * Math.PI / 180 : 0
  const { ring, arc } = makeDeviceRing()
  root.add(ring, arc)
  const holder = new THREE.Group()
  root.add(holder)
  const label = makeLabel(host.scene, `⚙ ${t.name}`, x, 60, z)
  holder.userData.modelFile = file
  host.scene.add(root)
  const twin = new DeviceNode({ twinId: t.id, name: t.name, modelRef: t.modelRef, root, holder, ring, label, state: t.state ?? 'idle', telemetry: t.telemetry ?? {} })
  twin.host = host
  twin.arc = arc
  twin.updateRing()
  host.deviceNodes.set(t.id, twin)
  // 服务端缩放优先(持久化恢复);缺省回退 localStorage
  host.registerScalable('device', t.id, holder, typeof t.scale === 'number' ? t.scale : undefined)
  // 高度系数:产线设备按设计稿比例错落(基准高 × 模型系数),未知模型维持 1
  void loadGltfToGroup(host, file, holder, UNITS * 1.6 * (model?.hFactor ?? 1))
  host.markDirty()
}

/** 数采/智控节点(程序化):模板分化传感网格 + **产线光晕**(同产线同色光环)+ 名牌 */
export function recreateDaqNode(host: DeviceLayerHost, t: DeviceTwinSync): void {
  const x = typeof t.posX === 'number' ? t.posX : WORLD_CX
  const z = typeof t.posZ === 'number' ? t.posZ : WORLD_CZ
  const root = new THREE.Group()
  root.position.set(x, GROUND_Y, z)
  root.rotation.y = typeof t.rotationY === 'number' ? t.rotationY * Math.PI / 180 : 0
  const { group: sensor, ledRing } = makeDaqMesh(t.modelRef)
  root.add(sensor)
  const sigRing = new THREE.Mesh(
    new THREE.RingGeometry(16, 21, 36),
    new THREE.MeshBasicMaterial({ color: 0x35e0a0, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }),
  )
  sigRing.rotation.x = -Math.PI / 2
  sigRing.position.y = 0.35
  root.add(sigRing)
  // 产线光晕:外圈加性光环(soft) + 内圈亮环;未分配 = 缺省绿
  const haloOuter = new THREE.Mesh(
    new THREE.RingGeometry(24, 34, 48),
    new THREE.MeshBasicMaterial({ color: 0x35e0a0, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
  )
  haloOuter.rotation.x = -Math.PI / 2
  haloOuter.position.y = 0.28
  root.add(haloOuter)
  const accent = t.lineColor || '#35e0a0'
  const label = makeLabel(host.scene, t.name, x, 62, z, accent)
  host.scene.add(root)
  const node = new DeviceNode({
    twinId: t.id, name: t.name, modelRef: t.modelRef,
    root, holder: root, ring: sigRing, label,
    state: t.state ?? 'running', telemetry: t.telemetry ?? {},
  })
  node.host = host
  node.lineColor = t.lineColor ?? ''
  // 换产线/换色:重 tint 光环 + LED 环 + 名牌(applyTwin 检测 lineColor 变化时触发)
  node.applyLine = (color: string) => {
    const c = new THREE.Color(color || '#35e0a0')
    ;(sigRing.material as THREE.MeshBasicMaterial).color.copy(c)
    ;(haloOuter.material as THREE.MeshBasicMaterial).color.copy(c)
    ;(ledRing.material as THREE.MeshBasicMaterial).color.copy(c).multiplyScalar(6) // 保持 HDR(LED 起晕)
    host.scene.remove(label)
    label.material.dispose()
    const fresh = makeLabel(host.scene, node.name, root.position.x, 62, root.position.z, color || '#35e0a0')
    node.label = fresh
    host.scene.add(fresh)
    host.markDirty()
  }
  if (t.lineColor) node.applyLine(t.lineColor)
  node.updateRing()
  host.deviceNodes.set(t.id, node)
  host.daqLedRings.set(t.id, ledRing)
  host.registerScalable('device', t.id, root, typeof t.scale === 'number' ? t.scale : undefined)
  host.markDirty()
}

/** 移除设备场景节点(服务端记录被删/本地重建清理) */
export function removeDeviceNode(host: DeviceLayerHost, id: string): void {
  const dev = host.deviceNodes.get(id)
  if (!dev) return
  host.scene.remove(dev.root)
  host.scene.remove(dev.label)
  host.disposeDeviceAssets(dev)
  if (host.selected?.kind === 'device' && host.selected.id === id) host.setSelected(null)
  host.scalables.delete(`device:${id}`)
  host.deviceNodes.delete(id)
  host.daqLedRings.delete(id)
  host.daqLinkSig = ''
  host.filmWebSig = ''
  host.markDirty()
}
