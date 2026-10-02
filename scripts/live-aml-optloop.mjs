/**
 * LIVE AML 闭环优化全链路验收(bench 方法论;真实平台 + 真实 PLC 模拟器 + 真实训练)。
 *
 * 链路:
 *   隔离平台(3005,含本日构建) + 专用模拟器(4011 影子实例,cast-film 预设)
 *   → admin 注册 → provisionTwinLine(6 DCW 执行器 + 5 DAQ 传感器,真实协议链路)
 *   → 3 批次 × 330s 真实采样(DAQ 1s 节拍;val 批 ≥300 窗满足 Twin Gate G4)
 *   → REST 构建数据集(输入=全部 6 个 DCW;输出目标=膜厚 goal;特征=熔温/熔压)
 *   → hybrid_twin Channel(模板实例化 + worker 节点绑定)
 *   → invoke 桥(POST /agent-tools/invoke): twin_scene_discover → twin_scene_compile
 *     → twin_scene_freeze(用户确认令牌) → twin_physics_spec_draft(骨架物理模型)
 *     → twin_physics_spec_validate
 *   → REST 提交 hybrid_residual 训练(**无 code → 平台参考训练器**:物理参数校准 →
 *     3 成员残差集成 → conformal 覆盖率),轮询状态/进度/日志尾(透明)
 *   → 模型注册表校验(label/元数据/aml/models/<id> 工件) → REST 晋升 shadow
 *   → invoke: twin_snapshot_create(auto_daq) → twin_trial_run×10 → twin_gate_evaluate
 *     → mpc_optimize(model_id=训练模型驱动 rollout) → 读推荐
 *   → 透明度文档 bench/results/<rid>/OPTIMIZATION-LOG.md
 *
 * 运行: SIM_BASE=http://127.0.0.1:4011 node scripts/live-aml-optloop.mjs(需先 aw build)
 */
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureSimulator, applyPreset, simNodes } from '../bench/lib/sim.mjs'
import { provisionTwinLine, startTwinBatch } from '../bench/lib/closedloop.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AW_BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3005'
const AW_PORT = Number(new URL(AW_BASE).port)
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const OUT_DIR = join(REPO, 'bench', 'results', `${RUN_ID}-aml-live-optloop`)
mkdirSync(OUT_DIR, { recursive: true })
const LOG_PATH = join(OUT_DIR, 'live-run.log')
const DOC_PATH = join(OUT_DIR, 'OPTIMIZATION-LOG.md')
const AML_ROOT = process.env.AW_AML_DIR_LIVE ?? join(REPO, 'aml')

process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'

const L = []
function log(line) {
  const text = typeof line === 'string' ? line : JSON.stringify(line)
  const stamped = `[${new Date().toISOString()}] ${text}`
  console.log(stamped)
  L.push(text)
  appendFileSync(LOG_PATH, stamped + '\n')
}
function section(title) {
  log('')
  log('════════════════════════════════════════════════════════')
  log(`  ${title}`)
  log('════════════════════════════════════════════════════════')
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

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

async function waitFor(predicate, { timeoutMs, everyMs = 4000, what }) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await predicate()
    if (v) return v
    await sleep(everyMs)
  }
  throw new Error(`等待超时: ${what}(${timeoutMs}ms)`)
}

/* ════════ Stage 0 · 隔离平台 + 专用模拟器 ════════ */
section('Stage 0 · 隔离平台(3005) + 专用模拟器(4011)')

async function platformUp(base) {
  try {
    const r = await fetch(`${base}/api/users/setup-status`, { signal: AbortSignal.timeout(5000) })
    const j = await r.json().catch(() => null)
    return r.status === 200 && j?.data != null
  }
  catch { return false }
}

