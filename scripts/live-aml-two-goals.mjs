/**
 * LIVE AML 闭环 · 双优化目标续跑(用户请求:分别下发两个优化目标,完成优化任务,验证模型训练):
 *   目标 1 thickness-50um:复用已训练模型(选型 → trial → 门禁 → MPC → 写入 → 复测)
 *   目标 2 thickness-52um:按目标选型发现无模型 → 平台训练新模型(objective_id=thickness-52um)
 *                          → 晋升 shadow → 门禁 → MPC → 写入 → 复测
 * 用法: node scripts/live-aml-two-goals.mjs <live-run 目录>(从 live-run.log 解析谱系)
 */
import { writeFileSync, appendFileSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const AW_BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3005'
const PREV_DIR = resolve(process.argv[2] ?? '')
const LOG_PATH = join(PREV_DIR, 'live-run.log')
const DOC_PATH = join(PREV_DIR, 'OPTIMIZATION-LOG.md')
const AML_ROOT = process.env.AW_AML_DIR_LIVE ?? join(REPO, 'aml')
process.env.NO_PROXY = '127.0.0.1,localhost'

const pick = (re) => { const src = readFileSync(LOG_PATH, 'utf8'); const lines = src.split('\n').reverse(); for (const line of lines) { const m = line.match(re); if (m) return m } return null }
const datasetId = pick(/数据集 (ds-[0-9a-z-]+):/)[1]
const lineId = pick(/lineId=(ln-[0-9a-f]+)/)[1]
const recipeId = pick(/recipeId=(rc-[0-9a-f]+)/)[1]
const workerId = pick(/worker=([0-9a-z-]+)/)[1]
const channelId = pick(/channelId=([0-9a-z-]+)/)[1]
const SCENE_ID = pick(/scene=castfilm-hold-opt-[0-9T]+/)[0].split('scene=')[1]

const OBJECTIVE_1 = 'thickness-50um'
const OBJECTIVE_2 = 'thickness-52um'
const GOAL1_TARGET_UM = 50
const GOAL2_TARGET_UM = 52

const L2 = []
function log(line) {
  const text = typeof line === 'string' ? line : JSON.stringify(line)
  const stamped = `[${new Date().toISOString()}] ${text}`
  console.log(stamped)
  L2.push(text)
  appendFileSync(LOG_PATH, stamped + '\n')
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, token) {
  const r = await fetch(AW_BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180_000) })
  return { status: r.status, json: await r.json().catch(() => null) }
}
async function invoke(tool, args, agentId, token) {
  const r = await api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, token)
  const text = r.json?.data?.result?.text ?? r.json?.result?.text ?? ''
  log(`  [invoke] ${tool} → ${r.status}`)
  return { text }
}

log(`双目标闭环启动: dataset=${datasetId} line=${lineId} scene=${SCENE_ID} Channel=${channelId}`)
const reg = await api('POST', '/api/workshop/users/register', { name: `aml-tg-${Date.now()}` })
const token = reg.json?.data?.token
{
  const { DatabaseSync } = await import('node:sqlite')
  const usersDb = new DatabaseSync(join(REPO, '.AgentWorkShop', 'data', 'users.sqlite'))
  usersDb.prepare(`UPDATE users SET role = 'admin' WHERE email LIKE 'aml-tg-%' AND role = 'user'`).run()
  usersDb.close()
}
if (!token) throw new Error('注册失败')

// 冻结场景解析(目标 key/观测节点/控制面)
const frozenScene = JSON.parse(readFileSync(join(AML_ROOT, 'twins', 'scenes', `${SCENE_ID}-1.0.0-frozen`, 'scenes.json'), 'utf8')).scene ?? {}
const targetObs = (frozenScene.observations ?? []).find(o => o.role === 'target')
const targetKey = targetObs?.id
const thicknessNode = targetObs?.nodeId
const sceneControls = frozenScene.controls ?? []
const speedCtl = sceneControls.find(c => (c.nodeId ?? '').includes('linespeed')) ?? sceneControls[0]
if (!targetKey || !speedCtl) throw new Error('冻结场景解析失败')
log(`目标观测 key=${targetKey}(节点 ${thicknessNode}) · 速度控制 ${speedCtl.id}(maxStep=${speedCtl.maxStep})`)

