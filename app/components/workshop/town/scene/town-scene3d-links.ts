/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— 数采绑定链路与薄膜 web。
 *
 * 自 TownScene3D.ts 抽出(设计稿 buildChanLine / rebuildWeb 移植):
 *  - 设备顶端世界高度(holder 包围盒;链路/膜 web 的挂点,带缓存);
 *  - 数采→设备 绑定链路(虚线贝塞尔 + 流动脉冲;签名门控增量重建);
 *  - 端点跟随(拖拽设备/数采时曲线实时跟随,端点未动则不重建);
 *  - 产线设备薄膜 web(按 X 序连接挤出→流延→MD→TD→收卷,半透明膜面)。
 *
 * 宿主契约:场景类实现 LinkHost(只列本模块触达的成员)。
 */
import * as THREE from 'three'
import type { DeviceNode } from './town-scene3d-nodes'
import type { DaqLink } from './town-scene3d-types'

/** 链路 / 薄膜 web 模块的宿主契约(一项 = 本模块真正用到的字段/方法) */
export interface LinkHost {
  readonly deviceNodes: Map<string, DeviceNode>
  /** 期望链路(TownView 传入;设备节点晚到时由 syncDevices 末尾重仲裁) */
  daqLinksWanted: Array<{ daqId: string, deviceId: string }>
  daqLinkSig: string
  /** 已建链路(端点移动时逐帧跟随重建) */
  daqLinks: DaqLink[]
  /** 绑定链路层(虚线贝塞尔 + 流动脉冲) */
  readonly daqLinkGroup: THREE.Group
  filmWebSig: string
  /** 薄膜 web(产线设备之间的半透明膜) */
  readonly filmWebGroup: THREE.Group
  filmWebMat: THREE.MeshStandardMaterial | null
  /** 请求下一帧重绘 */
  markDirty(): void
}

// 链路端点 scratch(逐帧跟随用;免每帧 3 次分配)
const _lkA = new THREE.Vector3()
const _lkB = new THREE.Vector3()
const _lkM = new THREE.Vector3()

/** 设备顶端世界高度(holder 包围盒;链路/膜 web 的挂点)。
 *  缓存优先:Box3.setFromObject 遍历整个 GLB 子树,原每帧每设备全量计算是 HUD 最大热点;
 *  设备贴地 y=0,高度只随缩放变化 → setModelScale/registerScalable 时失效即可。 */
export function deviceTopY(dev: DeviceNode): number {
  if (dev.topYCache != null) return dev.topYCache
  const box = new THREE.Box3().setFromObject(dev.holder)
  const y = Number.isFinite(box.max.y) ? Math.max(40, box.max.y) : 64
  dev.topYCache = y
  return y
}

/** 同步数采→设备绑定链路(TownView 传入 [{daqId, deviceId}];端点移动时逐帧跟随重建) */
export function syncDaqLinks(host: LinkHost, links: Array<{ daqId: string, deviceId: string }>): void {
  host.daqLinksWanted = links
  // 签名按"成功建链"的链路计算:节点未就绪被跳过的链路不计入 → 设备节点晚到时 syncDevices 末尾重仲裁补链
  const built = links.filter(l => host.deviceNodes.has(l.daqId) && host.deviceNodes.has(l.deviceId))
  const sig = built.map(l => `${l.daqId}>${l.deviceId}`).sort().join('|')
  if (sig === host.daqLinkSig) return
  host.daqLinkSig = sig
  for (const l of host.daqLinks) {
    host.daqLinkGroup.remove(l.line)
    host.daqLinkGroup.remove(l.pulse)
    l.line.geometry.dispose()
  }
  host.daqLinks = []
  for (const l of built) {
    const daq = host.deviceNodes.get(l.daqId)!
    const dev = host.deviceNodes.get(l.deviceId)!
    const a = new THREE.Vector3(daq.root.position.x, 42, daq.root.position.z)
    const b = new THREE.Vector3(dev.root.position.x, deviceTopY(dev) + 6, dev.root.position.z)
    const mid = a.clone().add(b).multiplyScalar(0.5)
    mid.y = Math.max(a.y, b.y) + 42
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b)
    const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(28))
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x35e0a0, transparent: true, opacity: 0.55, dashSize: 8, gapSize: 5 }))
    line.computeLineDistances()
    const pulse = new THREE.Mesh(new THREE.SphereGeometry(2.6, 10, 8), new THREE.MeshBasicMaterial({ color: 0x41c8f4 }))
    ;(pulse.material as THREE.MeshBasicMaterial).color.multiplyScalar(5) // HDR:链路数据脉冲起晕
    host.daqLinkGroup.add(line, pulse)
    host.daqLinks.push({ ...l, line, pulse, curve, pt: Math.random(), ptSig: '' })
  }
  host.markDirty()
}