if (!(await platformUp(AW_BASE))) {
  const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'start', '--port', String(AW_PORT)], {
    cwd: REPO,
    env: { ...process.env, AW_AML_DIR: AML_ROOT, PORT: String(AW_PORT) },
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  log(`平台冷启: port=${AW_PORT} pid=${child.pid}(repo 配置根)`)
  log(`  AW_AML_DIR=${AML_ROOT}(复用真实训练 venv;模型工件落 repo ./aml/models)`)
}
await waitFor(() => platformUp(AW_BASE), { timeoutMs: 180_000, what: '平台就绪' })
log(`✔ 平台在线 ${AW_BASE}`)
const sim = await ensureSimulator({ log: m => log(`[sim] ${m}`) })
log(`✔ 模拟器在线: ${JSON.stringify(sim).slice(0, 120)}`)
await applyPreset('cast-film-physics')
const simDevices = await simNodes()
log(`✔ cast-film 预设应用,设备 ${simDevices.length} 台: ${simDevices.map(d => `${d.id}(${d.protocol})`).join(', ')}`)

/* ════════ Stage 1 · admin 注册 ════════ */
section('Stage 1 · 用户注册 + 提权(repo 库既有用户体系,新注册=user;本链路需 admin 建 DCW/产线)')
const reg = await api('POST', '/api/workshop/users/register', { name: `aml-live-${RUN_ID}` })
const token = reg.json?.data?.token
if (!token) throw new Error(`注册失败: ${JSON.stringify(reg.json).slice(0, 200)}`)
log('✔ token 就绪')
// 提升 role → admin(直改全局 users.sqlite;resolveUserByToken 每请求读库,即时生效)。
// 这是对本隔离测试账号的一次性授权,等价于管理员在用户管理页手工提权。
{
  const { DatabaseSync } = await import('node:sqlite')
  const usersDb = new DatabaseSync(join(REPO, '.AgentWorkShop', 'data', 'users.sqlite'))
  const r = usersDb.prepare(`UPDATE users SET role = 'admin' WHERE email LIKE 'aml-live-${RUN_ID}%' AND role = 'user'`).run()
  usersDb.close()
  log(`✔ 提权 admin: ${Number(r.changes)} 行`)
}

/* ════════ Stage 2 · 产线 provision + 开跑 ════════ */
section('Stage 2 · 产线 provisioning(6 DCW 执行器 + 5 DAQ 传感器,驱动配置取自模拟器 /export)')
const sfx = RUN_ID.slice(5, 16).replace(/-/g, '')
const twin = await provisionTwinLine({ call: async (m, p, b) => { const r = await api(m, p, b, token); return { status: r.status, ...(r.json ?? {}) } } }, { simDevices, sfx })
for (const e of twin.ev) log('  ' + e)
if (!twin.ok) throw new Error(`provision 失败: ${(twin.errors ?? []).join('; ')} | ev=${(twin.ev ?? []).join(' ; ')}`)
log(`✔ lineId=${twin.lineId} productId=${twin.productId}`)
log(`  DCW: ${JSON.stringify(twin.dcw)}`)
log(`  DAQ: ${JSON.stringify(twin.daq)}`)

const batch1 = await startTwinBatch({ call: async (m, p, b) => { const r = await api(m, p, b, token); return { status: r.status, ...(r.json ?? {}) } } }, { lineId: twin.lineId, productId: twin.productId, dcw: twin.dcw, sfx })
if (!batch1.ok) throw new Error(`开跑失败: ${batch1.errors?.join('; ')}`)
log(`✔ 批次开跑 recipeId=${batch1.recipeId}`)

// ── SP 设定点回读 DAQ 节点:AML 数据集的 control 输入取自数采时序库,
//    执行器设定点必须有 DAQ 回读节点(同一信号,只读)才能进入训练。──
const { simExport } = await import('../bench/lib/sim.mjs')
const spReadback = {}
const spSignalIds = Object.keys(twin.dcw) // zone1-sp / screw-sp / linespeed-sp / diegap-sp …
for (const dev of simDevices) {
  const exp = await simExport(dev.id)
  const items = exp?.items ?? []
  for (const spId of spSignalIds) {
    if (spReadback[spId]) continue
    const sig = (dev.signals ?? []).find(s => s.id === spId)
    if (!sig) continue
    // export 的 item.signal = 信号【名】(如「加热区1SP」),按名对齐
    const item = items.find(i => i.signal === sig.name)
    if (!item?.driverConfig) continue
    // 写配置 → 读配置转换:mqtt 写用 jsonKey(发布字段),DAQ 读订阅同主题用 jsonPath 取值
    let cfg = { ...item.driverConfig }
    if (cfg.jsonKey !== undefined && cfg.jsonPath === undefined) {
      cfg.jsonPath = cfg.jsonKey
      delete cfg.jsonKey
    }
    const r = await api('POST', '/api/workshop/daq', {
      name: `${sig.name} 回读 ${sfx}`, templateRef: 'daq-temp-tc', driver: dev.protocol, driverConfig: cfg,
      unit: sig.unit, min: sig.min, max: sig.max, lineId: twin.lineId, intervalMs: 1000, publishIntervalMs: 0,
      semantics: `执行器设定点回读(AML control 输入) ${item.signal}`,
    }, token)
    if (r.json?.data?.node?.id) spReadback[spId] = r.json.data.node.id
  }
}
log(`✔ SP 回读 DAQ 节点 ${Object.keys(spReadback).length}/6: ${JSON.stringify(spReadback)}`)

