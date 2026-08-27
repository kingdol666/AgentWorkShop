/** 一次性:全页 UI 截图(高视口,右轨完整)+ 右轨滚动到底截图 */
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
await new Promise(r => setTimeout(r, 4500))
await page.screenshot({ path: 'docs/audit/screenshots/town-ui-full.png' })
await page.evaluate(() => {
  const rail = document.querySelector('.rail-right')
  if (rail) rail.scrollTop = rail.scrollHeight
})
await new Promise(r => setTimeout(r, 500))
await page.screenshot({ path: 'docs/audit/screenshots/town-ui-right-bottom.png' })
await browser.close()
console.log('shots ok')
