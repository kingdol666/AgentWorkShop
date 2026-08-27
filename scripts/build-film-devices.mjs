/**
 * 薄膜双拉产线基础设备 GLB 生成器(一次性/可重复执行)。
 *
 * 依据设计稿 digital-twin.html 的程序化预制件(FACT.*)移植为独立 GLB 文件,
 * 写入 public/assets/game/devices/ —— 设备库扫描 API 自动发现,拖入场景即实例化。
 *
 * 设备清单(挤出→流延→MD 纵拉→TD 横拉→收卷 + 辅助单元):
 *   extruder 挤出机 / caster 流延冷却 / mdo MD 纵拉机 / tdo TD 拉幅机 /
 *   winder 收卷机 / thickness-scanner 厚度扫描仪 / agv AGV 搬运车 / power-cabinet 配电柜
 * (控制台 device-console.glb 与机械臂 device-robot-arm.glb 已存在,不在生成之列)
 *
 * 材质约定:LED 部件使用名为 LED 的自发光材质;屏幕为深青面板色。
 * 运行:node scripts/build-film-devices.mjs
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

// Node 环境垫片:GLTFExporter 二进制导出仅用 FileReader 读 Blob(Node 24 原生 Blob)
globalThis.FileReader = class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((b) => {
      this.result = b
      this.onloadend()
    })
  }
}

const OUT_DIR = join(process.cwd(), 'public/assets/game/devices')

/* ---------- 材质(设计稿 MAT.* 移植;屏幕用纯色代替 Canvas 贴图) ---------- */
const std = (c, mt, rf) => new THREE.MeshStandardMaterial({ color: c, metalness: mt, roughness: rf })
const MAT = {
  steel: std(0x9fb2c8, 0.85, 0.32),
  chrome: std(0xdfe8f2, 1, 0.14),
  body: std(0x74869c, 0.35, 0.5),
  body2: std(0x55647a, 0.4, 0.55),
  dark: std(0x2b3442, 0.7, 0.45),
  rubber: std(0x1a1f27, 0.2, 0.95),
  copper: std(0xc57a45, 0.9, 0.35),
  roll: std(0xe6ecf4, 0.15, 0.6),
  glowCyan: new THREE.MeshBasicMaterial({ color: 0x53d6ff }),
  screen: new THREE.MeshBasicMaterial({ color: 0x123246 }),
}
MAT.glowCyan.name = 'GLOW'
MAT.screen.name = 'SCREEN'
const ledMat = new THREE.MeshBasicMaterial({ color: 0x35e0a0 })
ledMat.name = 'LED'

/* ---------- 建模基元 ---------- */
const B = (w, h, d, m) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
const Cyl = (rt, rb, h, m, seg = 24) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m)
const Sph = (r, m) => new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), m)
const Tor = (r, t, m) => new THREE.Mesh(new THREE.TorusGeometry(r, t, 10, 32), m)
const at = (m, x, y, z) => {
  m.position.set(x, y, z)
  return m
}
const grp = () => new THREE.Group()
const led = (m) => {
  m.material = ledMat
  return m
}

/* ---------- 设备预制件(设计稿 FACT.* 1:1 移植) ---------- */
const FACT = {}

FACT.extruder = () => {
  const g = grp()
  g.add(at(B(4.4, 0.26, 1.7, MAT.dark), 0, 0.13, 0))
  g.add(at(B(1.25, 1.15, 1.25, MAT.body2), -1.45, 0.85, 0))
  const barrel = at(Cyl(0.38, 0.38, 3.2, MAT.steel), 0.35, 1.18, 0)
  barrel.rotation.z = Math.PI / 2
  g.add(barrel)
  for (let i = 0; i < 4; i++) {
    const h = Tor(0.43, 0.07, MAT.copper)
    h.rotation.y = Math.PI / 2
    g.add(at(h, -0.55 + i * 0.65, 1.18, 0))
  }
  g.add(at(Cyl(0.52, 0.2, 0.85, MAT.steel), -1.45, 2.1, 0))
  g.add(at(B(0.55, 0.95, 0.95, MAT.body), 2.2, 1.15, 0))
  g.add(at(Cyl(0.15, 0.15, 0.45, MAT.dark), 2.62, 1.15, 0))
  g.add(at(B(0.75, 0.55, 0.1, MAT.dark), -1.45, 1.72, 0.68))
  const scr = at(B(0.6, 0.36, 0.02, MAT.screen), -1.45, 1.74, 0.74)
  scr.rotation.x = -0.08
  g.add(scr)
  g.add(led(at(B(0.5, 0.07, 0.07), -1.45, 2.02, 0.72)))
  g.add(led(at(B(0.06, 0.06, 1.3), 1.3, 2.6, 0)))
  return g
}