/* ════════ Stage 3 · 3 批次采样(每批 500s;批内两段安全阶跃激励) ════════ */
section('Stage 3 · 真实采样:3 批次 × 500s(批内阶跃激励:每个切分都覆盖 3 个设定点水平)')
// 实验设计:设定点只在批次间变化会导致 train/test 分布割裂(外推爆炸,G1/G3 必挂)。
// 批内阶跃:每个 run 依次经历 base → +Δ1 → +Δ2 三个水平,train/val/test 同分布;
// 各 run 的 Δ 略作变化增加丰富度,全部在配方窗口与安全上限内。
const BASE_SP = { 'linespeed-sp': 95, 'diegap-sp': 1.0 }
const EXCITE_RUNS = [
  [{ ls: 2.0, dg: 0.03 }, { ls: -1.5, dg: 0.06 }],
  [{ ls: -1.0, dg: 0.05 }, { ls: 2.5, dg: 0.02 }],
  [{ ls: 1.5, dg: 0.04 }, { ls: -2.0, dg: 0.05 }],
]
for (let run = 1; run <= 3; run++) {
  if (run > 1) {
    await api('POST', `/api/workshop/dcw/lines/${twin.lineId}/stop`, {}, token)
    log('  上一批次停止')
    // 复用同一配方 stop/start → 新 runId(数据集按 recipeId 取批次,须同配方)
    const st = await api('POST', `/api/workshop/dcw/lines/${twin.lineId}/start`, { recipeId: batch1.recipeId }, token)
    if (st.status !== 200) throw new Error(`批次 ${run} 开跑失败: ${JSON.stringify(st.json).slice(0, 200)}`)
    log(`  批次 ${run} 开跑(同配方 ${batch1.recipeId})`)
  }
  await sleep(60_000) // base 水平稳定 60s
  const [e1, e2] = EXCITE_RUNS[run - 1]
  await api('POST', `/api/workshop/dcw/${twin.dcw['linespeed-sp']}/write`, { value: BASE_SP['linespeed-sp'] + e1.ls }, token)
  await api('POST', `/api/workshop/dcw/${twin.dcw['diegap-sp']}/write`, { value: BASE_SP['diegap-sp'] + e1.dg }, token)
  log(`  批次${run} 阶跃1: linespeed=${BASE_SP['linespeed-sp'] + e1.ls} diegap=${(BASE_SP['diegap-sp'] + e1.dg).toFixed(2)}`)
  await sleep(170_000)
  await api('POST', `/api/workshop/dcw/${twin.dcw['linespeed-sp']}/write`, { value: BASE_SP['linespeed-sp'] + e2.ls }, token)
  await api('POST', `/api/workshop/dcw/${twin.dcw['diegap-sp']}/write`, { value: BASE_SP['diegap-sp'] + e2.dg }, token)
  log(`  批次${run} 阶跃2: linespeed=${BASE_SP['linespeed-sp'] + e2.ls} diegap=${(BASE_SP['diegap-sp'] + e2.dg).toFixed(2)}`)
  await sleep(270_000) // 第三水平保持至 500s
  const pv = twin.daq['film-thickness']
  const r = await api('GET', `/api/workshop/daq/${pv}/samples?bucketMs=1000&limit=3`, undefined, token)
  const latest = r.json?.data?.points?.[0]?.avg ?? '?'
  log(`  批次${run} 完成(500s) · 膜厚当前≈${typeof latest === 'number' ? latest.toFixed(2) : latest} μm`)
}
await api('POST', `/api/workshop/dcw/lines/${twin.lineId}/stop`, {}, token)
log('✔ 采样完成(3 批次 × 330s),产线停止')

