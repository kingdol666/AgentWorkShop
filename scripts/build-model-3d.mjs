/**
 * 内置 3D 角色模型生成器 —— 用 Three.js 搭一个低多边形「共鸣员工」并导出为 GLB。
 * 产出:public/assets/game/character/hero-3d.glb(单文件,内嵌几何,无外部贴图)。
 * 运行:node scripts/build-model-3d.mjs(或 pnpm game:build-model3d)。
 */
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import * as THREE from 'three'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// GLTFExporter 依赖浏览器 FileReader;Node 环境用最小 polyfill 兜底。
// 关键:GlbBlob/Blob → ArrayBuffer。Node 18+ 的 Blob 有 async arrayBuffer(),但
// GLTFExporter 走同步 FileReader,因此用 Blob.arrayBuffer() 的 Promise 抓回实际 buffer。
globalThis.FileReader = globalThis.FileReader || class {
  result = null
  onloadend = null
  error = null
  async readAsArrayBuffer(blob) {
    try {
      // blob 可能是 Buffer 或 Blob
      if (blob && typeof blob.arrayBuffer === 'function') this.result = await blob.arrayBuffer()
      else if (blob instanceof Uint8Array) this.result = blob.buffer
      else this.result = Buffer.from(blob).buffer
    }
    catch (e) {
      this.error = e
    }
    if (this.onloadend) this.onloadend()
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '../public/assets/game/character/hero-3d.glb')

/** 建低多边形员工:发光核心 + 锥形长袍 + 头部 + 飘带头发 + 双臂 */
function buildHero() {
  const g = new THREE.Group()

  // 材质(低饱和,场景会按频道色 tint 顶部环,模型本体用暖白/冷青)
  const robeMat = new THREE.MeshStandardMaterial({ color: 0xd8ecec, roughness: 0.7, metalness: 0.1 })
  const robeDeep = new THREE.MeshStandardMaterial({ color: 0x8fb7c4, roughness: 0.75, metalness: 0.1 })
  const glowMat = new THREE.MeshStandardMaterial({ color: 0x9fe8d4, emissive: 0x66c9b4, emissiveIntensity: 0.9, roughness: 0.4 })
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xf0e0d0, roughness: 0.8 })
  const hairMat = new THREE.MeshStandardMaterial({ color: 0x9adcea, roughness: 0.6 })
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xbfe8f0, emissive: 0x66c9b4, emissiveIntensity: 0.5, roughness: 0.5 })

  // 长袍(锥形裙摆)
  const robe = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.34, 1.0, 8), robeMat)
  robe.position.y = 0.5
  robe.castShadow = true
  g.add(robe)
  // 下摆深色带
  const hem = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.36, 0.12, 8), robeDeep)
  hem.position.y = 0.06
  g.add(hem)
  // 胸口发光核心
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), glowMat)
  core.position.y = 0.86
  g.add(core)
  // 肩部胸甲(微光)
  const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.14, 0.18, 8), trimMat)
  chest.position.y = 0.86
  chest.castShadow = true
  g.add(chest)
  // 头部
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 1), skinMat)
  head.position.y = 1.12
  head.castShadow = true
  g.add(head)
  // 后发/马尾
  const hair = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.5, 6), hairMat)
  hair.position.set(0.12, 1.02, -0.02)
  hair.rotation.z = -0.5
  g.add(hair)
  // 双臂(斜向飘带)
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.5, 5), trimMat)
    arm.position.set(s * 0.28, 0.66, 0.02)
    arm.rotation.z = s * 0.6
    g.add(arm)
  }
  // 头顶饰品(发光角)
  for (const s of [-1, 1]) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.2, 5), glowMat)
    horn.position.set(s * 0.14, 1.26, 0.06)
    horn.rotation.x = -0.2
    g.add(horn)
  }
  // 脚底落点(指示锚点位置,0 高度)
  const foot = new THREE.Mesh(new THREE.CircleGeometry(0.16, 16), glowMat)
  foot.rotation.x = -Math.PI / 2
  foot.position.y = 0.01
  g.add(foot)

  return g
}

const hero = buildHero()
const exporter = new GLTFExporter()
process.on('unhandledRejection', (e) => {
  console.error('unhandledRejection:', e?.message || e)
  process.exit(1)
})
writeGlb(hero, OUT)

/** 数字孪生设备模型:低多边形工业泵(底座+机身+叶轮+管道),与 hero-3d 分开导出 */
function buildDevice() {
  const g = new THREE.Group()
  const metal = new THREE.MeshStandardMaterial({ color: 0x8898a6, roughness: 0.5, metalness: 0.6 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x4a5a6a, roughness: 0.6, metalness: 0.4 })
  const teal = new THREE.MeshStandardMaterial({ color: 0x5fb8a8, roughness: 0.5, metalness: 0.3 })
  const warn = new THREE.MeshStandardMaterial({ color: 0xefb56a, roughness: 0.7 })

  // 底座
  const base = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.4, 2.0), metal)
  base.position.y = 0.2
  base.castShadow = true
  g.add(base)
  // 机身(立式圆柱泵体)
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.85, 2.2, 10), dark)
  body.position.y = 1.4
  body.castShadow = true
  g.add(body)
  // 叶轮罩(青色环)
  const casing = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.5, 10), teal)
  casing.position.y = 1.1
  g.add(casing)
  // 顶盖
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 0.4, 8), warn)
  cap.position.y = 2.6
  g.add(cap)
  // 出水管(横管)
  const pipeOut = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 1.6, 8), metal)
  pipeOut.rotation.z = Math.PI / 2
  pipeOut.position.set(1.2, 1.5, 0)
  g.add(pipeOut)
  // 进水管(竖管)
  const pipeIn = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.4, 8), dark)
  pipeIn.position.set(-0.9, 0.9, 0)
  pipeIn.rotation.z = 0.2
  g.add(pipeIn)
  // 控制面板(方形示数屏,青色发光)
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.15), teal)
  panel.position.set(-1.0, 1.9, 0)
  g.add(panel)
  return g
}

const DEVICE_OUT = path.resolve(__dirname, '../public/assets/game/character/device-3d.glb')
writeGlb(buildDevice(), DEVICE_OUT)

function writeGlb(obj, out) {
  exporter.parse(
    obj,
    (result) => {
      if (typeof result === 'string') {
        fs.writeFileSync(out, result, 'utf-8')
      }
      else {
        const buf = Buffer.from(result)
        fs.mkdirSync(path.dirname(out), { recursive: true })
        fs.writeFileSync(out, buf)
      }
      console.log('GLB written to', out)
    },
    (err) => {
      console.error('export error', err?.message || err)
      process.exit(1)
    },
    { binary: true },
  )
}
