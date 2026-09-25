/**
 * 0.7.46/0.7.47 打包系统验收 · 阶段 6:AML 真实训练 → 门禁 → 晋升 → 投入使用
 *  1) 保证注塑产线有 ≥3 个已完结批次(采样成行)
 *  2) 构建数据集快照(隔离三元组 + 控制/目标/特征节点)
 *  3) 提交**真实训练作业**(平台参考实现 train-example.py 作为内联 code;uv venv + torch)
 *  4) 评估门禁 → 模型注册 → 晋升 production(ONNX 深检)→ predict 影子参考(投入使用)
 * 用法:AW_BASE=http://127.0.0.1:3001 node scripts/_aw0746-stage6-aml.mjs
 */
import { readFileSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const ADMIN = { email: process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local', password: process.env.AW_ADMIN_PASSWORD ?? 'Awshop@123!' }
const REPO = process.env.AW_REPO ?? process.cwd()

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

const token = (await j('POST', '/api/users/login', { email: ADMIN.email, password: ADMIN.password })).data?.token
console.log(`\n═══ 阶段 6:AML 真实训练与投入使用 @ ${BASE} ═══`)

// ── 1. 产线与三元组 ──
const dcw = (await j('GET', '/api/workshop/dcw', undefined, token)).data
const line = (dcw.lines ?? []).find(l => /injection-aw0746/i.test(String(l.name)))
const product = (dcw.products ?? []).find(p => p.lineId === line.id)
const recipe = (dcw.recipes ?? []).find(r => r.lineId === line.id)
check('隔离三元组可解析(line/product/recipe)', Boolean(line && product && recipe), `${line.id} / ${product?.id} / ${recipe?.id}`)

const daq = (await j('GET', '/api/workshop/daq', undefined, token)).data
const nodes = (daq.nodes ?? []).filter(n => n.lineId === line.id)
const find = (arr, re) => arr.find(n => re.test(n.name))
// 数据集 nodes **只能是数采(DAQ)节点**:控制量取"可控量的数采观测通道"
// (模具温度 / 注射压力 / 节拍),目标 = 制品克重,特征 = 熔温·飞边·缩痕·熔压。
// 数控(DCW)节点是写通道,不属于 daq_samples,提交会被 AML_NODE_MISSING 拒绝。
const ctrl = [find(nodes, /mold-temp-pv/), find(nodes, /inj-pressure-pv/), find(nodes, /cycle-time/)].filter(Boolean)
const specNodes = [
  ...ctrl.map(n => ({ nodeId: n.id, role: 'control' })),
  { nodeId: find(nodes, /part-weight/).id, role: 'target' },
  ...[find(nodes, /melt-temp-pv/), find(nodes, /flash-rate/), find(nodes, /sink-mark/), find(nodes, /melt-pressure-pv/)].filter(Boolean).map(n => ({ nodeId: n.id, role: 'feature' })),
]
check('数据集节点编组(control/target/feature 均为 DAQ 通道)', specNodes.filter(n => n.role === 'control').length >= 2 && specNodes.some(n => n.role === 'target'), `nodes=${specNodes.length} ctrl=${ctrl.map(n => n.name).join('/')}`)

// ── 2. 保证 ≥4 个已完结批次(每轮 3 分钟采样) ──
// 关跑必须**无条件**先停:`/api/workshop/dcw` 的产线投影不含 activeRunId,
// 靠它判断"是否在跑"会漏停 → 后续 start 409(实测踩过),批次数量永远上不去。
// 复跑优化:`AW_DATASET_ID=<已建数据集>` 时跳过采样直接进入训练(调参迭代不再等 12 分钟)。
const reuseDatasetId = process.env.AW_DATASET_ID ?? ''
const BATCHES = Number(process.env.AW_BATCHES ?? 4)
if (!reuseDatasetId) {
  console.log(`  · 造批次:停线 → 开跑 → 采样 3 分钟 → 停线,重复 ${BATCHES} 轮`)
  for (let i = 1; i <= BATCHES; i += 1) {
    await j('POST', `/api/workshop/dcw/lines/${line.id}/stop`, {}, token)
    await sleep(2500)
    const st = await j('POST', `/api/workshop/dcw/lines/${line.id}/start`, { recipeId: recipe.id }, token)
    console.log(`    批次 ${i}: start status=${st.status} ${st.code ?? ''} ${st.message ?? 'ok'}`)
    await sleep(180_000)
  }
  await j('POST', `/api/workshop/dcw/lines/${line.id}/stop`, {}, token)
  await sleep(5000)
}

// ── 3. 数据集快照 ──
// beatMs 必须贴近真实采样间隔(实测产线运行中原样约 1.0 s/点):5 s 的拍格会把
// 3 分钟批次压成 ~27 行,行数门禁(≥500)必然不达标;1 s 拍格 → 单批次约 170 行。
const ds = reuseDatasetId
  ? { code: 0, data: { id: reuseDatasetId } }
  : await j('POST', '/api/workshop/aml/datasets', {
      lineId: line.id,
      productId: product.id,
      recipeId: recipe.id,
      nodes: specNodes,
      beatMs: Number(process.env.AW_BEAT_MS ?? 1000),
      window: { historySteps: 6, horizonSteps: 4 },
      cleaning: { hampelK: 3, maxInterpMs: 15_000, maxDropRatio: 0.5 },
      split: { valRatio: 0.2, testRatio: 0.2, seed: 42 },
      purpose: 'mpc_surrogate',
      note: '0.7.46/0.7.47 打包系统验收:注塑克重窗口闭环',
    }, token)
const datasetId = ds.data?.id ?? ds.data?.dataset?.id
const dsRow = ds.data?.dataset ?? ds.data
if (reuseDatasetId) {
  const d = (await j('GET', `/api/workshop/aml/datasets/${reuseDatasetId}`, undefined, token)).data
  const row = d?.dataset ?? d
  Object.assign(dsRow, { rowCount: row?.rowCount, runIds: row?.runIds ?? row?.runs ?? [] })
  console.log(`  · 复用数据集 ${reuseDatasetId} rows=${dsRow.rowCount} runs=${dsRow.runIds?.length}`)
}
check('数据集快照构建(真实打标样本)', Boolean(datasetId), `dataset=${datasetId} rows=${dsRow?.rowCount ?? '?'} runs=${dsRow?.runIds?.length ?? '?'} ${ds.code !== 0 ? `${ds.code}: ${ds.message}` : ''}`)
check('行数与批次满足门禁下限(≥500 行 / ≥3 批次)', Number(dsRow?.rowCount ?? 0) >= 500 && (dsRow?.runIds?.length ?? 0) >= 3, `rows=${dsRow?.rowCount} runs=${dsRow?.runIds?.length}`)

// ── 4. 真实训练作业 ──
const trainCode = readFileSync(`${REPO}/server/services/workshop/aml/python/train-example.py`, 'utf8')
const trainParams = process.env.AW_TRAIN_PARAMS
  ? JSON.parse(process.env.AW_TRAIN_PARAMS)
  : { lr: 0.01, epochs: 30, hidden: 64, batch: 64 }
console.log(`  · 训练超参:${JSON.stringify(trainParams)}`)
const job = await j('POST', '/api/workshop/aml/jobs', {
  datasetId,
  purpose: 'mpc_surrogate',
  jobKind: 'supervised',
  code: trainCode,
  params: trainParams,
  seed: 42,
  changeNote: '0.7.46 acceptance: baseline one-step model',
}, token)
const jobId = job.data?.id ?? job.data?.job?.id
check('训练作业提交(内联平台参考实现)', Boolean(jobId), `job=${jobId} ${job.message ?? ''}`)

console.log('  … 真实训练中(uv venv + torch,最长 15 分钟)…')
let jobRow = null
const deadline = Date.now() + 15 * 60_000
while (Date.now() < deadline) {
  await sleep(10_000)
  const row = (await j('GET', `/api/workshop/aml/jobs/${jobId}`, undefined, token)).data
  jobRow = row?.job ?? row
  process.stdout.write(`\r    status=${jobRow?.status ?? '?'} ${String(jobRow?.error ?? '').slice(0, 40)}   `)
  if (jobRow && ['done', 'failed', 'canceled'].includes(jobRow.status)) break
}
console.log('')
check('训练作业跑完(status=done)', jobRow?.status === 'done', `status=${jobRow?.status} err=${jobRow?.error ?? ''}`)
const logs = await j('GET', `/api/workshop/aml/jobs/${jobId}/logs`, undefined, token)
const logText = JSON.stringify(logs.data ?? '').slice(0, 4000)
check('训练日志可见 torch/ONNX 产出痕迹', /onnx|epoch|loss|torch/i.test(logText), logText.replace(/\\n/g, ' ').slice(0, 200))

// ── 5. 门禁 + 模型注册 ──
const exps = await j('GET', `/api/workshop/aml/experiments?datasetId=${datasetId}`, undefined, token)
const expList = Array.isArray(exps.data) ? exps.data : (exps.data?.experiments ?? exps.data?.items ?? [])
const exp = expList[0]
const gates = exp?.gates ?? exp?.gateReport ?? {}
console.log(`    门禁:${JSON.stringify(gates).slice(0, 400)}`)
check('门禁报告产出(逐项可读)', Object.keys(gates).length > 0 || exp?.gatesPassed !== undefined, Object.keys(gates).slice(0, 8).join(','))

const models = await j('GET', '/api/workshop/aml/models', undefined, token)
const modelList = Array.isArray(models.data) ? models.data : (models.data?.models ?? models.data?.items ?? [])
const model = modelList.find(m => m.experimentId === exp?.id) ?? modelList[0]
check('模型已注册(registry 出现候选)', Boolean(model?.id), `model=${model?.id} stage=${model?.stage}`)

// ── 6. 晋升 production(投入使用)──
let promoted = null
if (model?.id) {
  const p = await j('POST', `/api/workshop/aml/models/${model.id}/promote`, { toStage: 'production' }, token)
  promoted = p
  check('晋升 production(ONNX 深检 + 权限门)', p.code === 0 || p.status === 200, `status=${p.status} ${p.message ?? ''}`)
  const after = (await j('GET', '/api/workshop/aml/models', undefined, token)).data
  const listAfter = Array.isArray(after) ? after : (after?.models ?? after?.items ?? [])
  const m2 = listAfter.find(x => x.id === model.id)
  check('注册表 stage=production(模型已投入生产)', m2?.stage === 'production', `stage=${m2?.stage}`)
}

// ── 7. 预测引用(真正用起来)──
if (model?.id) {
  const hist = Array.from({ length: 6 }, () => specNodes.map(() => 0.5))
  const pred = await j('POST', `/api/workshop/aml/models/${model.id}/predict`, {
    history: hist,
    controls: [[0.5, 0.5, 0.5]],
    steps: 4,
  }, token)
  const arr = pred.data?.prediction ?? pred.prediction
  const flat = Array.isArray(arr) ? arr.flat(3).filter(v => typeof v === 'number') : []
  check('影子预测可用(what-if 投入使用)', pred.status === 200 && flat.length > 0, `points=${flat.length} first=${flat.slice(0, 3).map(v => v.toFixed?.(4) ?? v).join(',')}`)
}

console.log(`\n★ 阶段 6:${pass} 通过 / ${fails.length} 失败${fails.length ? ` (${fails.join('; ')})` : ''}`)
console.log(JSON.stringify({ lineId: line.id, datasetId, jobId, modelId: model?.id, jobStatus: jobRow?.status, gatesPassed: exp?.gatesPassed, promoteStatus: promoted?.status }, null, 1))
