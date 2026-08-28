/** 一次性:DAQ 服务端链路端到端验证 —— REST CRUD/绑定 + 浏览器 WS 读数帧捕获 */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'

const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const token = login?.data?.token
if (!token) throw new Error(`login failed: ${JSON.stringify(login).slice(0, 200)}`)
const H = { 'authorization': `Bearer ${token}`, 'content-type': 'application/json' }

// 0) 基线
const base = await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())
console.log('[baseline] controller =', JSON.stringify(base.data?.controller))
console.log('[baseline] legacy nodes provisioned =', base.data?.nodes?.length ?? 0)

// 1) 建两个节点(不同模板),一个绑定到现有设备孪生
const twins = await fetch(`${BASE}/api/workshop/device-twins`, { headers: H }).then(r => r.json())
const someDevice = (twins.data?.twins ?? []).find(t => t.kind !== 'daq')
console.log('[bind target]', someDevice ? `${someDevice.name}(${someDevice.id.slice(0, 8)})` : 'none')

const n1 = await fetch(`${BASE}/api/workshop/daq`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ templateRef: 'daq-temp-tc', posX: 100, posZ: 100 }),
}).then(r => r.json()).then(d => d.data.node)
const n2 = await fetch(`${BASE}/api/workshop/daq`, {
  method: 'POST', headers: H,
  body: JSON.stringify({ templateRef: 'daq-pressure-tx', posX: 160, posZ: 120 }),
}).then(r => r.json()).then(d => d.data.node)
console.log('[created]', n1.id, n2.id)

if (someDevice) {
  const b = await fetch(`${BASE}/api/workshop/daq/${n1.id}/bind`, {
    method: 'POST', headers: H, body: JSON.stringify({ deviceId: someDevice.id }),
  }).then(r => r.json())
  console.log('[bind] deviceBindingId =', b.data?.node?.deviceBindingId === someDevice.id ? 'OK' : 'FAIL')
}

// 单节点参数控制
await fetch(`${BASE}/api/workshop/daq/${n2.id}`, {
  method: 'PATCH', headers: H,
  body: JSON.stringify({ intervalMs: 300 }),
})
console.log('[patch] n2 interval=300ms')

// 全局暂停/恢复冒烟
const st = await fetch(`${BASE}/api/workshop/daq/controller`, {
  method: 'POST', headers: H, body: JSON.stringify({ action: 'config', defaultIntervalMs: 500 }),
}).then(r => r.json())
console.log('[controller config] defaultIntervalMs =', st.data?.controller?.defaultIntervalMs)

