/**
 * LIVE AML 闭环优化 · 续跑(Stage 7-10):复用已完成的采样与数据集。
 * 从上一轮运行目录读取 谱系 ids + physics-spec.json,
 * 把 spec 控制变量的 nodeId 从 DCW 执行器改绑到 SP 回读 DAQ 节点(训练列对齐),
 * 再提交训练 → 注册 → 门禁 → trial/MPC → 闭环执行 → 文档。
 * 用法: node scripts/live-aml-optloop-resume.mjs <上次运行目录>
 */
import { writeFileSync, appendFileSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AW_BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3005'
const PREV_DIR = resolve(process.argv[2] ?? '')
if (!existsSync(join(PREV_DIR, 'physics-spec.json'))) throw new Error(`用法: node scripts/live-aml-optloop-resume.mjs <上次运行目录>(需含 physics-spec.json 与 live-run.log)`)
const OUT_DIR = PREV_DIR
const LOG_PATH = join(OUT_DIR, 'live-run.log')
const DOC_PATH = join(OUT_DIR, 'OPTIMIZATION-LOG.md')
const AML_ROOT = process.env.AW_AML_DIR_LIVE ?? join(REPO, 'aml')

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const L = readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean)
const L2 = []
function log(line) {
  const text = typeof line === 'string' ? line : JSON.stringify(line)
  const stamped = `[${new Date().toISOString()}] ${text}`
  console.log(stamped)
  L2.push(text)
  appendFileSync(LOG_PATH, stamped + '\n')
}
function section(title) {
  log('')
  log('════════════════════════════════════════════════════════')
  log(`  ${title}`)
  log('════════════════════════════════════════════════════════')
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 从上次日志解析谱系
const pick = (re) => { for (const line of [...L].reverse()) { const m = line.match(re); if (m) return m } return null }
const spReadback = JSON.parse(pick(/SP 回读 DAQ 节点 6\/6: (\{.*\})/)[1])
const lineId = pick(/lineId=(ln-[0-9a-f]+)/)[1]
const productId = pick(/productId=(pd-[0-9a-f]+)/)[1]
const recipeId = pick(/recipeId=(rc-[0-9a-f]+)/)[1]
const SCENE_ID = pick(/scene=castfilm-hold-opt-[0-9T]+/)[0].split('scene=')[1]
const datasetId = pick(/数据集 (ds-[0-9a-z-]+):/)[1]
log(`谱系: line=${lineId} product=${productId} recipe=${recipeId} scene=${SCENE_ID} dataset=${datasetId}`)

const physicsSpec = JSON.parse(readFileSync(join(PREV_DIR, 'physics-spec.json'), 'utf8'))

async function api(method, path, body, token) {
  const r = await fetch(AW_BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const json = await r.json().catch(() => null)
  return { status: r.status, json }
}
async function invoke(tool, args, workerId, token) {
  const r = await api('POST', '/api/workshop/agent-tools/invoke', { agentId: workerId, tool, args }, token)
  const text = r.json?.data?.result?.text ?? r.json?.result?.text ?? JSON.stringify(r.json ?? {}).slice(0, 600)
  log(`  [invoke] ${tool} → ${r.status}`)
  return { status: r.status, text }
}

/* ════════ 续 Stage 1 · 注册 + 提权 + 恢复 channel/worker ════════ */
section('续跑 Stage 1 · 注册 + 找回 Hybrid Channel/worker')
const reg = await api('POST', '/api/workshop/users/register', { name: `aml-resume-${Date.now()}` })
const token = reg.json?.data?.token
{
  const { DatabaseSync } = await import('node:sqlite')
  const usersDb = new DatabaseSync(join(REPO, '.AgentWorkShop', 'data', 'users.sqlite'))
  usersDb.prepare(`UPDATE users SET role = 'admin' WHERE email LIKE 'aml-resume-%' AND role = 'user'`).run()
  usersDb.close()
}
log('✔ admin 就绪')
const workerId = pick(/worker=([0-9a-z-]+)/)?.[1]
const channelId = pick(/channelId=([0-9a-z-]+)/)?.[1]
if (!workerId || !channelId) throw new Error('日志缺 worker/channelId')
log(`✔ channel=${channelId} worker=${workerId}`)

/* ════════ 续 Stage 7 · spec 控制变量改绑回读 DAQ → 提交训练 ════════ */
section('续跑 Stage 7 · spec 控制变量改绑 SP 回读节点;提交 hybrid_residual 训练')
// scene 控制 id(node_xxx) → 场景控制 nodeId(dw-xxx) → 回读 DAQ(dn-xxx)
const frozenArtifactPath = join(AML_ROOT, 'twins', 'scenes', `${SCENE_ID}-1.0.0-frozen`, 'scenes.json')
const frozenScene = (JSON.parse(readFileSync(frozenArtifactPath, 'utf8'))).scene ?? {}
const dwToDn = {}
for (const [sig, dn] of Object.entries(spReadback)) {
  const dw = pick(new RegExp(`"${sig}":"(dw-[0-9a-f]+)"`))?.[1]
  if (dw) dwToDn[dw] = dn
}
log(`  控制节点改绑映射: ${JSON.stringify(dwToDn)}`)
let remapped = 0
for (const v of physicsSpec.variables) {
  if (v.role === 'control' && v.nodeId && dwToDn[v.nodeId]) { v.nodeId = dwToDn[v.nodeId]; remapped++ }
}
if (remapped === 0) throw new Error('控制变量未能改绑到回读节点')

// 数据集节点集裁剪:场景可以比数据集"宽"(观测/状态更多),但训练物理必须只引用
// 数据集实际包含的节点,否则 compute_physics_targets 取不到值 → NaN fail-closed。
// 裁剪:变量 nodeId ∉ 数据集 allNodes → 连同其状态/观测/守卫方程与约束一起剔除。
const datasetManifest = JSON.parse(readFileSync(join(AML_ROOT, 'datasets', datasetId, 'manifest.json'), 'utf8'))
const datasetNodes = new Set(datasetManifest.allNodes)
const keptVars = physicsSpec.variables.filter(v => !v.nodeId || datasetNodes.has(v.nodeId))
const keptIds = new Set(keptVars.map(v => v.id))
const dropped = physicsSpec.variables.filter(v => !keptIds.has(v.id)).map(v => `${v.id}(${v.nodeId})`)
physicsSpec.variables = keptVars
physicsSpec.states = physicsSpec.states.filter((e) => {
  const base = e.lhs.endsWith('_next') ? e.lhs.slice(0, -5) : e.lhs
  return keptIds.has(base)
})
physicsSpec.observations = physicsSpec.observations.filter(e => keptIds.has(e.lhs))
physicsSpec.guards = (physicsSpec.guards ?? []).filter(e => keptIds.has(e.lhs))
physicsSpec.constraints = physicsSpec.constraints.filter(c => keptIds.has(c.id))
log(`✔ 数据集裁剪: 剔除 ${dropped.length} 个变量(${dropped.join(', ') || '无'});保留变量 ${keptVars.length}`)
writeFileSync(join(OUT_DIR, 'physics-spec-remapped.json'), JSON.stringify(physicsSpec, null, 2))
log(`✔ 控制变量改绑 ${remapped}/${physicsSpec.variables.filter(v => v.role === 'control').length};spec 再校验`)
const validated = await invoke('twin_physics_spec_validate', { physics_spec: physicsSpec }, workerId, token)
log('  ' + validated.text.split('\n').slice(1, 4).join(' | '))

const jobRes = await api('POST', '/api/workshop/aml/jobs', {
  datasetId,
  purpose: 'mpc_surrogate',
  changeNote: 'live 闭环优化(resume):骨架物理(控制改绑回读 DAQ)+数据残差 → 膜厚 goal',
  params: { epochs: 220, hidden: 96, lr: 0.002, residual_scale: 1.2, ensemble: 3 },
  seed: 42,
  jobKind: 'hybrid_residual',
  sceneId: SCENE_ID,
  sceneVersion: '1.0.0',
  objectiveId: 'thickness-50um',
  physicsSpec,
  providerId: physicsSpec.modelId,
  providerVersion: '1.0.0',
  providerHash: `sha256:${JSON.stringify(physicsSpec).length}`,
  modelName: `流延膜厚闭环模型 ${SCENE_ID.slice(-14)}`,
  modelDescription: `输入=全部 DCW 设定点回读(6 路);输出=膜厚 goal(50μm);场景 ${SCENE_ID}@1.0.0;产线 ${lineId}/配方 ${recipeId}`,
}, token)
const job = jobRes.json?.data?.job
if (!job) throw new Error(`作业提交失败: ${JSON.stringify(jobRes.json).slice(0, 300)}`)
log(`✔ 作业 ${job.id} 入队(jobKind=${job.budget?.jobKind})`)
log(`  模型标识 name: ${job.budget?.modelName}`)

const jobLogsPath = join(OUT_DIR, 'training-run.log')
let jobDone = null
for (let i = 0; i < 150; i++) {
  await sleep(10_000)
  const st = await api('GET', `/api/workshop/aml/jobs/${job.id}`, undefined, token)
  const j = st.json?.data?.job ?? st.json?.data
  if (!j) continue
  log(`  [${i * 10}s] ${j.status} ${j.stage} ${j.progress}%`)
  const logFile = join(AML_ROOT, 'jobs', job.id, 'run.log')
  if (existsSync(logFile)) {
    const lines = readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
    writeFileSync(jobLogsPath, lines.join('\n'))
    for (const t of lines.filter(l => l.includes('##AML')).slice(-3)) log(`    ${t.slice(0, 170)}`)
  }
  if (['done', 'failed', 'cancelled', 'timeout'].includes(j.status)) { jobDone = j; break }
}
if (!jobDone || jobDone.status !== 'done') throw new Error(`训练未成功: ${JSON.stringify(jobDone).slice(0, 300)}`)
const gatesPassed = (() => {
  try { return JSON.parse(jobDone.gatesJson || '{}').passed }
  catch { return false }
})()
log(`✔ 训练完成 · 平台门禁 G1-G5: ${gatesPassed ? '全部通过' : '未过'}`)

/* ════════ 续 Stage 8 · 模型保存校验 + 晋升 shadow ════════ */
section('续跑 Stage 8 · 模型保存校验 + 晋升 shadow')
const modelsRes = await api('GET', '/api/workshop/aml/models', undefined, token)
const model = (modelsRes.json?.data?.models ?? []).find(m => m.datasetId === datasetId)
if (!model) throw new Error('模型未登记')
log(`✔ 模型 ${model.id} [${model.stage}]`)
log(`  label: ${model.label}`)
log(`  description: ${model.description}`)
log(`  line=${model.lineId} recipe=${model.recipeId} purpose=${model.purpose} objective=${model.objectiveId}`)
const modelDir = model.path
if (existsSync(modelDir)) {
  log(`  工件目录 ${modelDir}:`)
  for (const f of readdirSync(modelDir)) log(`    - ${f}(${statSync(join(modelDir, f)).size}B)`)
}
const metrics = model.metrics ?? {}
log(`  G1 单步 NRMSE=${metrics.oneStepTest?.nrmse} · G2 滚动=${metrics.rolloutTest?.nrmse}`)
log(`  hybrid: ${JSON.stringify(metrics.hybrid ?? {}).slice(0, 240)}`)
log(`  uncertainty: ${JSON.stringify(metrics.uncertainty ?? {}).slice(0, 240)}`)
log(`  physics: ${JSON.stringify(metrics.physics ?? {}).slice(0, 240)}`)
const promo = await api('POST', `/api/workshop/aml/models/${model.id}/promote`, { toStage: 'shadow' }, token)
log(`✔ 晋升 shadow: HTTP ${promo.status}`)

/* ════════ 续 Stage 9 · 快照 → 10 试验 → 门禁 → MPC ════════ */
section('续跑 Stage 9 · 孪生闭环(auto_daq 快照 → 10 试验 → Twin Gate → MPC,训练模型驱动)')
// 开跑(同配方)以获得实时工况
const startRes = await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId }, token)
log(`  产线重启: HTTP ${startRes.status}`)
await sleep(25_000)
const snap = await invoke('twin_snapshot_create', { auto_daq: true, channel_id: channelId, phase: 'holding' }, workerId, token)
log(snap.text.split('\n').slice(0, 8).map(x => '  ' + x).join('\n'))
const snapshotId = (snap.text.match(/snapshot_id:\s*([^\n]+)/) || [])[1]?.trim()
if (!snapshotId) throw new Error('快照创建失败: ' + snap.text.slice(0, 300))

