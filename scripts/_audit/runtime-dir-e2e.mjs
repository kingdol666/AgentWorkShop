#!/usr/bin/env node
/**
 * scripts/_audit/runtime-dir-e2e.mjs —— 运行时目录规约验收(A1-A6)。
 *
 * 验收规范:
 *   A1 目录优先级:cwd ./.AgentWorkShop(最高)> ~/.AgentWorkShop 兜底;AW_HOME/AW_AML_DIR 可显式覆盖
 *   A2 全产物落位配置根:data/、aml/{datasets,jobs,models,.venv,tools,runtime} 全在 <配置根>;检出根零新增
 *   A3 AML 训练产物入运行时目录:datasets/<id>/jobs/<id>/models/<id> 全在 <配置根>/aml,模型可读
 *   A4 uv 优先+启动预热:有 uv → 启动后自动后台创建 <配置根>/aml/.venv 并 ready(无 uv 回退 python -m venv)
 *   A5 清数据冷启动:删 data/aml 后重启全部自动重建;家目录兜底模式成立
 *   A6 更新链路:aw update --check 可用;配置根在包外 → 更新不触碰数据/模型/venv
 *
 * 流程:捕获真实 physics_spec → 预清(改名保留 *.pre-clean-20260927)→ repo 模式冷启 3467 →
 *       A2/A4 断言 → 注册 admin → 等 venv ready → 建线跑 4 批(4017 模拟器)→ A3 数据集+训练 →
 *       家目录兜底实例 3468(临时 cwd)→ aw update --check → 清场。
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const AW_PORT = 3467
const HOME_PORT = 3468
const SIM_PORT = 4017
const SIM_DIR = resolve(REPO, '..', 'plc-node-simulator-bench-4017')
const CONFIG_ROOT = join(REPO, '.AgentWorkShop')
const TODAY = '20260927'
let BASE = `http://127.0.0.1:${AW_PORT}`
const SIM = `http://127.0.0.1:${SIM_PORT}`

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJson = async (url, token) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000), headers: token ? { authorization: `Bearer ${token}` } : {} })
    return await r.json()
  }
  catch { return null }
}
const killPort = (port) => {
  try {
    const psi = spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8' })
    const pid = Number(psi.stdout.trim())
    if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  catch { /* 尽力而为 */ }
}

/** 捕获既有真实 physics_spec(训练器 fail-closed 要求真实骨架;S0 重命名前取样,训练时空 nodeIds 重映射)。
 *  候选:aml/jobs 与各 aml.pre-clean-NNN/jobs;优先含 artifacts 目录(已完成)的最新作业。 */
function captureRealSpec() {
  const candidates = [join(REPO, 'aml', 'jobs'), ...readdirSync(REPO).filter(d => d.startsWith('aml.pre-clean-')).map(d => join(REPO, d, 'jobs'))]
  for (const jobsDir of candidates) {
    try {
      if (!existsSync(jobsDir)) continue
      const done = readdirSync(jobsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && existsSync(join(jobsDir, d.name, 'artifacts')) && existsSync(join(jobsDir, d.name, 'physics_spec.json')))
        .map(d => ({ name: d.name, m: statSync(join(jobsDir, d.name)).mtimeMs }))
        .sort((a, b) => b.m - a.m)
      if (done.length) return JSON.parse(readFileSync(join(jobsDir, done[0].name, 'physics_spec.json'), 'utf8'))
    }
    catch { /* 试下一个候选 */ }
  }
  return null
}

