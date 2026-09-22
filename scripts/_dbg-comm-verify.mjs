/**
 * 通信系统洁净重启全链路验证(真 omp 引擎)
 *  T1 mock 任务执行  T2 omp 任务执行
 *  A1 agent→agent a2a 回执  A2 跨频道 lead→lead
 *  H1 人类→lead 回执  H2 人类→worker 直发(@)回执
 *  W1 WS 实时延迟 + seq 单调  W2 断线→lastSeq 重连补发(IM 离线语义)
 * 运行: node scripts/_dbg-comm-verify.mjs
 */
const BASE = 'http://127.0.0.1:3001'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const login = await fetch(BASE + '/api/users/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }) }).then(r => r.json())
const TOKEN = login.data.token
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
const api = async (m, p, b) => (await fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined })).json().catch(() => ({}))
let pass = 0, fail = 0
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); ok ? pass++ : fail++ }
const textOf = m => (m.parts ?? []).map(p => p.text ?? '').join('')
const tag = 'cv' + Math.random().toString(36).slice(2, 6)

// ── 建队:主频道(调度+甲 omp+乙 mock)+ 分站(omp lead) ──
const chA = (await api('POST', '/api/workshop/channels', { name: `通信实验室-${tag}` })).data
const CH = chA?.channelId ?? chA?.id
const lead = (await api('POST', '/api/workshop/agents', { name: `调度-${tag}`, harness: 'omp', config: { intro: '调度', systemPromptPrefix: '你是频道调度。中文简短回应。' } })).data
const wJia = (await api('POST', '/api/workshop/agents', { name: `甲-${tag}`, harness: 'omp', config: { intro: '执行', systemPromptPrefix: '你是成员甲。执行收到的指令,回复保持一句话。中文。' } })).data
const wYi = (await api('POST', '/api/workshop/agents', { name: `乙-${tag}`, harness: 'mock', config: { delayMs: 300 } })).data
const team = (await api('POST', '/api/workshop/teams', { name: `通信剧组-${tag}` })).data
const teamId = team.id ?? team?.team?.id
for (const [id, role] of [[lead.id, 'lead'], [wJia.id, 'worker'], [wYi.id, 'worker']]) {
  await api('POST', `/api/workshop/teams/${teamId}/members`, { agentId: id, role })
}
await api('POST', `/api/workshop/teams/${teamId}/deploy`, { channelId: CH })
const inst = (await api('GET', `/api/workshop/channels/${CH}/agents`)).data ?? []
const L = inst.find(a => a.role === 'lead')
const JIA = inst.find(a => a.name.includes('甲'))
const YI = inst.find(a => a.name.includes('乙'))
console.log(`CH=${CH} lead=${L.id.slice(0, 8)} 甲(omp)=${JIA.id.slice(0, 8)} 乙(mock)=${YI.id.slice(0, 8)}`)

const chB = (await api('POST', '/api/workshop/channels', { name: `分站-${tag}` })).data
const CHB = chB?.channelId ?? chB?.id
const leadB = (await api('POST', '/api/workshop/agents', { name: `分站调度-${tag}`, harness: 'omp', config: { intro: '分站', systemPromptPrefix: '你是分站调度。中文一句话回应。' } })).data
const teamB = (await api('POST', '/api/workshop/teams', { name: `分站剧组-${tag}` })).data
await api('POST', `/api/workshop/teams/${teamB.id ?? teamB?.team?.id}/members`, { agentId: leadB.id, role: 'lead' })
await api('POST', `/api/workshop/teams/${teamB.id ?? teamB?.team?.id}/deploy`, { channelId: CHB })

// ═══ T1 mock 任务 ═══
console.log('━━ T1 mock 任务 ━━')
const t1 = await api('POST', `/api/workshop/channels/${CH}/tasks`, { title: 'T1-乙速算', parts: [{ text: '1+1 等于几' }], assigneeId: YI.id })
const t1id = t1.data?.id ?? t1.data?.task?.id
let t1s = ''
const d1 = Date.now() + 120000
while (Date.now() < d1) {
  const j = await api('GET', `/api/workshop/channels/${CH}/tasks`)
  const arr = Array.isArray(j.data) ? j.data : j.data?.tasks ?? []
  t1s = arr.find(x => x.id === t1id)?.state ?? ''
  if (['COMPLETED', 'FAILED', 'CANCELED'].includes(t1s)) break
  await sleep(3000)
}
check('T1 mock 任务执行无误', t1s === 'COMPLETED', `state=${t1s}`)

