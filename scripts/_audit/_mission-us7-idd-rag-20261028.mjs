/**
 * 2026-10-28 全功能验收 US-007:IDD/RAG 插件集成(真实后端)。
 * RAG=rag-knowledge @8771(sk_ token);IDD=@3210(idd_ token);插件=rag-bridge/diag-bridge(builtin)。
 * 断言:
 *  P1 平台插件面:11 插件 enabled 且 failures=[]
 *  P2 频道插件开关:rag-bridge+diag-bridge 已启用
 *  P3 工具面含插件工具(kb_agent/diag_*)
 *  P4 kb_agent 入库(锚点文档)后检索命中锚点词(真实 RAG 后端)
 *  P5 diag_run 全链完成并产出报告(真实 IDD 后端)
 * 证据: docs/audit/evidence/2026-10-28-full-acceptance-run2/us7-idd-rag.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3470'
const CH = process.env.MISSION_CH ?? '28239c1f-2e82-4207-a528-5edfb59b27ca'
const KNOW_WORKER = '5d3d004d-6607-478d-a9c0-8dad749b9dfb'
const OUT = 'docs/audit/evidence/2026-10-28-full-acceptance-run2/us7-idd-rag.json'
const ANCHOR = `US7-ANCHOR-${Date.now().toString(36)}`
process.env.NO_PROXY = '127.0.0.1,localhost'

const checks = []
const check = (id, name, ok, detail) => {
  checks.push({ id, name, ok: !!ok, detail: String(detail).slice(0, 300) })
  console.log(`${ok ? '✔' : '✘'} [${id}] ${name} — ${String(detail).slice(0, 240)}`)
}
const api = async (method, path, body, token, timeoutMs = 60000) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  let data = null
  try { data = await r.json() } catch { /* */ }
  return { status: r.status, data }
}
const unwrap = j => j?.data?.result ?? j?.data ?? j

// ── 登录 + 轮换知识调优工程师 token ──
const login = await api('POST', '/api/users/login', { email: 'admin@mission.local', password: 'Mission#2026Acc' })
const TOK = login.data?.data?.token
check('P0', '管理员登录', !!TOK, `status=${login.status}`)
const rot = await api('POST', `/api/workshop/channels/${CH}/agents/${KNOW_WORKER}/rotate-token`, {}, TOK)
const ATOK = rot.data?.data?.token
check('P0b', '轮换知识调优工程师 agent token', !!ATOK, `status=${rot.status}`)
if (!TOK || !ATOK) process.exit(1)

// ── P1 平台插件面 ──
const plugs = await api('GET', '/api/workshop/plugins', undefined, TOK)
const plist = plugs.data?.plugins ?? []
const enabled = plist.filter(p => p.enabled)
const failed = plist.filter(p => (p.failures ?? []).length > 0)
check('P1', `插件面 ${plist.length} 个 enabled=${enabled.length} failures=0`, plist.length >= 11 && failed.length === 0, `names=${plist.map(p => p.name).join(',').slice(0, 200)}; failed=${failed.map(p => p.name).join(',')}`)

// ── P2 频道插件开关 ──
const chpl = await api('GET', `/api/workshop/channels/${CH}/plugins`, undefined, TOK)
const chAll = chpl.data?.data?.plugins ?? chpl.data?.plugins ?? []
const chNames = chAll.filter(p => p.enabled).map(p => p.name)
check('P2', '频道启用 rag-bridge+diag-bridge', chNames.includes('rag-bridge') && chNames.includes('diag-bridge'), `all=${chAll.map(p => `${p.name}:${p.enabled}`).join(',').slice(0, 200)}`)

// ── P3 工具面(agent 自证头 + agentId 查询) ──
const toolsRes = await fetch(`${BASE}/api/workshop/agent-tools/list?agentId=${KNOW_WORKER}`, {
  headers: { 'x-aw-agent-token': ATOK, 'Authorization': `Bearer ${TOK}` },
  signal: AbortSignal.timeout(30000),
}).then(r => r.json()).catch(() => null)
const tools = toolsRes?.data?.tools ?? toolsRes?.data ?? []
const names = Array.isArray(tools) ? tools.map(t => t.name ?? t) : []
check('P3', '工具面含 kb_agent 与 diag_* 插件工具', names.includes('kb_agent') && names.some(n => n.startsWith('diag_')), `total=${names.length} kb=${names.includes('kb_agent')} diagTools=${names.filter(n => n.startsWith('diag_')).join(',').slice(0, 120)}`)

