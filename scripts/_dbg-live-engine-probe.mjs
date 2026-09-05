/**
 * 最小实时探针:单 worker(harness 可选)+ mock lead,注入 requireReply 消息,
 * 全量拉取 AEP 事件(含 error/delta/status),观察引擎回合的真实行为。
 * 运行:node scripts/_dbg-live-engine-probe.mjs codex|dsh|omp
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3000'
const harness = process.argv[2] ?? 'dsh'

const reg = await fetch(`${BASE}/api/workshop/users/register`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: `probe-${harness}-${Date.now() % 100000}` }),
}).then(r => r.json())
const T = reg?.data?.token
if (!T) { console.error('注册失败'); process.exit(1) }
const api = async (method, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${T}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return await res.json().catch(() => ({}))
}

const ch = await api('POST', '/api/workshop/channels', { name: `probe-${harness}`, leadAgent: { name: 'lead', harness: 'mock' } })
const cid = ch?.data?.channelId
const w = await api('POST', `/api/workshop/channels/${cid}/agents`, {
  name: `w-${harness}`, harness, role: 'worker',
  config: harness === 'codex' ? { approvalPolicy: 'on-request', sandbox: 'workspace-write' } : {},
})
console.log(`channel=${cid} worker=${w?.data?.id} harness=${harness}`)

// 事件录制流由首个 WS 订阅触发(无订阅者不落库),故先接 WS 再触发事件
const { createRequire } = await import('node:module')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const { WebSocket } = createRequire(import.meta.url)('D:/codes/ABO/AgentWorkShop/node_modules/.pnpm/ws@8.21.3/node_modules/ws')
const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/api/workshop/ws')
ws.on('open', () => ws.send(JSON.stringify({ type: 'sub', channelId: cid, token: T })))
ws.on('error', (e) => console.log('[ws error]', e.message))
await sleep(1200)

const seen = []
let lastSeq = 0
const poll = async () => {
  const res = await api('GET', `/api/workshop/channels/${cid}/events?limit=500`)
  for (const f of (res?.data?.items ?? [])) {
    if (Number(f.seq ?? 0) > lastSeq) {
      lastSeq = Number(f.seq)
      seen.push(f)
      const p = f.payload ?? {}
      if (f.type === 'error') console.log(`[evt] ERROR ${p.code}: ${String(p.message ?? '').slice(0, 200)}`)
      else if (f.type === 'a2a.message') console.log(`[evt] message ${(p.parts ?? []).map(x => x.text ?? '').join('').slice(0, 120)}`)
      else if (f.type === 'agent.status.message') console.log(`[evt] status: ${String(p.text ?? '').slice(0, 140)}`)
      else if (f.type === 'agent.delta') process.stdout.write('.')
      else if (f.type === 'a2a.artifact') console.log(`[evt] artifact: ${(p.artifact?.parts ?? []).map(x => x.text ?? '').join('').slice(0, 260)}`)
      else if (f.type === 'task.status') console.log(`[evt] task ${p.state}`)
      else if (f.type === 'hitl.request') console.log(`[evt] HITL ${p.kind}`)
    }
  }
}
const poller = setInterval(() => { void poll().catch(() => {}) }, 1500)

const m = await api('POST', `/api/workshop/channels/${cid}/messages`, {
  toAgentId: w?.data?.id, fromLabel: '探针员', requireReply: true,
  text: `兼容性检查:请用一句话说明你的引擎(${harness}),然后原样回复"${harness} 在线"。`,
})
console.log('message sent:', m.status, m?.data?.messageId?.slice(0, 8))

const deadline = Date.now() + 300_000
let replied = false
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 2000))
  await poll()
  replied = seen.some(f => f.type === 'a2a.message' && f.payload?.metadata?.['x-aw-in-reply-to'] === m?.data?.messageId)
  if (replied) break
}
clearInterval(poller)
console.log(replied ? '\n=== 回执已收到 ===' : '\n=== 300s 未收到回执 ===')
const byType = {}
for (const f of seen) byType[f.type] = (byType[f.type] ?? 0) + 1
console.log('帧分布:', JSON.stringify(byType))
process.exit(0)