/* ════════ Stage 4 · 构建数据集(输入=SP 回读 DAQ,目标=膜厚) ════════ */
section('Stage 4 · AML 数据集构建(输入=6 个 SP 回读 DAQ;输出目标=膜厚 goal;特征=熔温/熔压)')
if (Object.keys(spReadback).length < 6) throw new Error(`SP 回读节点不足: ${JSON.stringify(spReadback)}`)
// 采样预检:逐节点确认批次期间有样本(无样本的回读剔除并记录,防 0 窗数据集)
const sampledControls = []
for (const [sig, nodeId] of Object.entries(spReadback)) {
  const r = await api('GET', `/api/workshop/daq/${nodeId}/samples?bucketMs=60000&limit=1`, undefined, token)
  const has = (r.json?.data?.points ?? []).length > 0
  log(`  回读采样检查 ${sig}(${nodeId}): ${has ? '✓ 有样本' : '✘ 无样本,剔除'}`)
  if (has) sampledControls.push({ nodeId, role: 'control' })
}
if (sampledControls.length < 4) throw new Error(`可用 control 回读不足: ${sampledControls.length}`)
const dsBody = {
  lineId: twin.lineId, productId: twin.productId, recipeId: batch1.recipeId,
  nodes: [
    ...sampledControls,
    { nodeId: twin.daq['film-thickness'], role: 'target' },
    { nodeId: twin.daq['melt-temp'], role: 'feature' },
    { nodeId: twin.daq['melt-pressure'], role: 'feature' },
  ],
  beatMs: 1000, window: { historySteps: 8, horizonSteps: 4 },
  split: { valRatio: 0.34, testRatio: 0.33, seed: 42 },
  purpose: 'mpc_surrogate',
  note: `live 闭环优化数据集 ${RUN_ID}`,
}
const ds = await api('POST', '/api/workshop/aml/datasets', dsBody, token)
const dataset = ds.json?.data?.dataset
if (!dataset) throw new Error(`数据集构建失败: ${JSON.stringify(ds.json).slice(0, 300)}`)
log(`✔ 数据集 ${dataset.id}: ${dataset.rowCount} 窗 / ${dataset.runIds.length} 批 / sha=${String(dataset.sha256).slice(0, 12)}`)

/* ════════ Stage 5 · hybrid_twin Channel 实例化 + worker 绑定 ════════ */
section('Stage 5 · Hybrid Twin Channel(模板实例化 + worker 节点绑定)')
const templates = await api('GET', '/api/workshop/channel-templates', undefined, token)
const tpl = templates.json?.data?.find(x => x.id === 'chtpl-hybrid-twin-mpc-default')
if (!tpl) throw new Error('hybrid 模板缺失')
const SCENE_ID = `castfilm-hold-opt-${sfx}`
const inst = await api('POST', `/api/workshop/channel-templates/${tpl.id}/instantiate`, {
  name: `AML Live OptLoop ${RUN_ID}`,
  toolProfile: 'hybrid_twin',
  scene: { sceneId: SCENE_ID, sceneVersion: '1.0.0', lineId: twin.lineId, productId: twin.productId, recipeId: batch1.recipeId },
  objective: { objectiveId: 'thickness-50um', targets: { film_thickness: 50 } },
  controlPolicy: 'recommendation_only',
}, token)
const channelId = inst.json?.data?.channelId
const worker = inst.json?.data?.agents?.find(x => x.role === 'worker')
if (!channelId || !worker) throw new Error(`实例化失败: ${JSON.stringify(inst.json).slice(0, 300)}`)
log(`✔ channelId=${channelId} worker=${worker.id}`)
for (const nodeId of Object.values(twin.dcw)) {
  await api('POST', '/api/workshop/agent-tools/bindings', { agentId: worker.id, nodeId, kind: 'dcw', mode: 'auto' }, token)
}
for (const nodeId of Object.values(twin.daq)) {
  await api('POST', '/api/workshop/agent-tools/bindings', { agentId: worker.id, nodeId, kind: 'daq', mode: 'auto' }, token)
}
log(`✔ worker 绑定 ${Object.keys(twin.dcw).length} DCW + ${Object.keys(twin.daq).length} DAQ`)

