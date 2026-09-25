/**
 * 0.7.47 打包系统验收 · 阶段 6c:AML 作业链路冒烟(内联 code + 新 sidecar 落盘)
 * 只验证"作业能不能真的跑起来":短训练(3 epoch)→ 作业到达终态 → 日志/门禁/工件可见。
 * 门禁是否达标由阶段 6b 的完整训练负责,这里不重复等 10 分钟。
 * 用法:AW_BASE=http://127.0.0.1:3001 node scripts/_aw0746-stage6c-jobsmoke.mjs
 */
import { readFileSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const REPO = process.env.AW_REPO ?? process.cwd()
const ADMIN = { email: process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local', password: process.env.AW_ADMIN_PASSWORD ?? 'Awshop@123!' }
let pass = 0
const fails = []
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass += 1
  else fails.push(name)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const j = async (method, path, body, token) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const token = (await j('POST', '/api/users/login', ADMIN)).data?.token
console.log(`\n═══ 阶段 6c:AML 作业链路冒烟 @ ${BASE} ═══`)

const datasets = ((await j('GET', '/api/workshop/aml/datasets', undefined, token)).data?.datasets ?? [])
const ds = datasets.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]
check('存在可复用数据集快照', Boolean(ds?.id), `dataset=${ds?.id} rows=${ds?.rowCount} runs=${JSON.parse(ds?.runIdsJson ?? '[]').length}`)

const code = readFileSync(`${REPO}/server/services/workshop/aml/python/train-example.py`, 'utf8')
const job = await j('POST', '/api/workshop/aml/jobs', {
  datasetId: ds.id,
  purpose: 'mpc_surrogate',
  jobKind: 'supervised',
  code,
  params: { lr: 0.01, epochs: 3, hidden: 32, batch: 64 },
  seed: 42,
  changeNote: '0.7.47 acceptance: inline-code job smoke',
}, token)
const jobId = job.data?.id ?? job.data?.job?.id
check('内联 code 作业被接受(不再要求 workspace/train.py)', Boolean(jobId) && !/train\.py 不存在/.test(String(job.message ?? '')), `job=${jobId} ${job.message ?? 'ok'}`)

let row = null
const deadline = Date.now() + 10 * 60_000
while (Date.now() < deadline) {
  await sleep(8000)
  const r = await j('GET', `/api/workshop/aml/jobs/${jobId}`, undefined, token)
  row = r.data?.job ?? r.data
  process.stdout.write(`\r    status=${row?.status ?? '?'}   `)
  if (row && ['done', 'failed', 'canceled'].includes(row.status)) break
}
console.log('')
check('作业到达终态(python 运行时真实执行)', ['done', 'failed'].includes(row?.status), `status=${row?.status} err=${String(row?.error ?? '').slice(0, 90)}`)
const logs = await j('GET', `/api/workshop/aml/jobs/${jobId}/logs`, undefined, token)
const logText = JSON.stringify(logs.data ?? '')
check('训练日志可见(epoch / onnx 痕迹)', /epoch|onnx|train-example done/i.test(logText), logText.slice(0, 180))
const exps = ((await j('GET', `/api/workshop/aml/experiments?datasetId=${ds.id}`, undefined, token)).data?.experiments ?? [])
const exp = exps.find(e => e.jobId === jobId)
const gates = exp?.gates
check('实验与门禁报告落库(逐项可读)', Boolean(exp?.id) && Array.isArray(gates?.checks) && gates.checks.length >= 4, `exp=${exp?.id} checks=${gates?.checks?.length} passed=${gates?.passed}`)

console.log(`\n★ 阶段 6c:${pass} 通过 / ${fails.length} 失败${fails.length ? ` (${fails.join('; ')})` : ''}`)
console.log(JSON.stringify({ datasetId: ds.id, jobId, status: row?.status, gatesPassed: gates?.passed }, null, 1))
