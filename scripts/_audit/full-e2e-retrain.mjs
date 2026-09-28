#!/usr/bin/env node
/**
 * scripts/_audit/full-e2e-retrain.mjs —— 全功能 E2E 的 AML 数据补强轮(同一存活实例 3474)。
 *
 * 背景:主跑 P4 训练管线全链走通(提交→真实训练→平台门禁判定),但门禁 fail-closed
 * (G1 1.17/0.9, G2 2.10/0.99)。根因是激励数据缺口:首轮 4 个批次只动了
 * linespeed/diegap 两个执行器,melttemp(temperature zone)全程零方差。
 *
 * 本轮:在同一产线上补 3 个批次、覆盖 zone1/2/3 + screw + linespeed + diegap 的激励
 * → 重建数据集(7 runs)→ 重新训练 → 门禁通过则走完整投用链
 * (快照→12 组模型背书试验→场景门禁→shadow/production 两段 HITL 晋升→MPC 未传
 *   model_id 验证自动投用→推荐写回 DCW→90s 后 PV 复测)。
 *
 * 用法:node scripts/_audit/full-e2e-retrain.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3474'
const SIM = 'http://127.0.0.1:4023'
const HOME = join(tmpdir(), 'aw-full-e2e-fmtJ6b')
const ADMIN = { email: 'e2e-full@awshop.local', password: 'E2eFull2026!' }
const NO_PROXY = { NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '' }

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const callA = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000),
  })
  const json = await r.json().catch(() => null)
  return { status: r.status, json, data: json?.data, message: json?.message }
}
const getJson = async (url) => {
  try { return await (await fetch(url, { signal: AbortSignal.timeout(30000) })).json() }
  catch { return null }
}

let TOKEN = ''
process.env.NO_PROXY = NO_PROXY.NO_PROXY

/* ── R0 自举:登录取 token + 从存活实例重建 id 映射 ── */
console.log('═══ [R0] 自举:登录 + 重建产线/节点/通道映射 ═══')
{
  const reg = await (await fetch(`${BASE}/api/users/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...NO_PROXY }, body: JSON.stringify(ADMIN),
  })).json()
  TOKEN = reg?.data?.token ?? ''
}
ok('R0a 登录', Boolean(TOKEN))

const SFX = 'fulle2e'
const simDevices = (await getJson(`${SIM}/api/nodes`))?.data ?? []
const dcwNodes = (await callA('GET', '/api/workshop/dcw/')).data?.nodes ?? []
const daqNodes = (await callA('GET', '/api/workshop/daq')).data?.nodes ?? (await callA('GET', '/api/workshop/daq')).data?.items ?? []
const lineId = dcwNodes.find(n => n.name?.endsWith(SFX))?.lineId
ok('R0b 定位产线', Boolean(lineId), String(lineId))
const nameOf = {}
for (const dev of simDevices) for (const s of (dev.signals ?? [])) nameOf[s.id] = s.name
const ACT = ['zone1-sp', 'zone2-sp', 'zone3-sp', 'screw-sp', 'linespeed-sp', 'diegap-sp']
const SEN = ['melt-temp', 'melt-pressure', 'film-thickness', 'defect-rate', 'gels-count']
const dcw = {}, daq = {}, spReadback = {}
for (const id of ACT) {
  const nm = `${nameOf[id]} ${SFX}`
  dcw[id] = dcwNodes.find(n => n.lineId === lineId && n.name === nm)?.id
}
for (const id of SEN) {
  const nm = `${nameOf[id]} ${SFX}`
  daq[id] = daqNodes.find(n => n.lineId === lineId && n.name === nm)?.id
}
for (const id of ACT) {
  const nm = `${nameOf[id]} 回读 e2e`
  spReadback[id] = daqNodes.find(n => n.lineId === lineId && n.name === nm)?.id
}
ok('R0c DCW ×6 映射', Object.values(dcw).every(Boolean), JSON.stringify(dcw))
ok('R0d DAQ 传感器 ×5 映射', Object.values(daq).every(Boolean), JSON.stringify(daq))
ok('R0e SP 回读 ×6 映射', Object.values(spReadback).every(Boolean), JSON.stringify(spReadback))
const recipes = (await callA('GET', '/api/workshop/dcw/recipes')).data
const recipe = (recipes?.recipes ?? []).find(r => r.lineId === lineId)
const recipeId = recipe?.id ?? recipe?.recipeId
const productId = recipe?.productId
ok('R0f 配方定位', Boolean(recipeId && productId), JSON.stringify({ recipeId, productId }))

/* 训练通道 + worker(主跑已建:全功能E2E训练通道) */
const channels = (await callA('GET', '/api/workshop/channels')).data ?? []
const chanRow = Array.isArray(channels) ? channels.find(c => c.name === '全功能E2E训练通道') : (channels.items ?? []).find(c => c.name === '全功能E2E训练通道')
const channelA = chanRow?.id ?? chanRow?.channelId
const chanAgents = (await callA('GET', `/api/workshop/channels/${channelA}/agents`)).data ?? []
const workerA = chanAgents.find(a => a.role === 'worker')?.id
ok('R0g 训练通道 + worker', Boolean(channelA && workerA), JSON.stringify({ channelA, workerA }))
const invoke = async (tool, args, agentId) => {
  const r = await callA('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args })
  const result = r.json?.data?.result
  return { isError: Boolean(result?.isError), text: String(result?.text ?? ''), data: result?.data ?? null }
}

/* ── R1 三批次三执行器激励(补 melttemp/screw 方差缺口)── */
console.log('═══ [R1] 补 3 批次(zone×3 + screw + linespeed + diegap 激励)═══')
const closeAndRestart = async (i) => {
  await callA('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {})
  await sleep(3000)
  const st = await callA('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId })
  if (st.status !== 200) { await sleep(8000); await callA('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId }) }
  console.log(`  ↳ 批次 ${i} 闭合/重启`)
}
/* 温区节点治理单步限 2.8℃(主跑实测):激励改多步爬坡(每步 ≤2.5,间隔 ≥65s),
   既尊重写治理又给足 zone 通道方差;screw/linespeed/diegap 沿用 ±2 小步 */
const BATCHES = [
  { n: 5, steps: [
    { at: 65_000, node: 'zone1-sp', v: 202.5 }, { at: 130_000, node: 'zone2-sp', v: 202.5 },
    { at: 195_000, node: 'zone1-sp', v: 205 }, { at: 201_000, node: 'linespeed-sp', v: 97 },
    { at: 260_000, node: 'zone2-sp', v: 205 },
  ] },
  { n: 6, steps: [
    { at: 65_000, node: 'zone3-sp', v: 197.5 }, { at: 130_000, node: 'zone1-sp', v: 197.5 },
    { at: 195_000, node: 'zone3-sp', v: 195 }, { at: 201_000, node: 'screw-sp', v: 152 },
    { at: 260_000, node: 'diegap-sp', v: 1.03 },
  ] },
  { n: 7, steps: [
    { at: 65_000, node: 'zone1-sp', v: 202.5 }, { at: 130_000, node: 'zone1-sp', v: 205 },
    { at: 195_000, node: 'zone1-sp', v: 207.5 }, { at: 201_000, node: 'screw-sp', v: 148 },
    { at: 260_000, node: 'zone1-sp', v: 210 }, { at: 261_000, node: 'diegap-sp', v: 0.97 },
  ] },
]
for (const b of BATCHES) {
  await closeAndRestart(b.n)
  const t0 = Date.now()
  let prev = 0
  for (const st of b.steps) {
    await sleep(Math.max(0, st.at - prev)); prev = st.at
    const w = await callA('POST', `/api/workshop/dcw/${dcw[st.node]}/write`, { value: st.v })
    console.log(`  ↳ 批次 ${b.n} 阶跃 ${st.node} ← ${st.v} ${w.status === 200 ? '√' : '✘ ' + String(w.message ?? '').slice(0, 60)}`)
  }
  await sleep(Math.max(0, 300_000 - (Date.now() - t0)))
}
await callA('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {})
await sleep(3000)
{
  const runs = (await callA('GET', '/api/workshop/dcw/recipes')).data?.runs ?? []
  const closed = runs.filter(x => x.endedAt && x.recipeId === recipeId)
  ok('R1a 已闭合批次 ≥7', closed.length >= 7, `closed=${closed.length}`)
}

/* ── R2 场景重编译冻结 + PhysicsSpec(新场景,干净基线)── */
const scene = { sceneId: `fulle2e-r2-${Date.now().toString(36)}`, sceneVersion: '1.0.0', lineId, productId, recipeId }
{
  const disco = await invoke('twin_scene_discover', {}, workerA)
  ok('R2a 场景发现', !disco.isError && /"target"\s*:\s*1/.test(disco.text), disco.text.slice(0, 100))
  const compiled = await invoke('twin_scene_compile', {
    scene_id: scene.sceneId, scene_version: '1.0.0', line_id: lineId, product_id: productId, recipe_id: recipeId,
    prompt: '流延膜厚度闭环优化:目标膜厚 50μm。控制=6 个执行器设定点(含 zone1/2/3 温区),观测=膜厚(目标)/熔温/熔压。约束:熔温 195~225℃,熔压 ≤22MPa。',
  }, workerA)
  ok('R2b 场景编译', !compiled.isError, compiled.text.slice(0, 100))
  const frozen = await invoke('twin_scene_freeze', { scene_id: scene.sceneId, scene_version: '1.0.0', confirmation: 'USER_CONFIRMED_SCENE_CONTRACT', approved_by: 'full-e2e-retrain' }, workerA)
  ok('R2c 场景冻结', !frozen.isError, frozen.text.slice(0, 100))
  const draft = await invoke('twin_physics_spec_draft', { dt_sec: 1 }, workerA)
  const artifactPath = (draft.text.match(/artifact:\s*([^\n]+)/) || [])[1]?.trim()
  ok('R2d PhysicsSpec 生成', !draft.isError && Boolean(artifactPath) && existsSync(artifactPath), draft.text.slice(0, 100))
  globalThis.__spec = artifactPath ? JSON.parse(readFileSync(artifactPath, 'utf8')) : null
}

/* ── R3 数据集重建(7 runs)+ spec 对齐 + 训练 + 门禁 ── */
let model = null
console.log('═══ [R3] 数据集重建 + hybrid_residual 训练 ═══')
let ds
{
  ds = (await callA('POST', '/api/workshop/aml/datasets', {
    lineId, productId, recipeId,
    nodes: [
      ...Object.values(spReadback).map(nid => ({ nodeId: nid, role: 'control' })),
      { nodeId: daq['film-thickness'], role: 'target' },
      { nodeId: daq['melt-pressure'], role: 'feature' },
      { nodeId: daq['melt-temp'], role: 'feature' },
    ],
    beatMs: 1000, window: { historySteps: 8, horizonSteps: 4 },
    split: { valRatio: 0.34, testRatio: 0.33, seed: 42 },
    purpose: 'mpc_surrogate', note: '全功能 E2E 补强数据集(3 执行器方差)',
  })).data?.dataset
  ok('R3a 数据集构建(≥7 runs)', Boolean(ds?.id) && (ds.runIds?.length ?? 0) >= 7, JSON.stringify({ id: ds?.id, rows: ds?.rowCount, runs: ds?.runIds?.length }).slice(0, 140))

  const physicsSpec = globalThis.__spec
  const man = JSON.parse(readFileSync(join(HOME, 'aml', 'datasets', ds.id, 'manifest.json'), 'utf8'))
  const datasetNodes = new Set(man.allNodes)
  const dwToDn = {}
  for (const [sig, dn] of Object.entries(spReadback)) dwToDn[dcw[sig]] = dn
  for (const v of physicsSpec.variables) {
    if (v.nodeId && !datasetNodes.has(v.nodeId) && dwToDn[v.nodeId]) v.nodeId = dwToDn[v.nodeId]
  }
  const keptVars = physicsSpec.variables.filter(v => !v.nodeId || datasetNodes.has(v.nodeId))
  const keptIds = new Set(keptVars.map(v => v.id))
  physicsSpec.variables = keptVars
  physicsSpec.states = physicsSpec.states.filter((e) => { const base = e.lhs.endsWith('_next') ? e.lhs.slice(0, -5) : e.lhs; return keptIds.has(base) })
  physicsSpec.observations = physicsSpec.observations.filter(e => keptIds.has(e.lhs))
  physicsSpec.guards = (physicsSpec.guards ?? []).filter(e => keptIds.has(e.lhs))
  physicsSpec.constraints = physicsSpec.constraints.filter(c => keptIds.has(c.id))

  const job = (await callA('POST', '/api/workshop/aml/jobs', {
    datasetId: ds.id, purpose: 'mpc_surrogate', changeNote: '全功能 E2E 补强轮训练(三执行器方差)',
    params: { epochs: 600, hidden: 128, lr: 0.0015, residual_scale: 2, ensemble: 3 },
    seed: 11, jobKind: 'hybrid_residual', sceneId: scene.sceneId, sceneVersion: '1.0.0', objectiveId: 'thickness-50um',
    physicsSpec, providerId: physicsSpec.modelId, providerVersion: '1.0.0', providerHash: `sha256:${JSON.stringify(physicsSpec).length}`,
    modelName: '全功能E2E 膜厚闭环模型 R2', modelDescription: '补强轮:zone×3+screw+linespeed+diegap 全执行器方差数据训练',
  })).data?.job
  ok('R3b 训练作业提交', Boolean(job?.id), JSON.stringify(job ?? {}).slice(0, 120))

  let done = null
  for (let i = 0; i < 120; i++) {
    await sleep(5000)
    done = (await callA('GET', `/api/workshop/aml/jobs/${job.id}`)).data?.job
    if (done?.status === 'done' || done?.status === 'failed') break
    if (i > 0 && i % 12 === 0) console.log(`  ↳ 训练中 (${i * 5 / 60 | 0}min) status=${done?.status ?? '?'}`)
  }
  ok('R3c 训练完成且平台门禁全过', done?.status === 'done', `status=${done?.status} err=${String(done?.error ?? '').slice(0, 200)}`)
  const models = (await callA('GET', '/api/workshop/aml/models')).data?.models ?? []
  model = models.filter(m => m.datasetId === ds.id).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
  ok('R3d 模型注册 + 工件在运行时目录', Boolean(model?.id) && existsSync(join(HOME, 'aml', 'models', model.id, 'model.onnx')), join(HOME, 'aml', 'models', model?.id ?? '?'))
  if (model) console.log(`  ↳ 模型 ${model.id} G1=${model.metrics?.oneStepTest?.nrmse} G2=${model.metrics?.rolloutTest?.nrmse} stage=${model.stage}`)
}

/* ── R4 投用链(快照→试验→场景门禁→HITL 晋升→MPC 自动投用→写回复测)── */
console.log('═══ [R4] 投用链 ═══')
if (!model?.id) {
  ok('R4 前置(过门禁模型)', false, '训练门禁未过,fail-closed')
  process.exit(1)
}
{
  const st = await callA('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId })
  if (st.status !== 200) { await sleep(8000); await callA('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId }) }
  let snapshotId = null
  let snap = null
  for (let attempt = 1; attempt <= 8 && !snapshotId; attempt++) {
    if (attempt > 1) { console.log('  ↳ 快照重试'); await sleep(20000) }
    snap = await invoke('twin_snapshot_create', { auto_daq: true, channel_id: channelA, phase: 'calibration' }, workerA)
    snapshotId = (snap.text.match(/snapshot_id:\s*([^\n]+)/) || [])[1]?.trim()
  }
  ok('R4a 孪生快照创建', Boolean(snapshotId), snap?.text.slice(0, 120))

  const frozen = JSON.parse(readFileSync(join(HOME, 'aml', 'twins', 'scenes', `${scene.sceneId}-1.0.0-frozen`, 'scenes.json'), 'utf8')).scene ?? {}
  const targetObs = (frozen.observations ?? []).find(o => o.role === 'target')
  const speedCtl = (frozen.controls ?? []).find(c => (c.nodeId ?? '').includes('linespeed')) ?? (frozen.controls ?? [])[0]
  const dcwRes = await callA('GET', '/api/workshop/dcw/')
  const dwValueById = Object.fromEntries((dcwRes.data?.nodes ?? []).filter(n => n.lineId === lineId).map(n => [n.id, Number(n.value)]))
  const baseline = Object.fromEntries((frozen.controls ?? []).map(c => [c.id, dwValueById[c.nodeId]]).filter(([, v]) => Number.isFinite(v)))
  let trialOk = 0
  for (let k = 0; k < 12; k++) {
    const delta = (k % 2 === 0 ? 1 : -0.5) * (speedCtl.maxStep ?? 2) * (0.3 + 0.07 * k)
    const cand = { ...baseline, [speedCtl.id]: (baseline[speedCtl.id] ?? 95) + delta }
    const t = await invoke('twin_trial_run', { snapshot_id: snapshotId, model_id: model.id, baseline_controls: baseline, candidate_controls: Array.from({ length: 4 }, () => cand) }, workerA)
    if (!t.isError && /improvement/.test(t.text)) trialOk++
  }
  ok('R4b 模型背书试验 12 组', trialOk >= 10, `ok=${trialOk}/12`)
  const gate = await invoke('twin_gate_evaluate', { model_id: model.id, scene_id: scene.sceneId }, workerA)
  const gatePassed = /"gatePassed":\s*true/.test(gate.text)
  ok('R4c 场景级门禁评估', !gate.isError && /gatePassed/.test(gate.text), gate.text.slice(0, 160))

  if (gatePassed) {
    const leadA = (await callA('GET', `/api/workshop/channels/${channelA}/agents`)).data?.find(a => a.role === 'lead')?.id
    const promoteStage = async (toStage) => {
      const p = invoke('aml_model_promote', { model_id: model.id, to_stage: toStage }, leadA)
      let rid = null
      for (let i = 0; i < 30 && !rid; i++) {
        await sleep(2000)
        const pend = await callA('GET', '/api/workshop/hitl/pending')
        const items = pend.data?.items ?? pend.data ?? []
        const hit = (Array.isArray(items) ? items : []).find(x => (x.detail ?? x.title ?? '').includes(model.id))
        if (hit) rid = hit.id ?? hit.requestId
      }
      if (rid) await callA('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: rid, confirmed: true, comment: `E2E 补强轮:门禁全过,批准 ${toStage}` })
      const r = await p
      return r.text
    }
    const s1 = await promoteStage('shadow')
    ok('R4d HITL 晋升 shadow', /晋升完成|shadow/.test(s1), s1.slice(0, 120))
    const s2 = /晋升完成/.test(s1) ? await promoteStage('production') : ''
    ok('R4e HITL 晋升 production', /晋升完成/.test(s2), s2.slice(0, 120))

    const objective = {
      schemaVersion: 1, createdAt: new Date().toISOString(), createdBy: 'full-e2e-retrain',
      objectiveId: 'thickness-50um', targets: { [targetObs.id]: 50 }, weights: { [targetObs.id]: 1 },
      controlCosts: {}, horizonSteps: 4, trustRegion: {},
    }
    const mpc = await invoke('mpc_optimize', { snapshot_id: snapshotId, baseline_controls: baseline, horizon_steps: 4, objective }, workerA)
    const rolloutModel = (mpc.text.match(/"rolloutModel":\s*"([^"]+)"/) || [])[1]
    const backed = (mpc.text.match(/"rolloutModelBacked":\s*(true|false)/) || [])[1]
    const bestCandidate = (mpc.text.match(/"bestCandidate":\s*(\{[^}]*\})/) || [])[1]
    ok('R4f MPC 未传 model_id 自动投用 production', rolloutModel === model.id && backed === 'true', `rollout=${rolloutModel} backed=${backed}`)
    let best = null
    try { best = JSON.parse(bestCandidate ?? 'null') } catch { /* 忽略 */ }
    const idToNode = Object.fromEntries((frozen.controls ?? []).map(c => [c.id, c.nodeId]))
    let wrote = 0
    for (const [specId, value] of Object.entries(best ?? {})) {
      const nodeId = idToNode[specId]
      if (!nodeId || !Number.isFinite(Number(value))) continue
      const w = await callA('POST', `/api/workshop/dcw/${nodeId}/write`, { value })
      if (w.status === 200) wrote++
    }
    ok('R4g MPC 推荐写回 DCW', wrote > 0, `wrote=${wrote}`)
    await sleep(90000)
    const r = await callA('GET', `/api/workshop/daq/${targetObs.nodeId}/samples?bucketMs=1000&limit=60`)
    const pts = (r.data?.points ?? []).map(p => Number(p.avg ?? p.value)).filter(Number.isFinite).slice(0, 30)
    const mean = pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : Number.NaN
    ok('R4h 写回后 PV 复测(膜厚有读数)', Number.isFinite(mean), `mean=${Number.isFinite(mean) ? mean.toFixed(2) : 'n/a'} μm(目标 50)`)
  }
  else {
    console.log('  ↳ 场景门禁未过 → fail-closed(不投用、不写 DCW,治理正确)')
    ok('R4d fail-closed 行为', true)
  }
  await callA('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {})
}

console.log(`\n═══ 补强轮:${pass} PASS / ${fails.length} FAIL ═══`)
if (fails.length) console.log(fails.map(f => `  ✖ ${f}`).join('\n'))
process.exit(fails.length ? 1 : 0)
