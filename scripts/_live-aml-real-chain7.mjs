/**
 * AML real 全链实机 v7（P1-C 终版）：
 * 数据窗口 = [镜像节点 createdAt, 激励批次 endedAt]（镜像数据覆盖的精确窗）→
 * dataset → eligibility(real, 台账派生) → train → profile+publish → bind → solve（line 已在跑）。
 * 用法：node scripts/_live-aml-real-chain7.mjs
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

  // ── ① 镜像节点 createdAt（数据覆盖窗起点）+ 激励批次 ──
  const daqList = (await api('GET', '/api/workshop/daq')).data?.nodes ?? []
  const mirrorNode = daqList.find(n => n.id === mvDaq)
  const mirrorFrom = Date.parse(mirrorNode?.createdAt ?? '')
  ok('G1', '镜像节点 createdAt（数据窗起点）', Number.isFinite(mirrorFrom), `from=${new Date(mirrorFrom).toISOString()}`)
  const runsResp = await api('GET', `/api/workshop/dcw/runs?recipeId=${encodeURIComponent(recipeId)}&limit=10`)
  const runs = runsResp.data?.runs ?? runsResp.data ?? []
  const ended = (Array.isArray(runs) ? runs : []).filter(r => r.endedAt).sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))
  const exciteRun = ended.find(r => Date.parse(r.endedAt) > mirrorFrom)
  ok('G2', '激励批次（ended > 镜像创建）', Boolean(exciteRun?.id), `run=${exciteRun?.id} ended=${exciteRun?.endedAt}`)
  if (!exciteRun?.id) throw new Error('无镜像覆盖的激励批次')

  // ── ② spec（窗口=镜像覆盖窗）──
  const spec = {
    schemaVersion: 2, id: `pm-wwtp-${TAG}`, version: 1,
    lineId, productId: state.line.productId, recipeId, recipeVersion: exciteRun.recipeVersion ?? 1,
    conditions: [{ id: 'c1', match: [{ field: 'recipeId', op: 'eq', value: recipeId }] }],
    variables: [
      { id: 'mv1', nodeId: mvDaq, role: 'mv', field: 'value', unit: 'Hz', scale: 1, offset: 0, delayMs: 20_000, min: 20, max: 50, maxStep: 5, controlNodeId: blowerDcw },
      { id: 'cv1', nodeId: cvId, role: 'cv', field: 'value', unit: 'mg/L', scale: 1, offset: 0, min: 0, max: 10 },
    ],
    timing: { beatMs: 1000, historySteps: 24, horizonSteps: 6, fixedDt: true },
    trainer: { ref: 'linear_arx@1', config: { arOrder: 1, inputOrder: 1, ridgeLambda: 1e-6, standardize: true } },
    datasetPolicy: {
      runIds: [exciteRun.id],
      fromMs: mirrorFrom,
      toMs: Date.parse(exciteRun.endedAt) - 5_000,
      split: { valRatio: 0.3, testRatio: 0.3, seed: 42 },
      cleaning: { hampelK: 0, maxInterpMs: 3000 },
    },
    gatePolicyRef: 'process-model.gates@1',
    modelInterface: { id: 'linear_state_space', version: 1, inputSemantics: 'setpoint', mode: 'state_space' },
    effectiveDomain: { mv: { mv1: { min: 20, max: 50, maxStep: 5 } }, cv: { cv1: { min: 0, max: 10 } } },
    purpose: 'mpc_surrogate',
  }
  const specCreated = await api('POST', '/api/workshop/process-model/specs', spec)
  const specPub = await api('POST', `/api/workshop/process-model/specs/${encodeURIComponent(spec.id)}/publish?version=1`)
  ok('G3', 'spec 登记+发布（镜像覆盖窗）', specCreated.status === 200 && specPub.status === 200, `create=${specCreated.status} pub=${specPub.status}`)
  const ds = await api('POST', '/api/workshop/process-model/datasets', spec)
  const datasetId = ds.data?.datasetId
  ok('G4', 'manifest v2 数据集（激励窗）', Boolean(datasetId), `rows=${ds.data?.rowCount} runs=${(ds.data?.runIds ?? []).length} msg=${String(ds.message ?? '').slice(0, 100)}`)

  // ── ③ eligibility(real;台账派生 observed) ──
  const elig = await api('POST', '/api/workshop/process-model/eligibility', { specId: spec.id, specVersion: 1, datasetId, scope: 'real' })
  const report = elig.data?.report ?? {}
  ok('G5', 'real 资格（observed + 激励充分）',
    elig.status === 200 && report.optimizationEligible === true,
    `eligible=${report.optimizationEligible} evidence=${report.actionEvidence} gaps=${JSON.stringify((report.gaps ?? []).map(g => g.code)).slice(0, 220)}`)

  // ── ④ 训练 → 模型 ──
  const train = await api('POST', '/api/workshop/process-model/train', { spec, datasetId, modelName: `WWTP-DO-ARX-${TAG}` })
  const jobId = train.data?.job?.id ?? train.data?.jobId
  ok('G6', '训练作业提交', train.status === 200 && Boolean(jobId), `job=${jobId}`)
  let jobStatus = ''
  let modelId = ''
  for (let i = 0; i < 60; i++) {
    await sleep(5000)
    const j = await api('GET', `/api/workshop/aml/jobs/${jobId}`)
    jobStatus = j.data?.status ?? j.data?.job?.status ?? ''
    modelId = j.data?.modelId ?? j.data?.job?.modelId ?? ''
    if (['done', 'failed', 'canceled'].includes(jobStatus)) break
  }
  ok('G7', '训练完成 + 模型登记', jobStatus === 'done' && Boolean(modelId), `status=${jobStatus} model=${modelId}`)
  const modelRow = modelId ? await api('GET', `/api/workshop/aml/models/${modelId}`) : null
  const artifactHash = modelRow?.data?.artifactHash ?? modelRow?.data?.model?.artifactHash ?? ''

  // ── ⑤ Profile + 发布 + 绑定 + solve（line 已在跑,不再 start）──
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
  ok('G8', 'Profile 创建+发布', profCreated.status === 200 && pub1.status === 200, `create=${profCreated.status}/${String(profCreated.message ?? '').slice(0, 60)} pub=${pub1.status}/${String(pub1.message ?? '').slice(0, 60)}`)
  const bind = await api('POST', '/api/workshop/optimization/bindings', {
    workspaceId: state.aml.workspaceId, channelId: state.channels.A.channelId,
    agentInstanceId: state.channels.A.leadId, profileId, profileVersion: 1, mode: 'recommendation',
  })
  const bindingId = bind.data?.binding?.id
  ok('G9', 'Agent↔Profile 绑定', bind.status === 200 && Boolean(bindingId), `binding=${bindingId} code=${bind.code}`)

  const solve = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: state.channels.A.leadId, bindingId }, 300_000)
  const solveStatus = solve.data?.result?.status
  ok('G10', 'real 作用域求解（建议,零设备写）',
    solve.status === 200 && solveStatus === 'optimal',
    `status=${solveStatus} firstMove=${JSON.stringify(solve.data?.result?.firstMove ?? solve.data?.recommendation?.firstMove ?? null).slice(0, 140)} msg=${String(solve.message ?? '').slice(0, 100)}`)

  state.aml = { ...state.aml, specId: spec.id, datasetId, modelId, profileId, bindingId, results: results.concat(state.aml?.results ?? []) }
  writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
} catch (err) {
  ok('HALT', 'real 全链未完成', false, err instanceof Error ? err.message.slice(0, 300) : String(err))
} finally {
  const pass = results.filter(r => r.pass).length
  console.log(`\n=== AML REAL CHAIN v7  pass=${pass}/${results.length} ===`)
}
