import puppeteer from 'puppeteer-core'
const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(15000)
console.log(await page.evaluate(() => ({
  hidden: document.hidden,
  vis: document.visibilityState,
  hasHook: !!globalThis.__townScene3d,
  disposed: globalThis.__townScene3d?.disposed,
  frameCount: globalThis.__townScene3d?.frameCount,
  qTier: globalThis.__townScene3d?.qTier,
  dtProbe: (() => { const sc = globalThis.__townScene3d; if (!sc) return null; const a = sc.clock.getDelta(); const b = sc.clock.getDelta(); return [+a.toFixed(4), +b.toFixed(4)] })(),
})))
await browser.close()
console.log('DONE')
