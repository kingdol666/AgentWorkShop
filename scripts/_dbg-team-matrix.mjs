/**
 * AgentTeam 真实运行场景矩阵(omp 真引擎,REST 契约层)
 * S1 用户→lead 聊天 + requireReply 回执
 * S2 用户→worker 直发(@worker 等价) + 回执,lead 不经手
 * S3 @worker 直派任务(assigneeId)直达到人并完成
 * S4 loop 模式限次任务
 * S5 频道公共记忆写入/检索/去重
 * S6 跨频道 lead→lead 通信 + 回执
 * S7 成员 disable/enable
 * 运行: node scripts/_dbg-team-matrix.mjs
 */
const BASE = 'http://127.0.0.1:3001'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const login = await fetch(BASE + '/api/users/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }) }).then(r => r.json())
const H = { 'content-type': 'application/json', authorization: `Bearer ${login.data.token}` }
const api = async (m, p, b) => (await fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined })).json().catch(() => ({}))
let pass = 0, fail = 0
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); ok ? pass++ : fail++ }
const tag = 'mt' + Math.random().toString(36).slice(2, 6)
const textOf = m => (m.parts ?? []).map(p => p.text ?? '').join('')
const msgsOf = async (ch, limit = 40) => {
  const j = await api('GET', `/api/workshop/channels/${ch}/messages?limit=${limit}`)
  const arr = j.data?.messages ?? j.data ?? []
  return Array.isArray(arr) ? arr : []
}

// ── 建队:总调度 + 快手 + 细笔 ──
const chA = (await api('POST', '/api/workshop/channels', { name: `接线测试间-${tag}` })).data
const CH = chA?.channelId ?? chA?.id
const lead = (await api('POST', '/api/workshop/agents', { name: `总调度-${tag}`, harness: 'omp', config: { intro: '调度与汇总', systemPromptPrefix: '你是频道总调度。收到消息礼貌回应;任务只拆解派发,不亲自干活。中文交流。' } })).data
const wk1 = (await api('POST', '/api/workshop/agents', { name: `快手-${tag}`, harness: 'omp', config: { intro: '快速执行', systemPromptPrefix: '你是频道成员快手。收到任何人(馆长或总调度)的消息与指令都要直接回应与执行,执行完向请求方回执。中文交流,回复务必简短。' } })).data
const wk2 = (await api('POST', '/api/workshop/agents', { name: `细笔-${tag}`, harness: 'omp', config: { intro: '细致执行', systemPromptPrefix: '你是频道成员细笔。认真执行收到的指令并回执。中文交流,回复务必简短。' } })).data
const team = (await api('POST', '/api/workshop/teams', { name: `接线剧组-${tag}` })).data
const teamId = team.id ?? team?.team?.id
await api('POST', `/api/workshop/teams/${teamId}/members`, { agentId: lead.id, role: 'lead' })
await api('POST', `/api/workshop/teams/${teamId}/members`, { agentId: wk1.id, role: 'worker' })
await api('POST', `/api/workshop/teams/${teamId}/members`, { agentId: wk2.id, role: 'worker' })
await api('POST', `/api/workshop/teams/${teamId}/deploy`, { channelId: CH })
const inst = (await api('GET', `/api/workshop/channels/${CH}/agents`)).data ?? []
const L = inst.find(a => a.role === 'lead')
const W1 = inst.find(a => a.name.includes('快手'))
const W2 = inst.find(a => a.name.includes('细笔'))
console.log(`channel=${CH} lead=${L.id.slice(0, 8)} 快手=${W1.id.slice(0, 8)} 细笔=${W2.id.slice(0, 8)}`)

/** 等待出现满足条件的消息(轮询历史) */
async function waitMsg(pred, budgetMs, label) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const msgs = await msgsOf(CH)
    const hit = msgs.find(pred)
    if (hit) return hit
    await sleep(5000)
  }
  console.log(`  (超时未等到: ${label})`)
  return null
}

