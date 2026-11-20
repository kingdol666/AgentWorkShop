// tsa5 round — C2/C3 resume with HUMAN-OVERRIDE semantics.
// Context: the agent chain independently concluded the current point (64/6.5, batch rr-a03144c0
// started at recipe v2) is fully in-band and recommended NO tuning (evidence-based pushback —
// correct engineering behavior). The acceptance round still needs the governed-write path proven
// on this build, so the human issues an explicit, accountable override (test semantics): a minimal
// in-limit step, approved with the override acknowledged on the card. This exercises:
//   agent pushback preserved in the record → human authority → HITL approval → dispatch → readback.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-21-tsa5-v0140-round')
mkdirSync(EV, { recursive: true })
const PRIVATE = 'D:/tmp/aw-liv5-1121'
const BASE = 'http://127.0.0.1:3021'
const TOKEN = JSON.parse(readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8')).admin
const CH = '4bbf5d97-b677-499f-abaf-9698ac76a234'
const LEAD = 'ec2758d0-53cc-41ff-8a98-e64a812dfa75'
const statePath = join(PRIVATE, 'tsa5-c-state.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
const persist = () => writeFileSync(statePath, JSON.stringify(state, null, 1))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const save = (name, obj) => writeFileSync(join(EV, name), JSON.stringify(obj, null, 1))
const log = (m) => console.log(`[tsa5-c23] ${m}`)

async function api(method, path, body, token, timeoutMs = 60_000) {
  let r
  try {
    r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) { return { status: 0, json: { raw: `network-error:${e.cause?.code ?? e.name}` } } }
  const text = await r.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 300) } }
  return { status: r.status, json }
}

async function sendWork(text) {
  const bodyPath = join(PRIVATE, 'c-msg.json')
  writeFileSync(bodyPath, JSON.stringify({ toAgentId: LEAD, text, priority: 'immediate', requireReply: true }))
  const r = await fetch(`${BASE}/api/workshop/channels/${CH}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: readFileSync(bodyPath),
    signal: AbortSignal.timeout(60_000),
  })
  return { status: r.status }
}

async function waitReply(sinceMs, timeoutMs = 14 * 60_000) {
  const t0 = Date.now()
  for (;;) {
    const list = (await api('GET', `/api/workshop/channels/${CH}/messages?limit=40`, undefined, TOKEN)).json?.data ?? []
    const items = Array.isArray(list) ? list : (list.items ?? [])
    const rep = items.find(m => Date.parse(m.createdAt ?? '') > sinceMs && m.fromAgentId === LEAD && (m.parts ?? []).some(p => String(p.text ?? '').length > 30))
    if (rep) return rep
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(15_000)
  }
}
const replyText = (rep, cap = 2000) => rep ? { at: rep.createdAt, text: (rep.parts ?? []).map(p => p.text ?? '').join('\n').slice(0, cap) } : { timeout: true }

async function waitDcwCard(timeoutMs = 12 * 60_000) {
  const t0 = Date.now()
  for (;;) {
    const p = await api('GET', `/api/workshop/hitl/pending?channelId=${CH}`, undefined, TOKEN)
    const card = (p.json?.data?.items ?? []).find(i => i.kind === 'dcw-approval')
    if (card) return card
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(10_000)
  }
}

const OVERRIDE_NOTE = '人工显式 override(测试语义):已知悉你们的「保持不动/带内」建议且予以记录;本步为最小步且在步限量程内,工艺无害,验收轮需要证实治理写路径。此决定责任在人工(我),不是对你们分析的否定。'

async function runStep(key, label, node, deltaText, readNode) {
  if (state[key]) { log(`${label} already done`); return }
  const sent = await sendWork(`【${label}】验收轮治理写路径验证(人工 override,测试语义):${OVERRIDE_NOTE} 请执行:${deltaText}。走配方审批提交方案,方案依据请如实写明「带内保持建议已被人工知情 override」。等我批准;获批后回报审批单号、下发与设备回读值。只允许这一个参数这一步。`)
  const sentAt = Date.now()
  save(`${key}-sent.json`, { status: sent.status, sentAt: new Date(sentAt).toISOString(), overrideNote: OVERRIDE_NOTE })
  const card = await waitDcwCard(12 * 60_000)
  if (!card) { save(`${key}-ABORT.json`, { error: 'no card after override instruction' }); throw new Error(`${label} 无审批卡`) }
  save(`${key}-card.json`, card)
  const decide = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, cancelled: false, choice: 0, comment: `${OVERRIDE_NOTE}(审批人:验收轮 owner)` }, TOKEN)
  save(`${key}-decide.json`, { status: decide.status })
  const rep = await waitReply(sentAt, 16 * 60_000)
  save(`${key}-reply.json`, replyText(rep))
  await sleep(4000)
  const rb = await api('POST', `/api/workshop/dcw/${readNode}/read`, {}, TOKEN)
  save(`${key}-readback.json`, rb.json)
  state[key] = { card: card.id, decide: decide.status, replied: Boolean(rep), readback: rb.json?.data?.read?.value }
  persist()
  log(`${label} 完成 card=${card.id} readback=${state[key].readback}`)
}

// R1: 保压压力SP +1 (device current per lead's re-read; step limit 2)
await runStep('c2', '闭环调参 R1(TSA5·override)', 'dw-3495bb89', '把「保压压力SP」在**设备实读当前值**基础上 +1MPa(步限 2 内)', 'dw-3495bb89')
// R2: 保压时间SP +0.5 (device current 7 → 7.5, within [2,8], step 0.5)
await runStep('c3', '闭环调参 R2(TSA5·override)', 'dw-852f4e0f', '把「保压时间SP」在**设备实读当前值**基础上 +0.5s(步限 0.5 内)', 'dw-852f4e0f')

console.log('TSA5-C23-RESULT ' + JSON.stringify({ c2: state.c2, c3: state.c3 }))
