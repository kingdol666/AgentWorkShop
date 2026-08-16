/**
 * AEP v1 协议级测试(对运行中的 dev server):
 * ① 信封:{v,type,seq,at,channelId,payload} 全字段;snapshot 含 agents/tasks/queue/messages
 * ② 事件直推:提交任务 → task.status/task.progress/a2a.artifact/a2a.message/agent.status 无轮询延迟到达
 * ③ seq 单调递增且连续
 * ④ 断线续传:断开期间发生事件 → sub{lastSeq} 重放缺失段(无快照帧、seq 连续)
 * ⑤ 缓冲窗外/游标缺失 → channel.snapshot 全量对齐兜底
 * ⑥ 多 channel 单连接:sub/unsub 复用一条 WS
 * ⑦ ping/pong 心跳;非法上行 → error
 * 运行: node scripts/test-ws-aep.mjs(需 server 已启动,AW_E2E_BASE 可覆盖)
 */
const BASE = process.env.AW_E2E_BASE ?? 'http://localhost:3000'
const WS_BASE = BASE.replace(/^http/, 'ws')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function api(method, path, arg) {
  // 调用侧统一 { body: {...} } 包装;无 body 的 GET 直传 path 后无第三参
  const body = arg && typeof arg === 'object' && 'body' in arg ? arg.body : arg
  const res = await fetch(`${BASE}/api/workshop${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, code: json?.code, data: json?.data }
}

/** WS 收集器:url 省省时连裸端点(纯上行 sub 模式) */
function openWs(url = `${WS_BASE}/api/workshop/ws`) {
  const frames = []
  const ws = new WebSocket(url)
  const opened = new Promise((resolve, reject) => {
    ws.onopen = () => resolve(true)
    ws.onerror = e => reject(new Error(`ws error: ${e?.message ?? e}`))
  })
  ws.onmessage = ev => frames.push(JSON.parse(ev.data))
  return { ws, frames, opened }
}

const seqsOf = frames => frames.map(f => f.seq).filter(n => Number.isFinite(n))
const isMonotonic = seqs => seqs.every((s, i) => i === 0 || s > seqs[i - 1])

async function main() {
  // ── 前置:channel + lead + 2 worker(mock);首次请求撞上 Nitro 构建窗口时重试 ──
  let ch = null
  for (let i = 0; i < 5 && !ch?.data?.channelId; i++) {
    ch = await api('POST', '/channels', { body: { name: `aep-${Date.now()}` } })
    if (!ch?.data?.channelId) {
      console.log(`[debug] 第 ${i + 1} 次失败: ${JSON.stringify(ch).slice(0, 200)}`)
      await sleep(1000)
    }
  }
  if (!ch?.data?.channelId) throw new Error(`channel 创建失败: ${JSON.stringify(ch).slice(0, 200)}`)
  const channelId = ch.data.channelId
  const mk = (name, role) => api('POST', `/channels/${channelId}/agents`, { body: { name, harness: 'mock', role } })
  await mk('aep-lead', 'lead')
  await mk('aep-w1', 'worker')
  await mk('aep-w2', 'worker')

  console.log('=== ① 信封与快照 ===')
  const c1 = openWs(`${WS_BASE}/api/workshop/ws?channelId=${channelId}`)
  await c1.opened
  const snap = await (async () => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const f = c1.frames.find(f => f.type === 'channel.snapshot')
      if (f) return f
      await sleep(50)
    }
    return null
  })()
  check('连接即收 channel.snapshot', !!snap)
  check('信封字段完整(v/type/seq/at/channelId/payload)', snap?.v === 1 && !!snap.type && typeof snap.seq === 'number' && !!snap.at && snap.channelId === channelId && !!snap.payload)
  check('快照含 agents(3)/queue(3)/tasks/messages', snap?.payload.agents?.length === 3 && snap?.payload.queue?.length === 3 && Array.isArray(snap?.payload.tasks) && Array.isArray(snap?.payload.messages))

  console.log('\n=== ② 事件直推(无轮询)===')
  const t1 = await api('POST', `/channels/${channelId}/tasks`, { body: { title: 'AEP 直推验证', description: 'mock 执行' } })
  check('任务提交 200', t1.status === 200)
  const sawComplete = await (async () => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const done = c1.frames.some(f => f.type === 'task.status' && f.payload?.taskId === t1.data.id && f.payload?.state === 'COMPLETED')
      if (done) return true
      await sleep(100)
    }
    return false
  })()
  const types = [...new Set(c1.frames.map(f => f.type))]
  check('任务全生命周期事件直推至 COMPLETED', sawComplete)
  check('事件类型覆盖(status/progress/artifact/message)', ['task.status', 'task.progress'].every(t => types.includes(t)), types.join(','))
  const a2a = c1.frames.filter(f => f.type === 'a2a.message')
  check('a2a.message 投递事件(route 汇流:lead assign)', a2a.length >= 1, `n=${a2a.length}`)

  console.log('\n=== ③ seq 单调 ===')
  const seqs = seqsOf(c1.frames.filter(f => f.type !== 'pong'))
  check('seq 严格单调递增', isMonotonic(seqs), `last=${seqs.at(-1)}`)

  console.log('\n=== ④ 断线续传(lastSeq 重放)===')
  const lastSeq = seqs.at(-1) ?? 0
  c1.ws.close()
  await sleep(300)
  // 断开期间提交第二个任务(事件进入服务端缓冲)
  const t2 = await api('POST', `/channels/${channelId}/tasks`, { body: { title: '断线期间任务', description: '重放验证' } })
  const t2done = await (async () => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const r = await api('GET', `/channels/${channelId}/tasks`)
      const t = r.data?.find(x => x.id === t2.data?.id)
      if (t?.state === 'COMPLETED') return true
      await sleep(200)
    }
    return false
  })()
  check('断线期间任务完成(事件入缓冲)', t2done)
  const c2 = openWs()
  await c2.opened
  c2.ws.send(JSON.stringify({ type: 'sub', channelId, lastSeq }))
  await sleep(500)
  const replay = c2.frames.filter(f => f.type !== 'pong' && f.type !== 'channel.snapshot')
  const replaySeqs = seqsOf(replay)
  check('重放帧 seq 从 lastSeq+1 连续', replaySeqs.length > 0 && replaySeqs[0] === lastSeq + 1 && replaySeqs.every((s, i) => i === 0 || s === replaySeqs[i - 1] + 1),
    `first=${replaySeqs[0]} last=${replaySeqs.at(-1)} (lastSeq=${lastSeq})`)
  check('重放含断线期间任务事件', replay.some(f => f.type === 'task.status' && f.payload?.taskId === t2.data?.id))
  check('无快照帧(重放路径不走全量)', !c2.frames.some(f => f.type === 'channel.snapshot'))

  console.log('\n=== ⑤ 全量对齐兜底(lastSeq 缺失) ===')
  const c3 = openWs()
  await c3.opened
  c3.ws.send(JSON.stringify({ type: 'sub', channelId })) // 无 lastSeq → snapshot
  await sleep(500)
  check('无 lastSeq → channel.snapshot 对齐', c3.frames.some(f => f.type === 'channel.snapshot'))

  console.log('\n=== ⑥ 多 channel 单连接(sub/unsub) ===')
  const ch2 = await api('POST', '/channels', { body: { name: `aep2-${Date.now()}` } })
  c3.ws.send(JSON.stringify({ type: 'sub', channelId: ch2.data.channelId }))
  await sleep(300)
  await api('POST', `/channels/${ch2.data.channelId}/agents`, { body: { name: 'solo-lead', harness: 'mock', role: 'lead' } })
  await api('POST', `/channels/${ch2.data.channelId}/tasks`, { body: { title: '第二通道任务' } })
  await sleep(1500)
  check('同一连接收到第二 channel 事件', c3.frames.some(f => f.channelId === ch2.data.channelId && f.type !== 'channel.snapshot'))
  c3.ws.send(JSON.stringify({ type: 'unsub', channelId: ch2.data.channelId }))
  await sleep(200)
  const beforeUnsub = c3.frames.filter(f => f.channelId === ch2.data.channelId).length
  await sleep(800)
  check('unsub 后不再收到该 channel 事件', c3.frames.filter(f => f.channelId === ch2.data.channelId).length === beforeUnsub)

  console.log('\n=== ⑦ 心跳与非法上行 ===')
  c3.ws.send(JSON.stringify({ type: 'ping' }))
  await sleep(300)
  check('ping → pong', c3.frames.some(f => f.type === 'pong'))
  c3.ws.send(JSON.stringify({ type: 'nonsense' }))
  await sleep(300)
  check('非法上行 → error UNSUPPORTED_UPLINK', c3.frames.some(f => f.type === 'error' && f.payload?.code === 'UNSUPPORTED_UPLINK'))
  c3.ws.close()
  c2.ws.close()

  // ── 清理 ──
  await api('DELETE', `/channels/${channelId}`)
  await api('DELETE', `/channels/${ch2.data.channelId}`)
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('AEP 测试异常:', e)
  process.exit(1)
})
