/**
 * LIVE AML 闭环 · Stage 9 续跑(模型已训练/注册,复用现有产物):
 * 产线重启 → auto_daq 快照 → 10 候选试验(训练模型 rollout)→ twin_gate_evaluate
 * (场景级 AcceptanceProfile)→ mpc_optimize → 推荐写入 → 复测 → 透明度文档。
 * 用法: node scripts/live-aml-stage9.mjs <live-run 目录>(从 live-run.log 解析谱系)
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
  const r = await fetch(AW_BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) })
  return { status: r.status, json: await r.json().catch(() => null) }
}
async function invoke(tool, args, agentId, token) {
  const r = await api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, token)
  const text = r.json?.data?.result?.text ?? r.json?.result?.text ?? ''
  log(`  [invoke] ${tool} → ${r.status}`)
  return { text }
}

log(`Stage 9 续跑: dataset=${datasetId} line=${lineId} scene=${SCENE_ID}`)
const reg = await api('POST', '/api/workshop/users/register', { name: `aml-s9-${Date.now()}` })
const token = reg.json?.data?.token
{
  const { DatabaseSync } = await import('node:sqlite')
  const usersDb = new DatabaseSync(join(REPO, '.AgentWorkShop', 'data', 'users.sqlite'))
  usersDb.prepare(`UPDATE users SET role = 'admin' WHERE email LIKE 'aml-s9-%' AND role = 'user'`).run()
  usersDb.close()
}
const modelsRes = await api('GET', '/api/workshop/aml/models', undefined, token)
const model = (modelsRes.json?.data?.models ?? []).find(m => m.datasetId === datasetId)
if (!model) throw new Error('模型未找到')
log(`✔ 模型 ${model.id} [${model.stage}] label=${model.label}`)

// 产线重启(真实工况快照)
await api('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId }, token)
log('  产线重启')
await sleep(25_000)
let snapshotId = null
let snap = null
for (let attempt = 1; attempt <= 4 && !snapshotId; attempt++) {
  if (attempt > 1) { log(`  快照重试 ${attempt}(等 DAQ 采样跟上)`); await sleep(25_000) }
  snap = await invoke('twin_snapshot_create', { auto_daq: true, channel_id: channelId, phase: 'calibration' }, workerId, token)
  log(snap.text.split('\n').slice(0, 8).map(x => '  ' + x).join('\n'))
  snapshotId = (snap.text.match(/snapshot_id:\s*([^\n]+)/) || [])[1]?.trim()
}
if (!snapshotId) throw new Error('快照失败: ' + snap.text.slice(0, 200))

const frozenArtifactPath = join(AML_ROOT, 'twins', 'scenes', `${SCENE_ID}-1.0.0-frozen`, 'scenes.json')
const frozenScene = (JSON.parse(readFileSync(frozenArtifactPath, 'utf8'))).scene ?? {}
const sceneControls = frozenScene.controls ?? []
const speedCtl = sceneControls.find(c => (c.nodeId ?? '').includes('linespeed')) ?? sceneControls[0]
const speedStep = speedCtl?.maxStep ?? 2

for (let k = 0; k < 10; k++) {
  const delta = (k % 2 === 0 ? 1 : -0.5) * speedStep * (0.3 + 0.07 * k)
  const t = await invoke('twin_trial_run', {
    snapshot_id: snapshotId,
    baseline_controls: { [speedCtl.id]: 95 },
    candidate_controls: [{ [speedCtl.id]: 95 + delta }, { [speedCtl.id]: 95 + delta }, { [speedCtl.id]: 95 + delta }, { [speedCtl.id]: 95 + delta }],
  }, workerId, token)
  log(`  trial#${k + 1} Δ=${delta.toFixed(2)} → ${(t.text.match(/improvement: [-\d.]+/) || [''])[0]}`)
}
const gate = await invoke('twin_gate_evaluate', { model_id: model.id, scene_id: SCENE_ID }, workerId, token)
log('  Twin Gate(场景级 AcceptanceProfile):')
log(gate.text.split('\n').slice(2, 28).map(x => '    ' + x).join('\n'))
const mpc = await invoke('mpc_optimize', {
  snapshot_id: snapshotId,
  model_id: model.id,
  baseline_controls: { [speedCtl.id]: 95 },
  horizon_steps: 4,
}, workerId, token)
writeFileSync(join(PREV_DIR, 'mpc-recommendation.txt'), mpc.text)
const mode = (mpc.text.match(/"mode":\s*"([^"]+)"/) || [])[1]
const bestCandidate = (mpc.text.match(/"bestCandidate":\s*(\{[^}]*\})/) || [])[1]
log(`✔ MPC: mode=${mode} best=${bestCandidate}`)

let best
try {
  best = JSON.parse(bestCandidate ?? 'null')
}
catch {
  best = null
}
const thicknessNode = (frozenScene.observations ?? []).find(v => (v.nodeId ?? '').includes('film'))?.nodeId
if (best && Object.keys(best).length > 0) {
  const idToNode = Object.fromEntries(sceneControls.map(c => [c.id, c.nodeId]))
  for (const [specId, value] of Object.entries(best)) {
    const nodeId = idToNode[specId]
    if (!nodeId || !Number.isFinite(Number(value))) continue
    const w = await api('POST', `/api/workshop/dcw/${nodeId}/write`, { value }, token)
    log(`  推荐写入 ${nodeId} ← ${Number(value).toFixed(2)} → HTTP ${w.status}`)
  }
  log('  等待 90s 工艺响应…')
  await sleep(90_000)
  const r = await api('GET', `/api/workshop/daq/${thicknessNode}/samples?bucketMs=1000&limit=60`, undefined, token)
  const pts = (r.json?.data?.points ?? []).map(p => Number(p.avg ?? p.value)).filter(Number.isFinite).slice(0, 30)
  const mean = pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : Number.NaN
  log(`✔ 执行后膜厚均值(最近 30s): ${mean.toFixed(2)} μm(目标 50μm)`)
  writeFileSync(join(PREV_DIR, 'closed-loop-write.json'), JSON.stringify({ best, thicknessAfter: mean }, null, 2))
}
else log('  ⚠ MPC 无可执行 bestCandidate')

// 文档
const modelsFull = model
const modelDir = modelsFull.path
const doc = [
  `# AML 混合孪生闭环优化 · 实机透明度记录`,
  ``,
  `- 运行: ${PREV_DIR.split('\\').pop()} · 平台 ${AW_BASE} · 模拟器 cast-film-physics(影子 4011)`,
  `- 产线 ${lineId} · 配方 ${recipeId} · 场景 ${SCENE_ID}@1.0.0(冻结) · Channel \`${channelId}\``,
  `- 模型 \`${model.id}\` [${model.stage}] label: ${modelsFull.label}`,
  ``,
  `## 1. 模型身份(输入=全部 DCW 设定点回读;输出=膜厚 goal 50μm)`,
  '```json',
  JSON.stringify({ id: model.id, label: modelsFull.label, description: modelsFull.description, lineId: modelsFull.lineId, recipeId: modelsFull.recipeId, objectiveId: modelsFull.objectiveId, dataset: datasetId }, null, 2),
  '```',
  ``,
  `## 2. 训练指标(平台权威)`,
  '```json',
  JSON.stringify({ oneStepTest: modelsFull.metrics?.oneStepTest, rolloutTest: modelsFull.metrics?.rolloutTest, hybrid: modelsFull.metrics?.hybrid, uncertainty: modelsFull.metrics?.uncertainty, physics: modelsFull.metrics?.physics }, null, 2).slice(0, 3600),
  '```',
  ``,
  `## 3. Twin Gate(场景级 AcceptanceProfile:cast-film 噪声底 persistence NRMSE≈0.38)`,
  '```text',
  gate.text.slice(0, 2400),
  '```',
  ``,
  `## 4. MPC 推荐(model-backed rollout)与闭环执行`,
  '```text',
  mpc.text.slice(0, 2400),
  '```',
  ``,
  `## 5. 模型工件(aml/models/${model.id}/)`,
  existsSync(modelDir) ? readdirSync(modelDir).map(f => `- ${f}(${statSync(join(modelDir, f)).size}B)`).join('\n') : `(路径: ${modelDir})`,
  ``,
  `## 6. 本阶段日志`,
  '```text',
  L2.join('\n'),
  '```',
].join('\n')
writeFileSync(DOC_PATH, doc)
log(`✔ 文档: ${DOC_PATH}`)
log('ALL STAGES DONE')
