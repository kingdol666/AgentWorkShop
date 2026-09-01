/** /town 最终验证:FPS 阶梯走向 + 标注数据实时刷新。 */
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
await sleep(16000)

// FPS + DPR 采样 24s(每 3s):阶梯应逐步降档,FPS 向 40 预算爬
for (let i = 0; i < 8; i++) {
  const s = await page.evaluate(() => {
    const m = document.body.textContent.match(/(\d+)\s*FPS/i)
    const cv = document.querySelector('#town-host canvas')
    return { fps: m ? Number(m[1]) : null, ratio: cv ? +(cv.width / cv.clientWidth).toFixed(2) : null }
  })
  console.log(`t+${i * 3}s fps=${s.fps} dpr=${s.ratio}`)
  await sleep(3000)
}

// 标注实时性:5s 窗口内 callout 数值文本变化次数(直通帧应 ≥ 每秒 1 次)
const changes = await page.evaluate(() => new Promise((resolve) => {
  const texts = []
  const iv = setInterval(() => {
    texts.push([...document.querySelectorAll('.callout .co-val')].map(e => e.textContent).join('|'))
  }, 100)
  setTimeout(() => {
    clearInterval(iv)
    resolve(texts.filter((v, i) => i && v !== texts[i - 1]).length)
  }, 5000)
}))
console.log('标注数值 5s 内变化次数:', changes, changes >= 4 ? 'PASS(真·实时)' : 'FAIL(仍受合批延迟)')
console.log('pageerror:', errors.length ? errors.slice(0, 3) : 'none')
await page.screenshot({ path: 'docs/audit/screenshots/redesign0831/town-realtime.png' })
await browser.close()
console.log('DONE')
