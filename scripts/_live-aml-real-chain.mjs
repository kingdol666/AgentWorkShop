/**
 * AML real 全链实机（P1-C）：治理激励写 → spec → dataset → eligibility(real) →
 * train → profile → bind → solve。零设备写（solve 只产建议）。
 * 用法：node scripts/_live-aml-real-chain.mjs
 */
process.env.NO_PROXY = '127.0.0.1,localhost'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = JSON.parse(readFileSync(join(REPO, '.rsi-demo-state.json'), 'utf8'))
const BASE = state.base
const H = { 'authorization': `Bearer ${state.token}`, 'content-type': 'application/json' }
const DB = new DatabaseSync(join(state.home, 'data', 'workshop.sqlite'))
DB.exec('PRAGMA busy_timeout = 5000')
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
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? '')
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)
const invokeAgent = (agentId, tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, 240_000)
const cards = async () => (await api('GET', '/api/workshop/hitl/pending')).data?.items ?? []
const TAG = `aml${Date.now().toString(36).slice(-4)}`

try {
  const A = state.channels.A
  const lineId = state.line.lineId
  const recipeId = state.line.recipeId
  const blower = state.line.dcw['blower-hz-sp']
  const mvId = `scen-wwtp:daq:${'blower-hz-sp'}` // DAQ 侧同源节点
  const daqNodes = state.line.daq
  const cvId = daqNodes['do-pv']

  // ── ① 治理激励写：3 档水平（24/27/22），write_intent+HITL，60s 设备间隔 ──
  const writeLevels = [24, 27, 22]
  const trial = async (value) => {
    const known = new Set((await cards()).map(x => x.id))
    const p = invokeAgent(A.leadId, 'recipe_trial', {
      recipe_id: recipeId, params: [{ node_id: blower, value }],
      hypothesis: `P1-C real 全链激励：风机 ${value}Hz（台账派生动作证据）`, emergency: true,
    })
    let card = null
    for (let i = 0; i < 60 && !card; i++) {
      await sleep(2000)
      card = (await cards()).find(x => !known.has(x.id)) ?? null
    }
    if (card) await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: 'AML real 激励批准' })
    const r = await p
    return { value, err: invErr(r), text: invText(r).slice(0, 120) }
  }
  const t1 = await trial(writeLevels[0])
  ok('A1', '激励写 1（24Hz，HITL 批准）', !t1.err, t1.text)
  await sleep(62_000)
  const t2 = await trial(writeLevels[1])
  ok('A2', '激励写 2（27Hz，60s 设备间隔）', !t2.err, t2.text)
  await sleep(62_000)
  const t3 = await trial(writeLevels[2])
  ok('A3', '激励写 3（22Hz）', !t3.err, t3.text)
  await sleep(90_000) // 物理随动 + DAQ 采样窗口

  // ── ② 过程 spec（real 线;MV=blower CV=DO）──
  const recipes = (await api('GET', '/api/workshop/dcw/recipes', undefined)).data ?? []
  const recipeRow = (Array.isArray(recipes) ? recipes : recipes.recipes ?? []).find(r => r.id === recipeId)
  const spec = {
    schemaVersion: 2, id: `pm-wwtp-${TAG}`, version: 1,
    lineId, productId: recipeRow?.productId ?? state.line.product, recipeId, recipeVersion: recipeRow?.version ?? 1,
    conditions: [{ id: 'c1', match: [{ field: 'recipeId', op: 'eq', value: recipeId }] }],
    variables: [
      { id: 'mv1', nodeId: blower, role: 'mv', field: 'value', unit: 'Hz', scale: 1, offset: 0, delayMs: 20_000, min: 20, max: 50, maxStep: 5, controlNodeId: blower },
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
  ok('A4', '过程 spec 登记+发布（real 线）', specCreated.status === 200 && specPub.status === 200, `create=${specCreated.status} pub=${specPub.status} code=${specCreated.code ?? specPub.code}`)

  // ── ③ 数据集（manifest v2；TSDB 三元组打标样本）──
  const ds = await api('POST', '/api/workshop/process-model/datasets', spec)
  const datasetId = ds.data?.datasetId
  ok('A5', 'manifest v2 数据集构建（真实 55k+ 采样）', Boolean(datasetId), `ds=${datasetId} rows=${ds.data?.rowCount} runs=${(ds.data?.runIds ?? []).length}`)

  // ── ④ eligibility real（台账派生 observed）──
  const elig = await api('POST', '/api/workshop/process-model/eligibility', { specId: spec.id, specVersion: 1, datasetId, scope: 'real' })
  const report = elig.data?.report ?? {}
  ok('A6', 'real 作用域资格评估（台账派生动作证据）',
    elig.status === 200 && report.optimizationEligible === true && report.actionEvidence === 'observed',
    `eligible=${report.optimizationEligible} evidence=${report.actionEvidence} gaps=${JSON.stringify((report.gaps ?? []).map(g => g.code)).slice(0, 160)}`)

  // ── ⑤ 训练（内置 linear_arx；AML job）──
  const train = await api('POST', '/api/workshop/process-model/train', { spec, datasetId, modelName: `WWTP-DO-ARX-${TAG}` })
  const jobId = train.data?.job?.id ?? train.data?.jobId
  ok('A7', '训练作业提交', train.status === 200 && Boolean(jobId), `job=${jobId} code=${train.code}`)
  let jobStatus = ''
  let modelId = ''
  let artifactHash = ''
  for (let i = 0; i < 60; i++) {
    await sleep(5000)
    const j = await api('GET', `/api/workshop/aml/jobs/${jobId}`)
    jobStatus = j.data?.status ?? j.data?.job?.status ?? ''
    if (['done', 'failed', 'canceled'].includes(jobStatus)) {
      modelId = j.data?.modelId ?? j.data?.job?.modelId ?? ''
      artifactHash = j.data?.artifactHash ?? j.data?.job?.artifactHash ?? ''
      break
    }
  }
  ok('A8', '训练完成 + 模型登记（linear_state_space@1）', jobStatus === 'done' && Boolean(modelId), `status=${jobStatus} model=${modelId}`)
  if (!modelId) {
    const models = await api('GET', `/api/workshop/aml/models?recipeId=${encodeURIComponent(recipeId)}`)
    modelId = (models.data ?? [])[0]?.id ?? ''
    artifactHash = (models.data ?? [])[0]?.artifactHash ?? ''
    ok('A8b', '模型回查（recipes 谱系）', Boolean(modelId), `model=${modelId}`)
  }

  // ── ⑥ Profile v1 + 发布 + 绑定 + solve（建议，零设备写）──
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
  ok('A9', 'Profile v1 创建+发布（problemIrHash 冻结）', profCreated.status === 200 && pub1.status === 200, `create=${profCreated.status} pub=${pub1.status} code=${pub1.code ?? profCreated.code}`)

  const bind = await api('POST', '/api/workshop/optimization/bindings', {
    channelId: A.channelId, agentInstanceId: A.leadId, profileId, profileVersion: 1, mode: 'recommendation',
  })
  const bindingId = bind.data?.binding?.id
  ok('A10', 'Agent↔Profile 绑定（recommendation 模式）', bind.status === 200 && Boolean(bindingId), `binding=${bindingId} code=${bind.code}`)

  const solve = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: A.leadId, bindingId }, 300_000)
  const solveStatus = solve.data?.result?.status
  ok('A11', 'real 作用域求解（建议产出,零设备写）',
    solve.status === 200 && solveStatus === 'optimal',
    `status=${solveStatus} firstMove=${JSON.stringify(solve.data?.result?.firstMove ?? solve.data?.recommendation?.firstMove ?? null).slice(0, 120)} msg=${String(solve.message ?? '').slice(0, 100)}`)

  state.aml = { specId: spec.id, datasetId, modelId, profileId, bindingId, results }
  writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
} catch (err) {
  ok('HALT', 'real 全链未完成', false, err instanceof Error ? err.message.slice(0, 300) : String(err))
} finally {
  const pass = results.filter(r => r.pass).length
  console.log(`\n=== AML REAL CHAIN  pass=${pass}/${results.length} ===`)
  DB.close()
}