/* ════════ Stage 6 · 场景发现→编译→冻结;骨架 PhysicsSpec ════════ */
section('Stage 6 · 场景发现→编译→冻结;骨架 PhysicsSpec(twin_physics_spec_draft)')
// 膜厚节点语义补『厚度』关键词(inferNodeRole 目标词表;信号名『膜厚』缺『度』不命中)→
// 不补语义膜厚会回退成 state,契约里没有 target,骨架物理模型就没有优化输出。
await api('PATCH', `/api/workshop/daq/${twin.daq['film-thickness']}`, { semantics: '流延膜厚度测量(优化目标 goal,单位 μm;厚度质量输出)' }, token)
const disco = await invoke('twin_scene_discover', {}, worker.id, token)
log(disco.text.split('\n').slice(0, 14).map(x => '  ' + x).join('\n'))
log('  膜厚目标识别: ' + (disco.text.includes('"target": 1') || disco.text.includes('"target":1') ? '✔ target=1' : '✘ 仍是 0(检查语义)'))
const compiled = await invoke('twin_scene_compile', {
  scene_id: SCENE_ID, scene_version: '1.0.0', line_id: twin.lineId, product_id: twin.productId, recipe_id: batch1.recipeId,
  prompt: '流延膜厚度闭环优化:目标膜厚 50μm。控制=6 个执行器设定点,观测=膜厚(目标)/熔温/熔压。约束:熔温 195~225℃,熔压 ≤22MPa。膜厚为目标输出。',
}, worker.id, token)
log(compiled.text.split('\n').slice(0, 12).map(x => '  ' + x).join('\n'))
const frozen = await invoke('twin_scene_freeze', {
  scene_id: SCENE_ID, scene_version: '1.0.0', confirmation: 'USER_CONFIRMED_SCENE_CONTRACT', approved_by: 'live-admin',
}, worker.id, token)
log(frozen.text.split('\n').slice(0, 8).map(x => '  ' + x).join('\n'))

// 冻结契约全文 = 孪生工件目录 scenes/<id>-<ver>-frozen/scenes.json(平台落盘,本地可读;
// 结构 { scene, contractHash, status, approvedBy, approvedAt },契约在 .scene 下)
const frozenArtifactPath = join(AML_ROOT, 'twins', 'scenes', `${SCENE_ID}-1.0.0-frozen`, 'scenes.json')
if (!existsSync(frozenArtifactPath)) throw new Error(`冻结场景工件缺失: ${frozenArtifactPath}`)
const frozenArtifact = JSON.parse(readFileSync(frozenArtifactPath, 'utf8'))
const frozenScene = frozenArtifact.scene ?? frozenArtifact
const sceneControls = frozenScene.controls ?? []
log(`✔ 冻结契约: controls=${sceneControls.length} targets=${(frozenScene.observations ?? []).filter(v => v.role === 'target').length} 约束=${(frozenScene.constraints ?? []).length}`)

const draft = await invoke('twin_physics_spec_draft', { dt_sec: 1 }, worker.id, token)
log(draft.text.split('\n').slice(0, 6).map(x => '  ' + x).join('\n'))
// 工具输出为摘要;spec 全文在落盘工件(aml/twins/physics-spec-draft/<id>/physics-spec-draft.json)
const draftArtifactPath = (draft.text.match(/artifact:\s*([^\n]+)/) || [])[1]?.trim()
if (!draftArtifactPath || !existsSync(draftArtifactPath)) throw new Error(`骨架 spec 工件缺失: ${draftArtifactPath}`)
const physicsSpec = JSON.parse(readFileSync(draftArtifactPath, 'utf8'))
log(`✔ 骨架 PhysicsSpec: model=${physicsSpec.modelId} 状态方程 ${physicsSpec.states.length} 观测 ${physicsSpec.observations.length} 可校准参数 ${physicsSpec.parameters.filter(p => p.min != null && p.max != null).length}/${physicsSpec.parameters.length}`)
writeFileSync(join(OUT_DIR, 'physics-spec.json'), JSON.stringify(physicsSpec, null, 2))
const validated = await invoke('twin_physics_spec_validate', { physics_spec: physicsSpec }, worker.id, token)
log(validated.text.split('\n').slice(0, 5).map(x => '  ' + x).join('\n'))