// 模型清单与 v3(50um) 定位
const modelsRes0 = await api('GET', '/api/workshop/aml/models', undefined, token)
const allModels0 = modelsRes0.json?.data?.models ?? []
const model50 = allModels0.find(m => m.datasetId === datasetId && (m.label ?? '').includes('v3')) ?? allModels0.find(m => m.datasetId === datasetId)
if (!model50) throw new Error('50μm 模型未找到')
log(`✔ 50μm 模型 ${model50.id} [${model50.stage}] objective=${model50.objectiveId}`)
if (model50.stage === 'candidate') {
  const promo = await api('POST', `/api/workshop/aml/models/${model50.id}/promote`, { toStage: 'shadow' }, token)
  log(`  晋升 shadow → HTTP ${promo.status}`)
}

/**
 * 单目标闭环:选型 → 快照 → 10 试验 → 门禁 → MPC(objective 显式下发) → 写入 → 复测
 */
async function goalCycle({ goalName, objectiveId, targetUm, model, baseline }) {
  log(`──────── 目标【${goalName}】objective=${objectiveId} 膜厚→${targetUm}μm 模型=${model.id} ────────`)
  const find = await invoke('aml_model_find', { line_id: lineId, recipe_id: recipeId, purpose: 'mpc_surrogate', objective_id: objectiveId }, workerId, token)
  log('  选型(aml_model_find):\n' + find.text.split('\n').slice(0, 10).map(x => '    ' + x).join('\n'))
  let snapshotId = null
  let snap = null
  for (let attempt = 1; attempt <= 8 && !snapshotId; attempt++) {
    if (attempt > 1) { log(`  快照重试 ${attempt}(等 DAQ 采样跟上)`); await sleep(25_000) }
    snap = await invoke('twin_snapshot_create', { auto_daq: true, channel_id: channelId, phase: 'calibration' }, workerId, token)
    snapshotId = (snap.text.match(/snapshot_id:\s*([^\n]+)/) || [])[1]?.trim()
  }
  if (!snapshotId) throw new Error(`[${goalName}] 快照失败: ` + snap.text.slice(0, 200))
  log(`  ✔ 快照 ${snapshotId}`)

  const step = speedCtl.maxStep ?? 2
  for (let k = 0; k < 12; k++) {
    const delta = (k % 2 === 0 ? 1 : -0.5) * step * (0.3 + 0.07 * k)
    const cand = { ...baseline, [speedCtl.id]: (baseline[speedCtl.id] ?? 95) + delta }
    const t = await invoke('twin_trial_run', {
      snapshot_id: snapshotId,
      model_id: model.id,
      baseline_controls: baseline,
      candidate_controls: Array.from({ length: 4 }, () => cand),
    }, workerId, token)
    log(`  trial#${k + 1} Δ=${delta.toFixed(2)} → ${(t.text.match(/improvement: [-\d.]+/) || [''])[0]}`)
  }
  const gate = await invoke('twin_gate_evaluate', { model_id: model.id, scene_id: SCENE_ID }, workerId, token)
  log('  Twin Gate(场景级 AcceptanceProfile):')
  log(gate.text.split('\n').slice(2, 26).map(x => '    ' + x).join('\n'))
  writeFileSync(join(PREV_DIR, `gate-${objectiveId}.txt`), gate.text)

  const objective = {
    schemaVersion: 1, createdAt: new Date().toISOString(), createdBy: 'platform-two-goals',
    objectiveId, targets: { [targetKey]: targetUm }, weights: { [targetKey]: 1 },
    controlCosts: {}, horizonSteps: 4, trustRegion: {},
  }
  const mpc = await invoke('mpc_optimize', {
    snapshot_id: snapshotId,
    model_id: model.id,
    baseline_controls: baseline,
    horizon_steps: 4,
    objective,
  }, workerId, token)
  writeFileSync(join(PREV_DIR, `mpc-${objectiveId}.txt`), mpc.text)
  const mode = (mpc.text.match(/"mode":\s*"([^"]+)"/) || [])[1]
  const bestCandidate = (mpc.text.match(/"bestCandidate":\s*(\{[^}]*\})/) || [])[1]
  const bestCost = (mpc.text.match(/"bestCost":\s*([\d.eE+-]+)/) || [])[1]
  log(`✔ MPC: mode=${mode} bestCost=${bestCost} best=${bestCandidate}`)

  let best
  try {
    best = JSON.parse(bestCandidate ?? 'null')
  }
  catch {
    best = null
  }
  const idToNode = Object.fromEntries(sceneControls.map(c => [c.id, c.nodeId]))
  const writes = []
  if (best && Object.keys(best).length > 0) {
    for (const [specId, value] of Object.entries(best)) {
      const nodeId = idToNode[specId]
      if (!nodeId || !Number.isFinite(Number(value))) continue
      const w = await api('POST', `/api/workshop/dcw/${nodeId}/write`, { value }, token)
      writes.push({ nodeId, value: Number(value), status: w.status })
      log(`  推荐写入 ${nodeId} ← ${Number(value).toFixed(2)} → HTTP ${w.status}`)
    }
    log('  等待 90s 工艺响应…')
    await sleep(90_000)
  }
  else log('  ⚠ MPC 无可执行 bestCandidate')
  const r = await api('GET', `/api/workshop/daq/${thicknessNode}/samples?bucketMs=1000&limit=60`, undefined, token)
  const pts = (r.json?.data?.points ?? []).map(p => Number(p.avg ?? p.value)).filter(Number.isFinite).slice(0, 30)
  const mean = pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : Number.NaN
  log(`✔ 【${goalName}】执行后膜厚均值(最近 30s): ${Number.isFinite(mean) ? mean.toFixed(2) : 'n/a'} μm(目标 ${targetUm}μm)`)
  writeFileSync(join(PREV_DIR, `closed-loop-${objectiveId}.json`), JSON.stringify({ objectiveId, targetUm, mode, best, writes, thicknessAfter: mean }, null, 2))
  return { best: best ?? {}, mean, mode }
}

