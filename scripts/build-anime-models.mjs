/**
 * 二次元 chibi 角色 + 工业设备模型 GLB 生成器(带节点动画,Blender 可直接导入)。
 *
 * 产出(写入 public/assets/game/…):
 *  - character/hero-anime-1..4.glb —— 4 个二次元角色(樱花/苍梧/寒川/紫檀),
 *    idle + walk 两段动画挂在命名节点上(非骨骼,glTF node TRS channels,Blender 导入为 actions);
 *  - devices/device-scanner.glb / device-console.glb / device-robot-arm.glb —— 工业设备(带待机动画)。
 *
 * 动画语义(与 Agent3D.playWalkAnim 对齐):clips[0]=idle, clips[1]=walk。
 * 运行: node scripts/build-anime-models.mjs
 */
import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// GLTFExporter(binary 路径)在纯 Node 环境需要 FileReader;Blob.arrayBuffer 等价 polyfill
globalThis.FileReader ??= class FileReaderPolyfill {
  result = null
  onload = null
  onloadend = null
  onerror = null
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then(
      (b) => {
        this.result = b
        this.onload?.()
        this.onloadend?.()
      },
      (e) => {
        this.onerror?.({ error: e })
        this.onloadend?.()
      },
    )
  }
}

const ROOT = resolve(process.cwd(), 'public/assets/game')
const CHAR_DIR = join(ROOT, 'character')
const DEV_DIR = join(ROOT, 'devices')
mkdirSync(CHAR_DIR, { recursive: true })
mkdirSync(DEV_DIR, { recursive: true })

// ---------- 小工具 ----------

function eulerQ(x = 0, y = 0, z = 0) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z))
}

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.08, ...opts })
}

/** 位置轨道(秒,值数组) */
function posTrack(node, times, values) {
  return new THREE.VectorKeyframeTrack(`${node.name}.position`, times, values)
}

/** 旋转轨道:传入每个关键帧的 euler {x,y,z}[] */
function rotTrack(node, times, eulers) {
  const qs = []
  for (const e of eulers) {
    qs.push(...eulerQ(e.x, e.y, e.z).toArray())
  }
  return new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, times, qs)
}

// ---------- 二次元 chibi 角色 ----------

const PALETTES = [
  { hair: 0xf7a8c8, hairShade: 0xe989b4, body: 0xffffff, accent: 0xef6fa8, eye: 0xff7eb0, label: '樱叶少女' },
  { hair: 0x74c7f0, hairShade: 0x4da3dc, body: 0xf3f7fb, accent: 0x3f9de0, eye: 0x4fc3ff, label: '苍梧少年' },
  { hair: 0xffb26b, hairShade: 0xf08f3c, body: 0xf7f2ea, accent: 0xe8742c, eye: 0xffa04d, label: '寒川工程师' },
  { hair: 0xb79af0, hairShade: 0x9a79e0, body: 0xf6f2ff, accent: 0x8a63e8, eye: 0xbd9bff, label: '紫檀智子' },
]

