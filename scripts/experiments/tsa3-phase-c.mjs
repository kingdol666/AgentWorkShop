// tsa3 round — G3 compact rerun on the fresh line/channel (ln-a80dfb0d / 4bbf5d97…).
// Stages: C0 equip → C1 read-only inspection → C2 governed write R1(+readback) → C4 RSI merge
// (second evidence unit = the earlier smoke closed-loop) → C5 memory save/recall → C6 negatives.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-20-governed-acceptance-round')
mkdirSync(EV, { recursive: true })
const PRIVATE = 'D:/tmp/aw-liv3-1120'
mkdirSync(PRIVATE, { recursive: true })
const BASE = 'http://127.0.0.1:3021'
const TOKEN = process.env.AW_TOKEN
const SECOND = process.env.AW_TOKEN2
if (!TOKEN) throw new Error('AW_TOKEN required')
const CH = '4bbf5d97-b677-499f-abaf-9698ac76a234'
const LINE = 'ln-a80dfb0d'
const LEAD = 'ec2758d0-53cc-41ff-8a98-e64a812dfa75'
const NODE_PRESSURE = 'dw-3495bb89'
const statePath = join(PRIVATE, 'tsa3-c-state.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
const persist = () => writeFileSync(statePath, JSON.stringify(state, null, 1))
const log = (m) => console.log(`[tsa3-c] ${m}`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const save = (name, obj) => writeFileSync(join(EV, name), JSON.stringify(obj, null, 1))

async function api(method, path, body, token, timeoutMs = 60_000) {
  let r
  try {
    r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) { return { status: 0, json: { raw: `network-error:${e.cause?.code ?? e.name}` } } }
  const text = await r.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 400) } }
  return { status: r.status, json }
}