// ═══ S1 用户→lead 聊天 + requireReply ═══
console.log('━━ S1 用户→lead requireReply ━━')
const s1 = await api('POST', `/api/workshop/channels/${CH}/messages`, { toAgentId: L.id, text: '总调度,请用一句话确认你在岗。', fromLabel: '馆长', priority: 'immediate', requireReply: true })
check('S1 消息受理', s1.code === 0, JSON.stringify(s1).slice(0, 60))
const s1Reply = await waitMsg(m => m.metadata?.['x-aw-in-reply-to'] === s1.data.messageId || (m.metadata?.['x-aw-to-label'] === '馆长' && (m.createdAt ?? '') > s1.data?.message?.createdAt), 180000, 'S1 回执')
check('S1 lead 回执(要求回复必有应答)', !!s1Reply, s1Reply ? textOf(s1Reply).slice(0, 60) : '')

// ═══ S2 用户→worker 直发(@worker 等价) ═══
console.log('━━ S2 用户→快手 直发(@worker) ━━')
const s2 = await api('POST', `/api/workshop/channels/${CH}/messages`, { toAgentId: W1.id, text: '快手,这条是馆长直接点名给你(经 @提及 锁定)。请回一句「快手在岗」,不要转给总调度。', fromLabel: '馆长', priority: 'immediate', requireReply: true })
check('S2 消息受理', s2.code === 0)
const s2Reply = await waitMsg(m => m.metadata?.['x-aw-in-reply-to'] === s2.data.messageId, 180000, 'S2 回执')
check('S2 worker 直气回执', !!s2Reply, s2Reply ? textOf(s2Reply).slice(0, 60) : '')

// ═══ S3 @worker 直派任务(assigneeId) ═══
console.log('━━ S3 任务直派 细笔(assigneeId) ━━')
const s3 = await api('POST', `/api/workshop/channels/${CH}/tasks`, { title: '细笔速记', parts: [{ text: '请用一行字写出今天日期与你的名字缩写,直接完成。' }], mode: 'goal', assigneeId: W2.id, modeConfig: { goalCriteria: '已输出一行日期与名字缩写' } })
const s3id = s3.data?.id ?? s3.data?.task?.id
check('S3 任务受理', !!s3id)
let s3done = null
const dl3 = Date.now() + 240000
while (Date.now() < dl3) {
  const j = await api('GET', `/api/workshop/channels/${CH}/tasks`)
  const arr = Array.isArray(j.data) ? j.data : j.data?.tasks ?? []
  s3done = arr.find(x => x.id === s3id)
  if (s3done && (s3done.state === 'COMPLETED' || s3done.state === 'FAILED')) break
  await sleep(6000)
}
check('S3 直派任务完成(不经 lead 拆解)', s3done?.state === 'COMPLETED', `state=${s3done?.state} assignee=${(s3done?.assigneeId ?? '').slice(0, 8) === W2.id.slice(0, 8) ? '细笔✓' : s3done?.assigneeId}`)
// 断言无 lead 拆解子任务
const s3all = (await api('GET', `/api/workshop/channels/${CH}/tasks`))
const s3arr = Array.isArray(s3all.data) ? s3all.data : s3all.data?.tasks ?? []
check('S3 无额外子任务(直达不拆解)', s3arr.filter(x => x.parentId === s3id).length === 0, `children=${s3arr.filter(x => x.parentId === s3id).length}`)

// ═══ S4 loop 模式限次 ═══
console.log('━━ S4 loop 限次任务 ━━')
const s4 = await api('POST', `/api/workshop/channels/${CH}/tasks`, { title: '循环点名', parts: [{ text: '每轮只回复一行:本轮完成。' }], mode: 'loop', assigneeId: W1.id, modeConfig: { intervalMs: 1000, maxIterations: 2 } })
const s4id = s4.data?.id ?? s4.data?.task?.id
check('S4 loop 受理', !!s4id)
let s4state = ''
const dl4 = Date.now() + 300000
while (Date.now() < dl4) {
  const j = await api('GET', `/api/workshop/channels/${CH}/tasks`)
  const arr = Array.isArray(j.data) ? j.data : j.data?.tasks ?? []
  s4state = arr.find(x => x.id === s4id)?.state ?? ''
  if (['COMPLETED', 'FAILED', 'CANCELED'].includes(s4state)) break
  await sleep(8000)
}
check('S4 loop 限次收口', s4state === 'COMPLETED' || s4state === 'CANCELED', `state=${s4state}`)