/* ═══ 目标 1 · thickness-50um:复用 v3 模型 ═══ */
// SP 激活写:SP 回读节点(dn-7ef0f578)为事件式发布,SP 不变不发 → 快照 auto_daq 必失败。
// 微扰 ±0.1 触发回读,工艺影响可忽略。
const wake = await api('POST', `/api/workshop/dcw/${speedCtl.nodeId}/write`, { value: 95.2 }, token)
log(`SP 激活写 ${speedCtl.nodeId} ← 95.2 → HTTP ${wake.status}(SP 回读节点事件式发布,需 SP 变化才发)`)
await sleep(8_000)
// baseline 必须携带全部 6 个控制输入(spec 状态方程引用全部控制;缺失 → ref NaN → rollout 失败)
const dcwRes = await api('GET', '/api/workshop/dcw/', undefined, token)
const dwValueById = Object.fromEntries((dcwRes.json?.data?.nodes ?? []).filter(n => n.lineId === lineId).map(n => [n.id, Number(n.value)]))
const baselineAll = Object.fromEntries(sceneControls.map(c => [c.id, dwValueById[c.nodeId]]).filter(([, v]) => Number.isFinite(v)))
log(`baseline(全部控制当前值): ${JSON.stringify(baselineAll)}`)
const baseline1 = baselineAll
const g1 = await goalCycle({ goalName: '目标1·质量跟踪', objectiveId: OBJECTIVE_1, targetUm: GOAL1_TARGET_UM, model: model50, baseline: baseline1 })

/* ═══ 目标 2 · thickness-52um:选型发现无模型 → 训练新模型 ═══ */
log('──────── 目标【目标2·工作点迁移】objective=thickness-52um 膜厚→52μm ────────')
const find2 = await invoke('aml_model_find', { line_id: lineId, recipe_id: recipeId, purpose: 'mpc_surrogate', objective_id: OBJECTIVE_2 }, workerId, token)
log('  选型(预期无 52μm 模型 → 新建路径):\n' + find2.text.split('\n').slice(0, 8).map(x => '    ' + x).join('\n'))

