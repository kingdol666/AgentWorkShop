/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— 纯构建工厂(几何 / 铭牌 / 传感器网格 / 贴图)。
 *
 * 自 TownScene3D.ts 抽出:只承载「不持有场景状态」的构建函数 ——
 *  - 领地平台/边框几何(按真实半轴烘焙放平)与贴形;
 *  - HMI 铭牌 Sprite(int 色 → CSS hex 的纯函数);
 *  - 频道信标 / 设备状态环 / 数采传感头 / 统一兜底机器人模型;
 *  - 程序化地面贴图与穹顶天幕。
 *
 * 不依赖 TownScene3D 实例:需要挂载的函数显式接收 `THREE.Scene`。
 */
import * as THREE from 'three'
import { WORLD_CX, WORLD_CZ, type ChannelLayout } from '#shared/town-scene-math'
import type { Block3D } from './town-scene3d-nodes'

/** 领地平台面几何:按真实半轴的外形(椭圆/矩形);放平烘焙进顶点(XY→XZ,无镜像),
 *  网格仅需 rotation.y —— 与边界线同一旋转语义,任意朝向严格贴合 */
export function makePadShapeGeometry(shape: 'ellipse' | 'rect', radiusX: number, radiusZ: number): THREE.ShapeGeometry {
  const shp = new THREE.Shape()
  if (shape === 'rect') {
    shp.moveTo(-radiusX, -radiusZ)
    shp.lineTo(radiusX, -radiusZ)
    shp.lineTo(radiusX, radiusZ)
    shp.lineTo(-radiusX, radiusZ)
    shp.closePath()
  }
  else {
    shp.absellipse(0, 0, radiusX, radiusZ, 0, Math.PI * 2)
  }
  const geo = new THREE.ShapeGeometry(shp, shape === 'rect' ? 1 : 56)
  geo.rotateX(Math.PI / 2)
  return geo
}

/** 领地边框几何:外形挖去内缩 ringW 的同形内形(椭圆/矩形;恒定世界线宽) */
export function makePadRingGeometry(shape: 'ellipse' | 'rect', radiusX: number, radiusZ: number, ringW = 13): THREE.ShapeGeometry {
  const irx = Math.max(4, radiusX - ringW)
  const irz = Math.max(4, radiusZ - ringW)
  const outer = new THREE.Shape()
  const inner = new THREE.Path()
  if (shape === 'rect') {
    outer.moveTo(-radiusX, -radiusZ)
    outer.lineTo(radiusX, -radiusZ)
    outer.lineTo(radiusX, radiusZ)
    outer.lineTo(-radiusX, radiusZ)
    outer.closePath()
    inner.moveTo(-irx, -irz)
    inner.lineTo(irx, -irz)
    inner.lineTo(irx, irz)
    inner.lineTo(-irx, irz)
    inner.closePath()
  }
  else {
    outer.absellipse(0, 0, radiusX, radiusZ, 0, Math.PI * 2)
    inner.absellipse(0, 0, irx, irz, 0, Math.PI * 2)
  }
  outer.holes.push(inner)
  const geo = new THREE.ShapeGeometry(outer, shape === 'rect' ? 1 : 56)
  geo.rotateX(Math.PI / 2)
  return geo
}

/** 平台/边框贴形(半径或形状变化后):平台与边框几何都按真实尺寸重建;同步朝向 */
export function applyPadToBlock(b: Block3D): void {
  const rotY = b.rotationY * Math.PI / 180
  b.platform.rotation.set(0, rotY, 0)
  b.padRing.rotation.set(0, rotY, 0)
  const oldP = b.platform.geometry
  b.platform.geometry = makePadShapeGeometry(b.shape, b.radiusX, b.radiusZ)
  oldP.dispose()
  const old = b.padRing.geometry
  b.padRing.geometry = makePadRingGeometry(b.shape, b.radiusX, b.radiusZ)
  old.dispose()
}

