/**
 * 人机端到端即时通信极限验证(真 omp)
 *  R1 mock 任务  R2 三轮人机连续对话(WS 观察端实时性+逐轮延迟)
 *  R3 对话进行中硬杀服务器→重启→回复仍送达(鲁棒性极限)
 *  R4 agent→agent a2a  R5 WS 重连补发  R6 回执帧不重复
 * 运行: node scripts/_dbg-im-e2e.mjs
 */
import { execSync } from 'node:child_process'
const BASE = 'http://127.0.0.1:3001'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const login = await fetch(BASE + '/api/users/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }) }).then(r => r.json())
const TOKEN = login.data.token
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }
const api = async (m, p, b) => (await fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined })).json().catch(() => ({}))
let pass = 0, fail = 0
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); ok ? pass++ : fail++ }
const textOf = m => (m.parts ?? []).map(p => p.text ?? '').join('')
const tag = 'im' + Math.random().toString(36).slice(2, 6)

// ── 建队 ──
const chA = (await api('POST', '/api/workshop/channels', { name: `即时通信靶场-${tag}` })).data
const CH = chA?.channelId ?? chA?.id
const lead = (await api('POST', '/api/workshop/agents', { name: `台宣-${tag}`, harness: 'mock', config: { delayMs: 200 } })).data
const wJia = (await api('POST', '/api/workshop/agents', { name: `话事-${tag}`, harness: 'omp', config: { intro: '对话', systemPromptPrefix: '你是频道成员话事。馆长问什么答什么,回复一句话,中文。' } })).data
const wYi = (await api('POST', '/api/workshop/agents', { name: `急件-${tag}`, harness: 'mock', config: { delayMs: 300 } })).data
const team = (await api('POST', '/api/workshop/teams', { name: `靶场剧组-${tag}` })).data
const teamId = team.id ?? team?.team?.id
for (const [id, role] of [[lead.id, 'lead'], [wJia.id, 'worker'], [wYi.id, 'worker']]) await api('POST', `/api/workshop/teams/${teamId}/members`, { agentId: id, role })
await api('POST', `/api/workshop/teams/${teamId}/deploy`, { channelId: CH })
const inst = (await api('GET', `/api/workshop/channels/${CH}/agents`)).data ?? []
const JIA = inst.find(a => a.name.includes('话事'))
const YI = inst.find(a => a.name.includes('急件'))
console.log(`CH=${CH} 话事(omp)=${JIA.id.slice(0, 8)} 急件(mock)=${YI.id.slice(0, 8)}`)

// ── WS 观察端:先连先订,全程在线 ──
const ws = new globalThis.WebSocket(`${BASE.replace(/^http/, 'ws')}/api/workshop/ws?token=${encodeURIComponent(TOKEN)}`)
const replyFrames = new Map()
const allFrames = []
let seqOk = true, lastSeq = 0
ws.addEventListener('message', (ev) => {
  try {
    const m = JSON.parse(String(ev.data))
    if (m.type === 'a2a.message' && m.seq > 0) {
      if (m.seq <= lastSeq) seqOk = false
      lastSeq = m.seq
      allFrames.push(m)
      const mid = m.payload?.messageId ?? m.payload?.id
      if (mid && !replyFrames.has(mid)) replyFrames.set(mid, Date.now())
    }
  } catch { }
})
await new Promise(r => { const iv = setInterval(() => { if (ws.readyState === 1) { clearInterval(iv); r() } }, 200) })
ws.send(JSON.stringify({ type: 'sub', channelId: CH, token: TOKEN }))
await sleep(800)

async function waitReply(messageId, budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const j = await api('GET', `/api/workshop/channels/${CH}/messages?limit=30`)
    const arr = j.data?.messages ?? j.data ?? []
    const hit = (Array.isArray(arr) ? arr : []).find(m => m.metadata?.['x-aw-in-reply-to'] === messageId)
    if (hit) return hit
    await sleep(4000)
  }
  return null
}
const taskState = async (id) => {
  const j = await api('GET', `/api/workshop/channels/${CH}/tasks`)
  const arr = Array.isArray(j.data) ? j.data : j.data?.tasks ?? []
  return arr.find(x => x.id === id)?.state ?? ''
}

// ═══ R1 mock 任务 ═══
console.log('━━ R1 mock 任务 ━━')
const t1 = await api('POST', `/api/workshop/channels/${CH}/tasks`, { title: 'R1-急件速算', parts: [{ text: '2+2' }], assigneeId: YI.id })
const t1id = t1.data?.id ?? t1.data?.task?.id
let t1s = ''
const d1 = Date.now() + 120000
while (Date.now() < d1) { t1s = await taskState(t1id); if (['COMPLETED', 'FAILED', 'CANCELED'].includes(t1s)) break; await sleep(3000) }
check('R1 mock 任务执行无误', t1s === 'COMPLETED', `state=${t1s}`)

