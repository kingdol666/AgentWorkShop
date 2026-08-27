/** 一次性:应用级 WS 连接健康探针(workshop 页 HUD 连接态)+ daq WS 双通道对照 */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const token = login.data.token
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

// 生产顺序:进数字孪生空间先 GET daq 快照(此请求同时把 WS 广播出装配到控制器)
const daqBase = await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())
console.log('[daq baseline]', JSON.stringify(daqBase.data?.controller), 'nodes =', daqBase.data?.nodes?.length)

// --- 对照组 A:Node 原生 WebSocket(端口 3000 直连)---
function nodeWsProbe(durMs = 5000) {
  return new Promise((resolve) => {
    const sock = new WebSocket(`ws://127.0.0.1:3000/api/workshop/ws?token=${token}`)
    const seen = { open: false, pong: false, snap: false, reading: 0, other: {} }
    sock.onopen = () => {
      seen.open = true
      sock.send(JSON.stringify({ type: 'ping' }))
    }
    sock.onmessage = (ev) => {
      const d = JSON.parse(String(ev.data))
      if (d.type === 'pong') seen.pong = true
      else if (d.type === 'channel.snapshot') seen.snap = true
      else if (d.type === 'daq.reading') seen.reading++
      else seen.other[d.type] = (seen.other[d.type] ?? 0) + 1
    }
    setTimeout(() => { try { sock.close() } catch {}; resolve(seen) }, durMs)
  })
}

const probeA = await nodeWsProbe()
console.log('[probe A: node ws / no sub]', JSON.stringify(probeA))

// --- 对照组 B:页面上下文开 WS(127.0.0.1 源内),sub 空频道 ---
const chans = await fetch(`${BASE}/api/workshop/channels`, { headers: H }).then(r => r.json())
const chanId = (chans.data ?? [])[0]?.id

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage()
await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
await new Promise(r => setTimeout(r, 1500))
if (chanId) {
  const probeB = await page.evaluate(async ({ tok, ch, durMs }) => new Promise((resolve) => {
    const seen = { open: false, pong: false, error: '', reading: 0, snap: false, others: {} }
    const sock = new WebSocket(`ws://127.0.0.1:3000/api/workshop/ws?token=${tok}`)
    sock.onopen = () => { seen.open = true; sock.send(JSON.stringify({ type: 'ping' })) }
    sock.onerror = () => { seen.error = 'socket-error' }
    sock.onclose = e => { if (!seen.pong) seen.error += ` close:${e.code}` }
    sock.onmessage = (ev) => {
      const d = JSON.parse(String(ev.data))
      if (d.type === 'pong') { seen.pong = true; sock.send(JSON.stringify({ type: 'sub', channelId: ch, token: tok })) }
      else if (d.type === 'channel.snapshot') seen.snap = true
      else if (d.type === 'daq.reading') seen.reading++
      else seen.others[d.type] = (seen.others[d.type] ?? 0) + 1
    }
    setTimeout(() => { try { sock.close() } catch {}; resolve(seen) }, durMs)
  }), { tok: token, ch: chanId, durMs: 6000 })
  console.log('[probe B: page ctx + sub]', JSON.stringify(probeB))
}

// --- 应用级真实连接:workshop HUD 连接状态徽标 ---
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
await new Promise(r => setTimeout(r, 7000))
const hud = await page.evaluate(() => {
  const t = document.body.innerText
  const hits = t.match(/(已连接|实时同步|重连中|已断线|同步中|在线|offline)/g)
  return hits ? hits.slice(0, 8) : []
})
console.log('[workshop HUD hints]', JSON.stringify(hud))
await browser.close()