/** int 颜色 → CSS hex(铭牌身份色用) */
export function hexOf(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

/** 文本 Sprite(名牌/名字)—— HMI 铭牌:深底 + 发丝描边 + 左缘数据条 + 等宽字。
 *  accent: 左缘数据条与描边 tint 的身份色(Agent 铭牌传所属频道哈希色 → 归属一眼可辨)。 */
export function makeLabel(scene: THREE.Scene, text: string, x: number, y: number, z: number, accent = '#41c8f4'): THREE.Sprite {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  const font = '600 21px "Geist Mono", Geist, "PingFang SC", monospace'
  ctx.font = font
  const padL = 26
  const padR = 14
  const w = Math.max(104, Math.ceil(ctx.measureText(text).width) + padL + padR)
  const h = 48
  canvas.width = w
  canvas.height = h
  ctx.font = font
  // 深色铭牌底 + 半透明度(不遮场景,只提字)
  ctx.fillStyle = 'rgba(10,14,20,0.8)'
  ctx.fillRect(0, 0, w, h)
  // 发丝描边(身份色轻 tint)+ 左缘数据条(身份色)
  ctx.strokeStyle = `${accent}66`
  ctx.lineWidth = 1
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1)
  ctx.fillStyle = accent
  ctx.fillRect(0, 0, 3, h)
  ctx.fillStyle = '#dce7f0'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, padL, h / 2 + 1)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }))
  sprite.scale.set(w / 6, h / 6, 1)
  sprite.position.set(x, y, z)
  scene.add(sprite)
  return sprite
}

/** 频道中心信标(HMI 定位销):点击 → pickBeacon 定位中心 + 唤醒边界编辑 */
export function makeBeacon(scene: THREE.Scene, color: number): THREE.Group {
  const g = new THREE.Group()
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a3542, roughness: 0.45, metalness: 0.65 })
  const base = new THREE.Mesh(new THREE.CylinderGeometry(7, 9, 5, 12), metal)
  base.position.y = 2.5
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 30, 8), metal)
  pole.position.y = 18
  const tip = new THREE.Mesh(new THREE.OctahedronGeometry(6.5), new THREE.MeshBasicMaterial({ color }))
  // HDR 亮度:信标顶标是 HMI 定位销的"灯",bloom 起晕(seleRing/边界保持 LDR 不起晕)
  ;(tip.material as THREE.MeshBasicMaterial).color.multiplyScalar(4.5)
  tip.position.y = 37
  g.add(base, pole, tip)
  return g
}

/** 领地底盘 = 按真实形状的平台(染色层) + 同形边框环(边界告示);所见即用户设置 */
export function makeBlock(scene: THREE.Scene, name: string, color: number, layout: ChannelLayout): { platform: THREE.Mesh, padRing: THREE.Mesh, beacon: THREE.Group } {
  const rotY = layout.rotationY * Math.PI / 180
  // 平台:按真实半轴构建(与边框环同一构建路径,无单位几何、无 scale 传递 —— 杜绝缩放残留)
  const platform = new THREE.Mesh(
    makePadShapeGeometry(layout.shape, layout.radiusX, layout.radiusZ),
    new THREE.MeshStandardMaterial({
      color, transparent: true, opacity: 0.24, roughness: 0.85, metalness: 0.12,
      emissive: color, emissiveIntensity: 0.12, side: THREE.DoubleSide,
    }),
  )
  // 几何已烘焙放平(XY→XZ 无镜像),网格仅做 Y 旋转(与边界线同语义),不再有任何 scale
  platform.rotation.set(0, rotY, 0)
  platform.position.set(layout.x, 0.16, layout.z)
  platform.receiveShadow = false
  scene.add(platform)
  // 边框环:实际尺寸外形挖去内缩内形(恒定 13 单位线宽,随形状变化重建)
  const padRing = new THREE.Mesh(
    makePadRingGeometry(layout.shape, layout.radiusX, layout.radiusZ),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.52, side: THREE.DoubleSide, depthWrite: false }),
  )
  padRing.rotation.set(0, rotY, 0)
  padRing.position.set(layout.x, 0.34, layout.z)
  scene.add(padRing)
  // 中央信标(HMI 定位销):底座 + 立杆 + 频道色菱形顶标(顶标随渲染循环缓转)
  const beacon = makeBeacon(scene, color)
  beacon.position.set(layout.x, 0, layout.z)
  scene.add(beacon)
  void name
  return { platform, padRing, beacon }
}

