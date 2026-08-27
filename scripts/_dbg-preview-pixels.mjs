/** 一次性:preview 深度验证 —— rig 内部状态 + 每卡 canvas 像素 */
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
await page.setViewport({ width: 1600, height: 1200 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 12000))

const out = await page.evaluate(() => {
  const rig = globalThis.__previewRig
  const info = rig
    ? {
        slots: rig.slots.size,
        drawCalls: rig.renderer.info.render.calls,
        triangles: rig.renderer.info.render.triangles,
        canvasW: rig.renderer.domElement.width,
        canvasH: rig.renderer.domElement.height,
        perSlot: [...rig.slots].map(s => {
          let tris = 0, visible = 0, geomEmpty = 0
          if (s.group) s.group.traverse(c => {
            if (c.isMesh) {
              const g = c.geometry
              const pos = g?.attributes?.position
              if (!pos || pos.count < 3) geomEmpty++
              else tris += (g.index ? g.index.count : pos.count) / 3
              if (c.visible !== false) visible++
            }
          })
          return {
            w: s.w, h: s.h, meshCount: (() => { let n = 0; s.group?.traverse(c => { if (c.isMesh) n++ }); return n })(),
            tris: Math.round(tris), visible, geomEmpty,
            canvasPx: (() => { const d = s.ctx.getImageData(0, 0, Math.min(s.w, 400), Math.min(s.h, 200)).data; let lit = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) lit++; return lit })(),
          }
        }),
      }
    : null
  // 手动渲染第 0 槽(agv,空白)对照:loop 之外的 render + drawImage
  const s0 = [...rig.slots][0]
  const before = (() => { const d = s0.ctx.getImageData(0, 0, s0.w, s0.h).data; let l = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) l++; return l })()
  rig.renderer.setSize(s0.w, s0.h, false)
  rig.renderer.render(s0.scene, s0.camera)
  s0.ctx.drawImage(rig.renderer.domElement, 0, 0, s0.w, s0.h)
  const after = (() => { const d = s0.ctx.getImageData(0, 0, s0.w, s0.h).data; let l = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) l++; return l })()
  info.manualTest = { slot0Before: before, slot0AfterManualRender: after }
  // 世界包围盒(fitObject 缩放是否退化)
  const bb = new (Object.getPrototypeOf(s0.group).constructor)().setFromObject ? null : null
  try {
    s0.group.updateWorldMatrix(true, true)
    const bx = new s0.group.children[0].Box3 ? null : null
  } catch {}
  // 用 three 全局?页面无 THREE;借助 rig 之外方式:直接数学遍历
  const pts = []
  s0.group.traverse(c => {
    if (c.isMesh) {
      const pos = c.geometry.attributes.position
      const m = c.matrixWorld
      const v = [0, 0, 0]
      for (let i = 0; i < pos.count; i += Math.max(1, Math.floor(pos.count / 7))) {
        v[0] = pos.getX(i); v[1] = pos.getY(i); v[2] = pos.getZ(i)
        const wx = m[0]*v[0]+m[4]*v[1]+m[8]*v[2]+m[12]
        const wy = m[1]*v[0]+m[5]*v[1]+m[9]*v[2]+m[13]
        const wz = m[2]*v[0]+m[6]*v[1]+m[10]*v[2]+m[14]
        pts.push([wx, wy, wz])
      }
    }
  })
  if (pts.length) {
    const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity]
    for (const p of pts) for (let k = 0; k < 3; k++) { mins[k] = Math.min(mins[k], p[k]); maxs[k] = Math.max(maxs[k], p[k]) }
    info.slot0WorldBox = { mins: mins.map(x => +x.toFixed(2)), maxs: maxs.map(x => +x.toFixed(2)) }
  }
  // 连续第二遍(排除首帧着色器编译)
  rig.renderer.render(s0.scene, s0.camera)
  s0.ctx.drawImage(rig.renderer.domElement, 0, 0, s0.w, s0.h)
  info.manualTest.slot0SecondRender = (() => { const d = s0.ctx.getImageData(0, 0, s0.w, s0.h).data; let l = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) l++; return l })()
  return info
})
console.log(JSON.stringify(out, null, 1).slice(0, 3000))
await browser.close()
