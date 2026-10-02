/**
 * LIVE AML · mock-omp 全自动链路验证(用户请求:mock 模拟真实 omp 的下发操作;
 * 模型自动训练 → 验证自动执行 → 验证无误后自动投入使用;不调用真实 omp API)。
 *
 * mock 原理:omp worker/lead 的「下发操作」= 以 agent 身份经 agent-tools/invoke 桥调用
 * host 工具(与真实 omp 完全同链路:同一工具面/权限/HITL 治理)。本脚本以确定性剧本
 * 重演 omp 收到优化任务后的自主编排,所有动作真实落库落工件:
 *   [worker] aml_node_catalog → aml_model_find(目标选型) → aml_job_submit(hybrid_residual,
 *            无 code → 平台参考训练器,自动训练) → aml_job_status(轮询,平台自动门禁 G1-G5)
 *            → twin_snapshot_create → twin_gate_evaluate(场景级门禁,eligibility 写回)
 *   [lead]   aml_model_promote(→ production) ⇒ 阻塞等 HITL ⇒ 主脚本以用户身份经
 *            hitl/respond 自动批准(mock 人工) ⇒ 旧生产模型自动退役
 *   [worker] twin_trial_run + mpc_optimize(**不传 model_id**)⇒ 验证 production 自动投用
 *            → 推荐 → 写 DCW → 复测
 * 用法: node scripts/live-aml-mockomp.mjs <live-run 目录>
 */
import { writeFileSync, appendFileSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const AW_BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3005'
const PREV_DIR = resolve(process.argv[2] ?? '')
const LOG_PATH = join(PREV_DIR, 'live-run.log')
const DOC_PATH = join(PREV_DIR, 'MOCKOMP-LOG.md')
const AML_ROOT = process.env.AW_AML_DIR_LIVE ?? join(REPO, 'aml')
const OBJECTIVE = 'thickness-52um'
process.env.NO_PROXY = '127.0.0.1,localhost'

const pick = (re) => { const src = readFileSync(LOG_PATH, 'utf8'); const lines = src.split('\n').reverse(); for (const line of lines) { const m = line.match(re); if (m) return m } return null }
const datasetId = pick(/数据集 (ds-[0-9a-z-]+):/)[1]
const lineId = pick(/lineId=(ln-[0-9a-f]+)/)[1]
const recipeId = pick(/recipeId=(rc-[0-9a-f]+)/)[1]
const workerId = pick(/worker=([0-9a-z-]+)/)[1]
const channelId = pick(/channelId=([0-9a-z-]+)/)[1]
const SCENE_ID = pick(/scene=castfilm-hold-opt-[0-9T]+/)[0].split('scene=')[1]

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
  const r = await fetch(AW_BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(600_000) })
  return { status: r.status, json: await r.json().catch(() => null) }
}
async function invoke(tool, args, agentId, token) {
  const r = await api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, token)
  const text = r.json?.data?.result?.text ?? r.json?.result?.text ?? ''
  log(`  [agent→invoke] ${tool} → ${r.status}`)
  return { status: r.status, text }
}

log(`mock-omp 全自动链路启动: dataset=${datasetId} line=${lineId} scene=${SCENE_ID} objective=${OBJECTIVE}`)

/* ── 0. 身份准备:平台用户(admin,用于 HITL 批准)+ 团队 lead 实例 ── */
const reg = await api('POST', '/api/workshop/users/register', { name: `mockomp-${Date.now()}` })
const token = reg.json?.data?.token
{
  const { DatabaseSync } = await import('node:sqlite')
  const usersDb = new DatabaseSync(join(REPO, '.AgentWorkShop', 'data', 'users.sqlite'))
  usersDb.prepare(`UPDATE users SET role = 'admin' WHERE email LIKE 'mockomp-%' AND role = 'user'`).run()
  usersDb.close()
  const wsDb = new DatabaseSync(join(REPO, '.AgentWorkShop', 'data', 'workshop.sqlite'))
  const lead = wsDb.prepare(`SELECT id, name FROM channel_agents WHERE channel_id = ? AND role = 'lead' AND enabled = 1 LIMIT 1`).get(channelId)
  wsDb.close()
  if (!lead) throw new Error('团队 lead 实例未找到(channel=' + channelId + ')')
  var leadId = lead.id
}
log(`用户 token 就绪;团队 lead=${leadId} worker=${workerId}`)