FACT.caster = () => {
  const g = grp()
  g.add(at(B(1.7, 0.26, 2.7, MAT.dark), 0, 0.13, 0))
  for (const z of [-1.05, 1.05]) g.add(at(B(0.34, 2.35, 0.3, MAT.body2), 0, 1.3, z))
  const roll = at(Cyl(1.12, 1.12, 2.1, MAT.chrome), 0, 1.62, 0)
  roll.rotation.x = Math.PI / 2
  g.add(roll)
  const nip = at(Cyl(0.42, 0.42, 2.1, MAT.steel), 0.95, 2.9, 0)
  nip.rotation.x = Math.PI / 2
  g.add(nip)
  g.add(at(B(0.8, 0.7, 0.8, MAT.body2), 1.25, 0.62, 1.15))
  g.add(led(at(B(0.07, 0.07, 0.9), 0, 2.55, -1.02)))
  return g
}

FACT.mdo = () => {
  const g = grp()
  for (const [x, z] of [[-2.5, -0.85], [2.5, -0.85], [-2.5, 0.85], [2.5, 0.85]]) {
    g.add(at(B(0.28, 0.9, 0.28, MAT.dark), x, 0.45, z))
  }
  g.add(at(B(5.6, 2.3, 2.2, MAT.body), 0, 2.05, 0))
  g.add(at(B(5.6, 0.18, 2.2, MAT.body2), 0, 3.29, 0))
  for (const x of [-1.7, 0, 1.7]) {
    for (const z of [-1.11, 1.11]) g.add(at(B(0.8, 0.9, 0.03, MAT.glowCyan), x, 2.0, z))
  }
  for (const x of [-1.8, 1.8]) g.add(at(Cyl(0.17, 0.17, 0.75, MAT.steel), x, 3.75, 0))
  for (const x of [-3.15, 3.15]) {
    g.add(at(B(0.55, 2.3, 2.35, MAT.dark), x, 1.15, 0))
    for (const y of [1.15, 1.7, 2.25]) {
      const r = at(Cyl(0.13, 0.13, 2.15, MAT.chrome), x, y, 0)
      r.rotation.x = Math.PI / 2
      g.add(r)
    }
  }
  g.add(led(at(B(4.8, 0.06, 0.06), 0, 3.44, 1.12)))
  return g
}

FACT.tdo = () => {
  const g = grp()
  for (const [x, z] of [[-2.8, -1.25], [2.8, -1.25], [-2.8, 1.25], [2.8, 1.25]]) {
    g.add(at(B(0.3, 0.85, 0.3, MAT.dark), x, 0.42, z))
  }
  g.add(at(B(6.2, 2.1, 3.0, MAT.body), 0, 1.9, 0))
  g.add(at(B(6.2, 0.22, 3.0, MAT.body2), 0, 3.06, 0))
  for (const x of [-2.6, 0, 2.6]) g.add(at(Cyl(0.15, 0.15, 0.65, MAT.steel), x, 3.5, 0))
  for (const z of [-1.53, 1.53]) g.add(at(B(5.4, 0.14, 0.04, MAT.glowCyan), 0, 1.85, z))
  for (const z of [-1.38, 1.38]) {
    g.add(at(B(6.7, 0.1, 0.16, MAT.steel), 0, 3.25, z))
    for (let i = -2; i <= 2; i++) g.add(at(B(0.16, 0.18, 0.2, MAT.dark), i * 1.3, 3.4, z))
  }
  g.add(led(at(B(5.6, 0.06, 0.06), 0, 3.24, 1.53)))
  return g
}

