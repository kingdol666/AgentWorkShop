/**
 * 2026-10-28 全功能验收 US-006 证据:Channel 真实团队作业对话摘录。
 * 证据: docs/audit/evidence/2026-10-28-full-acceptance-run2/us6-channel-dialog.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3470'
const CH = '28239c1f-2e82-4207-a528-5edfb59b27ca'
const OUT = 'docs/audit/evidence/2026-10-28-full-acceptance-run2/us6-channel-dialog.json'
process.env.NO_PROXY = '127.0.0.1,localhost'
const login = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@mission.local', password: 'Mission#2026Acc' }) }).then(r => r.json())
const TOK = login.data.token
const res = await fetch(`${BASE}/api/workshop/channels/${CH}/messages?limit=200`, { headers: { Authorization: `Bearer ${TOK}` } }).then(r => r.json())
const ms = Array.isArray(res.data) ? res.data : []
const agents = await fetch(`${BASE}/api/workshop/channels/${CH}/agents`, { headers: { Authorization: `Bearer ${TOK}` } }).then(r => r.json())
const nameOf = id => (agents.data ?? []).find(a => a.id === id)?.name ?? (id ? id.slice(0, 8) : 'user')
// 摘录:含工具调用/决策/数据引用的代表性消息(每 agent 取最长的 2 条)
const byAgent = {}
for (const m of ms) {
  const who = nameOf(m.fromAgentId)
  const text = (m.parts ?? []).map(p => p.text ?? '').join(' ')
  if (!text.trim()) continue
  byAgent[who] = byAgent[who] ?? []
  byAgent[who].push({ at: m.createdAt, len: text.length, text: text.slice(0, 700) })
}
const excerpts = {}
for (const [who, list] of Object.entries(byAgent)) {
  list.sort((a, b) => b.len - a.len)
  excerpts[who] = { count: list.length, samples: list.slice(0, 2) }
}
const toolMentions = ms.filter(m => /recipe_trial|daq_query|dcw_control|kb_agent|diag_run|recipe_update/.test((m.parts ?? []).map(p => p.text ?? '').join(' '))).length
const out = {
  suite: 'US-006 Channel 场景任务(真实 omp 团队)',
  channel: CH, at: new Date().toISOString(),
  totalMessages: ms.length,
  toolInvocationMentions: toolMentions,
  perAgent: Object.fromEntries(Object.entries(exceptsFix(excerpts))),
}
function exceptsFix(x) { return Object.entries(x) }
mkdirSync('docs/audit/evidence/2026-10-28-full-acceptance-run2', { recursive: true })
writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`msgs=${ms.length} toolMentions=${toolMentions} agents=${Object.keys(byAgent).join(',')}`)
console.log(`→ ${OUT}`)
