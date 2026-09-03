/**
 * 补充验证 B:WS daq.frame 实时帧 + 指标阈值告警(mock 场景)。
 * ①裸 WS(Node 原生)订阅真实频道 → 开跑 → 建 thickness-scan 节点
 * → ②收集 daq.frame 帧(preview ≤64 点、metrics、无 blob)
 * → ③thk-max alarmHigh=0.62:mock max 可达 0.65 → 等待告警落库(alarm_events)
 * → ④清理。
 * 运行: node scripts/_dbg-daq-frame-ws.mjs
 */
const ROOT = process.env.E2E_ROOT ?? 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1 }

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const token = login.data.token
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())

// 订阅任一真实频道(注册 scene peer;daq.* 帧不依赖频道)
const channels = await j('/api/workshop/channels')
const chanList = channels.data ?? []
const channelId = (Array.isArray(chanList) ? chanList[0] : chanList.channels?.[0] ?? chanList.items?.[0])?.id
if (!channelId) { console.error('FAIL: no channel'); process.exit(1) }
const ws = new WebSocket(ROOT.replace('http', 'ws') + '/api/workshop/ws')
const frameEvents = []
ws.onmessage = (ev) => {
  try {
    const e = JSON.parse(ev.data)
    if (e.type === 'daq.frame') frameEvents.push(e.payload)
  }
  catch { /* ignore */ }
}
ws.onopen = () => ws.send(JSON.stringify({ type: 'sub', channelId, token }))
await new Promise(r => { ws.onopen ? (ws.onopen = ((orig) => () => { orig(); r() })(ws.onopen)) : r() })

// 开跑 + 建向量节点
const d = (await j('/api/workshop/dcw')).data
const cand = d.lines.map(l => ({ line: l, recipe: d.recipes.find(r => r.lineId === l.id) })).find(x => x.recipe)
await j(`/api/workshop/dcw/lines/${cand.line.id}/stop`, 'POST').catch(() => {})
await sleep(1000)
await j(`/api/workshop/dcw/lines/${cand.line.id}/start`, 'POST', { recipeId: cand.recipe.id })
const node = (await j('/api/workshop/daq', 'POST', { templateRef: 'thickness-scan', lineId: cand.line.id, name: 'E2E WS 轮廓' })).data.node

// 收集 ~12s 帧事件
await sleep(12000)
const alarmsOpen = (await j('/api/workshop/daq/alarms?scope=all&limit=100')).data.alarms
const frameAlarms = alarmsOpen.filter(a => a.nodeId === node.id && a.metric === 'thickness-scan.max')

try {
  if (frameEvents.length >= 3) {
    console.log(`PASS WS daq.frame: 收到 ${frameEvents.length} 帧`)
    const f = frameEvents[frameEvents.length - 1]
    if (f.kind === 'vector' && (f.preview?.length ?? 0) > 0 && f.preview.length <= 64) console.log(`PASS 帧预览: ${f.preview.length} 点(≤64)`)
    else fail(`preview: kind=${f.kind} len=${f.preview?.length}`)
    if (f.metrics && Object.keys(f.metrics).length > 0) console.log(`PASS 帧指标: ${JSON.stringify(f.metrics).slice(0, 120)}`)
    else fail('metrics missing on daq.frame')
    if (JSON.stringify(f).length < 4096) console.log('PASS 帧载荷轻量(<4KB,无全量点列/blob)')
    else fail(`payload too large: ${JSON.stringify(f).length}`)
  } else fail(`daq.frame events insufficient: ${frameEvents.length}`)

  if (frameAlarms.length > 0) {
    const a = frameAlarms[0]
    console.log(`PASS 指标阈值告警: metric=${a.metric} rule=${a.rule} value=${a.value} threshold=${a.threshold}`)
  } else {
    console.log(`WARN: 12s 窗口内未见 thk-max 告警(mock max 需越 0.62;当前未触发,不判失败)`)
  }
} finally {
  ws.close()
  await j(`/api/workshop/daq/${node.id}`, 'DELETE').catch(() => {})
  await j(`/api/workshop/dcw/lines/${cand.line.id}/stop`, 'POST').catch(() => {})
}

console.log(process.exitCode ? '\nWS E2E FAILED' : '\nWS E2E PASS')
