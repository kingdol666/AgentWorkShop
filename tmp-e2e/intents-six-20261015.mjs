#!/usr/bin/env node
/**
 * 六意图全量集成实测 2026-10-15(全部分析模式经平台 diag_run → IDD 后台执行)。
 *   node tmp-e2e/intents-six-20261015.mjs
 *
 * 验收:
 *  I1 未知意图被桥侧拦截(干净报错,不打 IDD)
 *  I2 六意图全部受理即返 task_id(data_path 离线模式,各自独立伪产线键,互不阻塞)
 *  I3 每个任务的注入问题=意图目录情景模板(非通用话术)
 *  I4 diag_status 按 taskId 可见运行进度(意图标签在面)
 *  I5 快意图(quick-screen 等)在预算内跑到 completed 且报告落盘;重意图验证受理后由 IDD REST 停止收尾
 */
import { readFileSync, existsSync, statSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3997'
const IDD = 'http://127.0.0.1:3210'
const IDD_TOKEN = readFileSync('D:/codes/ABO/AgentWorkShop/.idd-token.tmp', 'utf8').trim()
const CSV = 'data/aw-snapshots/snap-ln-c4b434cb-1791990707000.csv'
const POLL_MIN = 30
process.env.NO_PROXY = '127.0.0.1,localhost'

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (method, path, body) => {
  const login = await fetch(BASE + '/api/users/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'fc-fcddrp@awshop.local', password: 'FcAdmin#2026' }) }).then(r => r.json())
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${login.data.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  return r.json().catch(() => ({}))
}
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? JSON.stringify(r))

const login = await fetch(BASE + '/api/users/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'fc-fcddrp@awshop.local', password: 'FcAdmin#2026' }) }).then(r => r.json())
const H = { 'content-type': 'application/json', 'authorization': `Bearer ${login.data.token}` }
const state = JSON.parse(readFileSync('D:/tmp/aw-fc-1015/final-verify-state.json', 'utf-8'))
const agentId = state.agentId
const inv = (tool, args, timeoutMs = 180_000) => fetch(BASE + '/api/workshop/agent-tools/invoke', {
  method: 'POST', headers: H, body: JSON.stringify({ agentId, tool, args }), signal: AbortSignal.timeout(timeoutMs),
}).then(r => r.json().catch(() => ({})))

const INTENTS = ['deep-diagnosis', 'stability-report', 'quick-screen', 'doe-analysis', 'experience-mining', 'optimizer-campaign']

/* I1 未知意图:桥侧拦截 */
{
  const bad = await inv('diag_run', { line: 'any', data_path: CSV, analysis_intent: 'bogus-intent' })
  ok('I1 未知意图被桥拦截(干净报错)', invText(bad).includes('未知分析意图'), invText(bad).slice(0, 140))
}

/* I2+I3 六意图受理 + 注入问题=意图模板 */
const tasks = []
for (const intent of INTENTS) {
  const r = await inv('diag_run', {
    line: `ln-intent-${intent.slice(0, 6)}`,
    data_path: CSV,
    analysis_intent: intent,
    scene: `aw_intent_${intent.slice(0, 8)}`,
  })
  const txt = invText(r)
  const taskId = (txt.match(/task_id=([A-Za-z0-9-]+)/i) ?? [])[1] ?? ''
  const hasScenarioQ = /评分与等级|快速筛查|因子效应|调参经验|优化战役|根因诊断/.test(txt)
  ok(`I2[${intent}] 受理即返 task_id=${taskId}`, !txt.includes('未知') && Boolean(taskId), txt.slice(0, 160))
  ok(`I3[${intent}] 注入意图情景模板`, taskId && hasScenarioQ, txt.slice(0, 200))
  if (taskId) tasks.push({ intent, taskId })
}

/* I4 运行进度可见(意图标签) */
await sleep(8000)
{
  const first = tasks[0]
  if (first) {
    const s = await inv('diag_status', { run_id: first.taskId })
    const txt = invText(s)
    ok('I4 diag_status 按 taskId 见运行态+意图标签', /状态=running|状态=completed/.test(txt) && /意图=/.test(txt), txt.slice(0, 220))
  }
}

/* I5 轮询到终态(预算内);结束时未完成的重任务用 IDD REST 停止收尾 */
const done = new Map()
const deadline = Date.now() + POLL_MIN * 60_000
while (Date.now() < deadline && done.size < tasks.length) {
  await sleep(30_000)
  for (const t of tasks) {
    if (done.has(t.intent)) continue
    const s = await inv('diag_status', { run_id: t.taskId }, 60_000)
    const txt = invText(s)
    const st = (txt.match(/状态=(\w+)/) ?? [])[1] ?? ''
    if (st === 'completed' || st === 'failed' || st === 'stopped') {
      done.set(t.intent, { st, txt })
      console.log(`  · [${t.intent}] → ${st}`)
    }
  }
}
for (const t of tasks) {
  const d = done.get(t.intent)
  ok(`I5[${t.intent}] 到终态`, Boolean(d), d ? d.txt.slice(0, 150) : '预算内未终态(稍后由 IDD REST 停止)')
}

/* 报告落盘核验(已完成的) */
for (const [intent, d] of done) {
  const p = (d.txt.match(/report_md_path=(\S+)/) ?? [])[1]
  if (p && existsSync(p)) ok(`I6[${intent}] 报告落盘(${statSync(p).size}B)`, statSync(p).size > 300)
  else if (p) ok(`I6[${intent}] 报告落盘`, false, `路径不存在: ${p}`)
}

/* 收尾:仍在跑的任务经 IDD REST 停止(生命周期闭环;不留下小时级后台负载) */
for (const t of tasks) {
  if (done.has(t.intent)) continue
  try {
    const r = await fetch(`${IDD}/api/diagnosis/stop/${t.taskId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${IDD_TOKEN}` }, body: '{}' }).then(r => r.json())
    console.log(`  · 停止 [${t.intent}] ${t.taskId}: ${JSON.stringify(r).slice(0, 80)}`)
  }
  catch (e) { console.log(`  · 停止失败 [${t.intent}]: ${e.message}`) }
}

console.log(`\n════ 六意图集成实测:${pass}/${pass + fails.length} 通过 ════`)
if (fails.length) { for (const f of fails) console.log('  ✖', f) }