/** 端点跟随:任一端点位移超阈值 → 重建该链路曲线(拖拽设备/数采时虚线实时跟随) */
export function refreshDaqLinks(host: LinkHost): void {
  for (const l of host.daqLinks) {
    const daq = host.deviceNodes.get(l.daqId)
    const dev = host.deviceNodes.get(l.deviceId)
    if (!daq || !dev) continue
    const topY = deviceTopY(dev) + 6
    const sig = `${Math.round(daq.root.position.x)},${Math.round(daq.root.position.z)},${Math.round(dev.root.position.x)},${Math.round(dev.root.position.z)},${Math.round(topY)}`
    if (sig === l.ptSig) continue // 端点未动:曲线/geometry 不重建(脉冲仍逐帧走)
    l.ptSig = sig
    const a = _lkA.set(daq.root.position.x, 42, daq.root.position.z)
    const b = _lkB.set(dev.root.position.x, topY, dev.root.position.z)
    const mid = _lkM.copy(a).add(b).multiplyScalar(0.5)
    mid.y = Math.max(a.y, b.y) + 42
    l.curve.v0.copy(a)
    l.curve.v1.copy(mid)
    l.curve.v2.copy(b)
    const pts = l.curve.getPoints(28)
    l.line.geometry.setFromPoints(pts)
    l.line.computeLineDistances()
  }
}

/** 产线设备型号识别(modelRef 含产线关键字 → 薄膜 web 连线成员) */
export function isLineDevice(modelRef: string): boolean {
  const ref = modelRef.toLowerCase()
  return /extruder|caster|mdo|tdo|winder/.test(ref)
}

/** 薄膜 web:按 X 序连接产线设备(挤出→流延→MD→TD→收卷),半透明膜面 —— 产线工艺连续性可视化 */
export function rebuildFilmWeb(host: LinkHost): void {
  const list = [...host.deviceNodes.values()]
    .filter(d => isLineDevice(d.modelRef) && !d.modelRef.startsWith('daq-'))
    .sort((a, b) => a.root.position.x - b.root.position.x)
  const sig = list.map(d => `${d.twinId}:${Math.round(d.root.position.x)},${Math.round(d.root.position.z)}`).join('|')
  if (sig === host.filmWebSig) return
  host.filmWebSig = sig
  while (host.filmWebGroup.children.length) {
    const c = host.filmWebGroup.children[0] as THREE.Mesh
    host.filmWebGroup.remove(c)
    c.geometry.dispose()
  }
  if (!host.filmWebMat) {
    host.filmWebMat = new THREE.MeshStandardMaterial({
      color: 0xaad8ff, metalness: 0.1, roughness: 0.35, transparent: true, opacity: 0.28,
      emissive: 0x2b6b8f, emissiveIntensity: 0.25, side: THREE.DoubleSide, depthWrite: false,
    })
  }
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i]!.root.position
    const b = list[i + 1]!.root.position
    const len = Math.abs(b.x - a.x) - 110
    if (len < 30) continue
    const web = new THREE.Mesh(new THREE.BoxGeometry(len, 1.2, 46), host.filmWebMat)
    web.position.set((a.x + b.x) / 2, 48, (a.z + b.z) / 2)
    host.filmWebGroup.add(web)
  }
  host.markDirty()
}