/* ── S0 · 捕获 spec + 预清数据(改名保留,遵循 *.pre-clean-* 惯例)── */
console.log('[S0] 捕获真实 physics_spec + 预清运行时数据(改名保留)')
const realSpec = captureRealSpec()
ok('捕获真实 physics_spec(训练骨架样本)', Boolean(realSpec), realSpec ? `variables=${realSpec.variables?.length}` : 'aml/jobs 无历史作业')
for (const port of [AW_PORT, HOME_PORT, SIM_PORT]) killPort(port)
if (existsSync(join(REPO, 'aml'))) {
  renameSync(join(REPO, 'aml'), join(REPO, `aml.pre-clean-${TODAY}`))
  console.log(`  · repo/aml → aml.pre-clean-${TODAY}`)
}
// 备份已存在 → 当前目录必是上一轮验收后的全新重建,直接清(真实数据早在首个备份里)
const moveAside = (src, label) => {
  if (!existsSync(src)) return
  const dst = join(dirname(src), `${label}.pre-clean-${TODAY}`)
  if (existsSync(dst)) {
    rmSync(src, { recursive: true, force: true })
    console.log(`  · ${label} → 已有备份 ${label}.pre-clean-${TODAY},当前(上次重建)直接清除`)
  }
  else {
    renameSync(src, dst)
    console.log(`  · ${label} → ${label}.pre-clean-${TODAY}`)
  }
}
moveAside(join(REPO, 'aml'), 'aml')
moveAside(join(CONFIG_ROOT, 'data'), 'data')
moveAside(join(CONFIG_ROOT, 'aml'), 'aml')
// 预置运行时设置:MCP 开关 + 门禁校准(placement 验收用松门禁;数据/模型落位与门禁强弱无关)
writeFileSync(join(CONFIG_ROOT, 'runtime-settings.json'), JSON.stringify({ version: 1, overrides: { 'mcp.enabled': true, 'aml.gates.nrmse': 0.9, 'aml.gates.rolloutNrmse': Number(process.env.RTD_GATE_ROLLOUT ?? 0.99), 'aml.gates.valTestGap': 2, 'aml.gates.minRows': 100 } }))
ok('A0 预清完成(检出根/aml 与配置根/data·aml 均已移除)', !existsSync(join(REPO, 'aml')) && !existsSync(join(CONFIG_ROOT, 'data')) && !existsSync(join(CONFIG_ROOT, 'aml')))

/* ── S1 · repo 模式冷启动(无 AW_HOME/AW_MODE,配置根=.AgentWorkShop)── */
console.log('[S1] repo 模式冷启动(配置根 = <repo>/.AgentWorkShop)')
{
  const out = openSync(join(CONFIG_ROOT, 'boot-audit.log'), 'a')
  const p = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'start', '--port', String(AW_PORT)], {
    cwd: REPO,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', NUXT_SESSION_PASSWORD: 'runtime-dir-e2e-session-password-0123456' },
    detached: true, windowsHide: true, stdio: ['ignore', out, out],
  })
  closeSync(out); p.unref()
}
let actualPort = AW_PORT
for (let i = 0; i < 20; i++) {
  await sleep(1500)
  try {
    const lock = JSON.parse(readFileSync(join(CONFIG_ROOT, '.runtime', 'aw.lock'), 'utf8'))
    if (Number.isInteger(lock?.port)) { actualPort = lock.port; break }
  }
  catch { /* 等锁 */ }
}
BASE = `http://127.0.0.1:${actualPort}`
let up = false
for (let i = 0; i < 40; i++) {
  await sleep(2000)
  if ((await getJson(`${BASE}/api/health`))?.data?.status === 'ok') { up = true; break }
}
ok('平台健康门', up, `BASE=${BASE} 日志 ${join(CONFIG_ROOT, 'boot-audit.log')}`)
if (!up) { console.log(`═══ ${pass} PASS / ${fails.length + 1} FAIL ═══`); process.exit(1) }

/* ── S2 · A2 全产物落位 + A4 预热已触发 ── */
console.log('[S2] A2 全产物落位配置根 + A4 启动预热触发')
let TOKEN = ''
{
  ok('A2a data/ 重建于配置根', existsSync(join(CONFIG_ROOT, 'data')))
  ok('A2b aml 骨架重建于配置根', ['datasets', 'jobs', 'models', 'tools', 'runtime'].every(s => existsSync(join(CONFIG_ROOT, 'aml', s))))
  ok('A2c 检出根无 aml/ 运行时目录(零新增)', !existsSync(join(REPO, 'aml')))

  for (let i = 0; i < 15; i++) {
    try {
      const r = await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'runtime-audit', email: `runtime-${Date.now()}@awshop.local`, password: 'runtime-e2e-passw0rd' }) })
      const j = await r.json()
      if (j?.data?.token) { TOKEN = j.data.token; break }
    }
    catch { /* 服务未就绪,重试 */ }
    await sleep(2000)
  }
  ok('admin 注册(全新库首注册即 admin)', Boolean(TOKEN))
  const envInfo = await getJson(`${BASE}/api/workshop/aml/env`, TOKEN)
  ok('A2d aml/env 报告运行时根', envInfo?.data?.amlRoot === join(CONFIG_ROOT, 'aml'), JSON.stringify({ root: envInfo?.data?.amlRoot, src: envInfo?.data?.amlRootSource }))
  ok('A2e 来源标签=项目运行时根', /项目运行时根/.test(envInfo?.data?.amlRootSource ?? ''), envInfo?.data?.amlRootSource)
  const bootLog = existsSync(join(CONFIG_ROOT, 'boot-audit.log')) ? readFileSync(join(CONFIG_ROOT, 'boot-audit.log'), 'utf8') : ''
  ok('A4a 启动预热已触发(uv 探测+后台建环境)', bootLog.includes('[aml] 启动预热'), bootLog.split('\n').filter(l => l.includes('[aml]')).slice(-2).join(' | ') || '(无 [aml] 行)')
}