/** 设备状态环 + 运行态动效弧(局部坐标一次定位随 root 移动 —— 修复曾被每帧写成世界坐标导致环 2× 漂移的缺陷)。
 *  颜色/显隐由 DeviceNode.updateRing 数据驱动,渲染循环只负责弧的缓转。 */
export function makeDeviceRing(): { ring: THREE.Mesh, arc: THREE.Mesh } {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(20, 26, 32),
    new THREE.MeshBasicMaterial({ color: 0xf6c453, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.3
  const arc = new THREE.Mesh(
    new THREE.RingGeometry(20, 26, 32, 1, 0, Math.PI * 1.5),
    new THREE.MeshBasicMaterial({ color: 0x35e0a0, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
  )
  arc.rotation.x = -Math.PI / 2
  arc.position.y = 0.34
  arc.visible = false
  return { ring, arc }
}

/** 数采节点传感头(设计稿 DAQ 预制件 1:1 移植,×34 世界单位):
 *  立杆基座 + 顶端 LED 环 + 每模板独立传感形态 —— 温度计/压力表/张力辊/编码盘/相机/电参天线。 */
export function makeDaqMesh(modelRef: string): { group: THREE.Group, ledRing: THREE.Mesh } {
  const S = 34
  const g = new THREE.Group()
  const steel = new THREE.MeshStandardMaterial({ color: 0x9fb2c8, metalness: 0.85, roughness: 0.32 })
  const body = new THREE.MeshStandardMaterial({ color: 0x74869c, metalness: 0.35, roughness: 0.5 })
  const body2 = new THREE.MeshStandardMaterial({ color: 0x55647a, metalness: 0.4, roughness: 0.55 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b3442, metalness: 0.7, roughness: 0.45 })
  const chrome = new THREE.MeshStandardMaterial({ color: 0xdfe8f2, metalness: 1, roughness: 0.14 })
  const copper = new THREE.MeshStandardMaterial({ color: 0xc57a45, metalness: 0.9, roughness: 0.35 })
  const glow = new THREE.MeshBasicMaterial({ color: 0x41c8f4 })
  glow.color.multiplyScalar(5)
  const B = (w: number, h: number, d: number, m: THREE.Material): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w * S, h * S, d * S), m)
    mesh.castShadow = true
    return mesh
  }
  const Cyl = (rt: number, rb: number, h: number, m: THREE.Material, seg = 20): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt * S, rb * S, h * S, seg), m)
    mesh.castShadow = true
    return mesh
  }
  const at = (m: THREE.Mesh, x: number, y: number, z: number): THREE.Mesh => {
    m.position.set(x * S, y * S, z * S)
    g.add(m)
    return m
  }
  // 立杆基座(设计稿 daqPole)
  at(Cyl(0.17, 0.22, 0.09, dark), 0, 0.045, 0)
  at(Cyl(0.028, 0.028, 0.95, steel, 10), 0, 0.55, 0)
  const ledRing = new THREE.Mesh(new THREE.TorusGeometry(0.09 * S, 0.02 * S, 10, 28), new THREE.MeshBasicMaterial({ color: 0x35e0a0 }))
  // HDR 亮度:LED 环(及其复用材质的 halo/iris/tip)提到阈值之上,"真发光"元件(bloom 起晕)
  ;(ledRing.material as THREE.MeshBasicMaterial).color.multiplyScalar(6)
  ledRing.rotation.x = Math.PI / 2
  g.add(ledRing)
  ledRing.position.y = 1.02 * S
  // 每模板传感头(modelRef = `daq-<tplId>`)
  if (modelRef.endsWith('temp-tc')) {
    at(B(0.24, 0.32, 0.24, body), 0, 1.2, 0)
    const probe = at(Cyl(0.014, 0.014, 0.4, steel, 8), 0.14, 0.85, 0)
    probe.rotation.z = -0.5
  }
  else if (modelRef.endsWith('pressure-tx')) {
    at(Cyl(0.13, 0.16, 0.3, steel), 0, 1.22, 0)
    at(Cyl(0.12, 0.12, 0.05, dark), 0, 1.4, 0)
    at(B(0.05, 0.05, 0.2, copper), 0, 1.1, 0.2)
  }
  else if (modelRef.endsWith('tension-cell')) {
    at(B(0.34, 0.2, 0.2, body), 0, 1.25, 0)
    for (const x of [-0.11, 0.11]) {
      const roll = at(Cyl(0.06, 0.06, 0.26, chrome), x, 1.25, 0)
      roll.rotation.x = Math.PI / 2
    }
  }
  else if (modelRef.endsWith('line-encoder')) {
    at(B(0.34, 0.05, 0.05, steel), 0.14, 1.28, 0)
    const disc = at(Cyl(0.16, 0.16, 0.05, dark), 0.32, 1.28, 0)
    disc.rotation.z = Math.PI / 2
    const halo = new THREE.Mesh(new THREE.TorusGeometry(0.1 * S, 0.015 * S, 10, 26), ledRing.material as THREE.Material)
    at(halo, 0.35, 1.28, 0)
  }
  else if (modelRef.endsWith('vision-cam')) {
    at(B(0.28, 0.2, 0.36, body2), 0, 1.3, 0)
    const lens = at(Cyl(0.07, 0.09, 0.14, dark), 0, 1.3, 0.24)
    lens.rotation.x = Math.PI / 2
    const iris = new THREE.Mesh(new THREE.TorusGeometry(0.075 * S, 0.012 * S, 10, 24), ledRing.material as THREE.Material)
    at(iris, 0, 1.3, 0.3)
  }
  else if (modelRef.endsWith('power-meter')) {
    at(B(0.32, 0.42, 0.18, body), 0, 1.3, 0)
    at(Cyl(0.012, 0.012, 0.42, steel, 8), 0.1, 1.7, 0)
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.028 * S, 10, 8), ledRing.material as THREE.Material)
    at(tip, 0.1, 1.92, 0)
    at(B(0.2, 0.06, 0.02, glow), 0, 1.42, 0.1)
  }
  return { group: g, ledRing }
}