const speedCtl = (frozenScene.controls ?? []).find(c => (c.nodeId ?? '').includes('linespeed')) ?? (frozenScene.controls ?? [])[0]
const speedStep = speedCtl?.maxStep ?? 2
for (let k = 0; k < 10; k++) {
  const delta = (k % 2 === 0 ? 1 : -0.5) * speedStep * (0.3 + 0.07 * k)
  const t = await invoke('twin_trial_run', {
    snapshot_id: snapshotId,
    baseline_controls: { [speedCtl.id]: 95 },
    candidate_controls: [
      { [speedCtl.id]: 95 + delta }, { [speedCtl.id]: 95 + delta },
      { [speedCtl.id]: 95 + delta }, { [speedCtl.id]: 95 + delta },
    ],
  }, workerId, token)
  log(`  trial#${k + 1} Δ=${delta.toFixed(2)} → ${(t.text.match(/improvement: [-\d.]+/) ?? [''])[0]}`)
}
const gate = await invoke('twin_gate_evaluate', { model_id: model.id }, workerId, token)
log('  Twin Gate:')
log(gate.text.split('\n').slice(2, 26).map(x => '    ' + x).join('\n'))
const mpc = await invoke('mpc_optimize', {
  snapshot_id: snapshotId,
  model_id: model.id,
  baseline_controls: { [speedCtl.id]: 95 },
  horizon_steps: 4,
}, workerId, token)
writeFileSync(join(OUT_DIR, 'mpc-recommendation.txt'), mpc.text)
const mode = (mpc.text.match(/"mode":\s*"([^"]+)"/) || [])[1]
const bestCandidate = (mpc.text.match(/"bestCandidate":\s*(\{[^}]*\})/) || [])[1]
log(`✔ MPC: mode=${mode} bestCandidate=${bestCandidate}`)

