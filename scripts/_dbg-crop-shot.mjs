/** 裁剪截图细节区域(puppeteer 加载 PNG 后按 clip 截图)。 */
import puppeteer from 'puppeteer-core'

const [, , src, out, x, y, w, h] = process.argv
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1400, deviceScaleFactor: 2 })
await page.goto(`file:///${src.replace(/\\/g, '/')}`)
await new Promise(r => setTimeout(r, 800))
await page.screenshot({ path: out, clip: { x: +x, y: +y, width: +w, height: +h } })
await browser.close()
console.log('crop ok')