function buildAnimeCharacter(pal) {
  const root = new THREE.Group()
  root.name = 'hero'
  const hips = new THREE.Group()
  hips.name = 'hips'
  hips.position.y = 0.9
  root.add(hips)

  // 腿(从髋部垂下的细圆柱,pivot 在髋)
  const legGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.6, 8)
  const legMat = mat(pal.body)
  const legL = new THREE.Group()
  legL.name = 'legL'
  legL.position.set(-0.14, -0.16, 0)
  const legLm = new THREE.Mesh(legGeo, legMat)
  legLm.position.y = -0.3
  legL.add(legLm)
  const legR = new THREE.Group()
  legR.name = 'legR'
  legR.position.set(0.14, -0.16, 0)
  const legRm = new THREE.Mesh(legGeo, legMat)
  legRm.position.y = -0.3
  legR.add(legRm)
  hips.add(legL, legR)

  // 躯干(胶囊 + 小裙)
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.32, 6, 12), mat(pal.body))
  torso.name = 'torso'
  torso.position.y = 0.18
  const skirt = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.28, 16), mat(pal.accent))
  skirt.position.y = 0.02
  hips.add(torso, skirt)

  // 手臂(pivot 在肩)
  const armGeo = new THREE.CylinderGeometry(0.075, 0.085, 0.5, 8)
  const armMat = mat(pal.body)
  const armL = new THREE.Group()
  armL.name = 'armL'
  armL.position.set(-0.32, 0.42, 0)
  const armLm = new THREE.Mesh(armGeo, armMat)
  armLm.position.y = -0.26
  armL.add(armLm)
  const armR = new THREE.Group()
  armR.name = 'armR'
  armR.position.set(0.32, 0.42, 0)
  const armRm = new THREE.Mesh(armGeo, armMat)
  armRm.position.y = -0.26
  armR.add(armRm)
  hips.add(armL, armR)

  // 大脑袋(二次元 chibi 比例)+ 头发 + 呆毛 + 眼睛
  const head = new THREE.Group()
  head.name = 'head'
  head.position.y = 0.88
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.34, 20, 16), mat(pal.body))
  head.add(skull)
  const hair = new THREE.Group()
  hair.name = 'hair'
  const hairCap = new THREE.Mesh(
    new THREE.SphereGeometry(0.365, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.62),
    mat(pal.hair),
  )
  hairCap.position.y = 0.05
  const ahoge = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.24, 6), mat(pal.hairShade))
  ahoge.position.set(0.02, 0.42, 0)
  ahoge.rotation.z = -0.5
  hair.add(hairCap, ahoge)
  const eyeGeo = new THREE.SphereGeometry(0.055, 10, 8)
  const eyeMat = new THREE.MeshBasicMaterial({ color: pal.eye })
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat)
  eyeL.position.set(-0.13, 0.02, 0.3)
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat)
  eyeR.position.set(0.13, 0.02, 0.3)
  head.add(hair, eyeL, eyeR)
  hips.add(head)

  // 胸口核灯(二次元科技感)
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshBasicMaterial({ color: pal.accent }))
  core.position.set(0, 0.32, 0.22)
  hips.add(core)

  return { root, hips, head, hair, armL, armR, legL, legR }
}

/** 角色动画:idle(呼吸/摆臂/点头) + walk(摆腿摆臂/跳跃);与 Agent3D clips[0]=idle,clips[1]=walk 对齐 */
function animeClips(a) {
  const { hips, head, hair, armL, armR, legL, legR } = a
  // idle 2.4s
  const it = [0, 0.6, 1.2, 1.8, 2.4]
  const idle = new THREE.AnimationClip('idle', 2.4, [
    posTrack(hips, it, [0, 0.9, 0, 0, 0.95, 0, 0, 0.9, 0, 0, 0.95, 0, 0, 0.9, 0]),
    rotTrack(armL, it, [{ z: 0.05 }, { z: 0.12 }, { z: 0.05 }, { z: 0.12 }, { z: 0.05 }]),
    rotTrack(armR, it, [{ z: -0.05 }, { z: -0.12 }, { z: -0.05 }, { z: -0.12 }, { z: -0.05 }]),
    rotTrack(head, it, [{ z: 0.02 }, { z: 0.06 }, { z: 0.02 }, { z: 0.06 }, { z: 0.02 }]),
    rotTrack(hair, it, [{ z: 0 }, { z: 0.04 }, { z: 0 }, { z: 0.04 }, { z: 0 }]),
  ])
  // walk 1.0s(四拍)
  const wt = [0, 0.25, 0.5, 0.75, 1]
  const walk = new THREE.AnimationClip('walk', 1, [
    rotTrack(legL, wt, [{ x: 0.75 }, { x: 0 }, { x: -0.75 }, { x: 0 }, { x: 0.75 }]),
    rotTrack(legR, wt, [{ x: -0.75 }, { x: 0 }, { x: 0.75 }, { x: 0 }, { x: -0.75 }]),
    rotTrack(armL, wt, [{ x: -0.55 }, { x: 0 }, { x: 0.55 }, { x: 0 }, { x: -0.55 }]),
    rotTrack(armR, wt, [{ x: 0.55 }, { x: 0 }, { x: -0.55 }, { x: 0 }, { x: 0.55 }]),
    rotTrack(head, wt, [{ z: 0.05 }, { z: -0.05 }, { z: 0.05 }, { z: -0.05 }, { z: 0.05 }]),
    posTrack(hips, wt, [0, 1.0, 0, 0, 1.02, 0, 0, 1.0, 0, 0, 1.02, 0, 0, 1.0, 0]),
  ])
  return [idle, walk]
}

