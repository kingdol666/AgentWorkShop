/** 美化验收截图:场景总览 + 编辑模式设备选中(检查器/关键设备监控卡片) */
import puppeteer from 'puppeteer-core'

const TOKEN = process.env.AW_TOKEN ?? 'ut-258a3578a5f2450d92416c08d1c1205f'
const ROOT = 'http://127.0.0.1:3000'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const OUT = 'docs/audit/screenshots'

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1920,1080'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1080 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
for (let i = 0; i < 40; i++) {
  if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
  await sleep(1000)
}
// 等模型 GLB 加载与首帧渲染充分
await sleep(5000)

const nDev = await page.evaluate(() => window.__town.scene.deviceNodes.size)
console.log('devices in scene:', nDev)

// 拉近到设备聚集区:聚焦第一个设备并缩小 dolly(特写看 PBR 材质/阴影)
await page.evaluate(() => {
  const s = window.__town.scene
  const [id, node] = [...s.deviceNodes.entries()][0]
  s.focusTo(node.root.position.x, node.root.position.z)
  s.dolly = 0.45
  console.log('focus', id)
})
await sleep(2500)

// Shot 1: 场景近景(浏览模式,KPI 条 + 设备/角色特写)
await page.screenshot({ path: `${OUT}/town-beauty-overview.png` })
console.log('shot: town-beauty-overview.png')

// Shot 2: 编辑模式 + 选中设备(左轨检查器 + 右轨关键设备监控 + DCW 行)
await page.evaluate(() => {
  ;[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '编辑')?.click()
})
await sleep(600)
const devId = await page.evaluate(() => [...window.__town.scene.deviceNodes.keys()][0])
await page.evaluate((id) => { window.__town.scene.setSelected({ kind: 'device', id }) }, devId)
await sleep(1200)
await page.screenshot({ path: `${OUT}/town-beauty-inspector.png` })
console.log('shot: town-beauty-inspector.png, selected:', devId)

await browser.close()
console.log('SHOTS DONE')
