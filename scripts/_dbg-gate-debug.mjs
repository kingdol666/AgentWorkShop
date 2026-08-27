/** 一次性:调试编辑模式 tryStartPointerDrag */
import puppeteer from 'puppeteer-core'

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: 'ut-bdebd04701084e8ab6a1a4c51f5375e4', domain: '127.0.0.1', path: '/' })
await page.goto('http://127.0.0.1:3000/town', { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
  await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 4000))
const out = await page.evaluate(() => {
  const s = window.__town.scene
  const dev = [...s.deviceNodes.values()][0]
  s.focusTo(dev.root.position.x, dev.root.position.z)
  return new Promise((resolve) => {
    setTimeout(() => {
      const p1 = s.worldToScreen(dev.root.position.x, 100, dev.root.position.z)
      if (!p1) return resolve({ err: 'worldToScreen null (offscreen)' })
      const w = s.screenToWorld(p1.x, p1.y)
      s.setMode('edit')
      const hit = typeof s.pickAt === 'function' ? s.pickAt(w.x, w.z) : 'no pickAt fn'
      const gate = s.tryStartPointerDrag(p1.x, p1.y)
      const giz = s.isGizmoBusy()
      if (gate) s.endPointerDrag()
      resolve({ devPos: { x: dev.root.position.x, z: dev.root.position.z }, w, mode: s.getMode(), hit: hit && hit.kind ? hit.kind : hit, gate, giz })
    }, 1600)
  })
})
console.log(JSON.stringify(out))
await browser.close()