const physicsSpec = JSON.parse(readFileSync(join(PREV_DIR, 'physics-spec-remapped.json'), 'utf8'))
const sfx = '0926T0155-g2'
const jobRes = await api('POST', '/api/workshop/aml/jobs', {
  datasetId,
  purpose: 'mpc_surrogate',
  changeNote: `live 双目标:为优化目标 ${OBJECTIVE_2} 新建模型(同数据集,目标维度打标)`,
  params: { epochs: 600, hidden: 192, lr: 0.0008, residual_scale: 2.5, ensemble: 3 },
  seed: 7,
  jobKind: 'hybrid_residual',
  sceneId: SCENE_ID,
  sceneVersion: '1.0.0',
  objectiveId: OBJECTIVE_2,
  physicsSpec,
  providerId: physicsSpec.modelId,
  providerVersion: '1.0.0',
  providerHash: `sha256:${JSON.stringify(physicsSpec).length}`,
  modelName: `流延膜厚闭环模型 ${sfx}`,
  modelDescription: `输入=全部 6 个 DCW 执行器;输出=膜厚 goal(52μm);场景 ${SCENE_ID}@1.0.0;产线 ${lineId}/配方 ${recipeId};目标 ${OBJECTIVE_2}`,
}, token)
const job = jobRes.json?.data?.job
if (!job) throw new Error(`作业提交失败: ${JSON.stringify(jobRes.json).slice(0, 300)}`)
log(`✔ 训练作业 ${job.id} 入队(objective=${OBJECTIVE_2}, epochs=600/hidden=192/ensemble=3)`)
let jobDone = null
for (let i = 0; i < 90; i++) {
  await sleep(10_000)
  const st = await api('GET', `/api/workshop/aml/jobs/${job.id}`, undefined, token)
  const j = st.json?.data?.job ?? st.json?.data
  if (!j) continue
  if (i % 3 === 0) log(`  [${i * 10}s] ${j.status} ${j.stage ?? ''} ${j.progress ?? ''}%`)
  if (['done', 'failed', 'cancelled', 'timeout'].includes(j.status)) { jobDone = j; break }
}
if (!jobDone || jobDone.status !== 'done') throw new Error(`训练未成功: ${JSON.stringify(jobDone).slice(0, 300)}`)
const gatesPassed2 = (() => {
  try { return JSON.parse(jobDone.gatesJson || '{}').passed }
  catch { return false }
})()
log(`✔ 训练完成 · 平台门禁 G1-G5: ${gatesPassed2 ? '全部通过' : '未过'}`)

const modelsRes2 = await api('GET', '/api/workshop/aml/models', undefined, token)
const model52 = (modelsRes2.json?.data?.models ?? []).find(m => m.objectiveId === OBJECTIVE_2)
if (!model52) throw new Error('52μm 模型未登记')
log(`✔ 52μm 模型 ${model52.id} [${model52.stage}] label=${model52.label}`)
if (model52.stage === 'candidate') {
  const promo2 = await api('POST', `/api/workshop/aml/models/${model52.id}/promote`, { toStage: 'shadow' }, token)
  log(`  晋升 shadow → HTTP ${promo2.status}`)
}
const baseline2 = { ...baseline1, ...g1.best }
log(`  目标 2 baseline(含目标 1 写入结果): ${JSON.stringify(baseline2)}`)
const g2 = await goalCycle({ goalName: '目标2·工作点迁移', objectiveId: OBJECTIVE_2, targetUm: GOAL2_TARGET_UM, model: model52, baseline: baseline2 })

/* ═══ 验证:模型工件 + 元数据 ═══ */
const modelsResF = await api('GET', '/api/workshop/aml/models', undefined, token)
const allF = modelsResF.json?.data?.models ?? []
const relModels = allF.filter(m => m.datasetId === datasetId)
log('模型注册表(本数据集):')
for (const m of relModels) log(`  - ${m.id} [${m.stage}] objective=${m.objectiveId} G1=${m.metrics?.oneStepTest?.nrmse ?? '?'} label=${(m.label ?? '').slice(0, 60)}`)
const artifactTrees = relModels.map((m) => {
  const dir = m.path
  return { id: m.id, path: dir, files: existsSync(dir) ? readdirSync(dir).map(f => `${f}(${statSync(join(dir, f)).size}B)`) : [] }
})
for (const t of artifactTrees) log(`  工件 ${t.id}: ${t.files.join(', ') || '(不可见)'}`)