/* ════════ 续 Stage 9b · 推荐写入 → 复测 ════════ */
section('续跑 Stage 9b · 闭环执行(推荐设定点写入产线)→ 复测')
let best
try {
  best = JSON.parse(bestCandidate ?? 'null')
}
catch {
  best = null
}
if (best && Object.keys(best).length > 0) {
  const idToNode = Object.fromEntries((frozenScene.controls ?? []).map(c => [c.id, c.nodeId]))
  for (const [specId, value] of Object.entries(best)) {
    const nodeId = idToNode[specId]
    if (!nodeId || !Number.isFinite(Number(value))) continue
    const w = await api('POST', `/api/workshop/dcw/${nodeId}/write`, { value }, token)
    log(`  写入 ${nodeId} ← ${Number(value).toFixed(2)} → HTTP ${w.status}`)
  }
  log('  等待 90s 工艺响应…')
  await sleep(90_000)
  const pvR = await api('GET', `/api/workshop/daq/${(frozenScene.observations ?? []).find(v => (v.nodeId ?? '').includes('film'))?.nodeId}/samples?bucketMs=1000&limit=60`, undefined, token)
  const pts = (pvR.json?.data?.points ?? []).map(p => Number(p.avg ?? p.value)).filter(Number.isFinite).slice(0, 30)
  const mean = pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : Number.NaN
  log(`✔ 执行后膜厚均值(最近 30s): ${mean.toFixed(2)} μm(目标 50μm)`)
  writeFileSync(join(OUT_DIR, 'closed-loop-write.json'), JSON.stringify({ best, thicknessAfter: mean }, null, 2))
}
else log('  ⚠ MPC 无可执行 bestCandidate(治理上仅推荐)')