// ═══ S5 频道公共记忆 写入/去重 ═══
console.log('━━ S5 公共记忆 ━━')
await api('POST', `/api/workshop/channels/${CH}/messages`, { toAgentId: W1.id, text: '请把这条信息写入频道公共记忆(title=本店暗号,content=雪里青,用于对暗号)。写完不用回复。', fromLabel: '馆长', priority: 'immediate' })
let memHit = null
const dl5 = Date.now() + 150000
while (Date.now() < dl5 && !memHit) {
  const j = await api('GET', `/api/workshop/channels/${CH}/agents/${W1.id}/memories`)
  const arr = j.data ?? []
  const list = Array.isArray(arr) ? arr : arr?.memories ?? []
  memHit = list.find(x => JSON.stringify(x).includes('雪里青'))
  if (!memHit) await sleep(6000)
}
check('S5 记忆可检索', !!memHit, memHit ? JSON.stringify(memHit).slice(0, 80) : '')

// ═══ S6 跨频道 lead→lead ═══
console.log('━━ S6 跨频道通信 ━━')
const chB = (await api('POST', '/api/workshop/channels', { name: `分店-${tag}` })).data
const CHB = chB?.channelId ?? chB?.id
const leadB = (await api('POST', '/api/workshop/agents', { name: `分店调度-${tag}`, harness: 'omp', config: { intro: '分店', systemPromptPrefix: '你是分店频道总调度。中文简短交流。' } })).data
const teamB = (await api('POST', '/api/workshop/teams', { name: `分店剧组-${tag}` })).data
await api('POST', `/api/workshop/teams/${teamB.id ?? teamB?.team?.id}/members`, { agentId: leadB.id, role: 'lead' })
await api('POST', `/api/workshop/teams/${teamB.id ?? teamB?.team?.id}/deploy`, { channelId: CHB })
const instB = (await api('GET', `/api/workshop/channels/${CHB}/agents`)).data ?? []
const LB = instB.find(a => a.role === 'lead')
const s6 = await api('POST', `/api/workshop/channels/${CH}/messages`, { toChannelId: CHB, fromAgentId: L.id, text: '总调度,请用一句话向总店报到。', requireReply: true })
check('S6 跨频道受理(仅 lead)', s6.code === 0, JSON.stringify(s6).slice(0, 70))
const s6Reply = await waitMsg(m => m.metadata?.['x-aw-in-reply-to'] === s6.data?.messageId, 180000, 'S6 回信')
check('S6 对端回信(in_reply_to 关联)', !!s6Reply, s6Reply ? textOf(s6Reply).slice(0, 60) : '')

// ═══ S7 成员 disable/enable ═══
console.log('━━ S7 成员启停 ━━')
const d1 = await api('PATCH', `/api/workshop/channels/${CH}/agents/${W2.id}`, { enabled: 0 })
const list1 = (await api('GET', `/api/workshop/channels/${CH}/agents`)).data ?? []
const w2after = list1.find(a => a.id === W2.id)
check('S7 disable 生效', d1.code === 0 && w2after?.enabled === 0, `enabled=${w2after?.enabled}`)
const d2 = await api('PATCH', `/api/workshop/channels/${CH}/agents/${W2.id}`, { enabled: 1 })
const list2 = (await api('GET', `/api/workshop/channels/${CH}/agents`)).data ?? []
check('S7 enable 恢复', (list2.find(a => a.id === W2.id))?.enabled === 1)

console.log(`\n━━━ 场景矩阵: ${pass} pass / ${fail} fail ━━━`)
process.exit(fail > 0 ? 1 : 0)