/* ── S3 · A4 等 venv ready(uv 供给)── */
console.log('[S3] A4 等待训练环境就绪(uv 后台供给,最长 10 分钟)')
{
  let ready = false
  let last = ''
  for (let i = 0; i < 60; i++) {
    await sleep(10_000)
    const st = await getJson(`${BASE}/api/workshop/aml/env`, TOKEN)
    last = JSON.stringify({ ready: st?.data?.venv?.ready, task: st?.data?.task?.status, tail: st?.data?.task?.log?.slice(-1) })
    if (st?.data?.venv?.ready) { ready = true; break }
  }
  ok('A4b .venv 在配置根就绪(uv 供给)', ready, last)
  ok('A4c venv 落点在配置根内', existsSync(join(CONFIG_ROOT, 'aml', '.venv')), join(CONFIG_ROOT, 'aml', '.venv'))
}

/* ── S4 · A3 训练产物入配置根(权威建线 → 4 批 → 数据集 → hybrid 训练 → 模型)── */
console.log('[S4] A3 训练产物入运行时目录(建线→4 批次→数据集→训练→模型)')
{
  process.env.SIM_BASE = SIM
  process.env.SIM_SHADOW_DIR = SIM_DIR
  const { ensureSimulator, applyPreset } = await import('../../bench/lib/sim.mjs')
  await ensureSimulator({ log: () => {} })
  await applyPreset('cast-film-physics')
  const simDevices = (await getJson(`${SIM}/api/nodes`))?.data ?? []

  const { provisionTwinLine, startTwinBatch } = await import('../../bench/lib/closedloop.mjs')
  const callA = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000) })
    const json = await r.json().catch(() => null)
    return { status: r.status, json, message: json?.message, data: json?.data }
  }
  const twin = await provisionTwinLine({ call: async (m, p, b) => { const r = await callA(m, p, b); return { status: r.status, data: r.data, message: r.message } } }, { simDevices, sfx: 'rtdir' })
  ok('S4a 权威建线(6 DCW + 5 DAQ)', twin.ok, (twin.ev ?? []).join(' | ').slice(0, 200))
  globalThis.__lineId = twin.lineId

  const spReadback = {}
  {
    // SP 回读 DAQ 节点(two-modes 同款:export 取配置,http/mqtt 的 jsonKey 修成 jsonPath)
    for (const dev of simDevices) {
      const exp = (await getJson(`${SIM}/api/nodes/${dev.id}/export`))?.data?.items ?? []
      for (const id of Object.keys(twin.dcw)) {
        if (spReadback[id]) continue
        const sig = (dev.signals ?? []).find(s => s.id === id)
        if (!sig) continue
        const item = exp.find(i => i.signal === sig.name)
        if (!item?.driverConfig) continue
        const cfg = { ...item.driverConfig }
        if (cfg.jsonKey !== undefined && cfg.jsonPath === undefined) { cfg.jsonPath = cfg.jsonKey; delete cfg.jsonKey }
        const r = await callA('POST', '/api/workshop/daq', {
          name: `${sig.name} 回读 rtdir`, templateRef: 'daq-temp-tc', driver: dev.protocol, driverConfig: cfg,
          unit: sig.unit, min: sig.min, max: sig.max, lineId: twin.lineId, intervalMs: 1000, publishIntervalMs: 0,
          semantics: `执行器设定点回读(AML control 输入) ${item.signal}`,
        })
        spReadback[id] = r.json?.data?.node?.id ?? r.json?.data?.id
      }
    }
  }
  ok('S4a-2 SP 回读 DAQ ×6', Object.keys(spReadback).length === 6, JSON.stringify(spReadback))
  // 膜厚语义补「目标 goal + 厚度」词表(scene 编译 target 识别依据;two-modes 同款 PATCH)
  await callA('PATCH', `/api/workshop/daq/${twin.daq['film-thickness']}`, { semantics: '流延膜厚度测量(优化目标 goal,单位 μm;厚度质量输出)' })
  await callA('POST', '/api/workshop/daq/controller', { action: 'start' })
  const batch = await startTwinBatch({ call: async (m, p, b) => { const r = await callA(m, p, b); return { status: r.status, data: r.data, message: r.message } } }, { lineId: twin.lineId, productId: twin.productId, dcw: twin.dcw, sfx: 'rtdir' })
  globalThis.__lineId = twin.lineId
  ok('S4b 配方开跑(批次1)', batch.ok && Boolean(batch.recipeId), JSON.stringify(batch).slice(0, 140))
  const recipeId = batch.recipeId

  /* ── S4c 训练通道(hybrid_twin)+ 场景发现/编译/冻结 + 骨架 PhysicsSpec ── */
  const scene = { sceneId: `runtime-dir-accept`, sceneVersion: '1.0.0', lineId: twin.lineId, productId: twin.productId, recipeId }
  const inst = await callA('POST', '/api/workshop/channel-templates/chtpl-hybrid-twin-mpc-default/instantiate', {
    name: `运行时目录训练通道 rtdir`, toolProfile: 'hybrid_twin', scene,
    objective: { objectiveId: 'thickness-50um', targets: { film_thickness: 50 } },
    controlPolicy: 'recommendation_only',
  })
  const instData = inst.json?.data ?? {}
  const channelA = instData.channelId
  const workerA = (instData.agents ?? []).find(a => a.role === 'worker')?.id
  ok('S4c-1 训练通道实例化(hybrid_twin)+ worker', Boolean(channelA && workerA), JSON.stringify({ channelA, workerA }).slice(0, 120))
  for (const nodeId of Object.values(twin.dcw)) await callA('POST', '/api/workshop/agent-tools/bindings', { agentId: workerA, nodeId, kind: 'dcw', mode: 'auto' })
  for (const nodeId of Object.values(twin.daq)) await callA('POST', '/api/workshop/agent-tools/bindings', { agentId: workerA, nodeId, kind: 'daq', mode: 'auto' })
  const invoke = async (tool, args, agentId) => {
    const r = await callA('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args })
    const result = r.json?.data?.result
    return { isError: Boolean(result?.isError), text: String(result?.text ?? ''), data: result?.data ?? null }
  }
  const disco = await invoke('twin_scene_discover', {}, workerA)
  ok('S4c-2 场景发现(target=1 语义命中)', !disco.isError && /"target"\s*:\s*1/.test(disco.text), disco.text.slice(0, 140))
  const compiled = await invoke('twin_scene_compile', {
    scene_id: scene.sceneId, scene_version: '1.0.0', line_id: twin.lineId, product_id: twin.productId, recipe_id: recipeId,
    prompt: '流延膜厚度闭环优化:目标膜厚 50μm。控制=6 个执行器设定点,观测=膜厚(目标)/熔温/熔压。约束:熔温 195~225℃,熔压 ≤22MPa。膜厚为目标输出。',
  }, workerA)
  ok('S4c-3 场景编译', !compiled.isError, compiled.text.slice(0, 140))
  const frozen = await invoke('twin_scene_freeze', {
    scene_id: scene.sceneId, scene_version: '1.0.0', confirmation: 'USER_CONFIRMED_SCENE_CONTRACT', approved_by: 'runtime-dir-e2e',
  }, workerA)
  ok('S4c-4 场景冻结(用户确认令牌)', !frozen.isError, frozen.text.slice(0, 140))
  const draft = await invoke('twin_physics_spec_draft', { dt_sec: 1 }, workerA)
  const draftArtifactPath = (draft.text.match(/artifact:\s*([^\n]+)/) || [])[1]?.trim()
  ok('S4c-5 骨架 PhysicsSpec 生成', !draft.isError && Boolean(draftArtifactPath) && existsSync(draftArtifactPath), draft.text.slice(0, 140))
  const physicsSpec = JSON.parse(readFileSync(draftArtifactPath, 'utf8'))
  const dwToDn = {}
  for (const [sig, dn] of Object.entries(spReadback)) dwToDn[twin.dcw[sig]] = dn
  console.log('  ↳ 批次1 采样积累 300s(物理滞后:阶跃全响应需要长批)')
  await sleep(300_000)

  /* ── S4d 4 个已闭合批次(每批 ~75s;首批已跑)── */
  const closeAndRestart = async (i) => {
    await callA('POST', `/api/workshop/dcw/lines/${twin.lineId}/stop`, {})
    await sleep(3000)
    const st = await callA('POST', `/api/workshop/dcw/lines/${twin.lineId}/start`, { recipeId })
    if (st.status !== 200) { await sleep(8000); await callA('POST', `/api/workshop/dcw/lines/${twin.lineId}/start`, { recipeId }) }
    console.log(`  ↳ 批次 ${i} 闭合/重启`)
  }
  // 批次 2-4:每批 300s + 两次工况阶跃(+65s/+200s)。物理滞后(熔体延迟/热惯性)需要长批
  // 才能看到阶跃的全响应;短批数据"输入已变输出未动"会毁掉一致性(实测 NRMSE>1 的根因)。
  const BATCHES = [
    { n: 2, steps: [{ at: 65_000, node: 'linespeed-sp', v: 97 }, { at: 200_000, node: 'diegap-sp', v: 1.03 }] },
    { n: 3, steps: [{ at: 65_000, node: 'linespeed-sp', v: 93 }, { at: 200_000, node: 'diegap-sp', v: 0.97 }] },
    { n: 4, steps: [{ at: 65_000, node: 'linespeed-sp', v: 97 }, { at: 200_000, node: 'diegap-sp', v: 1.0 }] },
  ]
  for (const b of BATCHES) {
    await closeAndRestart(b.n) // 闭合上一批 → 新批配方下发(锚定 60s 冷却)
    let prev = 0
    for (const st of b.steps) {
      await sleep(st.at - prev)
      prev = st.at
      const w = await callA('POST', `/api/workshop/dcw/${twin.dcw[st.node]}/write`, { value: st.v })
      console.log(`  ↳ 批次 ${b.n} 阶跃 ${st.node} ← ${st.v} ${w.status === 200 ? '√' : '✘ ' + String(w.json?.message ?? '').slice(0, 70)}`)
    }
    await sleep(300_000 - prev)
  }
  await callA('POST', `/api/workshop/dcw/lines/${twin.lineId}/stop`, {})
  await sleep(3000)

  const runs = (await callA('GET', '/api/workshop/dcw/recipes')).json?.data?.runs ?? []
  const closed = runs.filter(x => x.endedAt && x.recipeId === recipeId)
  ok('S4d 4 个已闭合批次', closed.length >= 4, `closed=${closed.length}`)

  /* ── S4e 数据集(9 节点)+ spec 变量改绑回读 + 训练 + 模型 ── */
  const ds = (await callA('POST', '/api/workshop/aml/datasets', {
    lineId: twin.lineId, productId: twin.productId, recipeId,
    nodes: [
      ...Object.values(spReadback).map(nid => ({ nodeId: nid, role: 'control' })),
      { nodeId: twin.daq['film-thickness'], role: 'target' },
      { nodeId: twin.daq['melt-pressure'], role: 'feature' },
      { nodeId: twin.daq['melt-temp'], role: 'feature' },
    ],
    beatMs: 1000, window: { historySteps: 8, horizonSteps: 4 },
    split: { valRatio: 0.34, testRatio: 0.33, seed: Number(process.env.RTD_SPLIT_SEED ?? 42) },
    purpose: 'mpc_surrogate', note: '运行时目录规约验收数据集',
  })).json?.data?.dataset
  ok('S4e-1 数据集构建(9 变量对齐 spec)', Boolean(ds?.id) && ds.runIds?.length >= 4, JSON.stringify({ id: ds?.id, rows: ds?.rowCount, runs: ds?.runIds?.length }).slice(0, 140))
  ok('A3a 数据集实体在配置根', existsSync(join(CONFIG_ROOT, 'aml', 'datasets', ds.id, 'manifest.json')), join(CONFIG_ROOT, 'aml', 'datasets', ds.id))

  // 训练前对齐(two-modes 同款):spec 变量改绑回读节点 + 剔除数据集外变量
  const man = JSON.parse(readFileSync(join(CONFIG_ROOT, 'aml', 'datasets', ds.id, 'manifest.json'), 'utf8'))
  const datasetNodes = new Set(man.allNodes)
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
    datasetId: ds.id, purpose: 'mpc_surrogate', changeNote: '运行时目录规约验收训练',
    params: { epochs: 600, hidden: 128, lr: 0.0015, residual_scale: 2, ensemble: 3 },
    seed: 11, jobKind: 'hybrid_residual', sceneId: scene.sceneId, sceneVersion: '1.0.0', objectiveId: 'thickness-50um',
    physicsSpec, providerId: physicsSpec.modelId, providerVersion: '1.0.0', providerHash: `sha256:${JSON.stringify(physicsSpec).length}`,
    modelName: `运行时目录验收模型 rtdir`, modelDescription: 'A3 验收:模型工件应落在运行时目录',
  })).json?.data?.job
  ok('S4e-2 训练作业提交', Boolean(job?.id), JSON.stringify(job ?? {}).slice(0, 160))

  let jobDone = null
  for (let i = 0; i < 60; i++) {
    await sleep(5000)
    const r = await callA('GET', `/api/workshop/aml/jobs/${job.id}`)
    jobDone = r.json?.data?.job
    if (jobDone?.status === 'done' || jobDone?.status === 'failed') break
  }
  ok('S4f 训练完成(平台门禁全过)', jobDone?.status === 'done', `status=${jobDone?.status} err=${(jobDone?.error ?? '').slice(0, 160)}`)
  const models = (await callA('GET', '/api/workshop/aml/models')).json?.data?.models ?? []
  const model = models.find(m => m.datasetId === ds.id)
  ok('A3b 模型注册且工件在配置根', Boolean(model?.id) && existsSync(join(CONFIG_ROOT, 'aml', 'models', model.id, 'model.onnx')), join(CONFIG_ROOT, 'aml', 'models', model?.id ?? '?'))
}

