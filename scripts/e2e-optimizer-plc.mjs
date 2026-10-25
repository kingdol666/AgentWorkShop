#!/usr/bin/env node
/* eslint-disable @stylistic/max-statements-per-line */
/**
 * AML + Optimizer 真实 PLC 采样数据集成 E2E(2026-10-23)。
 *
 * 前置:scripts/_provision-injection-line.mjs + e2e-injection-recipe-closedloop.mjs 已在
 * 隔离平台(AW_BASE,隔离 AW_HOME)上跑出真实协议采样(注塑产线,http 驱动 → plc-node-simulator)。
 *
 * 本脚本用**真实采样**走完整建模-求解-治理链:
 *  R1 数据真实性与谱系:真实 runs + confirmed segments → 数据集 lineage_verified=1
 *  R2 规格→资格→训练→模型(真实噪声数据的 ARX 拟合与门禁)
 *  R3 Profile→绑定→solve→建议(verified/unverified 两态)
 *  R4 互校 crosscheck;若 dual 则 dispatch→HITL 批准→DCW 真实写入→回读
 *
 * 运行:AW_BASE=http://127.0.0.1:3111 AW_HOME=<隔离根> npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-optimizer-plc.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3111'
const HOME = process.env.AW_HOME
if (!HOME) { console.error('需要 AW_HOME(与平台同一隔离根)'); process.exit(1) }
process.env.NO_PROXY = '127.0.0.1,localhost'
const EVID = join(process.cwd(), 'docs', 'audit', 'evidence', '2026-10-23-plc-integration')
mkdirSync(EVID, { recursive: true })

const results = []
const check = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 500) })
  console.log(`${cond ? '✔' : '✘'} [${id}] ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`)
  return Boolean(cond)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const { openWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { configureAmlRuntime } = await import('../server/services/workshop/aml/runtime')
const { recipeContentHash, getContextSegmentRepo } = await import('../server/services/workshop/process-model/context-segments.repo')
const { getDcwRecipeRepo } = await import('../server/services/workshop/dcw/dcw-recipe.repo')

const db = openWorkshopDb(join(HOME, 'data', 'workshop.sqlite'))
configureAmlRuntime(db)

async function api(method, path, body, token, timeoutMs = 120_000) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const json = await res.json().catch(() => ({}))
      return { status: res.status, ...json }
    }
    catch (err) {
      if (attempt === 2) return { status: -1, message: String(err).slice(0, 200) }
      await sleep(1500)
    }
  }
}

const data = r => r?.data

// ═══ 0. 登录 + 发现真实场景资产 ═══
const login = await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })
const token = data(login)?.token
check('P0.1', '平台登录', Boolean(token), login.message ?? '')
if (!token) { writeReport(); process.exit(1) }

const linesResp = await api('GET', '/api/workshop/dcw/lines', undefined, token)
const line = (data(linesResp)?.lines ?? []).find(l => /注塑成型质量窗口寻优/.test(l.name))
check('P0.2', '发现注塑真实产线', Boolean(line?.id), `line=${line?.id} name=${line?.name}`)
const nodesResp = await api('GET', '/api/workshop/daq', undefined, token)
const daqNodes = data(nodesResp)?.nodes ?? data(nodesResp)?.controller?.nodes ?? []
const mvNode = daqNodes.find(n => n.id?.startsWith('dn-') && /mold-temp/.test(`${n.name ?? ''}${n.templateKey ?? ''}`) && n.lineId === line.id)
  ?? daqNodes.find(n => n.lineId === line.id && /mold-temp/i.test(`${n.templateKey ?? ''}${n.name ?? ''}`))
const cvNode = daqNodes.find(n => n.lineId === line.id && /mold-temp/i.test(`${n.templateKey ?? ''}${n.name ?? ''}`))
  ?? daqNodes.find(n => n.lineId === line.id && /part-weight|克重|weight/i.test(`${n.templateKey ?? ''}${n.name ?? ''}`))
check('P0.3', '定位 MV/CV 真实数采节点', Boolean(mvNode?.id && cvNode?.id), `mv=${mvNode?.id}(${mvNode?.name}) cv=${cvNode?.id}(${cvNode?.name})`)
const dcwResp = await api('GET', '/api/workshop/dcw', undefined, token)
const dcwNodes = data(dcwResp)?.nodes ?? []
const holdSp = dcwNodes.find(n => /mold-temp-sp|模温/.test(`${n.name ?? ''}${n.id ?? ''}`))
check('P0.4', '定位保压执行节点(下发的 controlNodeId)', Boolean(holdSp?.id), `dcw=${holdSp?.id} readValue=${holdSp?.readValue}`)

// ═══ 1. 真实 runs + 谱系段 ═══
const runsResp = await api('GET', `/api/workshop/dcw/runs?lineId=${encodeURIComponent(line.id)}&limit=50`, undefined, token)
const runs = (data(runsResp)?.runs ?? []).filter(r => r.startedAt && r.recipeId)
  .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
check('P1.1', '真实批次 runs ≥1(闭环作业产物)', runs.length >= 1, `runs=${runs.length} latest=${runs[0]?.id} open=${runs.filter(r => !r.endedAt).length}`)
const usable = runs.slice(0, 6)
const currentRecipeId = String(usable[0]?.recipeId ?? '')
const currentProductId = String(usable[0]?.productId ?? '')
const recipeRepo = getDcwRecipeRepo()
const allRecipes = recipeRepo.list?.() ?? []
const recipe = allRecipes.find(r => r.id === currentRecipeId)
check('P1.2', '定位产线配方(与 run 一致)', Boolean(recipe?.id), `recipe=${recipe?.id} v${recipe?.version ?? 1} params=${(recipe?.params ?? []).length}`)
const segRepo = getContextSegmentRepo()
const segHash = recipeContentHash(recipe)
let segInserted = 0
for (const r of usable) {
  const from = new Date(r.startedAt).getTime()
  const to = r.endedAt ? new Date(r.endedAt).getTime() : Date.now()
  if (!(to > from)) continue
  try {
    segRepo.insert({ lineId: line.id, runId: r.id, fromTs: from, toTs: to, recipeId: recipe.id, recipeVersion: recipe.version ?? 1, recipeContentHash: segHash, conditionId: 'c-plc', source: 'line_run', confirmed: true })
    segInserted++
  }
  catch { /* 重复段幂等跳过 */ }
}
check('P1.3', 'confirmed context segments 落谱系(真实 run×当前配方)', segInserted >= 1, `inserted=${segInserted}/${usable.length}`)

