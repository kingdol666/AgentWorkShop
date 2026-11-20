// tsa5 round — AML leg on v0.14.0: real dataset snapshot from line batches (quality report =
// PR-D batch-quality surfacing), then a small built-in-reference-trainer job (hybrid_residual,
// no inline code) to terminal, recording terminal/artifact separation honestly.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-21-tsa5-v0140-round')
mkdirSync(EV, { recursive: true })
const BASE = 'http://127.0.0.1:3021'
const LINE = 'ln-a80dfb0d'
const RECIPE = 'rc-1bafdcf9'
const PRODUCT = 'pd-5c8e005f'
const TOKEN = JSON.parse(readFileSync('D:/tmp/aw-liv2-1119/aw-tokens.json', 'utf8')).admin
const sleep = ms => new Promise(r => setTimeout(r, ms))
const save = (name, obj) => writeFileSync(join(EV, name), JSON.stringify(obj, null, 1))
const log = m => console.log(`[tsa4-aml] ${m}`)

async function api(method, path, body, timeoutMs = 60_000) {
  let r
  try {
    r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  }
  catch (e) { return { status: 0, json: { raw: `network-error:${e.cause?.code ?? e.name}` } } }
  const text = await r.text()
  let json; try { json = JSON.parse(text) }
  catch { json = { raw: text.slice(0, 300) } }
  return { status: r.status, json }
}

// ---- product resolved from dcw-recipes.json (rc-1bafdcf9 → pd-5c8e005f) ----
const productId = PRODUCT
log(`line=${LINE} product=${productId}`)

// ---- dataset snapshot (real batches; quality report surfacing) ----
const spec = {
  lineId: LINE,
  productId,
  recipeId: RECIPE,
  // F-TSA5 observation: cross-run grid INTERSECTION — including the degraded sparse batch
  // (rr-48cfb72b, sampled during twin degradation) zeroes the whole dataset. Restrict to the
  // one historically complete batch; document the intersection semantics in the report.
  runIds: ['rr-0cc3b0be'],
  nodes: [
    { nodeId: 'dn-5634369a', role: 'feature' }, // 熔体压力PV (ln-a80dfb0d)
    { nodeId: 'dn-847baf8c', role: 'feature' }, // 模具温度PV (ln-a80dfb0d)
    { nodeId: 'dn-bad28587', role: 'target' }, // 制品克重PV (ln-a80dfb0d)
  ],
  beatMs: 5000,
  window: { historySteps: 12, horizonSteps: 3 },
  cleaning: { hampelK: 4, maxInterpMs: 15_000, maxDropRatio: 0.4 },
  split: { valRatio: 0.2, testRatio: 0.2, seed: 7 },
  purpose: 'quality_predict',
  note: 'TSA5 v0.14.0 验收:真实批次数据集+质量门',
}
// node ids resolved from the DAQ registry (dn-*); SP 写动作覆盖由写台账按批次窗口自动归并
const agg = await api('GET', '/api/workshop/daq')
const nodes = agg.json?.data?.nodes ?? []
const byName = n => nodes.find(x => x.name === n && x.lineId === LINE)?.id
const weightId = byName('制品克重PV')
if (weightId) spec.nodes[2].nodeId = weightId
save('aml-spec.json', spec)

const ds = await api('POST', '/api/workshop/aml/datasets', spec, 120_000)
save('aml-dataset.json', { status: ds.status, body: ds.json?.data ?? ds.json })
if (ds.status !== 200) throw new Error(`dataset build failed: ${JSON.stringify(ds.json).slice(0, 300)}`)
const dataset = ds.json?.data?.dataset ?? ds.json?.data
const report = ds.json?.data?.report ?? {}
log(`dataset=${dataset?.id} rows=${dataset?.rowCount} runs=${(dataset?.runIds ?? []).length} coverage=${JSON.stringify(report?.actionCoverage ?? report?.coverage ?? null)}`)

// ---- training job (platform supervised reference trainer, inline code) ----
const trainerCode = readFileSync('D:/tmp/aw-liv5-1121/repo/server/services/workshop/aml/python/train-example.py', 'utf8')
const job = await api('POST', '/api/workshop/aml/jobs', {
  datasetId: dataset.id,
  purpose: 'quality_predict',
  jobKind: 'supervised',
  code: trainerCode,
  changeNote: 'TSA5 v0.14.0 验收作业(平台 supervised 参考训练器,真实批次数据集)',
  seed: 7,
  budget: { maxExperiments: 2 },
  modelName: `tsa4-q-predict-${Date.now().toString(36)}`,
  modelDescription: 'v0.14.0 验收:克重质量预测(supervised 参考 GRU,小预算)',
})
save('aml-job-submit.json', { status: job.status, body: job.json?.data ?? job.json })
if (job.status !== 200) throw new Error(`job submit failed: ${JSON.stringify(job.json).slice(0, 300)}`)
const jobId = job.json?.data?.job?.id ?? job.json?.data?.id ?? job.json?.data?.jobId
log(`job=${jobId} submitted`)

// ---- poll to terminal ----
const terminal = ['SUCCEEDED', 'FAILED', 'CANCELED', 'COMPLETED', 'ERROR']
let detail = null
const t0 = Date.now()
while (Date.now() - t0 < 20 * 60_000) {
  await sleep(20_000)
  const d = await api('GET', `/api/workshop/aml/jobs/${jobId}`)
  const jd = d.json?.data?.job ?? d.json?.data ?? {}
  detail = { status: d.status, state: jd.state ?? jd.status, artifacts: jd.artifacts ?? jd.modelId ?? null, raw: { state: jd.state ?? jd.status, metrics: jd.metrics ?? null } }
  save('aml-job-poll.json', { at: new Date().toISOString(), state: detail.state })
  if (terminal.includes(String(detail.state).toUpperCase())) break
}
save('aml-job-final.json', detail)
log(`job terminal state=${detail?.state}`)

// ---- external artifact validity surface (what the job exposes) ----
const jobsList = await api('GET', '/api/workshop/aml/jobs')
const row = (jobsList.json?.data?.items ?? jobsList.json?.data ?? []).find(j => j.id === jobId)
save('aml-job-row.json', row ?? { note: 'not in list' })
console.log('TSA5-AML-RESULT ' + JSON.stringify({ dataset: dataset.id, rows: dataset.rowCount, coverage: report?.actionCoverage ?? null, job: jobId, state: detail?.state ?? null }))