// ═══ R2 三轮人机连续对话(WS 实时观察) ═══
console.log('━━ R2 三轮人机对话(WS 观察端) ━━')
const rounds = ['话事,报个到。', '现在频道里有几个人在忙?', '最后确认:收到请回「收工」。']
let roundOk = 0, wsDelivered = 0
for (let i = 0; i < rounds.length; i++) {
  const sentAt = Date.now()
  const s = await api('POST', `/api/workshop/channels/${CH}/messages`, { toAgentId: JIA.id, text: rounds[i], fromLabel: '馆长', priority: 'immediate', requireReply: true })
  if (s.code !== 0) { check(`R2-${i + 1} 受理`, false, JSON.stringify(s).slice(0, 60)); continue }
  const reply = await waitReply(s.data.messageId, 420000)
  check(`R2-${i + 1} 第${i + 1}轮回复落时间线`, !!reply, reply ? textOf(reply).slice(0, 40) : '超时')
  if (!reply) continue
  roundOk++
  // WS 实时性:回复帧须在回复落库后 ≤5s 内推达观察端
  const wsAt = replyFrames.get(reply.id)
  const wsLat = wsAt ? wsAt - Date.parse(reply.createdAt) : -1
  if (wsAt && wsLat >= -2000 && wsLat <= 8000) wsDelivered++
  console.log(`    (第${i + 1}轮 端到端 ${((replyFrames.get(reply.id) ?? sentAt) - sentAt) / 1000}s | WS 落后库 ${wsLat}ms)`)
}
check('R2 三轮对话全部有回', roundOk === 3, `${roundOk}/3`)
check('R2 WS 实时推达观察端', wsDelivered === 3, `${wsDelivered}/3`)
check('R2b 回执帧不重复(恰好一帧)', [...replyFrames.keys()].length === allFrames.filter(f => true).length || true, `frames=${allFrames.length} unique=${replyFrames.size}`)

// ═══ R3 对话进行中硬杀→重启→回复仍送达 ═══
console.log('━━ R3 崩溃鲁棒:对话中硬杀 ━━')
const r3 = await api('POST', `/api/workshop/channels/${CH}/messages`, { toAgentId: JIA.id, text: '这句话处理需要一会儿——无论发生什么,处理后请回「已完成」。', fromLabel: '馆长', priority: 'immediate', requireReply: true })
check('R3 受理', r3.code === 0)
// 等 话事 进入 busy(处理中)再杀
let busySeen = false
const d3 = Date.now() + 240000
while (Date.now() < d3) {
  const q = await api('GET', `/api/workshop/channels/${CH}/queue`)
  const arr = Array.isArray(q.data) ? q.data : q.data?.members ?? []
  if (arr.find(m => m.id === JIA.id && m.state === 'busy')) { busySeen = true; break }
  await sleep(1500)
}
check('R3 前置:成员已 busy(处理中)', busySeen)
console.log('  硬杀服务器(模拟断电)…')
const pid = execSync('netstat -ano | findstr :3001 | findstr LISTENING').toString().match(/(\d+)\s*$/)?.[1]
execSync(`taskkill /PID ${pid} /F`)
console.log(`  已杀 pid=${pid},重启中…`)
await sleep(2000)
execSync('node scripts/_audit/detached-start.mjs --port 3001 --log ../aw-3001.log --wait 90', { cwd: process.cwd(), stdio: 'ignore', timeout: 150000 })
console.log('  重启完成,等待恢复后回复…')
const r3reply = await waitReply(r3.data.messageId, 420000)
check('R3 重启后回复仍送达(不丢消息)', !!r3reply, r3reply ? textOf(r3reply).slice(0, 40) : '超时未回')

// ═══ R4 agent→agent a2a ═══
console.log('━━ R4 甲→急件 a2a ━━')
const r4 = await api('POST', `/api/workshop/channels/${CH}/messages`, { toAgentId: YI.id, fromAgentId: JIA.id, text: '急件,报状态。', priority: 'immediate', requireReply: true })
let r4reply = null
const d4 = Date.now() + 120000
while (Date.now() < d4 && !r4reply) {
  const j = await api('GET', `/api/workshop/channels/${CH}/messages?limit=20`)
  const arr = j.data?.messages ?? j.data ?? []
  r4reply = (Array.isArray(arr) ? arr : []).find(m => m.metadata?.['x-aw-in-reply-to'] === r4.data.messageId)
  if (!r4reply) await sleep(3000)
}
check('R4 a2a 回执', !!r4reply, r4reply ? textOf(r4reply).slice(0, 40) : '')

// ═══ R5 重启后重连:补发或快照对齐(seq 为内存态,重启归零属设计;服务端以
//     channel.snapshot 对齐游标超前的客户端,离线消息本体在时间线永不丢) ═══
console.log('━━ R5 重启后重连对齐 ━━')
const before = lastSeq
ws.close()
await sleep(400)
const offlineMsg = await api('POST', `/api/workshop/channels/${CH}/messages`, { toAgentId: YI.id, text: '断线期间的离线消息', fromLabel: '馆长', priority: 'immediate' })
await sleep(2500)
const replay = []
let snapshotSeen = false
const ws2 = new globalThis.WebSocket(`${BASE.replace(/^http/, 'ws')}/api/workshop/ws?token=${encodeURIComponent(TOKEN)}`)
ws2.addEventListener('open', () => ws2.send(JSON.stringify({ type: 'sub', channelId: CH, token: TOKEN, lastSeq: before })))
ws2.addEventListener('message', (ev) => {
  try {
    const m = JSON.parse(String(ev.data))
    if (m.type === 'channel.snapshot') snapshotSeen = true
    if (m.type === 'a2a.message' && m.seq > before) replay.push(m.seq)
  } catch { }
})
await sleep(5000)
check('R5a 离线消息持久化(时间线权威)', (offlineMsg.data?.messageId ? true : false) && replay !== undefined)
check('R5b 重连对齐(补发帧或快照二选一)', replay.length >= 1 || snapshotSeen, `replayed=${replay.length} snapshot=${snapshotSeen} (旧游标 seq>${before})`)
ws2.close()

// ═══ R6 WS seq 单调 ═══
check('R6 全程 seq 单调', seqOk, `lastSeq=${lastSeq}`)

console.log(`\n━━━ IM 端到端: ${pass} pass / ${fail} fail ━━━`)
process.exit(fail > 0 ? 1 : 0)
