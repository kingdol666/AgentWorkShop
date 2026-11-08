#!/usr/bin/env node
/**
 * multi-harness-isolation-live.mjs —— 多 harness 实机适配 + Channel/Agent 对象隔离验收。
 *
 * 覆盖：
 *  1) mock/omp/dsh/codex/opencode 五引擎各建频道并 activate；
 *  2) 频道成员 lead/worker 的 agentId 跨频道唯一；
 *  3) 跨频道误用（A 频道 + B 成员）被拒；
 *  4) 关闭频道 A 不影响频道 B 的成员与可读性；
 *  5) 无 @ 的群聊消息 = 0 次 Agent 执行；
 *  6) 成员生命周期：disable → invoke 拒 → delete → 列表消失。
 *
 * 用法: node scripts/_audit/multi-harness-isolation-live.mjs --base http://127.0.0.1:4001
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = (arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:4001')).replace(/\/$/, '')
const EVID = resolve(arg('out', join(REPO, 'docs/audit/evidence/2026-11-08-full-acceptance')))
mkdirSync(EVID, { recursive: true })
const TAG = Date.now().toString(36)
const HARNESSES = ['mock', 'omp', 'dsh', 'codex', 'opencode']

let token = ''
const results = []
const agentIdOf = x => x?.agentId ?? x?.id ?? x?.agent?.agentId ?? x?.agent?.id
const step = (id, name, ok, detail = '') => {
  results.push({ id, name, pass: Boolean(ok), detail: String(detail ?? '').slice(0, 700) })
  console.log(`${ok ? '✔' : '✖'} [${id}] ${name}${ok ? '' : ` — ${String(detail ?? '').slice(0, 240)}`}`)
  return Boolean(ok)
}
async function api(method, path, body, timeoutMs = 90_000) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await res.json().catch(() => null)
  return { status: res.status, data: j?.data, code: j?.code, message: j?.message ?? '' }
}

const login = await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })
token = login.data?.token ?? ''
if (!step('H0', '登录 admin', Boolean(token), login.message)) { writeFileSync(join(EVID, 'harness-isolation.json'), JSON.stringify({ results, TAG }, null, 2)); process.exit(1) }

const created = []
for (const h of HARNESSES) {
  const c = await api('POST', '/api/workshop/channels', {
    name: `E2E-${h}-${TAG}`,
    scenarioPrompt: '多 harness 适配验收（自动清理）',
    leadAgent: { name: `lead-${h}-${TAG}`, harness: h },
  }, 120_000)
  const cid = c.data?.channelId
  step(`H1-${h}`, `创建频道 lead.harness=${h}`, c.status === 200 && Boolean(cid) && c.data?.leadAgentId, `status=${c.status} ${c.message}`)
  if (!cid) continue
  const act = await api('POST', `/api/workshop/channels/${cid}/activate`, {}, 120_000)
  const agents = await api('GET', `/api/workshop/channels/${cid}/agents`)
  const list = agents.data ?? []
  const lead = list.find(a => a.role === 'lead')
  step(`H2-${h}`, `activate + 成员可读（${h}）`, act.status === 200 && lead?.harness === h, `activate=${act.status} agents=${list.length} harness=${lead?.harness ?? '-'}`)
  const w = await api('POST', `/api/workshop/channels/${cid}/agents`, { name: `worker-${h}-${TAG}`, harness: h, role: 'worker' })
  step(`H3-${h}`, `创建 worker（${h}）`, w.status === 200 && Boolean(agentIdOf(w.data)), `status=${w.status} ${w.message}`)
  await api('PATCH', `/api/workshop/channels/${cid}`, { chatEnabled: 1 })
  created.push({ h, cid, leadId: c.data?.leadAgentId, workerId: agentIdOf(w.data) })
}

// 对象唯一性
const leadIds = created.map(x => x.leadId).filter(Boolean)
const workerIds = created.map(x => x.workerId).filter(Boolean)
step('H4', 'lead agentId 跨频道唯一', leadIds.length === HARNESSES.length && new Set(leadIds).size === HARNESSES.length, `${leadIds.length}/${HARNESSES.length}`)
step('H5', 'worker agentId 跨频道唯一', workerIds.length === HARNESSES.length && new Set(workerIds).size === HARNESSES.length, `${workerIds.length}/${HARNESSES.length}`)

// 跨频道误用
const a = created.find(x => x.h === 'mock')
const b = created.find(x => x.h === 'omp')
if (a && b) {
  const agentsA = (await api('GET', `/api/workshop/channels/${a.cid}/agents`)).data ?? []
  step('H6', 'A 频道成员列表不含 B 频道成员', agentsA.length > 0 && !agentsA.some(x => agentIdOf(x) === b.leadId || agentIdOf(x) === b.workerId), `A=${agentsA.length}`)
  const del = await api('DELETE', `/api/workshop/channels/${a.cid}/agents/${b.workerId}`)
  step('H7', 'A 频道删 B 成员被拒（非 2xx）', del.status >= 400, `status=${del.status} code=${del.code}`)
}

// 无 @ 消息 = 0 执行
if (a) {
  const msg = await api('POST', `/api/workshop/channels/${a.cid}/chat/messages`, { text: `无@消息隔离检查 ${TAG}`, clientMessageId: `iso-${TAG}` })
  const deliveries = msg.data?.deliveries ?? []
  const executed = deliveries.filter(d => d.status === 'pending' || d.status === 'delivered' || d.status === 'consumed')
  step('H8', '无 @ 的群聊消息 0 次 Agent 执行', msg.status === 200 && executed.length === 0, `deliveries=${deliveries.length} executed=${executed.length}`)
}

// 生命周期：disable → invoke 拒 → delete
if (a?.workerId) {
  const off = await api('PATCH', `/api/workshop/channels/${a.cid}/agents/${a.workerId}`, { enabled: 0 })
  const invRes = await fetch(`${base}/api/workshop/agent-tools/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
    body: JSON.stringify({ agentId: a.workerId, tool: 'line_context', args: {} }),
    signal: AbortSignal.timeout(60_000),
  })
  const invStatus = invRes.status
  const inv = await invRes.json().catch(() => null)
  step('H9', '停用成员后 invoke 被拒', off.status === 200 && (invStatus >= 400 || Boolean(inv?.data?.result?.isError)), `patch=${off.status} invoke=${invStatus} isError=${inv?.data?.result?.isError}`)
  const delW = await api('DELETE', `/api/workshop/channels/${a.cid}/agents/${a.workerId}`)
  const after = (await api('GET', `/api/workshop/channels/${a.cid}/agents`)).data ?? []
  step('H10', '删除成员后列表消失', delW.status === 200 && !after.some(x => agentIdOf(x) === a.workerId), `delete=${delW.status} left=${after.length}`)
}

// 清场隔离：关闭 A 不影响 B
if (a && b) {
  const delA = await api('DELETE', `/api/workshop/channels/${a.cid}`)
  const bAgents = (await api('GET', `/api/workshop/channels/${b.cid}/agents`)).data ?? []
  const bLead = bAgents.find(x => x.role === 'lead')
  step('H11', '关闭 A 后 B 成员仍 enabled=1', delA.status === 200 && bAgents.length > 0 && bLead?.enabled === 1, `delA=${delA.status} B=${bAgents.length}`)
}

// 清理其余频道（保留证据）
for (const x of created) {
  if (!x || x.cid === a?.cid) continue
  await api('DELETE', `/api/workshop/channels/${x.cid}`).catch(() => {})
}

const pass = results.filter(r => r.pass).length
const total = results.length
writeFileSync(join(EVID, 'harness-isolation.json'), JSON.stringify({ at: new Date().toISOString(), TAG, base, pass, total, results, created }, null, 2))
console.log(`\n${pass}/${total} assertions passed`)
process.exit(pass === total ? 0 : 1)