// ---------- 工业设备 ----------

function buildScanner() {
  const g = new THREE.Group()
  g.name = 'scanner'
  const pillar = new THREE.BoxGeometry(0.9, 6, 0.9)
  const pm = mat(0x35414f, { metalness: 0.6, roughness: 0.4 })
  const pl = new THREE.Mesh(pillar, pm)
  pl.position.set(-3.4, 3, 0)
  const pr = new THREE.Mesh(pillar, pm)
  pr.position.set(3.4, 3, 0)
  const top = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.9, 1.1), mat(0x2b3644, { metalness: 0.6 }))
  top.position.y = 6.2
  const base = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.4, 1.4), mat(0x1e2733))
  base.position.y = 0.2
  // 扫描光带(待机往返)
  const scan = new THREE.Group()
  scan.name = 'scan'
  const strip = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 4.8, 0.5),
    new THREE.MeshBasicMaterial({ color: 0x59d9ff, transparent: true, opacity: 0.9 }),
  )
  strip.position.y = 3.2
  scan.add(strip)
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(6.6, 0.18, 0.9),
    new THREE.MeshBasicMaterial({ color: 0x59d9ff, transparent: true, opacity: 0.35 }),
  )
  beam.position.y = 3.2
  scan.add(beam)
  g.add(pl, pr, top, base, scan)
  return g
}

function buildConsole() {
  const g = new THREE.Group()
  g.name = 'console'
  const desk = new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.6, 1.8), mat(0x3a4656, { metalness: 0.5, roughness: 0.45 }))
  desk.position.y = 1.3
  const screen = new THREE.Mesh(new THREE.BoxGeometry(4.0, 2.0, 0.24), new THREE.MeshBasicMaterial({ color: 0x5fd6ff }))
  screen.name = 'screen'
  screen.position.set(0, 2.6, 0.55)
  screen.rotation.x = -0.28
  const antenna = new THREE.Group()
  antenna.name = 'antenna'
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.6, 8), mat(0x2b3644))
  pole.position.y = 3.6
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffb35c }))
  tip.position.y = 4.4
  antenna.add(pole, tip)
  const base = new THREE.Mesh(new THREE.BoxGeometry(5.0, 0.35, 2.2), mat(0x1e2733))
  base.position.y = 0.18
  g.add(desk, screen, antenna, base)
  return g
}

function buildRobotArm() {
  const g = new THREE.Group()
  g.name = 'robotArm'
  const base = new THREE.Group()
  base.name = 'base'
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.15, 0.9, 12), mat(0x2b3644, { metalness: 0.55 }))
  pedestal.position.y = 0.45
  base.add(pedestal)
  const arm = new THREE.Group()
  arm.name = 'arm'
  arm.position.y = 1.0
  const link1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.8, 0.5), mat(0x59d9ff, { metalness: 0.5, roughness: 0.35 }))
  link1.position.y = 1.4
  const elbow = new THREE.Group()
  elbow.name = 'elbow'
  elbow.position.y = 2.8
  const link2 = new THREE.Mesh(new THREE.BoxGeometry(0.4, 2.2, 0.4), mat(0x35414f, { metalness: 0.5 }))
  link2.position.y = 1.1
  const tipMesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffb35c }))
  tipMesh.position.y = 2.2
  elbow.add(link2, tipMesh)
  arm.add(link1, elbow)
  base.add(arm)
  g.add(base)
  return g
}

