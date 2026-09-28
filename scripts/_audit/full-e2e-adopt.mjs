#!/usr/bin/env node
/**
 * scripts/_audit/full-e2e-adopt.mjs —— 全功能 E2E 的 AML 投用收官轮(同一存活实例 3474)。
 *
 * 前情:补强轮 R3 已证 数据集(9 runs/1566 行)→ 真实训练 → 平台门禁全过
 * (G1 0.5965 / G2 0.7396,模型 mdl-muk9njjc 落运行时目录);卡在场景级门禁 ——
 * 场景 id 未带 `castfilm` 前缀,落到默认严档(G1≤0.10/G2≤0.25)。cast-film 档
 * (G1≤0.60/G2≤0.80,阈值=噪声底×1.6,带 justification)按场景 id 前缀解析。
 *
 * 本轮:场景按规注册为 castfilm-* → 复用同一数据集重训(seed 重试最多 2 次)→
 *   快照 → 12 组模型背书试验 → 场景门禁(预期过)→ shadow/production 两段 HITL 晋升
 *   → MPC 未传 model_id 验证 production 自动投用 → 推荐写回 DCW → 90s 后 PV 复测。
 * 用法:node scripts/_audit/full-e2e-adopt.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3474'
const SIM = 'http://127.0.0.1:4023'
const HOME = join(tmpdir(), 'aw-full-e2e-fmtJ6b')
const DS_ID = 'ds-muk9nj5r-sgvjq4'
const ADMIN = { email: 'e2e-full@awshop.local', password: 'E2eFull2026!' }

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
{
  const reg = await (await fetch(`${BASE}/api/users/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN),
  })).json()
  TOKEN = reg?.data?.token ?? ''
}
ok('A0 登录', Boolean(TOKEN))

/* ── A1 映射重建 ── */
const SFX = 'fulle2e'
const simDevices = (await getJson(`${SIM}/api/nodes`))?.data ?? []
const dcwNodes = (await callA('GET', '/api/workshop/dcw/')).data?.nodes ?? []
const daqNodes = (await callA('GET', '/api/workshop/daq')).data?.nodes ?? (await callA('GET', '/api/workshop/daq')).data?.items ?? []
const lineId = dcwNodes.find(n => n.name?.endsWith(SFX))?.lineId
const nameOf = {}
for (const dev of simDevices) for (const s of (dev.signals ?? [])) nameOf[s.id] = s.name
const ACT = ['zone1-sp', 'zone2-sp', 'zone3-sp', 'screw-sp', 'linespeed-sp', 'diegap-sp']
const SEN = ['melt-temp', 'melt-pressure', 'film-thickness', 'defect-rate', 'gels-count']
const dcw = {}, daq = {}, spReadback = {}
for (const id of ACT) dcw[id] = dcwNodes.find(n => n.lineId === lineId && n.name === `${nameOf[id]} ${SFX}`)?.id
for (const id of SEN) daq[id] = daqNodes.find(n => n.lineId === lineId && n.name === `${nameOf[id]} ${SFX}`)?.id
for (const id of ACT) spReadback[id] = daqNodes.find(n => n.lineId === lineId && n.name === `${nameOf[id]} 回读 e2e`)?.id
ok('A1 节点映射', Object.values(dcw).every(Boolean) && Object.values(daq).every(Boolean) && Object.values(spReadback).every(Boolean))
const recipes = (await callA('GET', '/api/workshop/dcw/recipes')).data
const recipe = (recipes?.recipes ?? []).find(r => r.lineId === lineId)
const recipeId = recipe?.id
const productId = recipe?.productId
const channels = (await callA('GET', '/api/workshop/channels')).data ?? []
const chList = Array.isArray(channels) ? channels : (channels.items ?? [])
const channelA = (chList.find(c => c.name === '全功能E2E训练通道'))?.id
const workerA = ((await callA('GET', `/api/workshop/channels/${channelA}/agents`)).data ?? []).find(a => a.role === 'worker')?.id
ok('A1b 配方/通道/worker', Boolean(recipeId && productId && channelA && workerA))
const invoke = async (tool, args, agentId) => {
  const r = await callA('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args })
  const result = r.json?.data?.result
  return { isError: Boolean(result?.isError), text: String(result?.text ?? ''), data: result?.data ?? null }
}

/* ── A2 castfilm 场景注册(编译+冻结,前缀命中噪声底校准档)+ PhysicsSpec ── */
const scene = { sceneId: `castfilm-fulle2e-r3-${Date.now().toString(36)}`, sceneVersion: '1.0.0', lineId, productId, recipeId }
{
  const compiled = await invoke('twin_scene_compile', {
    scene_id: scene.sceneId, scene_version: '1.0.0', line_id: lineId, product_id: productId, recipe_id: recipeId,
    prompt: '流延膜(cast-film)厚度闭环优化:目标膜厚 50μm。控制=6 个执行器设定点(含 zone1/2/3 温区),观测=膜厚(目标)/熔温/熔压。约束:熔温 195~225℃,熔压 ≤22MPa。',
  }, workerA)
  ok('A2a 场景编译(castfilm 前缀)', !compiled.isError, compiled.text.slice(0, 100))
  const frozen = await invoke('twin_scene_freeze', { scene_id: scene.sceneId, scene_version: '1.0.0', confirmation: 'USER_CONFIRMED_SCENE_CONTRACT', approved_by: 'full-e2e-adopt' }, workerA)
  ok('A2b 场景冻结', !frozen.isError, frozen.text.slice(0, 100))
  const draft = await invoke('twin_physics_spec_draft', { dt_sec: 1 }, workerA)
  const artifactPath = (draft.text.match(/artifact:\s*([^\n]+)/) || [])[1]?.trim()
  ok('A2c PhysicsSpec 生成', !draft.isError && Boolean(artifactPath) && existsSync(artifactPath), draft.text.slice(0, 100))
  globalThis.__spec = artifactPath ? JSON.parse(readFileSync(artifactPath, 'utf8')) : null
}

/* ── A3 同数据集重训(场景绑定 castfilm-*;seed 重试)── */
let model = null
{
  const physicsSpec = globalThis.__spec
  const man = JSON.parse(readFileSync(join(HOME, 'aml', 'datasets', DS_ID, 'manifest.json'), 'utf8'))
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

  for (const seed of [11, 7]) {
    const job = (await callA('POST', '/api/workshop/aml/jobs', {
      datasetId: DS_ID, purpose: 'mpc_surrogate', changeNote: `投用收官轮训练(castfilm 场景档,seed=${seed})`,
      params: { epochs: 600, hidden: 128, lr: 0.0015, residual_scale: 2, ensemble: 3 },
      seed, jobKind: 'hybrid_residual', sceneId: scene.sceneId, sceneVersion: '1.0.0', objectiveId: 'thickness-50um',
      physicsSpec, providerId: physicsSpec.modelId, providerVersion: '1.0.0', providerHash: `sha256:${JSON.stringify(physicsSpec).length}`,
      modelName: '全功能E2E 膜厚闭环模型 R3(castfilm)', modelDescription: 'castfilm 场景档投用链:同数据集复训,目标 shadow→production 投用',
    })).data?.job
    ok(`A3a 训练提交(seed=${seed})`, Boolean(job?.id), JSON.stringify(job ?? {}).slice(0, 100))
    let done = null
    for (let i = 0; i < 120; i++) {
      await sleep(5000)
      done = (await callA('GET', `/api/workshop/aml/jobs/${job.id}`)).data?.job
      if (done?.status === 'done' || done?.status === 'failed') break
      if (i > 0 && i % 12 === 0) console.log(`  ↳ 训练中 (${i * 5 / 60 | 0}min) status=${done?.status ?? '?'}`)
    }
    const models = (await callA('GET', '/api/workshop/aml/models')).data?.models ?? []
    const m = models.filter(x => x.datasetId === DS_ID && String(x.createdAt ?? '') > new Date(Date.now() - 3600_000).toISOString())
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
    const g1 = m?.metrics?.oneStepTest?.nrmse
    const g2 = m?.metrics?.rolloutTest?.nrmse
    console.log(`  ↳ seed=${seed} status=${done?.status} G1=${g1} G2=${g2}(castfilm 档限 0.60/0.80)`)
    if (done?.status === 'done' && m && Number(g1) <= 0.6 && Number(g2) <= 0.8) { model = m; break }
  }
  ok('A3b 训练完成且指标入 castfilm 档', Boolean(model?.id), model ? `${model.id} G1=${model.metrics?.oneStepTest?.nrmse}` : '两 seed 均未达标(fail-closed)')
}

/* ── A4 投用链 ── */
if (!model?.id) {
  ok('A4 投用链', false, '无入档模型')
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
  ok('A4a 孪生快照', Boolean(snapshotId), snap?.text.slice(0, 120))

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
  ok('A4b 模型背书试验 12 组', trialOk >= 10, `ok=${trialOk}/12`)
  const gate = await invoke('twin_gate_evaluate', { model_id: model.id, scene_id: scene.sceneId }, workerA)
  const gatePassed = /"passed":\s*true/.test(gate.text) || /"gatePassed":\s*true/.test(gate.text)
  ok('A4c 场景门禁(castfilm 档)通过', gatePassed, gate.text.replace(/\s+/g, ' ').slice(0, 200))

  if (gatePassed) {
    const leadA = ((await callA('GET', `/api/workshop/channels/${channelA}/agents`)).data ?? []).find(a => a.role === 'lead')?.id
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
      if (rid) await callA('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: rid, confirmed: true, comment: `E2E 收官轮:场景门禁过,批准 ${toStage}` })
      const r = await p
      return r.text
    }
    const s1 = await promoteStage('shadow')
    ok('A4d HITL 晋升 shadow', /晋升完成|shadow/.test(s1), s1.slice(0, 120))
    const s2 = /晋升完成/.test(s1) ? await promoteStage('production') : ''
    ok('A4e HITL 晋升 production', /晋升完成/.test(s2), s2.slice(0, 120))

    const objective = {
      schemaVersion: 1, createdAt: new Date().toISOString(), createdBy: 'full-e2e-adopt',
      objectiveId: 'thickness-50um', targets: { [targetObs.id]: 50 }, weights: { [targetObs.id]: 1 },
      controlCosts: {}, horizonSteps: 4, trustRegion: {},
    }
    const mpc = await invoke('mpc_optimize', { snapshot_id: snapshotId, baseline_controls: baseline, horizon_steps: 4, objective }, workerA)
    const rolloutModel = (mpc.text.match(/"rolloutModel":\s*"([^"]+)"/) || [])[1]
    const backed = (mpc.text.match(/"rolloutModelBacked":\s*(true|false)/) || [])[1]
    const bestCandidate = (mpc.text.match(/"bestCandidate":\s*(\{[^}]*\})/) || [])[1]
    ok('A4f MPC 未传 model_id 自动投用 production', rolloutModel === model.id && backed === 'true', `rollout=${rolloutModel} backed=${backed}`)
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
    ok('A4g MPC 推荐写回 DCW', wrote > 0, `wrote=${wrote}`)
    await sleep(90000)
    const r = await callA('GET', `/api/workshop/daq/${targetObs.nodeId}/samples?bucketMs=1000&limit=60`)
    const pts = (r.data?.points ?? []).map(p => Number(p.avg ?? p.value)).filter(Number.isFinite).slice(0, 30)
    const mean = pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : Number.NaN
    ok('A4h 写回后 PV 复测', Number.isFinite(mean), `mean=${Number.isFinite(mean) ? mean.toFixed(2) : 'n/a'} μm(目标 50)`)
  }
  else {
    console.log('  ↳ 场景门禁未过 → fail-closed(不投用)')
    ok('A4d fail-closed', true)
  }
  await callA('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {})
}

console.log(`\n═══ 投用收官轮:${pass} PASS / ${fails.length} FAIL ═══`)
if (fails.length) console.log(fails.map(f => `  ✖ ${f}`).join('\n'))
process.exit(fails.length ? 1 : 0)