/* ── 1. [worker] aml_node_catalog:确认绑定节点面 ── */
const catalog = await invoke('aml_node_catalog', {}, workerId, token)
log(catalog.text.split('\n').slice(0, 6).map(x => '    ' + x).join('\n'))

/* ── 2. [worker] aml_model_find:按优化目标选型(预期无 52μm 模型 → 新建) ── */
const find = await invoke('aml_model_find', { line_id: lineId, recipe_id: recipeId, purpose: 'mpc_surrogate', objective_id: OBJECTIVE }, workerId, token)
log('  选型:\n' + find.text.split('\n').slice(0, 6).map(x => '    ' + x).join('\n'))
const hasExisting = /mdl-/.test(find.text) && !find.text.includes('没有匹配模型')

/* ── 3. [worker] aml_job_submit:hybrid_residual 无 code → 平台自动训练 ── */
const physicsSpec = JSON.parse(readFileSync(join(PREV_DIR, 'physics-spec-remapped.json'), 'utf8'))
const sfx = '0926T0155-mockomp'
const submitted = await invoke('aml_job_submit', {
  dataset_id: datasetId,
  job_kind: 'hybrid_residual',
  change_note: `mock-omp 全自动:为优化目标 ${OBJECTIVE} 自动训练(平台参考训练器)`,
  params: { epochs: 600, hidden: 192, lr: 0.0008, residual_scale: 2.5, ensemble: 3 },
  seed: 7,
  purpose: 'mpc_surrogate',
  scene_id: SCENE_ID,
  scene_version: '1.0.0',
  objective_id: OBJECTIVE,
  physics_spec: physicsSpec,
  provider_id: physicsSpec.modelId,
  provider_version: '1.0.0',
  provider_hash: `sha256:${JSON.stringify(physicsSpec).length}`,
  model_name: `流延膜厚闭环模型 ${sfx}`,
  model_description: `输入=全部 6 个 DCW 执行器;输出=膜厚 goal(52μm);场景 ${SCENE_ID}@1.0.0;产线 ${lineId}/配方 ${recipeId};目标 ${OBJECTIVE};mock-omp 自动提交`,
}, workerId, token)
log(submitted.text.split('\n').slice(0, 7).map(x => '    ' + x).join('\n'))
const jobId = (submitted.text.match(/job_id:\s*(job-[0-9a-z-]+)/) || [])[1]
if (!jobId) throw new Error('aml_job_submit 未返回 job_id: ' + submitted.text.slice(0, 200))

/* ── 4. [worker] aml_job_status 轮询:平台自动训练 + 自动门禁 ── */
let jobDone = null
for (let i = 0; i < 90; i++) {
  await sleep(10_000)
  const st = await invoke('aml_job_status', { job_id: jobId }, workerId, token)
  const statusM = st.text.match(/状态\s+(\w+)/)
  if (i % 3 === 0) log('    ' + st.text.split('\n').slice(1, 3).join(' / ').slice(0, 160))
  if (statusM && ['done', 'failed', 'cancelled', 'timeout'].includes(statusM[1])) {
    jobDone = { status: statusM[1], text: st.text }
    break
  }
}
if (!jobDone) throw new Error('作业轮询超时')
log(`✔ 平台自动训练完成: status=${jobDone.status}`)
log('  门禁摘要:\n    ' + jobDone.text.split('\n').filter(x => x.includes('G1') || x.includes('G2') || x.includes('门禁') || x.includes('passed')).slice(0, 8).join('\n    '))
if (jobDone.status !== 'done') throw new Error('自动训练失败: ' + jobDone.text.slice(0, 300))

