/** 单上下文自洽探针:同一 evaluate 内测 渲染fps/rAF频率/门控frameAcc/档位。 */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(12000)

const report = await page.evaluate(() => new Promise((resolve) => {
  const sc = globalThis.__townScene3d
  if (!sc) { resolve({ err: 'no scene hook' }); return }
  // rAF 频率参照
  let rafN = 0
  let rafOn = true
  const rafCount = () => { if (!rafOn) return; rafN++; requestAnimationFrame(rafCount) }
  requestAnimationFrame(rafCount)
  const f0 = sc.frameCount
  const t0 = performance.now()
  const accSamples = []
  const accIv = setInterval(() => accSamples.push(+sc.frameAcc.toFixed(1)), 50)
  setTimeout(() => {
    rafOn = false
    clearInterval(accIv)
    const wall = (performance.now() - t0) / 1000
    resolve({
      wallSec: +wall.toFixed(1),
      rafHz: Math.round(rafN / wall),
      renderedFps: Math.round((sc.frameCount - f0) / wall),
      budgetMs: sc.frameBudgetMs,
      frameAccRange: [Math.min(...accSamples), Math.max(...accSamples)],
      qTier: sc.qTier,
      dpr: +sc.renderer.getPixelRatio().toFixed(2),
      bloomOn: sc.composer.passes.find(p => p.enabled === false) === undefined,
    })
  }, 6000)
}))
console.log(JSON.stringify(report, null, 1))
await browser.close()
console.log('DONE')