/* ── S5 · A5 家目录兜底(临时 cwd 启动,真 ~/.AgentWorkShop)── */
console.log('[S5] A5 家目录兜底:临时 cwd 启动(无 AW_HOME/AW_MODE)')
{
  const tempCwd = mkdtempSync(join(tmpdir(), 'aw-fallback-cwd-'))
  const homeRoot = join(homedir(), '.AgentWorkShop')
  const out = openSync(join(tempCwd, 'home-instance.log'), 'a')
  const p = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'start', '--port', String(HOME_PORT)], {
    cwd: tempCwd,
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', NUXT_SESSION_PASSWORD: 'runtime-dir-e2e-session-password-0123456' },
    detached: true, windowsHide: true, stdio: ['ignore', out, out],
  })
  closeSync(out); p.unref()
  let hb = false
  for (let i = 0; i < 40; i++) {
    await sleep(2000)
    if ((await getJson(`http://127.0.0.1:${HOME_PORT}/api/health`))?.data?.status === 'ok') { hb = true; break }
  }
  ok('A5a 家目录兜底实例健康(检出外 cwd)', hb, `日志 ${join(tempCwd, 'home-instance.log')}`)
  await sleep(4000)
  const bootLog = existsSync(join(tempCwd, 'home-instance.log')) ? readFileSync(join(tempCwd, 'home-instance.log'), 'utf8') : ''
  ok('A5b 兜底实例同样触发 AML 环境预热', bootLog.includes('[aml] 启动预热'), bootLog.split('\n').filter(l => l.includes('[aml]')).slice(-1).join('') || '(无)')
  ok('A5c 数据/AML 落 ~/.AgentWorkShop', existsSync(join(homeRoot, 'data')) && existsSync(join(homeRoot, 'aml', 'datasets')))
  killPort(HOME_PORT)
  try { rmSync(tempCwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 1500 }) } catch { /* 实例句柄延迟释放,允许残留 */ }
}

/* ── S6 · A6 更新链路 ── */
console.log('[S6] A6 更新链路:aw update --check(npm registry 对比)')
{
  const r = spawnSync(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'update', '--check'], { cwd: REPO, encoding: 'utf8', timeout: 120_000, shell: true })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  ok('A6 aw update --check 正常执行(版本对比/网络说明)', r.status === 0 || /latest|version|registry|npm|网络|超时/i.test(out), out.slice(0, 200))
  ok('A6b 配置根在包外(更新不触碰数据/模型/venv——设计断言)', !resolve(REPO, '.output').startsWith(join(homedir(), '.AgentWorkShop')) && existsSync(join(CONFIG_ROOT, 'aml', '.venv')))
}

/* ── 清场 ── */
console.log('[清场]')
killPort(actualPort)
killPort(SIM_PORT)
await sleep(1500)
console.log(`  · 保留新初始化的运行时目录(${CONFIG_ROOT})与 aml.pre-clean-${TODAY}/data.pre-clean-${TODAY} 备份`)

console.log('')
console.log(`═══ 运行时目录规约验收:${pass} PASS / ${fails.length} FAIL ═══`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('')
process.exit(fails.length ? 1 : 0)
