/** 一次性:/daq 实时帧验证 —— WS 连接(无频道订阅)下 townBus 的 daq.reading 帧计数 + 值变化节奏 */
import puppeteer from 'puppeteer-core'

const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1200'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 120)))
await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.goto('http://127.0.0.1:3000/daq', { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 9000))

// 订阅 townBus 计数 5s 内的 daq.reading 帧
const frames = await page.evaluate(() => new Promise((resolve) => {
  const bus = globalThis.__townBus
  if (!bus) {
    resolve(-1)
    return
  }
  let n = 0
  const off = bus.subscribe((e) => {
    if (e.type === 'daq.reading') n++
  })
  setTimeout(() => {
    off()
    resolve(n)
  }, 5000)
}))
console.log(`5s 内 daq.reading 帧数: ${frames} ${frames > 0 ? '(PASS 实时帧到达,无频道订阅)' : '(FAIL)'}`)

// 值变化节奏:同一节点 6s 内的值变化次数(纯 5s 轮询节奏下应为 0-1)
const changes = await page.evaluate(() => new Promise((resolve) => {
  const bus = globalThis.__townBus
  if (!bus) {
    resolve(-1)
    return
  }
  let last = null
  let changes = 0
  let target = ''

  const off = bus.subscribe((e) => {
    if (e.type !== 'daq.reading') return
    const p = e.payload
    if (!target) {
      target = p.nodeId
      last = p.value
      return
    }
    if (p.nodeId !== target) return
    if (last != null && p.value !== last) changes++
    last = p.value
  })
  setTimeout(() => {
    off()
    resolve(changes)
  }, 6000)
}))
console.log(`6s 内同一节点值变化次数: ${changes} ${changes >= 1 ? '(PASS 实时刷新)' : '(FAIL)'}`)

await page.screenshot({ path: 'docs/audit/screenshots/huashu-survey2/daq-realtime.png' })
await browser.close()
console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors')
