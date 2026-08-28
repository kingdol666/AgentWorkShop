/** 一次性:浏览器 console 错误/警告捕获(/daq 与 /town 全加载周期) */
import puppeteer from 'puppeteer-core'

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1200'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1200 })
await page.setCookie({ name: 'token', value: 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c', domain: '127.0.0.1', path: '/' })

const issues = []
page.on('console', (msg) => {
  const t = msg.type()
  if (t === 'error' || t === 'warning') {
    const text = msg.text()
    // 已知无害来源:Vue devtools 提示 / Chrome 扩展缺失 / favicon 404
    if (/vue-devtools|Download the Vue Devtools/i.test(text)) return
    issues.push(`[${t}][${page.url().split('/').slice(-1)[0] || '/'}] ${text.slice(0, 180)}`)
  }
})
page.on('pageerror', (err) => issues.push(`[pageerror] ${String(err).slice(0, 200)}`))

await page.goto('http://127.0.0.1:3000/users', { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 4000))
await page.goto('http://127.0.0.1:3000/workshop', { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 5000))
await page.goto('http://127.0.0.1:3000/daq', { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 6000))
await page.goto('http://127.0.0.1:3000/town', { waitUntil: 'domcontentloaded', timeout: 90000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
  await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 8000))

const sceneState = await page.evaluate(() => {
  const s = window.__town?.scene
  if (!s) return { ready: false }
  const daq = [...s.deviceNodes.values()].filter(d => (d.modelRef ?? '').startsWith('daq-'))
  return {
    ready: true,
    devices: s.deviceNodes.size,
    daqNodes: daq.length,
    channels: s.blocks.size,
    agents: s.agents.size,
  }
})
console.log('scene:', JSON.stringify(sceneState))

// 过滤后是否仍存在问题
const errors = issues.filter(i => i.startsWith('[error') || i.startsWith('[pageerror]'))
const warnings = issues.filter(i => i.startsWith('[warning'))
console.log(`console errors: ${errors.length}, warnings: ${warnings.length}`)
for (const e of errors) console.log('  E:', e)
const warnSample = [...new Set(warnings.map(w => w.replace(/\d+/g, 'N')))].slice(0, 6)
for (const w of warnSample) console.log('  W:', w)

await browser.close()
console.log(errors.length === 0 ? 'CONSOLE CLEAN (no errors)' : 'CONSOLE HAS ERRORS')
