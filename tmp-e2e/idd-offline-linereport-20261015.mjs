#!/usr/bin/env node
/**
 * 离线 IDD 产线报告 API 测试(不经平台,直连 127.0.0.1:3210)。
 *   node tmp-e2e/idd-offline-linereport-20261015.mjs
 *
 * 验收:① 鉴权接受(服务账号 Bearer);② analysisIntent=stability-report 被受理并即返 task_id;
 *      ③ 后台执行,按 task_id 轮询到 completed;④ report.md 落盘且非空(生产状况分析产出)。
 */
import { readFileSync, existsSync, statSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3210'
const TOKEN = readFileSync('D:/codes/ABO/AgentWorkShop/.idd-token.tmp', 'utf8').trim()
const CSV = 'data/aw-snapshots/snap-ln-c4b434cb-1791990707000.csv'
process.env.NO_PROXY = '127.0.0.1,localhost'

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const req = async (method, path, body) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}

/* ① 鉴权 + 健康 */
const health = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(8000) }).then(r => r.json()).catch(() => null)
ok('IDD 服务健康', health?.status === 'ok', JSON.stringify(health).slice(0, 120))
const authed = await req('GET', '/api/diagnosis/tasks')
ok('Bearer 鉴权接受(服务账号 token)', authed.status === 200, `status=${authed.status}`)

/* ② 提交产线报告任务(stability-report 意图,即返 task_id) */
const t0 = Date.now()
const started = await req('POST', '/api/diagnosis/tasks', {
  dataPath: CSV,
  sceneName: 'aw-line-report-offline-1015',
  userQuestion: '流延产线烘干单元运行稳定性报告:评估该时窗温度回路的整体运行状况并给出等级与建议(离线 API 验证)',
  harness: 'omp',
  enhancement: 'off',
  reportLanguage: 'zh',
  analysisIntent: 'stability-report',
  maxTurns: 150,
  timeoutMinutes: 40,
})
const taskId = String(started.data?.task_id ?? started.data?.runId ?? '')
ok(`分析意图 stability-report 受理,即返 task_id=${taskId}(耗时 ${Date.now() - t0}ms)`,
  started.status === 200 && Boolean(taskId), JSON.stringify(started).slice(0, 200))

/* ③ 按 task_id 轮询进度(后台执行;零 LLM 报告管线预期数分钟内) */
let st = null
let sawRunning = false
for (let i = 0; i < 100; i++) {
  await sleep(10_000)
  st = (await req('GET', `/api/diagnosis/tasks/${encodeURIComponent(taskId)}`)).data ?? {}
  const s = st.status ?? st.state
  if (s && s !== 'pending' && s !== 'completed' && s !== 'failed') sawRunning = true
  console.log(`  …[${Math.round((Date.now() - t0) / 1000)}s] status=${s} stage=${st.stage ?? st.current_step ?? '?'}`)
  if (s === 'completed' || s === 'failed') break
}
const finalStatus = st?.status ?? st?.state
ok(`后台执行到终态(${finalStatus};中途可见运行态=${sawRunning})`, finalStatus === 'completed', JSON.stringify(st).slice(0, 300))

/* ④ 报告产出落盘 */
const reportPath = String(st?.reportPath ?? st?.report_path ?? '')
if (reportPath && existsSync(reportPath)) {
  const size = statSync(reportPath).size
  const head = readFileSync(reportPath, 'utf8').slice(0, 400)
  ok(`report.md 落盘且非空(${size} 字节)`, size > 500, head.replace(/\n/g, ' ').slice(0, 160))
  console.log('  · 报告路径:', reportPath)
  console.log('  · 报告开头:', head.split('\n').slice(0, 6).join(' | ').slice(0, 300))
}
else {
  ok('report.md 落盘', false, `reportPath=${reportPath}`)
}

console.log(`\n════ 离线 IDD 产线报告 API 测试:${pass}/${pass + fails.length} 通过 ════`)
if (fails.length) { for (const f of fails) console.log('  ✖', f); process.exit(1) }
console.log('OFFLINE IDD OK')