function deviceClips(g, kind) {
  if (kind === 'scanner') {
    const scan = g.getObjectByName('scan')
    return [new THREE.AnimationClip('idle', 2, [
      posTrack(scan, [0, 0.5, 1, 1.5, 2], [-2.6, 0, 0, 0, 0, 0, 2.6, 0, 0, 0, 0, 0, -2.6, 0, 0]),
    ])]
  }
  if (kind === 'console') {
    const antenna = g.getObjectByName('antenna')
    return [new THREE.AnimationClip('idle', 2.4, [
      rotTrack(antenna, [0, 0.6, 1.2, 1.8, 2.4], [{ z: 0 }, { z: 0.1 }, { z: 0 }, { z: 0.1 }, { z: 0 }]),
    ])]
  }
  // robotArm:基座旋转 + 肘部摆动
  const base = g.getObjectByName('base')
  const arm = g.getObjectByName('arm')
  return [new THREE.AnimationClip('idle', 4, [
    rotTrack(base, [0, 1, 2, 3, 4], [{ y: -0.7 }, { y: 0 }, { y: 0.7 }, { y: 0 }, { y: -0.7 }]),
    rotTrack(arm, [0, 1, 2, 3, 4], [{ z: 0.15 }, { z: 0.65 }, { z: 0.15 }, { z: -0.3 }, { z: 0.15 }]),
  ])]
}

// ---------- 导出 ----------

async function saveGlb(object, clips, outPath) {
  const exporter = new GLTFExporter()
  const result = await new Promise((resolveP, rejectP) => {
    exporter.parse(object, res => resolveP(res), err => rejectP(err), { binary: true, animations: clips })
  })
  const buf = result instanceof ArrayBuffer ? Buffer.from(result) : Buffer.from(result)
  writeFileSync(outPath, buf)
  console.log('  ✓', outPath, `${(buf.length / 1024).toFixed(1)} KB, anims=${clips.map(c => c.name).join(',')}`)
  return buf
}

async function validateGlb(buf, label) {
  try {
    const loader = new GLTFLoader()
    const gltf = await new Promise((resolveP, rejectP) => {
      loader.parse(buf.slice().buffer, '', resolveP, rejectP)
    })
    console.log(`  ✓ 校验 ${label}: nodes=${gltf.scene.children.length}, anims=${gltf.animations.map(a => `${a.name}(${a.tracks.length})`).join(',')}`)
  }
  catch (e) {
    console.log(`  ✗ 校验 ${label}: ${String(e).slice(0, 180)}`)
  }
}

console.log('=== 二次元角色(character/) ===')
for (let i = 0; i < PALETTES.length; i++) {
  const pal = PALETTES[i]
  const obj = buildAnimeCharacter(pal)
  const clips = animeClips(obj)
  const buf = await saveGlb(obj.root, clips, join(CHAR_DIR, `hero-anime-${i + 1}.glb`))
  await validateGlb(buf, `hero-anime-${i + 1}(${pal.label})`)
}

console.log('=== 工业设备(devices/) ===')
const devices = [
  { name: 'device-scanner.glb', kind: 'scanner', build: buildScanner },
  { name: 'device-console.glb', kind: 'console', build: buildConsole },
  { name: 'device-robot-arm.glb', kind: 'robotArm', build: buildRobotArm },
]
for (const d of devices) {
  const obj = d.build()
  const clips = deviceClips(obj, d.kind)
  const buf = await saveGlb(obj, clips, join(DEV_DIR, d.name))
  await validateGlb(buf, d.name)
}
console.log('全部完成 🎉')