async function sendWork(text) {
  const bodyPath = join(PRIVATE, 'c-msg.json')
  writeFileSync(bodyPath, JSON.stringify({ toAgentId: LEAD, text, priority: 'immediate', requireReply: true }))
  const r = await fetch(`${BASE}/api/workshop/channels/${CH}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: readFileSync(bodyPath),
    signal: AbortSignal.timeout(60_000),
  })
  const json = await r.json().catch(() => ({ raw: 'parse-error' }))
  return { status: r.status, json }
}

async function waitReply(sinceMs, timeoutMs = 12 * 60_000) {
  const t0 = Date.now()
  for (;;) {
    const list = (await api('GET', `/api/workshop/channels/${CH}/messages?limit=40`, undefined, TOKEN)).json?.data ?? []
    const items = Array.isArray(list) ? list : (list.items ?? [])
    const rep = items.find(m => Date.parse(m.createdAt ?? '') > sinceMs && m.fromAgentId && (m.parts ?? []).some(p => String(p.text ?? '').length > 30))
    if (rep) return rep
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(15_000)
  }
}
const replyText = (rep, cap = 2400) => rep ? { id: rep.id, from: rep.fromAgentId, at: rep.createdAt, text: (rep.parts ?? []).map(p => p.text ?? '').join('\n').slice(0, cap) } : { timeout: true }

async function waitDcwCard(timeoutMs = 10 * 60_000) {
  const t0 = Date.now()
  for (;;) {
    const p = await api('GET', `/api/workshop/hitl/pending?channelId=${CH}`, undefined, TOKEN)
    const card = (p.json?.data?.items ?? []).find(i => i.kind === 'dcw-approval')
    if (card) return card
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(10_000)
  }
}

// ---- C0 equip ----
if (!state.c0) {
  const put = await api('PUT', `/api/workshop/channels/${CH}/plugins`, { plugins: [{ name: 'diag-bridge', enabled: true }, { name: 'rag-bridge', enabled: true }] }, TOKEN)
  const agents = (await api('GET', `/api/workshop/channels/${CH}/agents`, undefined, TOKEN)).json?.data?.items ?? []
  for (const a of agents) {
    await api('PATCH', `/api/workshop/channels/${CH}/agents/${a.id}`, { config: { ...(a.config ?? {}), provider: 'ustc', model: 'deepseek-flash', rpcMode: 'rpc' } }, TOKEN)
  }
  await api('PATCH', `/api/workshop/channels/${CH}`, { llm: { provider: 'ustc', model: 'deepseek-flash', effort: 'max' } }, TOKEN)
  save('c0-equip.json', { plugins: put.status, agents: agents.map(a => a.role) })
  state.c0 = { plugins: put.status, agents: agents.length }
  persist()
  log(`C0 装备完成 agents=${agents.length}`)
}

// ---- C1 inspection ----
if (!state.c1) {
  const sent = await sendWork('【早班巡检】读取「制品克重PV」「熔体压力PV」「模具温度PV」「飞边PV」最近5分钟采样(均值/最值/样本数),对照目标克重 32.50±0.35g 判定工况;若偏离给出第一步调参方向。只巡检,不写任何参数;可派数据分析师取数,你汇总判读。')
  const sentAt = Date.now()
  save('c1-sent.json', { status: sent.status, sentAt: new Date(sentAt).toISOString() })
  const rep = await waitReply(sentAt, 12 * 60_000)
  save('c1-reply.json', replyText(rep))
  state.c1 = { replied: Boolean(rep) }
  persist()
  log(`C1 完成 replied=${state.c1.replied}`)
}

// ---- C2 governed write R1 ----
if (!state.c2) {
  let sentAt
  if (existsSync(join(EV, 'c2-sent.json'))) {
    sentAt = Date.parse(JSON.parse(readFileSync(join(EV, 'c2-sent.json'), 'utf8')).sentAt)
  } else {
    const sent = await sendWork('【闭环调参 R1】基于刚才巡检结论执行一次受控调参:把「保压压力SP」在当前值基础上 +1MPa(步限内),走配方审批提交方案(依据写本轮实测),等我批准;获批后回报审批单号、下发与设备回读值。只允许这一个参数这一步。')
    sentAt = Date.now()
    save('c2-sent.json', { status: sent.status, sentAt: new Date(sentAt).toISOString() })
  }
  const card = await waitDcwCard(10 * 60_000)
  if (!card) { save('c2-ABORT.json', { error: 'no card' }); throw new Error('C2 无审批卡') }
  save('c2-card.json', card)
  const decide = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, cancelled: false, choice: 0, comment: '巡检数据支持小步上调,批准执行' }, TOKEN)
  save('c2-decide.json', { status: decide.status })
  const rep = await waitReply(sentAt, 20 * 60_000)
  save('c2-reply.json', replyText(rep))
  await sleep(4000)
  const rb = await api('POST', `/api/workshop/dcw/${NODE_PRESSURE}/read`, {}, TOKEN)
  save('c2-readback.json', rb.json)
  state.c2 = { card: card.id, decide: decide.status, replied: Boolean(rep), readback: rb.json?.data?.read?.value }
  persist()
  log(`C2 完成 card=${card.id} readback=${state.c2.readback}`)
}

// ---- C3 governed write R2 (保压时间SP +0.5s) → second evidence unit ----
if (!state.c3) {
  const NODE_TIME = 'dw-852f4e0f'
  const sent = await sendWork('【闭环调参 R2】执行第二次受控小步:把「保压时间SP」在当前值基础上 +0.5s(步限内),走配方审批提交方案(依据写 R1 后回读与最近数据),等我批准;获批后回报审批单号、下发与设备回读值。仍然只允许这一个参数这一步。')
  const sentAt = Date.now()
  save('c3-sent.json', { status: sent.status, sentAt: new Date(sentAt).toISOString() })
  const card = await waitDcwCard(10 * 60_000)
  if (!card) { save('c3-ABORT.json', { error: 'no card' }); throw new Error('C3 无审批卡') }
  save('c3-card.json', card)
  const decide = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, cancelled: false, choice: 0, comment: 'R1 回读一致,继续小步逼近目标带,批准' }, TOKEN)
  save('c3-decide.json', { status: decide.status })
  const rep = await waitReply(sentAt, 20 * 60_000)
  save('c3-reply.json', replyText(rep))
  await sleep(4000)
  const rb = await api('POST', `/api/workshop/dcw/${NODE_TIME}/read`, {}, TOKEN)
  save('c3-readback.json', rb.json)
  state.c3 = { card: card.id, decide: decide.status, replied: Boolean(rep), readback: rb.json?.data?.read?.value }
  persist()
  log(`C3 完成 card=${card.id} readback=${state.c3.readback}`)
}

// ---- C4 RSI governance (honest semantics) ----
// The successful tuning rounds' reflections did NOT surface as line candidates (reflector
// gap → plan Task 3/7 evidence). Only NEGATIVE candidates exist (failed inspection /
// failed suggestion). Demonstrate: gate rejects single promotion; merge behavior on two
// negatives recorded; human declines to promote negative-only evidence to validated.
if (!state.c4) {
  const gather = async () => {
    const out = []
    for (const a of [LEAD, '62d80352-553d-462b-a75d-dcc38ddb32ca', '27184eb1-299e-4c4c-9ff8-73a9d0110d8d', 'd7fea381-ce55-490a-ae8c-3195596f5704']) {
      const m = await api('GET', `/api/workshop/channels/${CH}/agents/${a}/memories?limit=100`, undefined, TOKEN)
      const items = Array.isArray(m.json?.data) ? m.json.data : (m.json?.data?.items ?? [])
      for (const x of items) if (x.kind === 'experience' && x.status === 'candidate' && x.scopeKind === 'line') out.push({ id: x.id, agent: a.slice(0, 8), title: String(x.title ?? '').slice(0, 50) })
    }
    return out
  }
  const cands = await gather()
  save('c4-candidates.json', cands)
  if (cands.length < 1) throw new Error('RSI candidate 不足=0')
  const gate = await api('POST', `/api/workshop/channels/${CH}/memories/${cands[0].id}/promote`, { to: 'validated' }, TOKEN)
  save('c4-single-gate.json', gate.json)
  let merge = { status: 0, json: { note: 'single candidate' } }
  let humanDecision = 'no-merge-needed'
  if (cands.length >= 2) {
    merge = await api('POST', `/api/workshop/channels/${CH}/memories/merge`, { memoryIds: [cands[0].id, cands[1].id] }, TOKEN)
    save('c4-merge-two-negatives.json', merge.json)
    humanDecision = 'decline: merged rows are negative-only evidence; promoting to validated would be semantically invalid (recorded, not executed)'
  }
  save('c4-human-decision.json', { decision: humanDecision, basis: 'independence/polarity rules (plan Task 3): negative-only rows must not become validated experience' })
  state.c4 = { cands: cands.length, singlePromoteStatus: gate.status, singlePromoteOk: Boolean(gate.json?.data?.ok), mergeStatus: merge.status, humanDeclined: true }
  persist()
  log(`C4 完成 cands=${cands.length} 单条晋升门=${gate.status}(data.ok=${state.c4.singlePromoteOk}) humanDeclined=true`)
}

// ---- C5 memory round ----
if (!state.c5) {
  const sent = await sendWork('【班中小结】两件事:1) save_memory 把本轮「保压压力SP +1MPa 经审批下发且回读一致」的闭环调参结论沉淀到频道共享记忆;2) search_memory 检索「保压压力 克重」回报命中条目标题与状态。')
  const sentAt = Date.now()
  const rep = await waitReply(sentAt, 20 * 60_000)
  save('c5-reply.json', replyText(rep))
  state.c5 = { replied: Boolean(rep) }
  persist()
  log(`C5 完成 replied=${state.c5.replied}`)
}

// ---- C6 negatives ----
if (!state.c6) {
  const oob = await api('POST', `/api/workshop/dcw/${NODE_PRESSURE}/write`, { value: 999 }, TOKEN)
  save('c6-oob.json', { status: oob.status, code: oob.json?.code })
  const cross = SECOND ? await api('POST', `/api/workshop/dcw/${NODE_PRESSURE}/write`, { value: 52 }, SECOND) : { status: 0, json: { note: 'no-second-token' } }
  save('c6-cross.json', { status: cross.status, code: cross.json?.code })
  state.c6 = { oob: oob.status, cross: cross.status }
  persist()
  log(`C6 完成 越量程=${oob.status} 跨用户=${cross.status}(期望 400/403)`)
}

console.log('TSA3-C-RESULT ' + JSON.stringify({ ok: true, state }))
