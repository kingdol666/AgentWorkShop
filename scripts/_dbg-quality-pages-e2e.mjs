/** 画质档验证 + 全站 9 页渲染扫描(截图 + pageerror 收集)。 */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const fail = m => { console.error('FAIL:', m); process.exitCode = 1 }

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())

// ===== A. 画质档 =====
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })

await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(16000)
for (const [label, wantScale] of [['超清', 1.0], ['高清', 0.8], ['普通', 0.6], ['自动', null]]) {
  await page.evaluate((l) => {
    const btn = [...document.querySelectorAll('.fps-seg button')].find(b => b.textContent.trim() === l)
    btn?.click()
  }, label)
  await sleep(400)
  const s = await page.evaluate(() => ({
    dpr: +globalThis.__townScene3d.renderer.getPixelRatio().toFixed(2),
    mode: globalThis.__townScene3d.qualityMode,
  }))
  if (wantScale == null) {
    console.log(`[画质] ${label}: mode=${s.mode} dpr=${s.dpr}`, s.mode === 'auto' ? 'PASS' : 'FAIL')
    if (s.mode !== 'auto') fail('自动档未生效')
  }
  else {
    const ok = Math.abs(s.dpr - wantScale) < 0.03 && s.mode !== 'auto'
    console.log(`[画质] ${label}: dpr=${s.dpr}(期望 ${wantScale})`, ok ? 'PASS' : 'FAIL')
    if (!ok) fail(`画质 ${label} 未生效`)
  }
}
await page.evaluate(() => { [...document.querySelectorAll('.fps-seg button')].find(b => b.textContent.trim() === '自动')?.click() })
const dockShot = await page.$('.dock')
await dockShot.screenshot({ path: 'docs/audit/screenshots/redesign0831/town-dock-quality.png' })
await browser.close()

// ===== B. 全站页面扫描 =====
const browser2 = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const p2 = await browser2.newPage()
await p2.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
await p2.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
const pages = [
  ['/', 'home', 6000],
  ['/daq', 'daq', 8000],
  ['/dcw', 'dcw', 6000],
  ['/workshop', 'workshop', 7000],
  ['/monitor', 'monitor', 5000],
  ['/users', 'users', 5000],
  ['/settings', 'settings', 5000],
]
let allOk = true
for (const [path, name, wait] of pages) {
  const errs = []
  const onErr = e => errs.push(String(e).slice(0, 120))
  p2.on('pageerror', onErr)
  try {
    await p2.goto(`${ROOT}${path}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await sleep(wait)
    const bodyLen = await p2.evaluate(() => document.body.innerText.length)
    const shot = `docs/audit/screenshots/redesign0831/e2e-${name}.png`
    await p2.screenshot({ path: shot })
    const bad = errs.filter(e => !e.includes('Hydration'))
    console.log(`[${name}] text=${bodyLen} pageerror=${bad.length}`, bad.length ? bad[0] : 'OK')
    if (bodyLen < 200 || bad.length) { allOk = false; fail(`${name} 渲染异常`) }
  }
  catch (e) {
    console.log(`[${name}] NAV FAIL:`, e.message.slice(0, 80))
    allOk = false
    fail(`${name} 导航失败`)
  }
  finally {
    p2.off('pageerror', onErr)
  }
}
await browser2.close()
console.log(allOk ? 'PAGES ALL PASS' : 'PAGES HAVE ISSUES')
