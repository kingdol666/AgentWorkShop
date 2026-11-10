/**
 * AML real 全链实机 v10（P1-C · 干净批次协议）：
 * 教训(v4-v9):告警态样本被 cleanPoints 按质量口径丢弃(设计正确)——
 *   深降激励/旧批次前半段 DO 崩 → do-pv alarm → 半窗 NaN → 数据集拒绝。
 * 正确协议 = 开新批 → 轮询 do-pv state=ok 且在带 → 带内激励 3 档 → 结批 → 全链。
 * 用法：node scripts/_live-aml-real-chain10.mjs
 */
process.env.NO_PROXY = '127.0.0.1,localhost'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = JSON.parse(readFileSync(join(REPO, '.rsi-demo-state.json'), 'utf8'))
const BASE = state.base
const H = { 'authorization': `Bearer ${state.token}`, 'content-type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? 'PASS' : 'FAIL'} ${id} — ${name}${detail ? ` · ${String(detail).slice(0, 200)}` : ''}`)
}
const api = async (method, path, body, timeoutMs = 300_000) => {
  const r = await fetch(BASE + path, {
    method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const TAG = `aml${Date.now().toString(36).slice(-4)}`

try {
  const lineId = state.line.lineId
  const recipeId = state.line.recipeId
  const blowerDcw = state.line.dcw['blower-hz-sp']
  const cvId = state.line.daq['do-pv']
  const mvDaq = state.aml.mvDaq

  // ── ① 结掉可能在跑的旧批 → 开新批（干净起点）──
  const stopOld = await api('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {})
  if (stopOld.status === 200) await sleep(5000)
  const start = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId })
  ok('J1', '干净开批（新 run;配方基准 26Hz）', start.status === 200, `status=${start.status} code=${start.code}`)

  // ── ② 等 DO 回带（state=ok;最多 8 分钟）──
  let cvOk = false
  let cvLast = null
  for (let i = 0; i < 60; i++) {
    await sleep(8000)
    const to = Date.now()
    const s = await api('GET', `/api/workshop/daq/${cvId}/samples?bucketMs=1000&from=${to - 20_000}&to=${to}&limit=10`)
    const pts = s.data?.points ?? []
    cvLast = pts[pts.length - 1] ?? null
    if (cvLast && cvLast.cnt >= 5 && Number(cvLast.avg) > 1.0 && Number(cvLast.avg) < 6.0) { cvOk = true; break }
  }
  ok('J2', 'DO 回带确认（state=ok;1.0-6.0 mg/L）', cvOk, `last=${JSON.stringify(cvLast).slice(0, 100)}`)

  // ── ③ 带内激励 3 档（±1Hz;60s 间隔;保证 ≥3 个 MV 水平且 DO 全程在带）──
  for (const level of [25.5, 26.5, 26.0]) {
    const w = await api('POST', `/api/workshop/dcw/${blowerDcw}/write`, { value: level }, 60_000)
    ok(`J3-${level}`, `带内激励写 ${level}Hz`, w.status === 200, `msg=${String(w.message ?? 'ok').slice(0, 60)}`)
    await sleep(62_000)
  }
  await sleep(60_000)

  // ── ④ 结批（干净窗闭合）──
  const stop = await api('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {})
  ok('J4', '结批', stop.status === 200, `status=${stop.status}`)
  const runsResp = await api('GET', `/api/workshop/dcw/runs?recipeId=${encodeURIComponent(recipeId)}&limit=10`)
  const runs = runsResp.data?.runs ?? runsResp.data ?? []
  const exciteRun = (Array.isArray(runs) ? runs : []).filter(r => r.endedAt).sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))[0]
  ok('J5', '激励批次定位', Boolean(exciteRun?.id), `run=${exciteRun?.id}`)

  // ── ⑤ spec + dataset + eligibility(real) ──
  const spec = {
    schemaVersion: 2, id: `pm-wwtp-${TAG}`, version: 1,
    lineId, productId: state.line.productId, recipeId, recipeVersion: exciteRun.recipeVersion ?? 1,
    conditions: [{ id: 'c1', match: [{ field: 'recipeId', op: 'eq', value: recipeId }] }],
    variables: [
      { id: 'mv1', nodeId: mvDaq, role: 'mv', field: 'value', unit: 'Hz', scale: 1, offset: 0, delayMs: 10_000, min: 20, max: 50, maxStep: 5, controlNodeId: blowerDcw },
      { id: 'cv1', nodeId: cvId, role: 'cv', field: 'value', unit: 'mg/L', scale: 1, offset: 0, min: 0, max: 10 },
    ],
    timing: { beatMs: 2000, historySteps: 12, horizonSteps: 3, fixedDt: true },
    trainer: { ref: 'linear_arx@1', config: { arOrder: 1, inputOrder: 1, ridgeLambda: 1e-6, standardize: true } },
    datasetPolicy: {
      runIds: [exciteRun.id],
      split: { valRatio: 0.3, testRatio: 0.3, seed: 42 },
      cleaning: { hampelK: 0, maxInterpMs: 6000 },
    },
    gatePolicyRef: 'process-model.gates@1',
    modelInterface: { id: 'linear_state_space', version: 1, inputSemantics: 'setpoint', mode: 'state_space' },
    effectiveDomain: { mv: { mv1: { min: 20, max: 50, maxStep: 5 } }, cv: { cv1: { min: 0, max: 10 } } },
    purpose: 'mpc_surrogate',
  }
  const specCreated = await api('POST', '/api/workshop/process-model/specs', spec)
  const specPub = await api('POST', `/api/workshop/process-model/specs/${encodeURIComponent(spec.id)}/publish?version=1`)
  ok('J6', 'spec 登记+发布', specCreated.status === 200 && specPub.status === 200, `create=${specCreated.status} pub=${specPub.status}`)
  const ds = await api('POST', '/api/workshop/process-model/datasets', spec)
  const datasetId = ds.data?.datasetId
  ok('J7', 'manifest v2 数据集（干净激励批）', Boolean(datasetId), `rows=${ds.data?.rowCount} runs=${(ds.data?.runIds ?? []).length} msg=${String(ds.message ?? '').slice(0, 100)}`)
  const elig = await api('POST', '/api/workshop/process-model/eligibility', { specId: spec.id, specVersion: 1, datasetId, scope: 'real' })
  const report = elig.data?.report ?? {}
  ok('J8', 'real 资格（observed + 激励充分）',
    elig.status === 200 && report.optimizationEligible === true,
    `eligible=${report.optimizationEligible} evidence=${report.actionEvidence} gaps=${JSON.stringify((report.gaps ?? []).map(g => g.code)).slice(0, 220)}`)

  // ── ⑥ 训练 → 模型 ──
  const train = await api('POST', '/api/workshop/process-model/train', { spec, datasetId, modelName: `WWTP-DO-ARX-${TAG}` })
  const jobId = train.data?.job?.id ?? train.data?.jobId
  ok('J9', '训练作业提交', train.status === 200 && Boolean(jobId), `job=${jobId}`)
  let jobStatus = ''
  let modelId = ''
  for (let i = 0; i < 60; i++) {
    await sleep(5000)
    const j = await api('GET', `/api/workshop/aml/jobs/${jobId}`)
    jobStatus = j.data?.status ?? j.data?.job?.status ?? ''
    modelId = j.data?.modelId ?? j.data?.job?.modelId ?? ''
    if (['done', 'failed', 'canceled'].includes(jobStatus)) break
  }
  ok('J10', '训练完成 + 模型登记', jobStatus === 'done' && Boolean(modelId), `status=${jobStatus} model=${modelId}`)
  const modelRow = modelId ? await api('GET', `/api/workshop/aml/models/${modelId}`) : null
  const artifactHash = modelRow?.data?.artifactHash ?? modelRow?.data?.model?.artifactHash ?? ''

  // ── ⑦ Profile + 发布 + 绑定 + solve（开批在 ① 已做且仍在跑）──
  const profileId = `opt-wwtp-${TAG}`
  const profileBody = {
    schemaVersion: 1, id: profileId, version: 1,
    modelRef: { modelId, artifactKind: 'linear_state_space@1', artifactHash, modelInterface: 'linear_state_space', stage: 'candidate' },
    problemTemplateRef: 'linear_mpc_quadratic@1',
    problemConfig: { linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.1 }, terminalWeight: 2, targets: { cv1: 3.4 } } },
    solverRef: 'osqp_mpc@1', solverVersion: '1',
    processSpecRef: `${spec.id}@1`, conditionIds: [], status: 'draft',
  }
  const profCreated = await api('POST', '/api/workshop/optimization/profiles', profileBody)
  const pub1 = await api('POST', `/api/workshop/optimization/profiles/${encodeURIComponent(profileId)}/publish?version=1`)
  ok('J11', 'Profile 创建+发布', profCreated.status === 200 && pub1.status === 200, `create=${profCreated.status}/${String(profCreated.message ?? '').slice(0, 60)} pub=${pub1.status}/${String(pub1.message ?? '').slice(0, 60)}`)
  const bind = await api('POST', '/api/workshop/optimization/bindings', {
    workspaceId: state.aml.workspaceId, channelId: state.channels.A.channelId,
    agentInstanceId: state.channels.A.leadId, profileId, profileVersion: 1, mode: 'recommendation',
  })
  const bindingId = bind.data?.binding?.id
  ok('J12', 'Agent↔Profile 绑定', bind.status === 200 && Boolean(bindingId), `binding=${bindingId} code=${bind.code}`)

  const solve = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: state.channels.A.leadId, bindingId }, 300_000)
  const solveStatus = solve.data?.result?.status
  ok('J13', 'real 作用域求解（建议,零设备写）',
    solve.status === 200 && solveStatus === 'optimal',
    `status=${solveStatus} firstMove=${JSON.stringify(solve.data?.result?.firstMove ?? solve.data?.recommendation?.firstMove ?? null).slice(0, 140)} msg=${String(solve.message ?? '').slice(0, 100)}`)

  state.aml = { ...state.aml, specId: spec.id, datasetId, modelId, profileId, bindingId, results: results.concat(state.aml?.results ?? []) }
  writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
} catch (err) {
  ok('HALT', 'real 全链未完成', false, err instanceof Error ? err.message.slice(0, 300) : String(err))
} finally {
  const pass = results.filter(r => r.pass).length
  console.log(`\n=== AML REAL CHAIN v10  pass=${pass}/${results.length} ===`)
}