// ═══ 2. 规格 → 数据集 → 资格 ═══
const beatMs = 2000
const SPEC = `pms-plc-${Date.now().toString(36).slice(-5)}`
const specBody = {
  schemaVersion: 2, id: SPEC, version: 1,
  lineId: line.id, productId: currentProductId || recipe.productId, recipeId: recipe.id, recipeVersion: recipe.version ?? 1,
  conditions: [{ id: 'c-plc', match: [{ field: 'recipeId', op: 'eq', value: recipe.id }] }],
  variables: [
    { id: 'mv1', nodeId: mvNode.id, role: 'mv', field: 'value', unit: mvNode.unit ?? '℃', scale: 1, offset: 0, delayMs: 3 * beatMs, min: 0, max: 200, maxStep: 40, controlNodeId: holdSp?.id },
    { id: 'cv1', nodeId: cvNode.id, role: 'cv', field: 'value', unit: cvNode.unit ?? '℃', scale: 1, offset: 0, min: 0, max: 200 },
  ],
  timing: { beatMs, historySteps: 40, horizonSteps: 6, fixedDt: true },
  trainer: { ref: 'linear_arx@1', config: { arOrder: 1, inputOrder: 1, ridgeLambda: 1e-6, standardize: true } },
  datasetPolicy: { split: { valRatio: 0.4, testRatio: 0.4, seed: 42 }, cleaning: { hampelK: 0 } },
  gatePolicyRef: 'process-model.gates@1',
  modelInterface: { id: 'linear_state_space', version: 1, inputSemantics: 'setpoint', mode: 'state_space' },
  effectiveDomain: { mv: { mv1: { min: 0, max: 200, maxStep: 40 } }, cv: { cv1: { min: 0, max: 200 } } },
  purpose: 'mpc_surrogate',
}
const specCreated = await api('POST', '/api/workshop/process-model/specs', specBody, token)
check('P2.1', '登记真实场景规格', specCreated.status === 200, `${specCreated.status}/${specCreated.message ?? ''}`)
const specPub = await api('POST', `/api/workshop/process-model/specs/${encodeURIComponent(SPEC)}/publish`, {}, token)
check('P2.2', '发布规格(不可变)', specPub.status === 200, `${specPub.status}/${specPub.message ?? ''}`)
const ds = await api('POST', '/api/workshop/process-model/datasets', specBody, token)
const datasetId = data(ds)?.datasetId
check('P2.3', '构建数据集(真实采样)', ds.status === 200 && Number(data(ds)?.rowCount ?? 0) > 100, `rows=${data(ds)?.rowCount} runs=${(data(ds)?.runIds ?? []).length} excluded=${(data(ds)?.excludedRuns ?? []).length} ${ds.message ?? ''}`)
const dsGet = await api('GET', `/api/workshop/aml/datasets/${encodeURIComponent(datasetId ?? '')}`, undefined, token)
check('P2.4', '谱系核验 lineage_verified=1', Number(data(dsGet)?.dataset?.lineageVerified ?? 0) === 1, `lineage=${data(dsGet)?.dataset?.lineageVerified}`)
const elig = await api('POST', '/api/workshop/process-model/eligibility', { specId: SPEC, datasetId }, token)
const eligReport = data(elig)?.report ?? data(elig)?.eligibility?.report ?? data(elig)
check('P2.5', '资格评估(真实数据具备优化资格)', elig.status === 200 && eligReport?.optimizationEligible === true, `status=${elig.status} eligible=${eligReport?.optimizationEligible} gaps=${(eligReport?.gaps ?? []).map(g => g.code).join(',')} ${elig.message ?? ''}`)