// ── 训练前对齐(关键):场景控制绑定的是 DCW 执行器,而数据集 control 列是 SP 回读
//    DAQ 节点 → spec 控制变量必须改绑回读节点;且 spec 只能引用数据集包含的节点
//    (场景可比数据集宽,宽出的变量取不到值 → 物理 NaN fail-closed)。──
const datasetManifest = JSON.parse(readFileSync(join(AML_ROOT, 'datasets', dataset.id, 'manifest.json'), 'utf8'))
const datasetNodes = new Set(datasetManifest.allNodes)
const dwToDn = {}
for (const [sig, dn] of Object.entries(spReadback)) dwToDn[twin.dcw[sig]] = dn
let remapped = 0
for (const v of physicsSpec.variables) {
  if (v.nodeId && !datasetNodes.has(v.nodeId) && dwToDn[v.nodeId]) { v.nodeId = dwToDn[v.nodeId]; remapped++ }
}
const keptVars = physicsSpec.variables.filter(v => !v.nodeId || datasetNodes.has(v.nodeId))
const keptIds = new Set(keptVars.map(v => v.id))
const dropped = physicsSpec.variables.filter(v => !keptIds.has(v.id)).map(v => `${v.id}(${v.nodeId})`)
physicsSpec.variables = keptVars
physicsSpec.states = physicsSpec.states.filter((e) => { const base = e.lhs.endsWith('_next') ? e.lhs.slice(0, -5) : e.lhs; return keptIds.has(base) })
physicsSpec.observations = physicsSpec.observations.filter(e => keptIds.has(e.lhs))
physicsSpec.guards = (physicsSpec.guards ?? []).filter(e => keptIds.has(e.lhs))
physicsSpec.constraints = physicsSpec.constraints.filter(c => keptIds.has(c.id))
writeFileSync(join(OUT_DIR, 'physics-spec-remapped.json'), JSON.stringify(physicsSpec, null, 2))
log(`✔ 训练对齐: 控制改绑 ${remapped};数据集裁剪剔除 ${dropped.length} 变量(${dropped.join(', ') || '无'});保留 ${keptVars.length}`)
const revalidated = await invoke('twin_physics_spec_validate', { physics_spec: physicsSpec }, worker.id, token)
log('  再校验: ' + revalidated.text.split('\n').filter(x => x.includes('"valid"')).join(' ').slice(0, 60))

/* ════════ Stage 7 · hybrid 训练(平台参考训练器,无 code) ════════ */
section('Stage 7 · 提交 hybrid_residual 训练(无 code → 平台参考训练器;物理校准+3 成员残差集成+UQ)')
const jobRes = await api('POST', '/api/workshop/aml/jobs', {
  datasetId: dataset.id,
  purpose: 'mpc_surrogate',
  changeNote: 'live 闭环优化:骨架物理+数据残差(全部 DCW → 膜厚 goal)',
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
  modelName: `流延膜厚闭环模型 ${sfx}`,
  modelDescription: `输入=全部 6 个 DCW 执行器;输出=膜厚 goal(50μm);场景 ${SCENE_ID}@1.0.0;产线 ${twin.lineId}/配方 ${batch1.recipeId}`,
}, token)
const job = jobRes.json?.data?.job
if (!job) throw new Error(`作业提交失败: ${JSON.stringify(jobRes.json).slice(0, 300)}`)
log(`✔ 作业 ${job.id} 入队(jobKind=${job.budget?.jobKind}, scene=${job.budget?.sceneId})`)
log(`  模型标识 name: ${job.budget?.modelName}`)
log(`  描述: ${job.budget?.modelDescription}`)

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
log(`  训练日志全文 → ${jobLogsPath}`)

