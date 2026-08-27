/** 一次性:截 RPG 导航图卡片 */
import puppeteer from 'puppeteer-core'

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1600'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1600 })
await page.setCookie({ name: 'token', value: 'ut-bdebd04701084e8ab6a1a4c51f5375e4', domain: '127.0.0.1', path: '/' })
await page.goto('http://127.0.0.1:3000/town', { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => (window.__town?.scene?.agents?.size ?? 0) > 0)) break
  await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 4000))
await page.evaluate(() => window.__town.scene.focusTo(1700, 1200))
await new Promise(r => setTimeout(r, 1800))
await page.evaluate(() => {
  const rail = document.querySelector('.rail-right')
  rail.scrollTop = rail.scrollHeight
})
await new Promise(r => setTimeout(r, 600))
const box = await (await page.$('.mm-body')).boundingBox()
await page.screenshot({ path: 'docs/audit/screenshots/town-nav-rpg.png', clip: { x: box.x - 8, y: box.y - 44, width: box.width + 66, height: box.height + 88 } })
await browser.close()
console.log('shot ok')
