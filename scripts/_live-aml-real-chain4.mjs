/**
 * AML real 全链实机 v4（P1-C 终版）：
 * param 基准限界放宽 → DAQ 镜像 → 激励 3 档 → 结批 → spec/dataset(限定窗口) →
 * eligibility(real, 台账派生) → train → profile+publish → bind(workspace) → 再开批 → solve。
 * 用法：node scripts/_live-aml-real-chain4.mjs
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

  // ── ① workspace + param 基准限界放宽（admin 运维动作）──
  const ws = await api('POST', '/api/workshop/workspaces', { name: `AML-Real4-${TAG}` })
  const wsId = ws.data?.id
  await api('POST', `/api/workshop/workspaces/${encodeURIComponent(wsId)}/channels/${encodeURIComponent(state.channels.A.channelId)}`)
  const params = (await api('GET', '/api/workshop/dcw/params')).data?.params ?? []
  const blowerParam = params.find(p => p.nodeId === blowerDcw)
  const paramPatch = await api('PATCH', `/api/workshop/dcw/params/${blowerParam.id}`, { stepLimit: 5 })
  ok('D1', 'workspace 挂载 + param 基准限界放宽(0.6→5Hz)', Boolean(wsId) && paramPatch.status === 200, `ws=${wsId} param=${paramPatch.status}`)

  // ── ② DAQ 镜像 ──
  const simExport = await fetch('http://127.0.0.1:4010/api/nodes').then(r => r.json())
  const blowerDev = (simExport.data ?? []).find(n => n.id === 'wwtp-blower-mbtcp')
  const spSignal = (blowerDev?.signals ?? []).find(s => s.id === 'blower-hz-sp')
  const daqCreated = await api('POST', '/api/workshop/daq', {
    name: `scen-wwtp:daq:blower-sp-m3-${TAG}`, templateRef: 'daq-temp-tc',
    driver: blowerDev.protocol, driverConfig: spSignal.driverConfig,
    unit: 'Hz', min: 0, max: 300, decimals: 2, lineId, intervalMs: 1000, publishIntervalMs: 0,
  })
  const mvDaq = daqCreated.data?.node?.id
  ok('D2', 'MV DAQ 镜像节点', Boolean(mvDaq), `daq=${mvDaq}`)

  // ── ③ 治理激励 3 档（manual;readback-verified;60s 间隔）──
  for (const level of [24, 27, 22]) {
    const w = await api('POST', `/api/workshop/dcw/${blowerDcw}/write`, { value: level }, 60_000)
    ok(`D3-${level}`, `激励写 ${level}Hz`, w.status === 200 && (w.data?.write?.ack ?? w.data?.ack) === 'readback-verified',
      `ack=${w.data?.write?.ack ?? w.data?.ack ?? '?'} msg=${String(w.message ?? '').slice(0, 80)}`)
    if (level !== 22) await sleep(62_000)
  }
  await sleep(45_000)

  // ── ④ 结批 → spec → dataset（限定窗口:只取最近 40 分钟激励数据）──
  const stop = await api('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {})
  ok('D4', '结批', stop.status === 200, `status=${stop.status}`)
  const exciteFrom = Date.now() - 40 * 60_000
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
    datasetPolicy: { fromMs: exciteFrom, split: { valRatio: 0.3, testRatio: 0.3, seed: 42 }, cleaning: { hampelK: 0 } },
    gatePolicyRef: 'process-model.gates@1',
    modelInterface: { id: 'linear_state_space', version: 1, inputSemantics: 'setpoint', mode: 'state_space' },
    effectiveDomain: { mv: { mv1: { min: 20, max: 50, maxStep: 5 } }, cv: { cv1: { min: 0, max: 10 } } },
    purpose: 'mpc_surrogate',
  }
  const specCreated = await api('POST', '/api/workshop/process-model/specs', spec)
  const specPub = await api('POST', `/api/workshop/process-model/specs/${encodeURIComponent(spec.id)}/publish?version=1`)
  ok('D5', 'spec 登记+发布', specCreated.status === 200 && specPub.status === 200, `create=${specCreated.status} pub=${specPub.status}`)
  const ds = await api('POST', '/api/workshop/process-model/datasets', spec, 300_000)
  const datasetId = ds.data?.datasetId
  ok('D6', 'manifest v2 数据集（激励窗）', Boolean(datasetId), `rows=${ds.data?.rowCount} runs=${(ds.data?.runIds ?? []).length} msg=${String(ds.message ?? '').slice(0, 80)}`)

  // ── ⑤ eligibility(real;台账派生) ──
  const elig = await api('POST', '/api/workshop/process-model/eligibility', { specId: spec.id, specVersion: 1, datasetId, scope: 'real' }, 300_000)
  const report = elig.data?.report ?? {}
  ok('D7', 'real 资格（台账派生 observed + 激励充分）',
    elig.status === 200 && report.optimizationEligible === true,
    `eligible=${report.optimizationEligible} evidence=${report.actionEvidence} gaps=${JSON.stringify((report.gaps ?? []).map(g => g.code)).slice(0, 220)}`)

  // ── ⑥ 训练 → 模型 ──
  const train = await api('POST', '/api/workshop/process-model/train', { spec, datasetId, modelName: `WWTP-DO-ARX-${TAG}` })
  const jobId = train.data?.job?.id ?? train.data?.jobId
  ok('D8', '训练作业提交', train.status === 200 && Boolean(jobId), `job=${jobId} msg=${String(train.message ?? '').slice(0, 80)}`)
  let jobStatus = ''
  let modelId = ''
  for (let i = 0; i < 60; i++) {
    await sleep(5000)
    const j = await api('GET', `/api/workshop/aml/jobs/${jobId}`)
    jobStatus = j.data?.status ?? j.data?.job?.status ?? ''
    modelId = j.data?.modelId ?? j.data?.job?.modelId ?? ''
    if (['done', 'failed', 'canceled'].includes(jobStatus)) break
  }
  ok('D9', '训练完成 + 模型登记', jobStatus === 'done' && Boolean(modelId), `status=${jobStatus} model=${modelId}`)
  const modelRow = modelId ? await api('GET', `/api/workshop/aml/models/${modelId}`) : null
  const artifactHash = modelRow?.data?.artifactHash ?? modelRow?.data?.model?.artifactHash ?? ''

  // ── ⑦ Profile + 发布 + 绑定 + 再开批 + solve ──
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
  ok('D10', 'Profile 创建+发布（IR hash 冻结）', profCreated.status === 200 && pub1.status === 200, `create=${profCreated.status}/${String(profCreated.message ?? '').slice(0, 60)} pub=${pub1.status}/${String(pub1.message ?? '').slice(0, 60)}`)
  const bind = await api('POST', '/api/workshop/optimization/bindings', {
    workspaceId: wsId, channelId: state.channels.A.channelId,
    agentInstanceId: state.channels.A.leadId, profileId, profileVersion: 1, mode: 'recommendation',
  })
  const bindingId = bind.data?.binding?.id
  ok('D11', 'Agent↔Profile 绑定', bind.status === 200 && Boolean(bindingId), `binding=${bindingId} code=${bind.code}`)
  const start = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId })
  ok('D12', '再开批（solve 运行门）', start.status === 200, `status=${start.status} code=${start.code}`)
  await sleep(12_000)

  const solve = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: state.channels.A.leadId, bindingId }, 300_000)
  const solveStatus = solve.data?.result?.status
  ok('D13', 'real 作用域求解（建议,零设备写）',
    solve.status === 200 && solveStatus === 'optimal',
    `status=${solveStatus} firstMove=${JSON.stringify(solve.data?.result?.firstMove ?? solve.data?.recommendation?.firstMove ?? null).slice(0, 140)} msg=${String(solve.message ?? '').slice(0, 100)}`)

  state.aml = { specId: spec.id, datasetId, modelId, profileId, bindingId, mvDaq, workspaceId: wsId, results }
  writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
} catch (err) {
  ok('HALT', 'real 全链未完成', false, err instanceof Error ? err.message.slice(0, 300) : String(err))
} finally {
  const pass = results.filter(r => r.pass).length
  console.log(`\n=== AML REAL CHAIN v4  pass=${pass}/${results.length} ===`)
}