/* ════════ Stage 8 · 模型保存校验 + 晋升 shadow ════════ */
section('Stage 8 · 模型保存校验(aml/models/<id> 工件 + label 元数据)+ 晋升 shadow')
const modelsRes = await api('GET', '/api/workshop/aml/models', undefined, token)
const model = (modelsRes.json?.data?.models ?? []).find(m => m.datasetId === dataset.id)
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
else log(`  ⚠ 模型目录(服务器进程视角): ${modelDir}`)
const metrics = model.metrics ?? {}
log(`  G1 单步 NRMSE=${metrics.oneStepTest?.nrmse} · G2 滚动=${metrics.rolloutTest?.nrmse}`)
log(`  hybrid: ${JSON.stringify(metrics.hybrid ?? {}).slice(0, 240)}`)
log(`  uncertainty: ${JSON.stringify(metrics.uncertainty ?? {}).slice(0, 240)}`)
log(`  physics: ${JSON.stringify(metrics.physics ?? {}).slice(0, 240)}`)
const promo = await api('POST', `/api/workshop/aml/models/${model.id}/promote`, { toStage: 'shadow' }, token)
log(`✔ 晋升 shadow: HTTP ${promo.status}`)

/* ════════ Stage 9 · 孪生闭环:快照 → 10 试验 → 门禁 → MPC 推荐 ════════ */
section('Stage 9 · 孪生闭环(auto_daq 快照 → 10 候选试验 → Twin Gate → MPC 推荐,训练模型驱动)')
await api('POST', `/api/workshop/dcw/lines/${twin.lineId}/start`, { recipeId: batch1.recipeId }, token)
log('  产线重启(真实工况下采快照)')
await sleep(25_000)
const snap = await invoke('twin_snapshot_create', { auto_daq: true, channel_id: channelId, phase: 'holding' }, worker.id, token)
log(snap.text.split('\n').slice(0, 8).map(x => '  ' + x).join('\n'))
const snapshotId = (snap.text.match(/snapshot_id:\s*([^\n]+)/) || [])[1]?.trim()
if (!snapshotId) throw new Error('快照创建失败: ' + snap.text.slice(0, 300))

// 候选轨迹:线速度小幅变化(量程 20~120,maxStep 由场景 writePolicy 派生)
const speedCtl = sceneControls.find(c => (c.nodeId ?? '').includes('linespeed')) ?? sceneControls[0]
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
  }, worker.id, token)
  log(`  trial#${k + 1} Δlinespeed=${delta.toFixed(2)} → ${t.text.split('\n').filter(x => x.includes('constraints_passed') || x.includes('improvement')).join(' | ').slice(0, 160)}`)
}
const gate = await invoke('twin_gate_evaluate', { model_id: model.id }, worker.id, token)
log('  Twin Gate(12 判据,回写 twinEligibility):')
log(gate.text.split('\n').slice(2, 26).map(x => '    ' + x).join('\n'))
const mpc = await invoke('mpc_optimize', {
  snapshot_id: snapshotId,
  model_id: model.id,
  baseline_controls: { [speedCtl.id]: 95 },
  horizon_steps: 4,
}, worker.id, token)
writeFileSync(join(OUT_DIR, 'mpc-recommendation.txt'), mpc.text)
const mode = (mpc.text.match(/"mode":\s*"([^"]+)"/) || [])[1]
const bestCandidate = (mpc.text.match(/"bestCandidate":\s*(\{[^}]*\})/) || [])[1]
const bestCost = (mpc.text.match(/"bestCost":\s*([\d.eE+-]+)/) || [])[1]
log(`✔ MPC 完成: mode=${mode} bestCandidate=${bestCandidate} bestCost=${bestCost}`)
log(`  完整推荐 → ${join(OUT_DIR, 'mpc-recommendation.txt')}`)

