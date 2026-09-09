/** 任务 CANCELED 现行探针:复刻 live-line S5 夹具(无清理),500ms 粒度记录任务状态迁移,
 *  终态非 COMPLETED 时导出 events/messages/task 现场,定位取消者。 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:3001'
const TAG = process.argv[3] ?? `cp${Math.random().toString(36).slice(2, 6)}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

const login = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'perf-runner@awshop.io', password: 'Perf@Run2026' }) }).then(r => r.json())
const token = login.data.token
const api = async (method, path, { body } = {}) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

const chRes = await api('POST', '/api/workshop/channels', { body: { name: `probe-${TAG}`, leadAgent: { name: `lead-${TAG}`, harness: 'mock', config: { delayMs: 60 } } } })
if (!chRes.data?.channelId) { console.error('channel create failed:', JSON.stringify(chRes).slice(0, 300)); process.exit(1) }
const ch = chRes.data
console.log('channel:', ch.channelId)
const tplRes = await api('POST', '/api/workshop/agents', { body: { name: `op-${TAG}`, harness: 'omp', config: { provider: 'zhipu-coding-plan', model: 'glm-5.3-flash', systemPromptPrefix: '你是产线操作员:严格按步骤执行,完成后立即调用 complete_task。' } } })
const tpl = tplRes.data?.id ? tplRes.data : tplRes.data?.agent ?? tplRes.data
if (!tpl?.id) { console.error('agent create failed:', JSON.stringify(tplRes).slice(0, 300)); process.exit(1) }
const joinRes = await api('POST', `/api/workshop/channels/${ch.channelId}/agents`, { body: { agentId: tpl.id, role: 'worker' } })
const join = joinRes.data
if (!join?.data?.id && !join?.id) { console.error('join failed:', JSON.stringify(joinRes).slice(0, 300)); process.exit(1) }
const instId = join.data?.id ?? join.id
console.log('worker joined:', instId?.slice(0, 8))

const t1Res = await api('POST', `/api/workshop/channels/${ch.channelId}/tasks`, {
  body: {
    title: `probe-${TAG}`,
    parts: [{ text: `两步作业:1) dcw_line_context 查看当前产线上下文;2. 完成后调用 complete_task,交付原样包含一行 PROBE-OK。` }],
    assigneeId: instId,
  },
})
if (!t1Res.data) { console.error('task create failed:', JSON.stringify(t1Res).slice(0, 300)); process.exit(1) }
const taskId = t1Res.data?.task?.id ?? t1Res.data?.id
console.log('task:', taskId)

const t0 = Date.now()
let last = ''
let terminal = null
while (Date.now() - t0 < 5 * 60_000) {
  await sleep(500)
  const t = (await api('GET', `/api/workshop/channels/${ch.channelId}/tasks`)).data
  const row = (Array.isArray(t) ? t : t.tasks ?? []).find(x => x.id === taskId)
  const st = row?.state ?? '?'
  if (st !== last) {
    console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s state: ${last || '(new)'} -> ${st} (progress=${row?.progress ?? '-'})`)
    last = st
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(st)) { terminal = st; break }
  }
}
console.log('terminal:', terminal)
if (terminal && terminal !== 'COMPLETED') {
  const events = await api('GET', `/api/workshop/channels/${ch.channelId}/events?limit=200`)
  const msgs = await api('GET', `/api/workshop/channels/${ch.channelId}/messages?limit=100`)
  const ev = JSON.stringify(events.data ?? events)
  const interesting = ev.match(/\{[^{}]*[Tt]ransition[^{}]*\}|\{[^{}]*cancel[^{}]*\}/g) ?? []
  console.log('== transition-ish events:', interesting.slice(0, 6))
  const mlist = (msgs.data?.messages ?? msgs.data ?? [])
  for (const m of mlist.slice(-8)) {
    const text = (m.parts ?? []).map(p => p.text ?? '').join(' ').replace(/\s+/g, ' ').slice(0, 220)
    console.log(`msg[${m.role}] task=${(m.taskId ?? '').slice(0, 8)} meta=${JSON.stringify(m.metadata ?? {}).slice(0, 120)}`)
    console.log('   ', text)
  }
}
console.log('channel kept for inspection:', ch.channelId)
