/** 一次性:preview 最小复现 —— rig 渲染器 + 独立场景渲染 mdo.glb,逐步排查 */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1200'],
})
const page = await browser.newPage()
page.on('console', m => console.log('[page]', m.text().slice(0, 200)))
await page.setViewport({ width: 1600, height: 1200 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 9000))

const out = await page.evaluate(async () => {
  const dbg = globalThis.__pvDebug
  const rig = globalThis.__previewRig
  if (!dbg || !rig) return { error: 'handles missing' }
  const { THREE, GLTFLoader } = dbg

  const gltf = await new Promise((res, rej) => new GLTFLoader().load('/assets/game/devices/mdo.glb', res, undefined, rej))
  const obj = gltf.scene

  // 原始包围盒(scale 前)
  const box = new THREE.Box3().setFromObject(obj)
  const size = box.getSize(new THREE.Vector3())

  // 居中缩放(同组件逻辑)
  const max = Math.max(size.x, size.y, size.z) || 1
  obj.position.x -= box.min.x + size.x / 2
  obj.position.y -= box.min.y + size.y / 2
  obj.position.z -= box.min.z + size.z / 2
  obj.scale.setScalar(2 / max)

  const scene = new THREE.Scene()
  scene.add(obj)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 1.5))
  const dl = new THREE.DirectionalLight(0xffffff, 2.5)
  dl.position.set(3, 4, 2)
  scene.add(dl)
  const cam = new THREE.PerspectiveCamera(38, 150 / 76, 0.1, 100)
  cam.position.set(2.4, 1.8, 3.1)
  cam.lookAt(0, 0, 0)

  const cv = document.createElement('canvas')
  cv.width = 150; cv.height = 76
  const ctx = cv.getContext('2d')
  const count = () => { const d = ctx.getImageData(0, 0, 150, 76).data; let l = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) l++; return l }

  rig.renderer.setSize(150, 76, false)
  rig.renderer.render(scene, cam)
  ctx.drawImage(rig.renderer.domElement, 0, 0, 150, 76)
  const p1 = count()
  rig.renderer.render(scene, cam)
  ctx.drawImage(rig.renderer.domElement, 0, 0, 150, 76)
  const p2 = count()

  // 环境光贴图(组件用了 PMREM 环境;这里不设,若能画出 = 环境所致)
  // A) 清屏色判定:不渲染模型,只 clear 成洋红 → drawImage 后画布应有大量像素
  rig.renderer.setClearColor(0xff00ff, 1)
  rig.renderer.clear()
  ctx.drawImage(rig.renderer.domElement, 0, 0, 150, 76)
  const clearColorPx = count()

  // B) 正视相机 + 缩小模型(0.5 单位)再渲染
  obj.scale.setScalar(0.5 / max)
  cam.position.set(0, 0, 6)
  cam.lookAt(0, 0, 0)
  rig.renderer.render(scene, cam)
  ctx.drawImage(rig.renderer.domElement, 0, 0, 150, 76)
  const p3 = count()
  rig.renderer.render(scene, cam)
  ctx.drawImage(rig.renderer.domElement, 0, 0, 150, 76)
  const p4 = count()
  rig.renderer.setClearColor(0x000000, 0)

  // C) 项目包围盒到屏幕
  const box2 = new THREE.Box3().setFromObject(obj)
  const proj = []
  for (const [cx, cy, cz] of [[box2.min.x, box2.min.y, box2.min.z], [box2.max.x, box2.max.y, box2.max.z], [box2.min.x, box2.max.y, box2.max.z]]) {
    const v = new THREE.Vector3(cx, cy, cz).project(cam)
    proj.push([+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(3)])
  }
  // D) mesh 二分:逐 mesh 单独渲染(其余 visible=false),找出可见者
  const meshes = []
  obj.traverse(c => { if (c.isMesh) meshes.push(c) })
  const per = []
  for (const m of meshes) {
    for (const o of meshes) o.visible = o === m
    rig.renderer.render(scene, cam)
    ctx.clearRect(0, 0, 150, 76)
    ctx.drawImage(rig.renderer.domElement, 0, 0, 150, 76)
    per.push(count())
  }
  for (const o of meshes) o.visible = true
  // E) 对照:device-console 同管线
  const g2 = await new Promise((res, rej) => new GLTFLoader().load('/assets/game/devices/device-console.glb', res, undefined, rej))
  const o2 = g2.scene
  const b2 = new THREE.Box3().setFromObject(o2)
  const s2 = b2.getSize(new THREE.Vector3())
  const max2 = Math.max(s2.x, s2.y, s2.z) || 1
  o2.position.x -= b2.min.x + s2.x / 2
  o2.position.y -= b2.min.y + s2.y / 2
  o2.position.z -= b2.min.z + s2.z / 2
  o2.scale.setScalar(2 / max2)
  const scene2 = new THREE.Scene()
  scene2.add(o2)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 1.5))
  const dl2 = new THREE.DirectionalLight(0xffffff, 2.5)
  dl2.position.set(3, 4, 2)
  scene2.add(dl2)
  const cam2 = new THREE.PerspectiveCamera(38, 150 / 76, 0.1, 100)
  cam2.position.set(2.4, 1.8, 3.1)
  cam2.lookAt(0, 0, 0)
  rig.renderer.render(scene2, cam2)
  ctx.clearRect(0, 0, 150, 76)
  ctx.drawImage(rig.renderer.domElement, 0, 0, 150, 76)
  const consolePx = count()
  // F) DoubleSide 判定:绕向反转假设
  for (const m of meshes) { if (m.material) m.material = m.material.clone(), m.material.side = THREE.DoubleSide }
  rig.renderer.render(scene, cam)
  ctx.clearRect(0, 0, 150, 76)
  ctx.drawImage(rig.renderer.domElement, 0, 0, 150, 76)
  const doubleSidePx = count()
  // G) mesh 级诊断:世界包围盒/索引/材质
  const diag = meshes.slice(0, 4).map(m => {
    const b = new THREE.Box3().setFromObject(m)
    const sz = b.getSize(new THREE.Vector3())
    return {
      idx: m.geometry.index?.count ?? null,
      posCount: m.geometry.attributes.position?.count ?? 0,
      drawRange: m.geometry.drawRange?.count ?? null,
      mat: m.material?.type ?? '?',
      transparent: m.material?.transparent ?? false,
      opacity: m.material?.opacity,
      worldSize: [+sz.x.toFixed(3), +sz.y.toFixed(3), +sz.z.toFixed(3)],
      worldCenter: [+((b.min.x + b.max.x) / 2).toFixed(2), +((b.min.y + b.max.y) / 2).toFixed(2), +((b.min.z + b.max.z) / 2).toFixed(2)],
    }
  })
  return {
    diag, doubleSidePx, mdoIsoPx: p1, consoleIsoPx: consolePx,
    mdoMeshCount: meshes.length,
    mdoPerMeshPx: per,
    visibleMeshes: per.filter(x => x > 50).length,
  }
})
console.log(JSON.stringify(out))
await browser.close()