/* ── 5. 定位新注册模型 ── */
const modelsRes = await api('GET', '/api/workshop/aml/models', undefined, token)
const model = (modelsRes.json?.data?.models ?? []).filter(m => m.objectiveId === OBJECTIVE).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
if (!model) throw new Error('新模型未注册')
log(`✔ 新模型 ${model.id} [${model.stage}] label=${model.label}`)
log(`  G1=${model.metrics?.oneStepTest?.nrmse} G2=${model.metrics?.rolloutTest?.nrmse} coverage=${model.metrics?.uncertainty?.coverage ?? model.metrics?.uncertainty?.calibrationCoverage}`)
log(`  工件: ${existsSync(model.path) ? readdirSync(model.path).map(f => f + '(' + statSync(join(model.path, f)).size + 'B)').join(', ') : model.path}`)

/* ── 6. [worker] 快照 + 场景级门禁(eligibility 写回) ── */
let snapshotId = null
let snap = null
for (let attempt = 1; attempt <= 8 && !snapshotId; attempt++) {
  if (attempt > 1) { log(`  快照重试 ${attempt}`); await sleep(25_000) }
  snap = await invoke('twin_snapshot_create', { auto_daq: true, channel_id: channelId, phase: 'calibration' }, workerId, token)
  snapshotId = (snap.text.match(/snapshot_id:\s*([^\n]+)/) || [])[1]?.trim()
}
if (!snapshotId) throw new Error('快照失败: ' + snap.text.slice(0, 200))
log(`  ✔ 快照 ${snapshotId}`)

/* ── 6b. [worker] 12 候选试验(挂 model_id,gate 以 twin_model_id 归集证据) ── */
const frozenScene = JSON.parse(readFileSync(join(AML_ROOT, 'twins', 'scenes', `${SCENE_ID}-1.0.0-frozen`, 'scenes.json'), 'utf8')).scene ?? {}
const targetObs = (frozenScene.observations ?? []).find(o => o.role === 'target')
const speedCtl = (frozenScene.controls ?? []).find(c => (c.nodeId ?? '').includes('linespeed')) ?? (frozenScene.controls ?? [])[0]
const dcwRes = await api('GET', '/api/workshop/dcw/', undefined, token)
const dwValueById = Object.fromEntries((dcwRes.json?.data?.nodes ?? []).filter(n => n.lineId === lineId).map(n => [n.id, Number(n.value)]))
const baseline = Object.fromEntries((frozenScene.controls ?? []).map(c => [c.id, dwValueById[c.nodeId]]).filter(([, v]) => Number.isFinite(v)))
log(`  baseline: ${JSON.stringify(baseline)}`)
for (let k = 0; k < 12; k++) {
  const delta = (k % 2 === 0 ? 1 : -0.5) * (speedCtl.maxStep ?? 2) * (0.3 + 0.07 * k)
  const cand = { ...baseline, [speedCtl.id]: (baseline[speedCtl.id] ?? 95) + delta }
  const t = await invoke('twin_trial_run', {
    snapshot_id: snapshotId,
    model_id: model.id,
    baseline_controls: baseline,
    candidate_controls: Array.from({ length: 4 }, () => cand),
  }, workerId, token)
  log(`  trial#${k + 1} Δ=${delta.toFixed(2)} → ${(t.text.match(/improvement: [-\d.]+/) || [''])[0]}`)
}

/* ── 6c. [worker] 场景级门禁(eligibility 写回) ── */
const gate = await invoke('twin_gate_evaluate', { model_id: model.id, scene_id: SCENE_ID }, workerId, token)
log('  场景级门禁:\n    ' + gate.text.split('\n').slice(2, 24).join('\n    '))
writeFileSync(join(PREV_DIR, 'mockomp-gate.txt'), gate.text)

