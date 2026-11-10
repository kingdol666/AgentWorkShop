/**
 * AML real 全链实机 v2（P1-C）：
 * DAQ 镜像 SP → 治理激励 3 档（manual, readback-verified）→ spec → dataset →
 * eligibility(real, 台账派生 observed) → train → profile+publish → bind → solve（建议,零写）。
 * 用法：node scripts/_live-aml-real-chain2.mjs
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
const api = async (method, path, body, timeoutMs = 180_000) => {
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

  // ── ① SP 的 DAQ 镜像节点（同源 modbus driverConfig;激励必须落在 TSDB）──
  const simExport = await fetch('http://127.0.0.1:4010/api/nodes').then(r => r.json())
  const blowerDev = (simExport.data ?? []).find(n => n.id === 'wwtp-blower-mbtcp')
  const spSignal = (blowerDev?.signals ?? []).find(s => s.id === 'blower-hz-sp')
  const daqCreated = await api('POST', '/api/workshop/daq', {
    name: `scen-wwtp:daq:blower-hz-sp-mirror-${TAG}`, templateRef: 'daq-temp-tc',
    driver: blowerDev.protocol, driverConfig: spSignal.driverConfig,
    unit: 'Hz', min: 0, max: 300, decimals: 2, lineId, intervalMs: 1000, publishIntervalMs: 0,
  })
  const mvDaq = daqCreated.data?.node?.id
  ok('B1', 'MV 的 DAQ 镜像节点（真实 modbus 采样）', Boolean(mvDaq), `daq=${mvDaq} code=${daqCreated.code}`)
  if (!mvDaq) throw new Error('镜像节点创建失败')

  // ── ② 治理激励 3 档（admin 手动写;60s 设备间隔;台账 readback-verified）──
  for (const level of [24, 27, 22]) {
    const w = await api('POST', `/api/workshop/dcw/${blowerDcw}/write`, { value: level }, 60_000)
    ok(`B2-${level}`, `激励写 ${level}Hz（manual;readback 证实）`,
      w.status === 200 && (w.data?.write?.ok ?? w.data?.ok ?? true) && w.data?.write?.ack === 'readback-verified',
      `ack=${w.data?.write?.ack ?? w.data?.ack ?? '?'} msg=${String(w.message ?? '').slice(0, 80)}`)
    if (level !== 22) await sleep(62_000)
  }
  await sleep(75_000) // 物理随动 + 采样窗

  // ── ③ spec（real 线;mv=DAQ 镜像,cv=DO）──
  const recipes = (await api('GET', '/api/workshop/dcw/recipes')).data ?? []
  const recipeRow = (Array.isArray(recipes) ? recipes : recipes.recipes ?? []).find(r => r.id === recipeId)
  const spec = {
    schemaVersion: 2, id: `pm-wwtp-${TAG}`, version: 1,
    lineId, productId: recipeRow?.productId ?? state.line.productId, recipeId, recipeVersion: recipeRow?.version ?? 1,
    conditions: [{ id: 'c1', match: [{ field: 'recipeId', op: 'eq', value: recipeId }] }],
    variables: [
      { id: 'mv1', nodeId: mvDaq, role: 'mv', field: 'value', unit: 'Hz', scale: 1, offset: 0, delayMs: 20_000, min: 20, max: 50, maxStep: 5, controlNodeId: blowerDcw },
      { id: 'cv1', nodeId: cvId, role: 'cv', field: 'value', unit: 'mg/L', scale: 1, offset: 0, min: 0, max: 10 },
    ],
    timing: { beatMs: 1000, historySteps: 24, horizonSteps: 6, fixedDt: true },
    trainer: { ref: 'linear_arx@1', config: { arOrder: 1, inputOrder: 1, ridgeLambda: 1e-6, standardize: true } },
    datasetPolicy: { split: { valRatio: 0.3, testRatio: 0.3, seed: 42 }, cleaning: { hampelK: 0 } },
    gatePolicyRef: 'process-model.gates@1',
    modelInterface: { id: 'linear_state_space', version: 1, inputSemantics: 'setpoint', mode: 'state_space' },
    effectiveDomain: { mv: { mv1: { min: 20, max: 50, maxStep: 5 } }, cv: { cv1: { min: 0, max: 10 } } },
    purpose: 'mpc_surrogate',
  }
  const specCreated = await api('POST', '/api/workshop/process-model/specs', spec)
  const specPub = await api('POST', `/api/workshop/process-model/specs/${encodeURIComponent(spec.id)}/publish?version=1`)
  ok('B3', '过程 spec 登记+发布（real 线）', specCreated.status === 200 && specPub.status === 200, `create=${specCreated.status} pub=${specPub.status}`)

  // ── ④ 数据集 → 资格（real;台账派生）──
  const ds = await api('POST', '/api/workshop/process-model/datasets', spec)
  const datasetId = ds.data?.datasetId
  ok('B4', 'manifest v2 数据集（真实采样+激励窗）', Boolean(datasetId), `rows=${ds.data?.rowCount} runs=${(ds.data?.runIds ?? []).length} msg=${String(ds.message ?? '').slice(0, 80)}`)
  const elig = await api('POST', '/api/workshop/process-model/eligibility', { specId: spec.id, specVersion: 1, datasetId, scope: 'real' })
  const report = elig.data?.report ?? {}
  ok('B5', 'real 作用域资格（台账派生动作证据）',
    elig.status === 200 && report.optimizationEligible === true && report.actionEvidence === 'observed',
    `eligible=${report.optimizationEligible} evidence=${report.actionEvidence} gaps=${JSON.stringify((report.gaps ?? []).map(g => g.code)).slice(0, 200)}`)

  // ── ⑤ 训练 → 模型 ──
  const train = await api('POST', '/api/workshop/process-model/train', { spec, datasetId, modelName: `WWTP-DO-ARX-${TAG}` })
  const jobId = train.data?.job?.id ?? train.data?.jobId
  ok('B6', '训练作业提交', train.status === 200 && Boolean(jobId), `job=${jobId}`)
  let jobStatus = ''
  let modelId = ''
  for (let i = 0; i < 60; i++) {
    await sleep(5000)
    const j = await api('GET', `/api/workshop/aml/jobs/${jobId}`)
    jobStatus = j.data?.status ?? j.data?.job?.status ?? ''
    modelId = j.data?.modelId ?? j.data?.job?.modelId ?? ''
    if (['done', 'failed', 'canceled'].includes(jobStatus)) break
  }
  ok('B7', '训练完成 + 模型登记', jobStatus === 'done' && Boolean(modelId), `status=${jobStatus} model=${modelId}`)
  if (!modelId) {
    const models = await api('GET', `/api/workshop/aml/models?recipeId=${encodeURIComponent(recipeId)}`)
    modelId = (models.data ?? [])[0]?.id ?? ''
    ok('B7b', '模型回查', Boolean(modelId), `model=${modelId}`)
  }
  const modelRow = modelId ? await api('GET', `/api/workshop/aml/models/${modelId}`) : null
  const artifactHash = modelRow?.data?.artifactHash ?? modelRow?.data?.model?.artifactHash ?? ''

  // ── ⑥ Profile + 发布 + 绑定 + solve ──
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
  ok('B8', 'Profile 创建+发布', profCreated.status === 200 && pub1.status === 200, `create=${profCreated.status}/${String(profCreated.message ?? '').slice(0, 60)} pub=${pub1.status}/${String(pub1.message ?? '').slice(0, 60)}`)

  const chInfo = (await api('GET', `/api/workshop/channels/${state.channels.A.channelId}`)).data
  const bind = await api('POST', '/api/workshop/optimization/bindings', {
    workspaceId: chInfo?.workspace ?? '', channelId: state.channels.A.channelId,
    agentInstanceId: state.channels.A.leadId, profileId, profileVersion: 1, mode: 'recommendation',
  })
  const bindingId = bind.data?.binding?.id
  ok('B9', 'Agent↔Profile 绑定', bind.status === 200 && Boolean(bindingId), `binding=${bindingId} code=${bind.code} msg=${String(bind.message ?? '').slice(0, 80)}`)

  const solve = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: state.channels.A.leadId, bindingId }, 300_000)
  const solveStatus = solve.data?.result?.status
  ok('B10', 'real 作用域求解（建议,零设备写）',
    solve.status === 200 && solveStatus === 'optimal',
    `status=${solveStatus} firstMove=${JSON.stringify(solve.data?.result?.firstMove ?? solve.data?.recommendation?.firstMove ?? null).slice(0, 140)} msg=${String(solve.message ?? '').slice(0, 100)}`)

  state.aml = { specId: spec.id, datasetId, modelId, profileId, bindingId, mvDaq, results }
  writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
} catch (err) {
  ok('HALT', 'real 全链未完成', false, err instanceof Error ? err.message.slice(0, 300) : String(err))
} finally {
  const pass = results.filter(r => r.pass).length
  console.log(`\n=== AML REAL CHAIN v2  pass=${pass}/${results.length} ===`)
}
