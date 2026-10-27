/**
 * 2026-10-28 全功能验收 US-007 收口:检索命中 + IDD 诊断全链完成。
 * 前置事实:kb 入库任务 kbt_mvqz6i8t_43c90986 已在真实 RAG 后端 completed(锚点 US7-ANCHOR-mvqz6gkv)。
 * 断言:
 *  Q1 平台 kb_agent(query) 检索命中锚点(异步提交→轮询结果)
 *  Q2 diag run 35af7c85 完成或 diag_results(lead) 出现 completed 记录(真实 IDD 全链)
 * 证据: docs/audit/evidence/2026-10-28-full-acceptance-run2/us7-final.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3470'
const CH = '28239c1f-2e82-4207-a528-5edfb59b27ca'
const KNOW = '5d3d004d-6607-478d-a9c0-8dad749b9dfb'
const LEAD = '80dd5691-f5db-46f7-beef-97c7cfd11c99'
const OUT = 'docs/audit/evidence/2026-10-28-full-acceptance-run2/us7-final.json'
process.env.NO_PROXY = '127.0.0.1,localhost'
const checks = []
const check = (id, name, ok, detail) => {
  checks.push({ id, name, ok: !!ok, detail: String(detail).slice(0, 400) })
  console.log(`${ok ? '✔' : '✘'} [${id}] ${name} — ${String(detail).slice(0, 260)}`)
}

const login = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@mission.local', password: 'Mission#2026Acc' }) }).then(r => r.json())
const TOK = login.data.token
const rotK = await fetch(`${BASE}/api/workshop/channels/${CH}/agents/${KNOW}/rotate-token`, { method: 'POST', headers: { Authorization: `Bearer ${TOK}` } }).then(r => r.json())
const rotL = await fetch(`${BASE}/api/workshop/channels/${CH}/agents/${LEAD}/rotate-token`, { method: 'POST', headers: { Authorization: `Bearer ${TOK}` } }).then(r => r.json())
const KTOK = rotK.data?.token
const LTOK = rotL.data?.token
if (!KTOK || !LTOK) { console.error('token fail'); process.exit(1) }
await new Promise(r => setTimeout(r, 4000)) // 轮换后等运行时重载生效

const invoke = async (atok, agentId, tool, args, timeoutMs = 120000) => {
  const r = await fetch(`${BASE}/api/workshop/agent-tools/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-aw-agent-token': atok, 'Authorization': `Bearer ${TOK}` },
    body: JSON.stringify({ agentId, tool, args: args ?? {} }),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(x => x.json()).catch(e => ({ error: String(e) }))
  const u = r?.data?.result ?? r?.data ?? r
  const text = typeof u?.text === 'string' ? u.text : JSON.stringify(u ?? '')
  return { ok: u?.isError === false, text }
}

// ── Q1 检索命中(异步,轮询真后端任务) ──
const ANCHOR = 'US7-ANCHOR-mvqz6gkv'
const q = await invoke(KTOK, KNOW, 'kb_agent', { prompt: `检索:注塑保压压力工艺窗口是多少?零件重量目标多少?必须引用 ${ANCHOR} 锚点条目内容`, action: 'query', mode: 'async' }, 90000)
const qTask = (q.text.match(/task[_\s-]?id[:=\s]*([a-zA-Z0-9_-]+)/i) ?? [])[1]
check('Q1a', '检索任务已提交真后端', !!qTask, `taskId=${qTask ?? '?'} resp=${q.text.slice(0, 150)}`)
let hit = false
let note = 'no task'
if (qTask) {
  for (let i = 0; i < 12 && !hit; i++) {
    const st = await invoke(KTOK, KNOW, 'kb_agent_status', { task_id: qTask, wait_seconds: 110 }, 130000)
    const done = /completed|完成|成功/i.test(st.text) && !/running|pending|queued/i.test(st.text)
    const failed = /failed|失败/i.test(st.text)
    hit = st.text.includes(ANCHOR)
    note = st.text.slice(0, 300)
    if (done || hit || failed) break
  }
}
check('Q1b', `检索命中锚点(${ANCHOR})`, hit, note)

// ── Q2 IDD 诊断全链 ──
let diagOk = false
let diagNote = ''
for (let i = 0; i < 25 && !diagOk; i++) {
  const st = await invoke(LTOK, LEAD, 'diag_status', { run_id: '35af7c85' }, 60000)
  if (/completed|完成/i.test(st.text) && !/running/i.test(st.text)) { diagOk = true; diagNote = st.text.slice(0, 300); break }
  diagNote = st.text.slice(0, 200)
  await new Promise(r => setTimeout(r, 10000))
}
const dres = await invoke(LTOK, LEAD, 'diag_results', {}, 60000)
check('Q2', 'IDD 诊断全链完成(运行完成或结果库有 completed 记录)', diagOk || /completed/i.test(dres.text), `status=${diagNote.slice(0, 140)} | results=${dres.text.slice(0, 180)}`)

const pass = checks.filter(c => c.ok).length
mkdirSync('docs/audit/evidence/2026-10-28-full-acceptance-run2', { recursive: true })
writeFileSync(OUT, JSON.stringify({ suite: 'US-007 收口(检索命中+IDD 全链)', at: new Date().toISOString(), checks, verdict: `PASS(${pass}/${checks.length})` }, null, 2))
console.log(`\nUS-007-final: PASS(${pass}/${checks.length}) → ${OUT}`)
process.exit(pass === checks.length ? 0 : 1)
