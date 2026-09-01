/** /town 资源优化验证:FPS 走向 + 自适应 DPR + 交互延迟。 */
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
await sleep(20000)

// 采样 FPS 徽标 12s(每 2s 一次):观察自适应 DPR 生效后 FPS 是否回升
const samples = []
for (let i = 0; i < 6; i++) {
  const fps = await page.evaluate(() => {
    const m = document.body.textContent.match(/(\d+)\s*FPS/i)
    return m ? Number(m[1]) : null
  })
  samples.push(fps)
  await sleep(2000)
}
console.log('FPS 走向(每 2s):', samples.join(' → '))
const dpr = await page.evaluate(() => {
  const cv = document.querySelector('#town-host canvas')
  if (!cv) return null
  return { bufW: cv.width, cssW: cv.clientWidth, ratio: +(cv.width / cv.clientWidth).toFixed(2) }
})
console.log('canvas DPR(实际/初始应≤1.25):', JSON.stringify(dpr))

// 交互延迟:点 视角切换(重置视角按钮)→ 场景响应(exposure 状态变化不可见,改用 KPI 条存在性 + click→下一帧)
const clickLat = await page.evaluate(() => new Promise((resolve) => {
  const btn = [...document.querySelectorAll('.ctl-btns .btn')].find(b => b.textContent.includes('重置视角'))
  if (!btn) { resolve(-2); return }
  const t0 = performance.now()
  btn.click()
  const check = () => {
    // 重置视角无直接 DOM 反馈;用「再无长任务阻塞且能跑完 rAF」作代理:两帧内返回即流畅
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now() - t0))))
  }
  requestAnimationFrame(check)
}))
console.log('重置视角点击→双帧返回延迟:', clickLat, clickLat >= 0 && clickLat < 150 ? 'PASS' : 'CHECK')
console.log('pageerror:', errors.length ? errors : 'none')
await page.screenshot({ path: 'docs/audit/screenshots/redesign0831/town-perf.png' })
await browser.close()
console.log('DONE')