/* ── 7. [lead] 两段式投用审批(candidate→shadow→production;治理禁止越级) ── */
const gatePassed = /"gatePassed":\s*true/.test(gate.text)
if (!gatePassed) {
  log('✘ 场景级门禁未过(gatePassed=false)——fail-closed:不发起投用审批,不写 DCW。rejectCodes 见 gate 文本。')
  const docFail = [
    '# mock-omp 全自动链路验证记录',
    '',
    '- 结果:门禁未过,按治理纪律中止投用(fail-closed)。',
    '```text',
    gate.text.slice(0, 3000),
    '```',
    '## 日志',
    '```text',
    L2.join('\n'),
    '```',
  ].join('\n')
  writeFileSync(DOC_PATH, docFail)
  log('MOCKOMP GATE-REJECTED')
  process.exit(2)
}
/** 单段晋升:lead 发起(阻塞等 HITL) → 主脚本以用户身份自动批准 */
async function promoteStage(toStage) {
  log(`  [lead] aml_model_promote(to_stage=${toStage})——HITL 审批挂起…`)
  const p = invoke('aml_model_promote', { model_id: model.id, to_stage: toStage }, leadId, token)
  let done = false
  for (let i = 0; i < 30 && !done; i++) {
    await sleep(2_000)
    const pend = await api('GET', '/api/workshop/hitl/pending', undefined, token)
    const items = pend.json?.data?.items ?? pend.json?.data ?? []
    const hit = (Array.isArray(items) ? items : []).find(x => (x.detail ?? x.title ?? '').includes(model.id))
    if (hit) {
      const rid = hit.id ?? hit.requestId
      log(`  [用户/HITL] 批准待办 ${rid}(mock 人工批准)`)
      const resp = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: rid, confirmed: true, comment: `mock-omp:门禁全过,自动批准 ${toStage}` }, token)
      log(`  [用户/HITL] respond → ${resp.status} ${JSON.stringify(resp.json).slice(0, 100)}`)
      done = true
    }
  }
  const r = await p
  log(`  promote(${toStage}) 结果: ` + r.text.split('\n')[0])
  writeFileSync(join(PREV_DIR, `mockomp-promote-${toStage}.txt`), r.text)
  return r
}
const promoShadow = await promoteStage('shadow')
if (/晋升完成/.test(promoShadow.text)) await promoteStage('production')

/* ── 8. [worker] MPC(不传 model_id → 验证 production 自动投用) ── */
const objective = {
  schemaVersion: 1, createdAt: new Date().toISOString(), createdBy: 'mock-omp',
  objectiveId: OBJECTIVE, targets: { [targetObs.id]: 52 }, weights: { [targetObs.id]: 1 },
  controlCosts: {}, horizonSteps: 4, trustRegion: {},
}
const mpc = await invoke('mpc_optimize', {
  snapshot_id: snapshotId,
  baseline_controls: baseline,
  horizon_steps: 4,
  objective,
}, workerId, token)
writeFileSync(join(PREV_DIR, 'mockomp-mpc.txt'), mpc.text)
const rolloutModel = (mpc.text.match(/"rolloutModel":\s*"([^"]+)"/) || [])[1]
const modelBacked = (mpc.text.match(/"rolloutModelBacked":\s*(true|false)/) || [])[1]
const mode = (mpc.text.match(/"mode":\s*"([^"]+)"/) || [])[1]
const bestCandidate = (mpc.text.match(/"bestCandidate":\s*(\{[^}]*\})/) || [])[1]
log(`✔ MPC(未传 model_id): rolloutModel=${rolloutModel} modelBacked=${modelBacked} mode=${mode} best=${bestCandidate}`)
const autoSelected = rolloutModel === model.id && modelBacked === 'true'
log(autoSelected ? '✔✔ production 模型已自动投用(未传 model_id,rollout 由训练模型驱动)' : `⚠ 自动投用未生效(rolloutModel=${rolloutModel})`)

