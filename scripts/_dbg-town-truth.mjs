/** /town 真值探针:渲染帧计数(非 rAF 频率)+ 质量档 + 实时标注。 */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 160)))
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(15000)

for (let i = 0; i < 6; i++) {
  const s = await page.evaluate(() => new Promise((resolve) => {
    const sc = globalThis.__townScene3d
    if (!sc) { resolve(null); return }
    const f0 = sc.renderer.info.render.frame
    const t0 = performance.now()
    setTimeout(() => {
      const f1 = sc.renderer.info.render.frame
      resolve({
        realFps: Math.round((f1 - f0) / ((performance.now() - t0) / 1000)),
        qTier: sc.qTier,
        dpr: +sc.renderer.getPixelRatio().toFixed(2),
        budget: Math.round(sc.frameBudgetMs),
      })
    }, 2000)
  }))
  console.log(`t+${i * 2}s`, JSON.stringify(s))
  if (s === null) break
  await sleep(1000)
}
await browser.close()
console.log('DONE')