FACT.winder = () => {
  const g = grp()
  g.add(at(B(2.9, 0.3, 2.3, MAT.dark), 0, 0.15, 0))
  for (const x of [-1, 1]) g.add(at(B(0.42, 2.25, 2.05, MAT.body2), x, 1.35, 0))
  for (const x of [-1, 1]) {
    const r = at(Cyl(1.02, 0.78, 1.5, MAT.roll), x, 1.95, 0)
    r.rotation.x = Math.PI / 2
    g.add(r)
    g.add(at(Cyl(0.2, 0.2, 1.6, MAT.dark), x, 1.95, 0))
  }
  g.add(at(B(0.66, 0.95, 0.14, MAT.dark), 0, 1.5, 1.18))
  g.add(at(B(0.56, 0.4, 0.02, MAT.screen), 0, 1.6, 1.26))
  g.add(led(at(B(0.5, 0.06, 0.06), 0, 2.62, 0)))
  return g
}

FACT.scanner = () => {
  const g = grp()
  g.add(at(B(2.8, 0.2, 1.0, MAT.dark), 0, 0.1, 0))
  for (const x of [-1.15, 1.15]) g.add(at(B(0.24, 2.7, 0.5, MAT.steel), x, 1.5, 0))
  g.add(at(B(2.75, 0.32, 0.55, MAT.steel), 0, 2.9, 0))
  g.add(at(B(0.5, 0.62, 0.4, MAT.body), 0, 2.25, 0))
  g.add(at(B(0.14, 0.1, 0.14, MAT.glowCyan), 0, 1.9, 0))
  g.add(led(at(B(0.5, 0.06, 0.06), 0, 3.12, 0)))
  return g
}

FACT.agv = () => {
  const g = grp()
  g.add(at(B(1.75, 0.5, 1.15, MAT.body2), 0, 0.42, 0))
  g.add(at(B(1.5, 0.1, 0.95, MAT.dark), 0, 0.72, 0))
  for (const [x, z] of [[-0.65, 0.45], [0.65, 0.45], [-0.65, -0.45], [0.65, -0.45]]) {
    const w = at(Cyl(0.18, 0.18, 0.14, MAT.rubber), x, 0.2, z)
    w.rotation.x = Math.PI / 2
    g.add(w)
  }
  g.add(at(B(1.25, 0.09, 0.07, MAT.rubber), 0, 0.68, 0.56))
  g.add(led(at(B(1.2, 0.07, 0.05), 0, 0.6, 0.58)))
  g.add(at(B(0.1, 0.62, 0.1, MAT.steel), -0.6, 1.05, -0.3))
  g.add(led(Sph(0.09), -0.6, 1.4, -0.3))
  return g
}

FACT.cabinet = () => {
  const g = grp()
  g.add(at(B(1.22, 0.14, 0.92, MAT.dark), 0, 0.07, 0))
  g.add(at(B(1.1, 2.2, 0.8, MAT.body2), 0, 1.24, 0))
  g.add(at(B(1.0, 2.06, 0.03, MAT.body), 0, 1.24, 0.41))
  for (const y of [0.5, 0.9, 1.3]) g.add(at(B(0.7, 0.03, 0.02, MAT.dark), 0, y + 0.62, 0.43))
  g.add(led(Sph(0.05), 0.38, 2.1, 0.43))
  return g
}

/* ---------- 导出清单:文件名 → 预制件(×34 统一放大,便于库内直观) ---------- */
const EXPORTS = [
  ['extruder.glb', FACT.extruder],
  ['caster.glb', FACT.caster],
  ['mdo.glb', FACT.mdo],
  ['tdo.glb', FACT.tdo],
  ['winder.glb', FACT.winder],
  ['thickness-scanner.glb', FACT.scanner],
  ['agv.glb', FACT.agv],
  ['power-cabinet.glb', FACT.cabinet],
]
const S = 34

const exporter = new GLTFExporter()
for (const [file, build] of EXPORTS) {
  const g = build()
  g.scale.setScalar(S)
  g.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(g)
  const h = box.max.y - box.min.y
  const buf = await new Promise((resolve, reject) => {
    exporter.parse(g, resolve, reject, { binary: true })
  })
  writeFileSync(join(OUT_DIR, file), Buffer.from(buf))
  console.log(`OK ${file}  ${String(buf.byteLength).padStart(7)} B  建模高 ${h.toFixed(2)}(x34)`)
}
console.log('完成:薄膜双拉基础设备已写入 public/assets/game/devices/')