// ═══ 3. 训练(真实噪声数据的 ARX 拟合 + 平台门禁) ═══
const train = await api('POST', '/api/workshop/process-model/train', { spec: specBody, datasetId }, token)
const jobId = data(train)?.jobId
check('P3.1', '提交训练作业', train.status === 200 && Boolean(jobId), `${train.status}/${train.message ?? ''}`)
let job = null
for (let i = 0; i < 120 && job?.status !== 'done' && job?.status !== 'failed'; i++) {
  await sleep(3000)
  const jr = await api('GET', `/api/workshop/aml/jobs/${encodeURIComponent(jobId ?? '')}`, undefined, token)
  job = data(jr)?.job ?? data(jr)
}
const modelId = job?.modelId
check('P3.2', '训练作业完成(真实数据过平台门禁)', job?.status === 'done' && Boolean(modelId), `status=${job?.status} model=${modelId} err=${job?.error ?? ''} metrics=${JSON.stringify(job?.metrics?.platform?.rolloutTest ?? job?.metrics?.platform?.oneStepTest ?? {}).slice(0, 160)}`)

// 训练失败(真实数据未过门禁)是诚实结果:链路到训练为止,后面跳过
if (job?.status === 'done' && modelId) {
  const ws = data(await api('POST', '/api/workshop/workspaces', { name: `PLC优化工作区-${Date.now().toString(36).slice(-4)}` }, token))
  const ch = data(await api('POST', '/api/workshop/channels', { name: `PLC优化频道-${Date.now().toString(36).slice(-4)}`, leadAgent: { name: 'plc-lead', harness: 'mock', config: { delayMs: 120 } } }, token))
  const leadAgentId = ch?.leadAgentId ?? ''
  const wsId = ws?.id ?? ''
  const channelId = ch?.channelId ?? ch?.id ?? ''
  if (wsId && channelId && leadAgentId) await api('POST', `/api/workshop/workspaces/${wsId}/channels/${channelId}`, undefined, token)
  check('P4.1', '建工作区/频道/lead 实例并挂载', Boolean(wsId && channelId && leadAgentId), `ws=${wsId} ch=${channelId} lead=${leadAgentId}`)

  const cfg = { linear_mpc_quadratic: { cvWeights: { cv1: 1 }, duWeights: { mv1: 0.05 }, terminalWeight: 2, targets: { cv1: 55 }, targetsUnit: 'engineering' } }
  const prof = await api('POST', '/api/workshop/optimization/profiles', { id: `optp-plc-${Date.now().toString(36).slice(-5)}`, modelId, template: 'linear_mpc_quadratic@1', solver: 'osqp_mpc@1', processSpecRef: `${SPEC}@1`, problemConfig: cfg }, token)
  const profileId = data(prof)?.profile?.id ?? ''
  check('P4.2', '登记 Profile(服务端回填工件)', prof.status === 200 && Boolean(profileId), `${prof.status}/${prof.message ?? ''}`)
  const pub = await api('POST', `/api/workshop/optimization/profiles/${encodeURIComponent(profileId)}/publish`, {}, token)
  check('P4.3', '发布 Profile', pub.status === 200, `${pub.status}/${pub.message ?? ''}`)
  const bind = await api('POST', '/api/workshop/optimization/bindings', { workspaceId: wsId, channelId, agentInstanceId: leadAgentId, profileId, profileVersion: 1, mode: 'recommendation' }, token)
  const bindingId = data(bind)?.binding?.id ?? ''
  check('P4.4', '绑定 Agent(授权面=绑定面)', bind.status === 200 && Boolean(bindingId), `${bind.status}/${bind.message ?? ''}`)

  const solve = await api('POST', '/api/workshop/optimization/solve', { agentInstanceId: leadAgentId }, token, 180_000)
  const outcome = data(solve)
  const recId = String(outcome?.recommendation?.id ?? '')
  const solveOk = solve.status === 200 && outcome?.result?.status === 'optimal'
  check('P4.5', '真实数据求解 optimal + 建议两态', solveOk && ['verified', 'unverified'].includes(outcome?.recommendation?.status), `status=${outcome?.result?.status} firstMove=${JSON.stringify(outcome?.result?.firstMoveEngineering ?? outcome?.result?.firstMove)} rec=${outcome?.recommendation?.status} reason=${outcome?.recommendation?.statusLabel ?? ''}`)
  const firstEng = outcome?.result?.firstMoveEngineering?.mv1
  check('P4.6', 'firstMoveEngineering 与模型单位换算一致(scale=1)', Number.isFinite(firstEng) && Math.abs(firstEng - (outcome?.result?.firstMove?.mv1 ?? Number.NaN)) < 1e-9, `eng=${firstEng} model=${outcome?.result?.firstMove?.mv1}`)

  if (solveOk && recId) {
    const xc = await api('POST', `/api/workshop/optimization/recommendations/${encodeURIComponent(recId)}/crosscheck`, {}, token)
    const dual = data(xc)?.dual?.dual === true
    check('P5.1', '候选互校(真实模型 worker vs predictor)', xc.status === 200 && data(xc)?.crosscheck?.verdict === 'pass', `verdict=${data(xc)?.crosscheck?.verdict} maxDev=${JSON.stringify(data(xc)?.crosscheck?.maxDev)} dual=${dual}`)
    if (dual) {
      const disp = await api('POST', `/api/workshop/optimization/recommendations/${encodeURIComponent(recId)}/dispatch`, { note: '真实PLC场景集成:申请下发' }, token)
      const cardId = String(data(disp)?.dispatch?.cardId ?? '')
      check('P5.2', '真实场景下发建卡', disp.status === 200 && cardId.startsWith('optimizer-recipe:'), `${disp.status}/${cardId || disp.message || ''}`)
      if (cardId) {
        let card = null
        for (let i = 0; i < 10 && !card; i++) {
          const pending = data(await api('GET', '/api/workshop/agent-tools/approvals', undefined, token))
          card = (pending?.approvals ?? []).find(a => a.id === cardId || String(a.nodeId ?? '') === cardId)
          if (!card) await sleep(1000)
        }
        check('P5.3', '审批面可见真实下发卡', Boolean(card), `id=${card?.id}`)
        if (card) {
          const before = holdSp?.readValue
          const decide = await api('POST', `/api/workshop/agent-tools/approvals/${encodeURIComponent(card.id)}/decide`, { approved: true, comment: 'PLC 集成验收批准' }, token)
          const acks = data(decide)?.dispatch?.execution?.acks
          check('P5.4', 'HITL 批准 → D13 重验 → 整批写入', decide.status === 200 && data(decide)?.dispatch?.approved === true && acks?.verified >= 1, `${decide.status}/${JSON.stringify(data(decide)?.dispatch ?? decide).slice(0, 160)}`)
          await sleep(1500)
          const dcwAfter = await api('GET', '/api/workshop/dcw', undefined, token)
          const nodeAfter = (JSON.parse(JSON.stringify(data(dcwAfter) ?? {})).nodes ?? []).find(n => n.id === holdSp?.id)
          check('P5.5', '执行节点回读变化(真实驱动写入)', nodeAfter && Number.isFinite(nodeAfter.readValue) && nodeAfter.readValue !== before, `before=${before} after=${nodeAfter?.readValue}`)
        }
      }
    }
  }
}

// ═══ 报告 ═══
function writeReport() {}
const pass = results.filter(r => r.pass).length
const report = { at: new Date().toISOString(), base: BASE, home: HOME, line: line?.id, total: results.length, pass, fail: results.length - pass, results }
writeFileSync(join(EVID, 'optimizer-plc-report.json'), JSON.stringify(report, null, 2))
console.log(`\n${pass}/${results.length} 通过;证据:${join(EVID, 'optimizer-plc-report.json')}`)
process.exit(pass === results.length ? 0 : 1)