// 2) 浏览器内开原生 WebSocket 捕获 daq.reading 帧(生产路径同款:sub 已挂载频道后广播帧随流下发)
const chans = await fetch(`${BASE}/api/workshop/channels`, { headers: H }).then(r => r.json())
let anyChannel = (chans.data ?? [])[0]?.id
if (!anyChannel) {
  // 当前用户名下无频道 → 建一个(仅作 WS 广播订阅载体)
  const made = await fetch(`${BASE}/api/workshop/channels`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: 'daq-e2e-空频道' }),
  }).then(r => r.json())
  anyChannel = made.data?.channelId
  console.log('[ws carrier channel created]', anyChannel?.slice(0, 8))
}
if (!anyChannel) throw new Error('频道创建失败,无法建立广播订阅')

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage()
await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
await new Promise(r => setTimeout(r, 2500))
// 记录帧类型全景(含 pong/snapshot/close),定位订阅链路
const seen2 = await page.evaluate(async ({ tok, durMs }) => new Promise((resolve) => {
  const seen = { open: false, pong: 0, snap: 0, error: '', close: '', reading: 0, changed: 0, controller: 0 }
  const sock = new WebSocket(`ws://127.0.0.1:3000/api/workshop/ws?token=${tok}`)
  sock.onopen = () => { seen.open = true; sock.send(JSON.stringify({ type: 'ping' })) }
  sock.onerror = () => { seen.error = 'err' }
  sock.onclose = (e) => { seen.close = `${e.code}` }
  sock.onmessage = (ev) => {
    try {
      const d = JSON.parse(String(ev.data))
      if (d.type === 'pong') { seen.pong++; sock.send(JSON.stringify({ type: 'ping' })); return }
      if (d.type === 'daq.reading') seen.reading++
      else if (d.type === 'daq.node.changed') seen.changed++
      else if (d.type === 'daq.controller') seen.controller++
      else if (d.type === 'channel.snapshot') seen.snap++
    }
    catch {}
  }
  setTimeout(() => {
    try { sock.close() }
    catch {}; resolve(seen)
  }, durMs)
}), { tok: token, durMs: 5000 })
console.log('[frames no-sub check]', JSON.stringify(seen2))
const frames = await page.evaluate(async ({ wsToken, channelId, durMs }) => new Promise((resolve) => {
  const seen = { reading: 0, changed: 0, controller: 0, snap: 0, other: {}, error: null, opened: false }
  // open 时即订阅(服务端 legacy 路径):单帧建立 peer,不依赖客户端 ping/sub 编排
  const sock = new WebSocket(`ws://127.0.0.1:3000/api/workshop/ws?token=${wsToken}&channelId=${channelId}`)
  sock.onopen = () => { seen.opened = true }
  sock.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data)
      if (e.type === 'daq.reading') {
        seen.reading++
        seen.byNode[e.payload.templateRef] = (seen.byNode[e.payload.templateRef] ?? 0) + 1
        if (seen.samples.length < 3) seen.samples.push(e.payload)
      }
      else if (e.type === 'daq.node.changed') seen.changed++
      else if (e.type === 'daq.controller') seen.controller++
      else if (e.type === 'channel.snapshot') seen.snap++
      else if (e.type === 'error' && !seen.error) seen.error = e.payload
      else {
        const k = String(e.type)
        seen.other[k] = (seen.other[k] ?? 0) + 1
      }
    }
    catch { /* 忽略坏帧 */ }
  }
  setTimeout(() => { sock.close(); resolve(seen) }, durMs)
}), { wsToken: token, channelId: anyChannel, durMs: 7000 })
console.log(`[ws frames in 7s, sub=${anyChannel.slice(0, 8)}]`, JSON.stringify(frames))

// 2.5) 时序库落库断言:创建的节点应有样本入库(消费者→TSDB 链路)
await new Promise(r => setTimeout(r, 2500)) // 等 flush 窗口(500ms 批量写)
const samples = await fetch(`${BASE}/api/workshop/daq/${n1.id}/samples?limit=100`, { headers: H }).then(r => r.json())
const pts = samples.data?.points ?? []
console.log(`[tsdb] n1 samples stored = ${pts.length}`, pts.length > 0 ? `(first: ${JSON.stringify(pts[0])})` : 'FAIL')
const meta = await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())
console.log('[meta] tsdb =', meta.data?.meta?.tsdb, '| queue =', meta.data?.meta?.queue,
  '| produced =', meta.data?.meta?.produced, '| consumed =', meta.data?.meta?.consumed,
  '| dropped =', meta.data?.meta?.dropped, '| stored =', meta.data?.meta?.samplesStored)

// 3) 绑定回写:绑定设备 telemetry 中应出现温度通道值(temp-tc → temperature 键回写)
if (someDevice) {
  const before = (twins.data?.twins ?? []).find(t => t.id === someDevice.id)?.telemetry?.temperature ?? null
  const after = await fetch(`${BASE}/api/workshop/device-twins`, { headers: H }).then(r => r.json())
  const t2 = after.data.twins.find(t => t.id === someDevice.id)
  console.log('[telemetry write-back]', JSON.stringify({
    device: someDevice.name,
    temperatureBeforeBindingEcho: before,
    temperatureNow: t2?.telemetry?.temperature,
    derivedState: t2?.state,
  }))
}

// 4) 清理测试节点
for (const id of [n1.id, n2.id]) {
  await fetch(`${BASE}/api/workshop/daq/${id}`, { method: 'DELETE', headers: H }).catch(() => {})
}
console.log('[cleanup] test nodes removed')
await browser.close()
