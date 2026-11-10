/**
 * AML real 全链实机 v11（P1-C 终版·工况重置 + 干净批次协议）：
 * 模拟器 plant/reset(warm) → 干净开批 → 等 DO 回带 → 带内激励 3 档 → 结批 →
 * spec/dataset → eligibility(real) → train → profile+publish → bind → solve。
 * 用法：node scripts/_live-aml-real-chain11.mjs
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
const sim = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:4010${path}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
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

  // ── ① 停批 + 模拟器工况重置（warm;物理状态回标称;多轮试验后的状态漂移修复）──
  await api('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {})
  const reset = await sim('POST', '/api/plant/reset', { id: 'wwtp', warm: true, disturbances: { heaterDecay: 1, feedDriftPerMin: 0 } })
  ok('K1', '模拟器工况重置（wwtp warm）', reset.status === 200, `status=${reset.status}`)
  await sleep(3000)

  // ── ② 干净开批 → 等 DO 回带 ──
  const start = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId })
  ok('K2', '干净开批', start.status === 200, `status=${start.status} code=${start.code}`)
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
  ok('K3', 'DO 回带确认（1.0-6.0 mg/L）', cvOk, `last=${JSON.stringify(cvLast).slice(0, 100)}`)

  // ── ③ 带内激励 3 档 ──
  for (const level of [25.5, 26.5, 26.0]) {
    const w = await api('POST', `/api/workshop/dcw/${blowerDcw}/write`, { value: level }, 60_000)
    ok(`K4-${level}`, `带内激励写 ${level}Hz`, w.status === 200, `msg=${String(w.message ?? 'ok').slice(0, 60)}`)
    await sleep(62_000)
  }
  await sleep(60_000)

  // ── ④ 结批 → spec → dataset → eligibility(real) ──
  const stop = await api('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {})
  ok('K5', '结批', stop.status === 200, `status=${stop.status}`)
  const runsResp = await api('GET', `/api/workshop/dcw/runs?recipeId=${encodeURIComponent(recipeId)}&limit=10`)
  const runs = runsResp.data?.runs ?? runsResp.data ?? []
  const exciteRun = (Array.isArray(runs) ? runs : []).filter(r => r.endedAt).sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))[0]
  ok('K6', '激励批次定位', Boolean(exciteRun?.id), `run=${exciteRun?.id}`)
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
  ok('K7', 'spec 登记+发布', specCreated.status === 200 && specPub.status === 200, `create=${specCreated.status} pub=${specPub.status}`)
  const ds = await api('POST', '/api/workshop/process-model/datasets', spec)
  const datasetId = ds.data?.datasetId
  ok('K8', 'manifest v2 数据集（干净激励批）', Boolean(datasetId), `rows=${ds.data?.rowCount} runs=${(ds.data?.runIds ?? []).length} msg=${String(ds.message ?? '').slice(0, 100)}`)
  const elig = await api('POST', '/api/workshop/process-model/eligibility', { specId: spec.id, specVersion: 1, datasetId, scope: 'real' })
  const report = elig.data?.report ?? {}
  ok('K9', 'real 资格（observed + 激励充分）',
    elig.status === 200 && report.optimizationEligible === true,
    `eligible=${report.optimizationEligible} evidence=${report.actionEvidence} gaps=${JSON.stringify((report.gaps ?? []).map(g => g.code)).slice(0, 220)}`)

  // ── ⑤ 训练 → 模型 ──
  const train = await api('POST', '/api/workshop/process-model/train', { spec, datasetId, modelName: `WWTP-DO-ARX-${TAG}` })
  const jobId = train.data?.job?.id ?? train.data?.jobId
  ok('K10', '训练作业提交', train.status === 200 && Boolean(jobId), `job=${jobId}`)
  let jobStatus = ''
  let modelId = ''
  for (let i = 0; i < 60; i++) {
    await sleep(5000)
    const j = await api('GET', `/api/workshop/aml/jobs/${jobId}`)
    jobStatus = j.data?.status ?? j.data?.job?.status ?? ''
    modelId = j.data?.modelId ?? j.data?.job?.modelId ?? ''
    if (['done', 'failed', 'canceled'].includes(jobStatus)) break
  }
  ok('K11', '训练完成 + 模型登记', jobStatus === 'done' && Boolean(modelId), `status=${jobStatus} model=${modelId}`)
  const modelRow = modelId ? await api('GET', `/api/workshop/aml/models/${modelId}`) : null
  const artifactHash = modelRow?.data?.artifactHash ?? modelRow?.data?.model?.artifactHash ?? ''

  // ── ⑥ Profile + 发布 + 绑定 + solve（开批在 ② 已做且仍在跑）──
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
  ok('K12', 'Profile 创建+发布', profCreated.status === 200 && pub1.status === 200, `create=${profCreated.status}/${String(profCreated.message ?? '').slice(0, 60)} pub=${pub1.status}/${String(pub1.message ?? '').slice(0, 60)}`)
  const bind = await api('POST', '/api/workshop/optimization/bindings', {
    workspaceId: state.aml.workspaceId, channelId: state.channels.A.channelId,
    agentInstanceId: state.channels.A.leadId, profileId, profileVersion: 1, mode: 'recommendation',
  })
  const bindingId = bind.data?.binding?.id
  ok('K13', 'Agent↔Profile 绑定', bind.status === 200 && Boolean(bindingId), `binding=${bindingId} code=${bind.code}`)

  const solve = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: state.channels.A.leadId, bindingId }, 300_000)
  const solveStatus = solve.data?.result?.status
  ok('K14', 'real 作用域求解（建议,零设备写）',
    solve.status === 200 && solveStatus === 'optimal',
    `status=${solveStatus} firstMove=${JSON.stringify(solve.data?.result?.firstMove ?? solve.data?.recommendation?.firstMove ?? null).slice(0, 140)} msg=${String(solve.message ?? '').slice(0, 100)}`)

  state.aml = { ...state.aml, specId: spec.id, datasetId, modelId, profileId, bindingId, results: results.concat(state.aml?.results ?? []) }
  writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
} catch (err) {
  ok('HALT', 'real 全链未完成', false, err instanceof Error ? err.message.slice(0, 300) : String(err))
} finally {
  const pass = results.filter(r => r.pass).length
  console.log(`\n=== AML REAL CHAIN v11  pass=${pass}/${results.length} ===`)
}