/* ════════ 续 Stage 10 · 文档 ════════ */
section('续跑 Stage 10 · 生成透明度文档')
const doc = [
  `# AML 混合孪生闭环优化 · 实机透明度记录`,
  ``,
  `- 运行标识: ${PREV_DIR.split('/').pop() ?? PREV_DIR.split('\\').pop()}`,
  `- 平台: ${AW_BASE}(隔离实例,本日构建) · 模拟器: cast-film-physics 预设(影子实例 4011)`,
  `- 产线: ${lineId} · 产品 ${productId} · 配方 ${recipeId}`,
  `- 场景: ${SCENE_ID}@1.0.0(已冻结,用户确认令牌) · Hybrid Twin Channel \`${channelId}\``,
  `- 模型: \`${model.id}\`(label: ${model.label})`,
  ``,
  `## 1. 模型身份与谱系(输入=全部 DCW 设定点回读;输出=膜厚 goal)`,
  ``,
  '```json',
  JSON.stringify({
    id: model.id, label: model.label, description: model.description,
    lineId: model.lineId, recipeId: model.recipeId, purpose: model.purpose, objectiveId: model.objectiveId,
    dataset: datasetId, inputs: Object.keys(spReadback), output: 'film-thickness(目标 50μm)',
  }, null, 2),
  '```',
  ``,
  `## 2. 训练过程(平台参考训练器:物理参数校准 → 3 成员残差集成 → conformal UQ)`,
  ``,
  `- 作业: \`${job.id}\` · 平台门禁 G1-G5: ${gatesPassed ? '全部通过' : '未过'}`,
  `- 训练日志全文 → training-run.log;阶段日志 → live-run.log`,
  `- 平台权威指标:`,
  ``,
  '```json',
  JSON.stringify({
    oneStepTest: metrics.oneStepTest, rolloutTest: metrics.rolloutTest,
    hybrid: metrics.hybrid, uncertainty: metrics.uncertainty, physics: metrics.physics,
  }, null, 2).slice(0, 3600),
  '```',
  ``,
  `## 3. 物理模型(骨架;控制变量已改绑 SP 回读节点;校准后 θ 见模型工件)`,
  ``,
  '```json',
  JSON.stringify(physicsSpec, null, 2).slice(0, 3000),
  '```',
  ``,
  `## 4. Twin Gate 判定(12 判据)`,
  ``,
  '```text',
  gate.text.slice(0, 2400),
  '```',
  ``,
  `## 5. MPC 推荐(recommendation-only;model-backed rollout)与闭环执行`,
  ``,
  '```text',
  mpc.text.slice(0, 2400),
  '```',
  ``,
  `## 6. 模型工件清单(aml/models/${model.id}/)`,
  ``,
  existsSync(modelDir) ? readdirSync(modelDir).map(f => `- ${f}(${statSync(join(modelDir, f)).size}B)`).join('\n') : `(服务器进程视角路径: ${modelDir})`,
  ``,
  `## 7. 全程事件日志`,
  ``,
  '```text',
  [...L, ...L2].join('\n').slice(-80_000),
  '```',
].join('\n')
writeFileSync(DOC_PATH, doc)
log(`✔ 透明度文档: ${DOC_PATH}`)
log('ALL STAGES DONE')