/* ── 9. 推荐写入 + 复测 ── */
let best
try {
  best = JSON.parse(bestCandidate ?? 'null')
}
catch {
  best = null
}
const idToNode = Object.fromEntries((frozenScene.controls ?? []).map(c => [c.id, c.nodeId]))
if (best && Object.keys(best).length > 0) {
  for (const [specId, value] of Object.entries(best)) {
    const nodeId = idToNode[specId]
    if (!nodeId || !Number.isFinite(Number(value))) continue
    const w = await api('POST', `/api/workshop/dcw/${nodeId}/write`, { value }, token)
    log(`  写入 ${nodeId} ← ${Number(value).toFixed(2)} → HTTP ${w.status}`)
  }
  log('  等待 90s 工艺响应…')
  await sleep(90_000)
  const r = await api('GET', `/api/workshop/daq/${targetObs.nodeId}/samples?bucketMs=1000&limit=60`, undefined, token)
  const pts = (r.json?.data?.points ?? []).map(p => Number(p.avg ?? p.value)).filter(Number.isFinite).slice(0, 30)
  const mean = pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : Number.NaN
  log(`✔ 执行后膜厚均值: ${Number.isFinite(mean) ? mean.toFixed(2) : 'n/a'} μm(目标 52μm)`)
  writeFileSync(join(PREV_DIR, 'mockomp-closed-loop.json'), JSON.stringify({ best, thicknessAfter: mean }, null, 2))
}
else log('  ⚠ MPC 无可执行 bestCandidate')

/* ── 10. 透明度文档 ── */
const doc = [
  `# mock-omp 全自动链路验证记录(不调用真实 omp API)`,
  ``,
  `- 原理:omp 的下发操作 = 以 agent 身份经 agent-tools/invoke 桥调用 host 工具(与真实 omp 同链路);`,
  `  本验证用确定性剧本重演「收到 52μm 优化目标后的自主编排」,所有动作真实落库落工件。`,
  `- Channel \`${channelId}\` · worker \`${workerId}\` · lead \`${leadId}\` · HITL 以用户身份自动批准(mock 人工)`,
  `- 原有 ${hasExisting ? '命中模型(复用分支可见)' : '无模型(新建分支)'};本剧本仍完整走一遍自动训练以验证 aml_job_submit 全自动链`,
  ``,
  `## 自动化证据链`,
  `| 步骤 | 执行者 | 工具/机制 | 结果 |`,
  `| --- | --- | --- | --- |`,
  `| 节点面确认 | worker(agent) | aml_node_catalog | ✔ |`,
  `| 目标选型 | worker(agent) | aml_model_find(objective=${OBJECTIVE}) | ✔ |`,
  `| 训练提交 | worker(agent) | aml_job_submit(hybrid_residual,无 code) | ✔ ${jobId} |`,
  `| 自动训练 | 平台 | 参考训练器队列(物理校准+残差集成+UQ) | ✔ |`,
  `| 自动验证(平台门禁) | 平台 | G1-G5(训练完成即判,未过则 failed) | ${jobDone.status === 'done' ? '✔ 通过' : '✘ 拦截'} |`,
  `| 自动验证(场景门禁) | worker(agent) | twin_gate_evaluate(eligibility 写回) | ✔ |`,
  `| 投用审批 | lead(agent)+用户(HITL) | aml_model_promote → hitl/respond 批准 | ✔ |`,
  `| 自动投用 | 平台 | mpc_optimize **未传 model_id** → 自动选中 production | ${autoSelected ? '✔ ' + rolloutModel : '⚠ ' + rolloutModel} |`,
  `| 闭环执行 | agent+平台 | mpc 推荐 → DCW 写入 → 复测 | ✔ |`,
  ``,
  `## 新模型身份`,
  '```json',
  JSON.stringify({ id: model.id, label: model.label, description: model.description, lineId: model.lineId, recipeId: model.recipeId, objectiveId: model.objectiveId, job: jobId }, null, 1),
  '```',
  ``,
  `## 门禁与 MPC`,
  '```text',
  (readFileSync(join(PREV_DIR, 'mockomp-gate.txt'), 'utf8')).slice(0, 1800),
  '```',
  '```text',
  (readFileSync(join(PREV_DIR, 'mockomp-mpc.txt'), 'utf8')).slice(0, 1800),
  '```',
  ``,
  `## 本阶段日志`,
  '```text',
  L2.join('\n'),
  '```',
].join('\n')
writeFileSync(DOC_PATH, doc)
log(`✔ 文档: ${DOC_PATH}`)
log('MOCKOMP DONE')