// ═══ A1 agent→agent a2a(甲→乙 requireReply;乙 mock 秒回) ═══
console.log('━━ A1 甲→乙 a2a 回执 ━━')
// 甲 omp 收到消息后会经 host 工具回信;这里直接驱动乙侧:给乙投递一条要求回复的消息,以甲身份
const a1 = await api('POST', `/api/workshop/channels/${CH}/messages`, { toAgentId: YI.id, fromAgentId: JIA.id, text: '乙,报一下你的当前状态。', priority: 'immediate', requireReply: true })
check('A1 受理', a1.code === 0)
let a1reply = null
const da1 = Date.now() + 120000
while (Date.now() < da1 && !a1reply) {
  const j = await api('GET', `/api/workshop/channels/${CH}/messages?limit=20`)
  const arr = j.data?.messages ?? j.data ?? []
  a1reply = (Array.isArray(arr) ? arr : []).find(m => m.metadata?.['x-aw-in-reply-to'] === a1.data.messageId)
  if (!a1reply) await sleep(4000)
}
check('A1 乙回甲(in_reply_to 关联)', !!a1reply, a1reply ? textOf(a1reply).slice(0, 50) : '')

// ═══ T2 omp 任务 ═══
console.log('━━ T2 omp 任务 ━━')
const t2 = await api('POST', `/api/workshop/channels/${CH}/tasks`, { title: 'T2-甲真执行', parts: [{ text: '请只回复一行:执行完毕。' }], assigneeId: JIA.id, mode: 'goal', modeConfig: { goalCriteria: '已输出一行执行完毕' } })
const t2id = t2.data?.id ?? t2.data?.task?.id
let t2s = ''
const d2 = Date.now() + 300000
while (Date.now() < d2) {
  const j = await api('GET', `/api/workshop/channels/${CH}/tasks`)
  const arr = Array.isArray(j.data) ? j.data : j.data?.tasks ?? []
  t2s = arr.find(x => x.id === t2id)?.state ?? ''
  if (['COMPLETED', 'FAILED', 'CANCELED'].includes(t2s)) break
  await sleep(6000)
}
check('T2 omp 任务执行无误', t2s === 'COMPLETED', `state=${t2s}`)

// ═══ H1 人类→lead 回执(修复链验证) ═══
console.log('━━ H1 人类→lead requireReply ━━')
const h1 = await api('POST', `/api/workshop/channels/${CH}/messages`, { toAgentId: L.id, text: '调度,回一句:通信正常。', fromLabel: '馆长', priority: 'immediate', requireReply: true })
let h1reply = null
const dh1 = Date.now() + 600000
while (Date.now() < dh1 && !h1reply) {
  const j = await api('GET', `/api/workshop/channels/${CH}/messages?limit=20`)
  const arr = j.data?.messages ?? j.data ?? []
  h1reply = (Array.isArray(arr) ? arr : []).find(m => m.metadata?.['x-aw-in-reply-to'] === h1.data.messageId)
  if (!h1reply) await sleep(5000)
}
check('H1 lead 回执落时间线', !!h1reply, h1reply ? textOf(h1reply).slice(0, 50) : '')

// ═══ H2 人类→worker 直发(@worker) ═══
console.log('━━ H2 人类→甲 直发 ━━')
const h2 = await api('POST', `/api/workshop/channels/${CH}/messages`, { toAgentId: JIA.id, text: '甲,馆长点名:回一句甲在岗。', fromLabel: '馆长', priority: 'immediate', requireReply: true })
let h2reply = null
const dh2 = Date.now() + 600000
while (Date.now() < dh2 && !h2reply) {
  const j = await api('GET', `/api/workshop/channels/${CH}/messages?limit=20`)
  const arr = j.data?.messages ?? j.data ?? []
  h2reply = (Array.isArray(arr) ? arr : []).find(m => m.metadata?.['x-aw-in-reply-to'] === h2.data.messageId)
  if (!h2reply) await sleep(5000)
}
check('H2 worker 直气回执', !!h2reply, h2reply ? textOf(h2reply).slice(0, 50) : '')