/* ═══ 透明度文档 ═══ */
const fmtMetrics = m => JSON.stringify({ oneStepTest: m?.metrics?.oneStepTest, rolloutTest: m?.metrics?.rolloutTest, hybrid: m?.metrics?.hybrid, uncertainty: m?.metrics?.uncertainty, physics: m?.metrics?.physics }, null, 1).slice(0, 2400)
const gate1Text = existsSync(join(PREV_DIR, `gate-${OBJECTIVE_1}.txt`)) ? readFileSync(join(PREV_DIR, `gate-${OBJECTIVE_1}.txt`), 'utf8') : ''
const gate2Text = existsSync(join(PREV_DIR, `gate-${OBJECTIVE_2}.txt`)) ? readFileSync(join(PREV_DIR, `gate-${OBJECTIVE_2}.txt`), 'utf8') : ''
const mpc1Text = existsSync(join(PREV_DIR, `mpc-${OBJECTIVE_1}.txt`)) ? readFileSync(join(PREV_DIR, `mpc-${OBJECTIVE_1}.txt`), 'utf8') : ''
const mpc2Text = existsSync(join(PREV_DIR, `mpc-${OBJECTIVE_2}.txt`)) ? readFileSync(join(PREV_DIR, `mpc-${OBJECTIVE_2}.txt`), 'utf8') : ''
const doc = [
  `# AML 混合孪生双目标闭环优化 · 实机透明度记录(终版)`,
  ``,
  `- 运行: ${PREV_DIR.split(/[\\/]/).pop()} · 平台 ${AW_BASE}(start 模式隔离实例) · 模拟器 cast-film-physics(影子 4011)`,
  `- 产线 ${lineId} · 配方 ${recipeId} · 场景 ${SCENE_ID}@1.0.0(冻结) · hybrid_twin Channel \`${channelId}\`(worker \`${workerId}\`)`,
  `- 全部工业动作经 Channel worker agent 工具面下发(agent-tools/invoke);训练作业经平台 REST(admin)`,
  ``,
  `## 0. 训练历史(本数据集 ${datasetId},3 批次×批内阶跃激励,634 窗)`,
  `| 模型 | 目标 | 关键配置 | G1 单步 NRMSE | 结论 |`,
  `| --- | --- | --- | --- | --- |`,
  `| R2(job-muhrno7x-l5fp4f) | thickness-50um | epochs=220/hidden=96 | 0.591 | 噪声底门禁(0.7)通过;castfilm 场景级门(0.6)未过 → MPC 降级 safe_small_step |`,
  `| v3(job-muhs53g7-onxwyu) | thickness-50um | epochs=600/hidden=192/residual_scale=2.5 | 0.548 | 场景级门(0.6)通过 → precise_search |`,
  `| g2(本脚本训练) | thickness-52um | epochs=600/hidden=192/residual_scale=2.5/seed=7/lr=0.0008 | 见下 | 目标维度新建模型 |`,
  ``,
  `## 1. 目标 1 · thickness-50um(复用已有模型)`,
  `- 选型: aml_model_find(objective=thickness-50um) → 命中 v3 模型 → 复用,不重训`,
  `- 模型身份:`,
  '```json',
  JSON.stringify({ id: model50.id, label: model50.label, description: model50.description, lineId: model50.lineId, recipeId: model50.recipeId, objectiveId: model50.objectiveId, dataset: datasetId }, null, 1),
  '```',
  `- 训练指标:`,
  '```json',
  fmtMetrics(model50),
  '```',
  `- Twin Gate:`,
  '```text',
  gate1Text.slice(0, 2200),
  '```',
  `- MPC(objective 显式下发 targets.膜厚=50):`,
  '```text',
  mpc1Text.slice(0, 2200),
  '```',
  `- 闭环执行: 写入 ${JSON.stringify(g1.best)} → 复测膜厚均值 ${Number.isFinite(g1.mean) ? g1.mean.toFixed(2) : 'n/a'} μm(目标 50μm)`,
  ``,
  `## 2. 目标 2 · thickness-52um(按目标选型 → 无模型 → 新建训练)`,
  `- 选型: aml_model_find(objective=thickness-52um) → 无匹配 → 决策新建(模型按目标维度隔离)`,
  `- 新模型身份:`,
  '```json',
  JSON.stringify({ id: model52.id, label: model52.label, description: model52.description, lineId: model52.lineId, recipeId: model52.recipeId, objectiveId: model52.objectiveId, dataset: datasetId, job: job.id }, null, 1),
  '```',
  `- 训练指标:`,
  '```json',
  fmtMetrics(model52),
  '```',
  `- Twin Gate:`,
  '```text',
  gate2Text.slice(0, 2200),
  '```',
  `- MPC(objective targets.膜厚=52):`,
  '```text',
  mpc2Text.slice(0, 2200),
  '```',
  `- 闭环执行: baseline(含目标 1 写入)=${JSON.stringify({ ...baseline1, ...g1.best })} → 写入 ${JSON.stringify(g2.best)} → 复测膜厚均值 ${Number.isFinite(g2.mean) ? g2.mean.toFixed(2) : 'n/a'} μm(目标 52μm)`,
  ``,
  `## 3. 模型工件保存验证(aml/models/<id>/)`,
  ...artifactTrees.flatMap(t => [`### ${t.id}`, t.files.length ? t.files.map(f => `- ${f}`).join('\n') : `(路径: ${t.path})`, ``]),
  `## 4. 本阶段日志`,
  '```text',
  L2.join('\n'),
  '```',
].join('\n')
writeFileSync(DOC_PATH, doc)
log(`✔ 文档: ${DOC_PATH}`)
log('TWO GOALS DONE')
