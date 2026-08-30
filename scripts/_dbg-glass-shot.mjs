/** 一次性:Aurora Glass 双主题四页截图验收 */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1200'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 160)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)) })
await page.setViewport({ width: 1920, height: 1200 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })

// 用用户真实路径切主题(点 header 按钮;reload 写 localStorage 会踩 dev cssinjs hash 错位)
const setTheme = async (dark) => {
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.icon-btn')]
    const themeBtn = btns.find(b => b.querySelector('.i-tabler-sun-high, .i-tabler-moon-stars'))
    themeBtn?.click()
  })
  await new Promise(r => setTimeout(r, 3500))
}

// 暗色主题(默认)
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle2', timeout: 90000 })
await new Promise(r => setTimeout(r, 6000))
await page.screenshot({ path: 'docs/audit/screenshots/glass-dark-dash.png' })
await page.goto('http://127.0.0.1:3000/daq', { waitUntil: 'networkidle2', timeout: 90000 })
await new Promise(r => setTimeout(r, 3000))
await page.screenshot({ path: 'docs/audit/screenshots/glass-dark-daq.png' })

// 亮色主题(点按钮切换)
await setTheme(false)
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle2', timeout: 90000 })
await new Promise(r => setTimeout(r, 5000))
await new Promise(r => setTimeout(r, 5000))
await page.screenshot({ path: 'docs/audit/screenshots/glass-light-dash.png' })
await page.goto('http://127.0.0.1:3000/daq', { waitUntil: 'networkidle2', timeout: 90000 })
await new Promise(r => setTimeout(r, 2500))
await page.screenshot({ path: 'docs/audit/screenshots/glass-light-daq.png' })
// 中等 viewport 复验
await page.setViewport({ width: 1366, height: 900 })
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle2', timeout: 90000 })
await new Promise(r => setTimeout(r, 4000))
await page.screenshot({ path: 'docs/audit/screenshots/glass-dark-dash-1366.png' })
console.log('shots done | page errors:', errors.length ? errors.slice(0, 4) : 'none')
await browser.close()