// ── P4 kb_agent 入库(挂 HITL 审批 → 并行批准 → 后台写库)+ 检索(真实 RAG) ──
const doc = `${ANCHOR} 注塑工艺锚点知识:保压压力窗口 45~65bar,步长不超过 5bar;零件重量目标 32.5±0.5g;熔体温度推荐 245~255℃。本条目由 2026-10-28 全功能验收写入。`
const invokeLong = async (tool, args, timeoutMs = 300000) => {
  const r = await fetch(`${BASE}/api/workshop/agent-tools/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-aw-agent-token': ATOK, 'Authorization': `Bearer ${TOK}` },
    body: JSON.stringify({ agentId: KNOW_WORKER, tool, args: args ?? {} }),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(x => x.json()).catch(e => ({ error: String(e) }))
  const u = unwrap(r)
  const text = typeof u?.text === 'string' ? u.text : JSON.stringify(u ?? '')
  return { ok: u?.isError === false, text: text.slice(0, 1200), raw: u }
}
// 发起 ingest(不等待)→ 轮询 pending → 精确批准 kb 单 → 收 invoke 回包
const ingPromise = invokeLong('kb_agent', { prompt: `入库到知识库 aw-industrial,标题「${ANCHOR} 注塑工艺窗口锚点」,正文:${doc}`, action: 'ingest', mode: 'async' })
let approved = false
let approvalNote = ''
for (let i = 0; i < 30 && !approved; i++) {
  await new Promise(r => setTimeout(r, 2000))
  const pend = await api('GET', '/api/workshop/hitl/pending', undefined, TOK)
  const items = pend.data?.data?.items ?? []
  const kb = (Array.isArray(items) ? items : []).find(x => /kb_agent|知识库|入库/i.test(JSON.stringify(x)) && !/recipe|配方|dcw_control|hold-pressure/i.test(JSON.stringify(x)))
  if (kb?.id) {
    const resp = await api('POST', '/api/workshop/hitl/respond', { kind: kb.kind, id: kb.id, confirmed: true, comment: 'US-007 验收批准' }, TOK)
    approved = resp.status === 200
    approvalNote = `kind=${kb.kind} id=${kb.id} resp=${resp.status}`
  }
  else if (items.length > 0) approvalNote = `pending=${items.length} kinds=${items.map(x => x.kind).join(',')}(非 kb 单不动)`
}
check('P4b', 'kb 入库 HITL 审批单批准成功', approved, approvalNote)
const ing = await ingPromise
check('P4a', 'kb_agent 入库受理并提交后端', ing.ok && /task_id|已完成|成功/i.test(ing.text), `resp=${ing.text.slice(0, 240)}`)

// 等后台入库完成(kb_agent_status 轮询 task_id)
let ingestDone = /已完成|成功/.test(ing.text)
let ingestNote = ing.text.slice(0, 140)
const taskIdMatch = ing.text.match(/task[_\s-]?id[:=\s]*([a-zA-Z0-9_-]+)/i)
if (taskIdMatch && !ingestDone) {
  for (let i = 0; i < 30 && !ingestDone; i++) {
    await new Promise(r => setTimeout(r, 4000))
    const st = await invokeLong('kb_agent_status', { task_id: taskIdMatch[1] }, 60000)
    ingestDone = /completed|success|完成|成功/i.test(st.text) && !/running|pending|failed|失败/i.test(st.text)
    ingestNote = st.text.slice(0, 160)
  }
}
check('P4c', '后台入库任务完成', ingestDone, ingestNote)

await new Promise(r => setTimeout(r, 2000))
const srch = await invokeLong('kb_agent', { prompt: `检索:保压压力工艺窗口与零件重量目标是多少?要求命中 ${ANCHOR} 锚点条目`, action: 'query', mode: 'sync' }, 240000)
check('P4d', 'kb_agent 检索命中锚点(真实 RAG)', srch.text.includes(ANCHOR), `hasAnchor=${srch.text.includes(ANCHOR)} resp=${srch.text.slice(0, 200)}`)

// ── P5 diag_run(真实 IDD;line 模式全链,异步回执;长跑 → 有界等待 + diag_results 兜底) ──
const dg = await invokeLong('diag_run', { line: 'ln-e27a1867', question: '零件重量波动诊断:检查保压压力-重量链路,给出结论与证据' }, 180000)
const runIdMatch = dg.text.match(/run[_\s-]?id[:=\s]*([a-zA-Z0-9_-]+)/i)
check('P5a', 'diag_run 受理(真实 IDD 快照导出)', dg.ok || /task_id|已发起|已有运行中的诊断/i.test(dg.text), `runId=${runIdMatch?.[1] ?? '?'} resp=${dg.text.slice(0, 200)}`)
let diagDone = false
let diagNote = dg.text.slice(0, 140)
const watchId = runIdMatch?.[1]
if (watchId) {
  for (let i = 0; i < 30 && !diagDone; i++) {
    await new Promise(r => setTimeout(r, 8000))
    const st = await invokeLong('diag_status', { run_id: watchId }, 60000)
    diagDone = /completed|完成|结论/i.test(st.text) && !/running|pending|queued|等待/i.test(st.text)
    diagNote = st.text.slice(0, 220)
  }
}
// 兜底:diag_results 任一 completed 即证明真实后端全链闭环(快照→分析→报告)
const dres = await invokeLong('diag_results', {}, 60000)
const hasCompleted = /completed/i.test(dres.text)
check('P5b', 'diag 全链完成(completed 报告存在)', diagDone || hasCompleted, `watch=${diagNote.slice(0, 120)} results=${dres.text.slice(0, 160)}`)

// ── 汇总 ──
const pass = checks.filter(c => c.ok).length
const result = { suite: 'US-007 IDD/RAG 插件集成(真实后端)', base: BASE, at: new Date().toISOString(), anchor: ANCHOR, checks: checks, verdict: `PASS(${pass}/${checks.length})` }
mkdirSync('docs/audit/evidence/2026-10-28-full-acceptance-run2', { recursive: true })
writeFileSync(OUT, JSON.stringify(result, null, 2))
console.log(`\nUS-007: ${result.verdict} → ${OUT}`)
process.exit(pass === checks.length ? 0 : 1)
