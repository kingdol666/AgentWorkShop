/** /daq 性能测量:长任务/WS帧率/渲染热点。 */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })

// 主线程占用率探针:事件循环延迟采样
await page.evaluateOnNewDocument(() => {
  window.__evt = { frames: 0, longTasks: 0, longTotal: 0, delaySamples: [] }
  try {
    new PerformanceObserver((l) => {
      for (const t of l.getEntries()) { window.__evt.longTasks++; window.__evt.longTotal += t.duration }
    }).observe({ entryTypes: ['longtask'] })
  } catch {}
})
await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(15000)

// 5s 观测窗:事件循环延迟 + WS 帧计数(钩一下 WebSocket)
const sample = await page.evaluate(() => new Promise((resolve) => {
  const t0 = performance.now()
  const delays = []
  let last = t0
  const iv = setInterval(() => {
    const now = performance.now()
    delays.push(now - last - 50)
    last = now
  }, 50)
  // 数一下 5s 内到达的 JSON 消息(WS)
  let wsMsgs = 0
  const OrigWS = window.WebSocket
  // 已有连接无法挂钩,改从 store 帧率侧面观测:读 DOM 实时值列变化次数
  const valCell = document.querySelector('.nodes-table tbody .val')
  const texts = []
  const domIv = setInterval(() => { texts.push(valCell?.textContent ?? '') }, 100)
  setTimeout(() => {
    clearInterval(iv); clearInterval(domIv)
    const changed = texts.filter((v, i) => i && v !== texts[i - 1]).length
    resolve({
      window: Math.round(performance.now() - t0),
      avgDelay: +(delays.reduce((a, b) => a + b, 0) / delays.length).toFixed(1),
      maxDelay: +Math.max(...delays).toFixed(0),
      delaysOver100: delays.filter(d => d > 100).length,
      valCellChanges: changed,
      longTasks: window.__evt?.longTasks ?? 0,
      longTotal: Math.round(window.__evt?.longTotal ?? 0),
    })
  }, 5000)
}))
console.log('5s 观测窗:', JSON.stringify(sample))
console.log('节点数:', await page.evaluate(() => document.querySelectorAll('.nodes-table tbody tr').length),
  '| 优化记录行:', await page.evaluate(() => document.querySelectorAll('.opt-list .opt-row').length),
  '| opt-body 常驻:', await page.evaluate(() => !!document.querySelector('.opt-body')))
console.log('errors: (跳过)')
await browser.close()
console.log('DONE')