/**
 * 程序化「孪生机器人」兜底模型:GLB 缺失/加载失败时使用,保证 Agent 永远可见。
 * 结构:胶囊躯干 + 头部 + 发光核心胸灯 + 天线信号球 + 悬浮底盘;中性工业灰 + 青蓝核心。
 */
export function makeFallbackBot(): THREE.Group {
  const bot = new THREE.Group()
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2a3542, roughness: 0.42, metalness: 0.62 })
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x141b24, roughness: 0.6, metalness: 0.4 })
  const coreMat = new THREE.MeshBasicMaterial({ color: 0x41c8f4 })
  // 躯干(胶囊)
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.62, 8, 16), bodyMat)
  body.position.y = 0.86
  // 头部
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), bodyMat)
  head.position.y = 1.62
  // 面窗(发光条带,数字孪生眼)
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.12), coreMat)
  visor.position.set(0, 1.66, 0.27)
  // 发光核心胸灯
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), coreMat)
  core.position.set(0, 1.1, 0.36)
  // 悬浮底盘
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 0.26, 16), darkMat)
  base.position.y = 0.16
  // 天线 + 信号球
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 6), darkMat)
  antenna.position.set(0, 2.04, 0)
  const signal = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), coreMat)
  signal.position.set(0, 2.34, 0)
  bot.add(body, head, visor, core, base, antenna, signal)
  return bot
}

/** 工业孪生地面贴图(程序化 Canvas:深色混凝土地基 + 分块拼缝 + 细网格导引线 + 噪点)。
 *  一次性生成并缓存;SVG 背景贴图仅作历史兼容,优先使用本贴图。 */
