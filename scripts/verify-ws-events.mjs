/**
 * AEP 事件流实时验证(真实 WebSocket + REST)——验证「发给前端渲染的 event」端到端:
 *  - 连接 /api/workshop/ws(带用户 token)→ sub 指定 channel
 *  - 首帧应是 channel.snapshot(agents/tasks/queue/messages 实体基线)
 *  - REST 提交任务 → 依次收到 agent.status / task.status / task.progress / a2a.artifact / a2a.message
 *  - 信封完整性:v/type/seq/at/channelId/payload;seq 单调递增
 * 运行:node scripts/verify-ws-events.mjs [--base http://127.0.0.1:3000]
 */
const BASE = (process.argv.find(a => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:3000')
const API = BASE + '/api/workshop'
const WS = BASE.replace(/^http/, 'ws') + '/api/workshop/ws'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

async function api(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitTaskTerminal(taskId, token, timeoutMs = 20_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const { json } = await api('GET', `/tasks/${taskId}`, { token })
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(json?.data?.state ?? '')) return json?.data
    await sleep(250)
  }
  return null
}

let __token = null
let __channel = null

async function main() {
  console.log('━━━ AEP 事件流实时验证(真实 WS)→', WS, '━━━')
  const user = await api('POST', '/users/register', { body: { name: 'ws-events-' + Math.random().toString(36).slice(2, 9) } })
  const token = user.json?.data?.token
  __token = token
  check('用户注册/拿 token', !!token)

  const ch = await api('POST', '/channels', { token, body: { name: 'ws-events-check' } })
  const CH = ch.json?.data?.channelId
  __channel = CH
  check('channel 创建', !!CH)
  await api('POST', `/channels/${CH}/agents`, { token, body: { name: 'ws-lead', harness: 'mock', role: 'lead' } })
  const worker = await api('POST', `/channels/${CH}/agents`, { token, body: { name: 'ws-worker', harness: 'mock', role: 'worker' } })
  const WORKER = worker.json?.data?.id
  check('lead/worker 实例创建', !!WORKER)

  // 连接 WS + sub
  const ws = new WebSocket(WS)
  const frames = []
  const seen = new Set()
  let snapshot = null
  ws.onmessage = (ev) => {
    const e = JSON.parse(ev.data)
    frames.push(e)
    if (e.type === 'channel.snapshot' && e.channelId === CH) snapshot = e
    seen.add(e.type)
  }
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  ws.send(JSON.stringify({ type: 'sub', channelId: CH, token }))
  await sleep(800)

  check('sub 后收到 channel.snapshot', !!snapshot)
  check('snapshot 含 channel 元信息', !!snapshot?.payload?.channel && snapshot.payload.channel.id === CH)
  check('snapshot agents 含 lead/worker', (snapshot?.payload?.agents ?? []).some(a => a.role === 'lead') && (snapshot?.payload?.agents ?? []).some(a => a.role === 'worker'))
  check('snapshot 信封合法(v/seq/at/channelId)', snapshot?.v === 1 && typeof snapshot.seq === 'number' && typeof snapshot.at === 'string')

  // 提交任务 → 事件流
  const task = await api('POST', `/channels/${CH}/tasks`, { token, body: { title: 'ws-event-task', description: '触发事件流' } })
  const TASK = task.json?.data?.id
  check('任务提交', !!TASK)

  const final = await waitTaskTerminal(TASK, token)
  check('任务 COMPLETED', final?.state === 'COMPLETED', final?.state ?? '')
  await sleep(800) // 等尾部事件

  ws.send(JSON.stringify({ type: 'unsub', channelId: CH }))
  ws.close()

  const channelFrames = frames.filter(f => f.channelId === CH)
  check('收到 agent.status', channelFrames.some(f => f.type === 'agent.status'), `n=${channelFrames.filter(f => f.type === 'agent.status').length}`)
  check('收到 task.status', channelFrames.some(f => f.type === 'task.status'))
  check('收到 task.progress', channelFrames.some(f => f.type === 'task.progress'))
  const artifacts = channelFrames.filter(f => f.type === 'a2a.artifact')
  check('收到 a2a.artifact', artifacts.length > 0, `n=${artifacts.length}`)
  const taskStatus = channelFrames.find(f => f.type === 'task.status')
  check('task.status 载荷含 state/taskId', !!taskStatus?.payload?.state && !!taskStatus?.payload?.taskId)
  check('task.status 载荷含 assigneeId(事件即实体)', typeof taskStatus?.payload?.assigneeId === 'string')
  // seq 单调性:同一 channel 内 seq 严格递增
  let monotonic = true
  let prev = -1
  for (const f of channelFrames) {
    if (f.seq <= prev) {
      monotonic = false
      break
    }
    prev = f.seq
  }
  check('channel 内 seq 单调递增', monotonic, `frames=${channelFrames.length}`)
  check('含超额投递的 a2a.message', channelFrames.some(f => f.type === 'a2a.message'))

  console.log(`\n  [事件样本] ${channelFrames.slice(0, 4).map(f => `${f.seq}:${f.type}(state=${f.payload?.state ?? '-'})`).join('  ')}`)
  console.log(`\n━━━ 结果: PASS=${pass} FAIL=${fail} ━━━`)
  process.exit(fail === 0 ? 0 : 1)
}

try {
  await main()
}
finally {
  if (__channel && __token) await api('DELETE', `/channels/${__channel}`, { token: __token }).catch(() => {})
}
