/** 诊断探针:/town 场景 agents=0 之谜 —— 注入 WS 钩子记录 channel.snapshot,转储 __townStats。 */
import puppeteer from 'puppeteer-core'

const ROOT = process.argv[2] ?? 'http://127.0.0.1:3001'
const EMAIL = process.argv[3] ?? 'admin@awshop.local'
const PASS = process.argv[4] ?? 'admin123'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASS }) }).then(r => r.json())
if (!login?.data?.token) { console.error('LOGIN FAIL'); process.exit(1) }
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: login.data.token, domain: new URL(ROOT).hostname, path: '/' })
await page.evaluateOnNewDocument(() => {
  window.__wslog = []
  const OrigWS = window.WebSocket
  window.WebSocket = function (url, protocols) {
    window.__wslog.push({ ev: 'open-req', url: String(url) })
    const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url)
    ws.addEventListener('open', () => window.__wslog.push({ ev: 'open', url: String(url) }))
    ws.addEventListener('close', (e) => window.__wslog.push({ ev: 'close', code: e.code, reason: e.reason }))
    ws.addEventListener('error', () => window.__wslog.push({ ev: 'error', url: String(url) }))
    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : ''
      let entry = { ev: 'msg', bytes: ev.data?.size ?? raw.length, kind: ev.data?.constructor?.name }
      try {
        const d = JSON.parse(raw)
        entry.t = d?.type ?? d?.event ?? '?'
        if (String(entry.t).includes('snapshot')) {
          const ag = d?.data?.agents ?? d?.payload?.agents
          entry.agents = Array.isArray(ag) ? ag.length : typeof ag
          entry.channelId = d?.data?.channelId ?? d?.channelId
        }
      }
      catch { entry.parse = 'fail' }
      window.__wslog.push(entry)
    })
    const origSend = ws.send.bind(ws)
    ws.send = (d) => { window.__wslog.push({ ev: 'send', head: String(d).slice(0, 120) }); return origSend(d) }
    return ws
  }
  window.WebSocket.prototype = OrigWS.prototype
  window.WebSocket.CONNECTING = OrigWS.CONNECTING
  window.WebSocket.OPEN = OrigWS.OPEN
  window.WebSocket.CLOSING = OrigWS.CLOSING
  window.WebSocket.CLOSED = OrigWS.CLOSED
})
page.on('pageerror', e => console.log('PAGEERROR:', String(e).slice(0, 160)))

await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(15000)
const dump = await page.evaluate(() => ({
  stats: window.__townStats ?? null,
  wslog: (window.__wslog ?? []).slice(0, 30),
  empty: !!document.querySelector('[data-hud="town-empty"]'),
  loading: !!document.querySelector('[data-hud="town-loading"]'),
}))
console.log(JSON.stringify(dump, null, 1))
await browser.close()
