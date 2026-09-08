/** 渲染性能基线/对比测量:/daq 与 /town 双页统一探针(前后对比同参同窗)。
 *  用法:node scripts/_dbg-render-perf.mjs <base> <email> <pass> <outJson>
 *  输出 JSON:{ daq:{...}, town:{...} } —— 供 plan 文档引用(证据化,非估算)。 */
import puppeteer from 'puppeteer-core'
import { writeFileSync } from 'node:fs'

const ROOT = process.argv[2] ?? 'http://127.0.0.1:3001'
const EMAIL = process.argv[3] ?? 'perf-runner@awshop.io'
const PASS = process.argv[4] ?? 'Perf@Run2026'
const OUT = process.argv[5] ?? '.e2e-shots/render-perf.json'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASS }) }).then(r => r.json())
if (!login?.data?.token) { console.error('LOGIN FAIL', JSON.stringify(login)); process.exit(1) }

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: login.data.token, domain: new URL(ROOT).hostname, path: '/' })

// 页面加载前注入:WS 帧计数(按 type)+ longtask + 事件循环延迟采样器
await page.evaluateOnNewDocument(() => {
  window.__perf = { ws: {}, longTasks: 0, longTotal: 0, loopDelays: [], heapSamples: [] }
  try {
    new PerformanceObserver((l) => {
      for (const t of l.getEntries()) { window.__perf.longTasks++; window.__perf.longTotal += t.duration }
    }).observe({ entryTypes: ['longtask'] })
  } catch {}
  const OrigWS = window.WebSocket
  window.WebSocket = function (...args) {
    const ws = new OrigWS(...args)
    ws.addEventListener('message', (ev) => {
      try {
        const d = JSON.parse(String(ev.data))
        const type = d?.type ?? d?.event ?? 'raw'
        window.__perf.ws[type] = (window.__perf.ws[type] ?? 0) + 1
      }
      catch { window.__perf.ws.raw = (window.__perf.ws.raw ?? 0) + 1 }
    })
    return ws
  }
  window.WebSocket.prototype = OrigWS.prototype
  ;['OPEN', 'CLOSED', 'CLOSING', 'CONNECTING'].forEach(k => { try { window.WebSocket[k] = OrigWS[k] } catch {} })
  // 事件循环延迟:50ms 心跳,记录超出量
  let last = performance.now()
  setInterval(() => {
    const now = performance.now()
    window.__perf.loopDelays.push(now - last - 50)
    last = now
    try { window.__perf.heapSamples.push(Math.round(performance.memory.usedJSHeapSize / 1048576)) } catch {}
  }, 50)
})

const summarize = (tag, warmMs, winMs) => page.evaluate(async ({ tag, warmMs, winMs }) => {
  const pct = (arr, p) => arr.length ? +arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))].toFixed(1) : null
  await new Promise(r => setTimeout(r, warmMs))
  const p = window.__perf
  const ws0 = JSON.stringify(p.ws)
  const lt0 = p.longTasks
  const ltT0 = p.longTotal
  const d0 = p.loopDelays.length
  const heap0 = p.heapSamples.length ? p.heapSamples[p.heapSamples.length - 1] : null
  await new Promise(r => setTimeout(r, winMs))
  const ws1 = JSON.parse(JSON.stringify(p.ws))
  const ws0o = JSON.parse(ws0)
  const delta = {}
  for (const k of new Set([...Object.keys(ws1), ...Object.keys(ws0o)])) delta[k] = (ws1[k] ?? 0) - (ws0o[k] ?? 0)
  const delays = p.loopDelays.slice(d0)
  const heaps = p.heapSamples.slice(d0 ? Math.max(0, d0) : 0)
  return {
    tag,
    windowMs: winMs,
    wsDelta: delta,
    longTasks: p.longTasks - lt0,
    longTotalMs: Math.round(p.longTotal - ltT0),
    loopAvg: +(delays.reduce((a, b) => a + b, 0) / Math.max(1, delays.length)).toFixed(1),
    loopP95: pct(delays, 0.95),
    loopMax: delays.length ? +Math.max(...delays).toFixed(0) : 0,
    heapMB: heaps.length ? heaps[heaps.length - 1] : heap0,
    heapPeakMB: heaps.length ? Math.max(...heaps) : null,
  }
}, { tag, warmMs, winMs })

// ---------------- /daq ----------------
await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
const daq = await summarize('daq', 12000, 10000)
// SPA 挂载后采集(预热窗结束后 DOM 才是真实形态)
const daqDom = await page.evaluate(() => ({
  rows: document.querySelectorAll('.nodes-table tbody tr').length,
  elements: document.getElementsByTagName('*').length,
  svgPolylines: document.querySelectorAll('.nodes-table svg polyline').length,
}))
daq.rows = daqDom.rows
daq.domElements = daqDom.elements
daq.svgPolylines = daqDom.svgPolylines
// DOM 变更批次(10s):表格重渲染频率的代理
daq.domMutationBatches = await page.evaluate((winMs) => new Promise((resolve) => {
  let batches = 0
  let armed = false
  const obs = new MutationObserver(() => { if (armed) batches++ })
  obs.observe(document.querySelector('.nodes-table') ?? document.body, { childList: true, subtree: true, characterData: true, attributes: true })
  setTimeout(() => { armed = true }, 500)
  setTimeout(() => { obs.disconnect(); resolve(batches) }, winMs)
}), 10000)

// ---------------- /town ----------------
await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(18000)
const fpsSamples = []
for (let i = 0; i < 6; i++) {
  const fps = await page.evaluate(() => {
    // 优先读场景仪表化(墙钟真实 fps);无 hook 时退回徽标正则(易混入相邻文本)
    const st = window.__townStats
    if (st) return st.fps
    const m = document.body.textContent.match(/(\d+)\s*FPS/i)
    return m ? Number(m[1]) : null
  })
  fpsSamples.push(fps)
  await sleep(2000)
}
const dpr = await page.evaluate(() => {
  const cv = document.querySelector('#town-host canvas')
  if (!cv) return null
  return { bufW: cv.width, cssW: cv.clientWidth, ratio: +(cv.width / cv.clientWidth).toFixed(2) }
})
const townDom = await page.evaluate(() => document.getElementsByTagName('*').length)
const town = await summarize('town', 1000, 10000)
town.fpsSamples = fpsSamples
town.avgFps = +(fpsSamples.filter(v => v != null).reduce((a, b) => a + b, 0) / Math.max(1, fpsSamples.filter(v => v != null).length)).toFixed(1)
town.dpr = dpr
town.domElements = townDom
town.statsHook = await page.evaluate(() => window.__townStats ? JSON.parse(JSON.stringify(window.__townStats)) : null)

const result = { at: new Date().toISOString(), base: ROOT, daq, town }
writeFileSync(OUT, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
await browser.close()
console.log('DONE ->', OUT)