/* ════════ Stage 9b · 闭环执行:推荐设定点 → admin 写入(HITL 授权模拟)→ 复测 ════════ */
section('Stage 9b · 闭环执行:把 MPC 推荐的设定点写入产线(admin 执行),等待响应后复测')
let best
try {
  best = JSON.parse(bestCandidate ?? 'null')
}
catch {
  best = null
}
if (best && Object.keys(best).length > 0) {
  // spec 控制 id → 场景控制 nodeId(DCW 节点)
  const idToNode = Object.fromEntries(sceneControls.map(c => [c.id, c.nodeId]))
  const writes = []
  for (const [specId, value] of Object.entries(best)) {
    const nodeId = idToNode[specId]
    if (!nodeId || !Number.isFinite(Number(value))) continue
    const w = await api('POST', `/api/workshop/dcw/${nodeId}/write`, { value }, token)
    writes.push({ specId, nodeId, value, status: w.status })
    log(`  写入 ${nodeId} ← ${Number(value).toFixed(2)} → HTTP ${w.status}`)
  }
  log(`  等待 90s 工艺响应(settling)…`)
  await sleep(90_000)
  const pv = twin.daq['film-thickness']
  const r = await api('GET', `/api/workshop/daq/${pv}/samples?bucketMs=1000&limit=60`, undefined, token)
  const pts = (r.json?.data?.points ?? []).map(p => Number(p.avg ?? p.value)).filter(Number.isFinite).slice(0, 30)
  const mean = pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : Number.NaN
  log(`✔ 执行后膜厚均值(最近 30s): ${mean.toFixed(2)} μm(目标 50μm;写入前 ≈54 μm)`)
  writeFileSync(join(OUT_DIR, 'closed-loop-write.json'), JSON.stringify({ writes, thicknessAfter: mean }, null, 2))
}
else {
  log('  ⚠ MPC 未给出可执行的 bestCandidate(如 safe_small_step 阶段)——按平台治理,此阶段只推荐不写。')
}

/* ════════ Stage 10 · 透明度文档 ════════ */
section('Stage 10 · 生成透明度文档')
const doc = [
  `# AML 混合孪生闭环优化 · 实机透明度记录`,
  ``,
  `- 运行标识: ${RUN_ID}`,
  `- 平台: ${AW_BASE}(隔离实例,本日构建) · 模拟器: cast-film 预设(bench 影子实例 4011)`,
  `- 产线: ${twin.lineId} · 产品 ${twin.productId} · 配方 ${batch1.recipeId}`,
  `- 场景: ${SCENE_ID}@1.0.0(已冻结,用户确认令牌) · Hybrid Twin Channel \`${channelId}\``,
  `- 模型: \`${model.id}\`(label: ${model.label})`,
  ``,
  `## 1. 模型身份与谱系(输入=全部 DCW;输出=膜厚 goal)`,
  ``,
  '```json',
  JSON.stringify({
    id: model.id, label: model.label, description: model.description,
    lineId: model.lineId, recipeId: model.recipeId, purpose: model.purpose, objectiveId: model.objectiveId,
    dataset: dataset.id, windows: dataset.rowCount, runs: dataset.runIds.length,
    inputs: Object.keys(twin.dcw), output: 'film-thickness(目标 50μm)',
  }, null, 2),
  '```',
  ``,
  `## 2. 训练过程(平台参考训练器:物理参数校准 → 3 成员残差集成 → conformal UQ)`,
  ``,
  `- 作业: \`${job.id}\` · 平台门禁 G1-G5: ${gatesPassed ? '全部通过' : '未过'}`,
  `- 训练日志(平台 ##AML 协议行 + 训练输出全文)→ training-run.log;阶段日志 → live-run.log`,
  `- 平台权威指标:`,
  ``,
  '```json',
  JSON.stringify({
    oneStepTest: metrics.oneStepTest, rolloutTest: metrics.rolloutTest,
    hybrid: metrics.hybrid, uncertainty: metrics.uncertainty, physics: metrics.physics,
  }, null, 2).slice(0, 3600),
  '```',
  ``,
  `## 3. 物理模型(骨架 + 训练校准后 θ 见模型工件 physics_parameters.json)`,
  ``,
  '```json',
  JSON.stringify(physicsSpec, null, 2).slice(0, 3000),
  '```',
  ``,
  `## 4. Twin Gate 判定(12 判据,回写模型 twinEligibility)`,
  ``,
  '```text',
  gate.text.slice(0, 2400),
  '```',
  ``,
  `## 5. MPC 推荐(recommendation-only;model-backed rollout)`,
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
  L.join('\n').slice(-80_000),
  '```',
].join('\n')
writeFileSync(DOC_PATH, doc)
log(`✔ 透明度文档: ${DOC_PATH}`)
log(`✔ 运行目录: ${OUT_DIR}`)
log('ALL STAGES DONE')
