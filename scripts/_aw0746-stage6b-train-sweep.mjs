/**
 * 0.7.46/0.7.47 打包系统验收 · 阶段 6b:训练调参冲刺(复用已采样的数据集,不再等 12 分钟)
 *  逐档提交真实训练作业,直到单步 NRMSE 门禁(G1 ≤ 0.10)通过;通过则晋升 production + 影子预测。
 *  每档都是"平台内联 code"路径:第 1/2 档用平台参考实现换超参,第 3 档用带 z-score 标准化的加强实现。
 * 用法:AW_BASE=http://127.0.0.1:3001 [AW_DATASET_ID=ds-xxx] node scripts/_aw0746-stage6b-train-sweep.mjs
 */
import { readFileSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const ADMIN = { email: process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local', password: process.env.AW_ADMIN_PASSWORD ?? 'Awshop@123!' }
const REPO = process.env.AW_REPO ?? process.cwd()

const j = async (method, path, body, token) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const token = (await j('POST', '/api/users/login', { email: ADMIN.email, password: ADMIN.password })).data?.token
console.log(`\n═══ 阶段 6b:训练调参冲刺 @ ${BASE} ═══`)

const dcw = (await j('GET', '/api/workshop/dcw', undefined, token)).data
const line = (dcw.lines ?? []).find(l => /injection-aw0746/i.test(String(l.name)))
const product = (dcw.products ?? []).find(p => p.lineId === line.id)
const recipe = (dcw.recipes ?? []).find(r => r.lineId === line.id)
const daq = (await j('GET', '/api/workshop/daq', undefined, token)).data
const find = (arr, re) => arr.find(n => re.test(n.name))
const nodes = (daq.nodes ?? []).filter(n => n.lineId === line.id)

async function buildDataset(window) {
  const ds = await j('POST', '/api/workshop/aml/datasets', {
    lineId: line.id,
    productId: product.id,
    recipeId: recipe.id,
    nodes: [
      { nodeId: find(nodes, /mold-temp-pv/).id, role: 'control' },
      { nodeId: find(nodes, /inj-pressure-pv/).id, role: 'control' },
      { nodeId: find(nodes, /cycle-time/).id, role: 'control' },
      { nodeId: find(nodes, /part-weight/).id, role: 'target' },
      ...[find(nodes, /melt-temp-pv/), find(nodes, /flash-rate/), find(nodes, /sink-mark/), find(nodes, /melt-pressure-pv/)].filter(Boolean).map(n => ({ nodeId: n.id, role: 'feature' })),
    ],
    beatMs: 1000,
    window,
    cleaning: { hampelK: 3, maxInterpMs: 15_000, maxDropRatio: 0.5 },
    split: { valRatio: 0.2, testRatio: 0.2, seed: 42 },
    purpose: 'mpc_surrogate',
    note: `0.7.46 验收:调参冲刺 window=${window.historySteps}/${window.horizonSteps}`,
  }, token)
  return ds.data?.id
}

async function rowOf(datasetId) {
  const d = (await j('GET', `/api/workshop/aml/datasets/${datasetId}`, undefined, token)).data
  const row = d?.dataset ?? d
  return { id: datasetId, rows: Number(row?.rowCount ?? 0), runs: JSON.parse(row?.runIdsJson ?? '[]').length }
}

async function trainAndWait(datasetId, code, params, note, minutes = 16) {
  const job = await j('POST', '/api/workshop/aml/jobs', { datasetId, purpose: 'mpc_surrogate', jobKind: 'supervised', code, params, seed: 42, changeNote: note }, token)
  const jobId = job.data?.id ?? job.data?.job?.id
  if (!jobId) return { status: 'submit-failed', message: job.message, jobId: null }
  const deadline = Date.now() + minutes * 60_000
  let row = null
  while (Date.now() < deadline) {
    await sleep(10_000)
    row = (await j('GET', `/api/workshop/aml/jobs/${jobId}`, undefined, token)).data
    row = row?.job ?? row
    process.stdout.write(`\r    ${jobId} status=${row?.status ?? '?'}   `)
    if (row && ['done', 'failed', 'canceled'].includes(row.status)) break
  }
  console.log('')
  return { jobId, status: row?.status, error: row?.error ?? '' }
}

async function gatesOf(datasetId, jobId) {
  const exps = ((await j('GET', `/api/workshop/aml/experiments?datasetId=${datasetId}`, undefined, token)).data?.experiments ?? [])
  // 实验列表按创建升序返回,必须按 jobId 精确匹配本次作业(否则读到旧档的指标)
  const exp = exps.find(e => e.jobId === jobId) ?? exps.at(-1)
  const metrics = JSON.parse(exp?.metricsJson || '{}')
  return { exp, metrics, gates: exp?.gates ?? exp?.gateReport ?? null }
}

// ── 档位定义 ──
const refCode = readFileSync(`${REPO}/server/services/workshop/aml/python/train-example.py`, 'utf8')
const strongCode = readFileSync(`${REPO}/scripts/_aw0746-train-strong.py`, 'utf8')
let datasetId = process.env.AW_DATASET_ID ?? ''

const attempts = [
  { label: '参考实现 + 更大容量/更久训练(lr3e-3,e200,h128)', code: refCode, params: { lr: 0.003, epochs: 200, hidden: 128, batch: 64 }, window: null },
  { label: '参考实现 + 全连接加宽(lr1e-3,e300,h256,b128)', code: refCode, params: { lr: 0.001, epochs: 300, hidden: 256, batch: 128 }, window: null },
  { label: '加强实现(z-score + 2 层 + best-val 回滚,lr3e-3,e400,h128)', code: strongCode, params: { lr: 0.003, epochs: 400, hidden: 128, batch: 64 }, window: { historySteps: 10, horizonSteps: 4 } },
]

let winner = null
for (const [i, a] of attempts.entries()) {
  if (a.window) {
    datasetId = await buildDataset(a.window)
    console.log(`  · 重建数据集(window=${a.window.historySteps}/${a.window.horizonSteps}) → ${datasetId}`)
  }
  const info = await rowOf(datasetId)
  if (info.rows < 500) {
    console.log(`  ✗ 数据集行数不足:${JSON.stringify(info)}`)
    continue
  }
  console.log(`\n  档 ${i + 1}:${a.label}\n    dataset=${datasetId} rows=${info.rows} runs=${info.runs} params=${JSON.stringify(a.params)}`)
  const run = await trainAndWait(datasetId, a.code, a.params, `0.7.46 sweep #${i + 1}: ${a.label}`)
  const { exp, metrics, gates } = await gatesOf(datasetId, run.jobId)
  const g1 = Number(metrics.oneStepTest?.nrmse ?? NaN)
  const g2 = Number(metrics.rolloutTest?.nrmse ?? NaN)
  const g3 = Number(metrics.oneStepVal?.nrmse ?? NaN)
  console.log(`    job=${run.jobId} ${run.status}${run.error ? ` err=${run.error}` : ''}`)
  console.log(`    oneStep(test)=${g1.toFixed(4)} oneStep(val)=${g3.toFixed(4)} rollout=${g2.toFixed(4)} gatesPassed=${gates?.passed}`)
  if (run.status === 'done' && Number.isFinite(g1) && g1 <= 0.10) {
    winner = { attempt: i + 1, datasetId, jobId: run.jobId, exp, metrics }
    break
  }
  console.log(`    ✗ 未过 G1(实测 ${Number.isFinite(g1) ? g1.toFixed(4) : 'n/a'} / 上限 0.10),进入下一档`)
}

if (!winner) {
  console.log('\n★ 阶段 6b:全部档位未过 G1 门禁')
  process.exit(2)
}

console.log(`\n  ✓ 档 ${winner.attempt} 通过门禁:G1=${Number(winner.metrics.oneStepTest.nrmse).toFixed(4)}`)
const models = ((await j('GET', '/api/workshop/aml/models', undefined, token)).data?.models ?? [])
const model = models.find(m => m.experimentId === winner.exp?.id) ?? models[0]
console.log(`  · 模型注册:${model?.id} stage=${model?.stage}`)
const p = await j('POST', `/api/workshop/aml/models/${model.id}/promote`, { toStage: 'production' }, token)
console.log(`  · 晋升 production:status=${p.status} ${p.message ?? ''}`)
const after = ((await j('GET', '/api/workshop/aml/models', undefined, token)).data?.models ?? []).find(x => x.id === model.id)
console.log(`  · 复核 stage=${after?.stage}`)

const hist = Array.from({ length: Number(winner.metrics.ioSpec?.historySteps ?? 10) }, () => winner.metrics.ioSpec.allNodes.map(n => Number(winner.metrics.ioSpec.norm.x.mean[winner.metrics.ioSpec.allNodes.indexOf(n)] ?? 0)))
const pred = await j('POST', `/api/workshop/aml/models/${model.id}/predict`, { history: hist, controls: [[0.5, 0.5, 0.5]], steps: 4 }, token)
const arr = pred.data?.prediction ?? pred.prediction
const flat = Array.isArray(arr) ? arr.flat(3).filter(v => typeof v === 'number') : []
console.log(`  · 影子预测:status=${pred.status} points=${flat.length} first=${flat.slice(0, 3).map(v => v.toFixed?.(4) ?? v).join(',')}`)

console.log(`\n★ 阶段 6b:通过(dataset=${winner.datasetId} job=${winner.jobId} model=${model.id} stage=${after?.stage})`)
console.log(JSON.stringify({ datasetId: winner.datasetId, jobId: winner.jobId, modelId: model.id, oneStepTest: winner.metrics.oneStepTest?.nrmse, rolloutTest: winner.metrics.rolloutTest?.nrmse, stage: after?.stage, predictPoints: flat.length }, null, 1))