// ═══ A2 跨频道 lead→lead ═══
console.log('━━ A2 跨频道通信 ━━')
const a2 = await api('POST', `/api/workshop/channels/${CH}/messages`, { toChannelId: CHB, fromAgentId: L.id, text: '分站调度,请回一句:分站在线。', requireReply: true })
check('A2 跨频道受理', a2.code === 0, JSON.stringify(a2).slice(0, 60))
let a2reply = null
const da2 = Date.now() + 600000
while (Date.now() < da2 && !a2reply) {
  const j = await api('GET', `/api/workshop/channels/${CH}/messages?limit=30`)
  const arr = j.data?.messages ?? j.data ?? []
  a2reply = (Array.isArray(arr) ? arr : []).find(m => m.metadata?.['x-aw-in-reply-to'] === a2.data.messageId)
  if (!a2reply) await sleep(5000)
}
check('A2 分站回信落主频道', !!a2reply, a2reply ? textOf(a2reply).slice(0, 50) : '')

// ═══ W1/W2 WS 实时 + 重连补发 ═══
console.log('━━ W1/W2 WS 实时与补发 ━━')
const ws = new globalThis.WebSocket(`${BASE.replace(/^http/, 'ws')}/api/workshop/ws?token=${encodeURIComponent(TOKEN)}`)
let wsOpen = false
const frames = []
let seqOk = true
let lastSeqSeen = 0
ws.addEventListener('open', () => { wsOpen = true })
ws.addEventListener('message', (ev) => {
  try {
    const m = JSON.parse(String(ev.data))
    if (m.type === 'a2a.message' && m.seq > 0) {
      if (m.seq <= lastSeqSeen) seqOk = false
      lastSeqSeen = m.seq
      frames.push({ seq: m.seq, at: Date.now() })
    }
  } catch { }
})
await new Promise(r => { const iv = setInterval(() => { if (wsOpen) { clearInterval(iv); r() } }, 200) })
ws.send(JSON.stringify({ type: 'sub', channelId: CH, token: TOKEN }))
await sleep(1000)

// 实时延迟测量:REST 发送 → WS 帧到达
const sentAt = Date.now()
const wmsg = await api('POST', `/api/workshop/channels/${CH}/messages`, { toAgentId: YI.id, text: '延迟测量消息', fromLabel: '馆长', priority: 'immediate' })
let latency = -1
const dw1 = Date.now() + 15000
while (Date.now() < dw1) {
  const hit = frames.find(f => f.at >= sentAt)
  if (hit) { latency = hit.at - sentAt; break }
  await sleep(100)
}
check('W1 WS 实时推送(≤5s)', latency >= 0 && latency <= 5000, `latency=${latency}ms`)
check('W1b seq 单调递增', seqOk, `lastSeq=${lastSeqSeen}`)

// 断线 → 离线期发 2 条 → lastSeq 重连 → 补发
const lastSeqBefore = lastSeqSeen
ws.close()
await sleep(500)
await api('POST', `/api/workshop/channels/${CH}/messages`, { toAgentId: YI.id, text: '离线消息一', fromLabel: '馆长', priority: 'immediate' })
await api('POST', `/api/workshop/channels/${CH}/messages`, { toAgentId: YI.id, text: '离线消息二', fromLabel: '馆长', priority: 'immediate' })
await sleep(2500)
const replay = []
const ws2 = new globalThis.WebSocket(`${BASE.replace(/^http/, 'ws')}/api/workshop/ws?token=${encodeURIComponent(TOKEN)}`)
ws2.addEventListener('open', () => {
  ws2.send(JSON.stringify({ type: 'sub', channelId: CH, token: TOKEN, lastSeq: lastSeqBefore }))
})
ws2.addEventListener('message', (ev) => {
  try {
    const m = JSON.parse(String(ev.data))
    if (m.type === 'a2a.message' && m.seq > lastSeqBefore) replay.push(m.seq)
  } catch { }
})
await sleep(6000)
check('W2 重连补发离线消息', replay.length >= 2, `replayed=${replay.length} (from seq>${lastSeqBefore})`)
ws2.close()

console.log(`\n━━━ 通信验证: ${pass} pass / ${fail} fail ━━━`)
process.exit(fail > 0 ? 1 : 0)