export function makeIndustrialGroundTexture(renderer: THREE.WebGLRenderer): THREE.CanvasTexture {
  const size = 1024
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  // 深色混凝土地基(微渐变)+ 分块拼缝 + 细网格导引线 —— 夜航深蓝基调(设计稿 #131f36 系)
  const grad = ctx.createLinearGradient(0, 0, size, size)
  grad.addColorStop(0, '#151f36')
  grad.addColorStop(0.5, '#101a2d')
  grad.addColorStop(1, '#131c31')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  // 分块拼缝(工业板格 8×8;低调度 —— 地面是舞台,不是主角)
  ctx.strokeStyle = 'rgba(42,63,102,0.32)'
  ctx.lineWidth = 2
  for (let i = 0; i <= 8; i++) {
    const p = (i / 8) * size
    ctx.beginPath()
    ctx.moveTo(p, 0)
    ctx.lineTo(p, size)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, p)
    ctx.lineTo(size, p)
    ctx.stroke()
  }
  // 细网格导引线(设计稿 GridHelper 主色 0x2a3f66;压暗让设备读第一眼)
  ctx.strokeStyle = 'rgba(42,63,102,0.2)'
  ctx.lineWidth = 1
  for (let i = 0; i <= 32; i++) {
    const p = (i / 32) * size
    ctx.beginPath()
    ctx.moveTo(p, 0)
    ctx.lineTo(p, size)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, p)
    ctx.lineTo(size, p)
    ctx.stroke()
  }
  // 噪点(亚光粗糙感;伪随机但确定性)
  ctx.fillStyle = 'rgba(255,255,255,0.02)'
  for (let i = 0; i < 900; i++) {
    const x = (i * 733) % size
    const y = (i * 151) % size
    ctx.fillRect(x, y, 2, 2)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(23, 17)
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
  return tex
}

/** 穹顶天幕:垂直渐变(顶部深空 → 地平线工业暖灰)+ 顶半球星野 + 底部更亮一点,覆盖整球 */
export function makeSkyDome(): THREE.Mesh {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createLinearGradient(0, 0, 0, 256)
  grad.addColorStop(0, '#080d16') // 天顶:近黑夜空
  grad.addColorStop(0.40, '#121b27')
  grad.addColorStop(0.64, '#22303e') // 中段石墨蓝(提前起坡,渐变带更长)
  grad.addColorStop(0.84, '#3b4b5b') // 地平线:钢色微光(与雾同族)
  grad.addColorStop(1, '#2a3644') // 地平线下收暗(下半球)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  // 星野(顶部 45%:确定性伪随机,数据青/冷白微点,越靠天顶越密 —— 夜航纵深,低调度不抢戏)
  let seed = 20260831
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let i = 0; i < 220; i++) {
    const x = rnd() * canvas.width
    const y = rnd() * rnd() * 118
    const r = rnd() < 0.88 ? 1 : 2
    const a = 0.12 + rnd() * 0.5
    ctx.fillStyle = rnd() < 0.24 ? `rgba(160,220,255,${a.toFixed(2)})` : `rgba(232,240,250,${a.toFixed(2)})`
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const geo = new THREE.SphereGeometry(5600, 24, 16)
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false })
  const dome = new THREE.Mesh(geo, mat)
  dome.position.set(WORLD_CX, 0, WORLD_CZ)
  dome.renderOrder = -10
  return dome
}

/** 赛博小镇背景贴图 → 地面材质(优先程序化工业贴图;SVG 兼容保留)。
 *  返回是否成功(调用方据此置脏标记,与抽出前 try 内 `this.dirty = true` 同级)。 */
export function applyGroundTexture(ground: THREE.Mesh, renderer: THREE.WebGLRenderer): boolean {
  try {
    const mat = ground.material as THREE.MeshStandardMaterial
    // 工业孪生贴图为主(SVG 历史贴图只在程序化不可用时兜底)
    mat.map = makeIndustrialGroundTexture(renderer)
    mat.color.set(0xffffff)
    mat.roughness = 0.94
    mat.metalness = 0.06
    // 环境反射压低:沥青地面保持亚光,反射生命留给金属设备/角色模型
    mat.envMapIntensity = 0.28
    mat.needsUpdate = true
    return true
  }
  catch { /* Canvas 不可用:保持纯色地面 */ }
  return false
}
