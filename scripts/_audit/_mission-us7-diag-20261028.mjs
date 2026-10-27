/**
 * US-007 补证:IDD 升级后发起 quick-screen 诊断并等到 completed(真实报告入结果库)。
 * 证据: docs/audit/evidence/2026-10-28-full-acceptance-run2/us7-diag-completed.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3470'
const CH = '28239c1f-2e82-4207-a528-5edfb59b27ca'
const LEAD = '80dd5691-f5db-46f7-beef-97c7cfd11c99'
const OUT = 'docs/audit/evidence/2026-10-28-full-acceptance-run2/us7-diag-completed.json'
process.env.NO_PROXY = '127.0.0.1,localhost'
const login = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@mission.local', password: 'Mission#2026Acc' }) }).then(r => r.json())
const TOK = login.data.token
const rot = await fetch(`${BASE}/api/workshop/channels/${CH}/agents/${LEAD}/rotate-token`, { method: 'POST', headers: { Authorization: `Bearer ${TOK}` } }).then(r => r.json())
const LTOK = rot.data?.token
await new Promise(r => setTimeout(r, 4000))
const invoke = async (tool, args, timeoutMs = 120000) => {
  const r = await fetch(`${BASE}/api/workshop/agent-tools/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-aw-agent-token': LTOK, 'Authorization': `Bearer ${TOK}` },
    body: JSON.stringify({ agentId: LEAD, tool, args }),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(x => x.json()).catch(e => ({ error: String(e) }))
  const u = r?.data?.result ?? r?.data ?? r
  return { ok: u?.isError !== true, text: typeof u?.text === 'string' ? u.text : JSON.stringify(u ?? '') }
}
const dg = await invoke('diag_run', { line: 'ln-e27a1867', analysis_intent: 'quick-screen', question: '注塑线快速质量筛查:克重/飞边/缩痕当前状态' }, 150000)
const runId = (dg.text.match(/run[_\s-]?id[:=\s]*([a-zA-Z0-9_-]+)/i) ?? [])[1]
console.log('dispatched runId=', runId, dg.text.slice(0, 120))
let done = false
let note = dg.text.slice(0, 200)
if (runId) {
  for (let i = 0; i < 60 && !done; i++) {
    await new Promise(r => setTimeout(r, 10000))
    const st = await invoke('diag_status', { run_id: runId }, 60000)
    if (/completed|完成/i.test(st.text) && !/running|queued|pending/i.test(st.text)) { done = true; note = st.text.slice(0, 500) }
    else note = st.text.slice(0, 200)
  }
}
mkdirSync('docs/audit/evidence/2026-10-28-full-acceptance-run2', { recursive: true })
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), runId, completed: done, note }, null, 2))
console.log(`completed=${done} → ${OUT}`)
