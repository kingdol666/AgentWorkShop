/**
 * LIVE 双模式闭环优化全链路:探索式(optimization_explore)→ AML 模型式(trial/MPC/bayes)。
 *
 * 与 live-aml-optloop.mjs(单通道 hybrid、REST 激励)的分工:本脚本按 2026-09-26 解耦
 * 架构跑**两个 Channel** —— 工艺优化通道(aml_optimization,探索/AML 双模式)与
 * 训练通道(hybrid_twin,场景冻结/训练/门禁),全部产线写入走 Agent 治理链:
 *
 *   隔离平台(home 模式,AW_BASE:3061) + 专用模拟器(SIM_BASE:4012 影子,cast-film 预设)
 *   → admin 注册(首注册即 admin) → provisionTwinLine(6 DCW + 5 DAQ + 6 SP 回读)
 *   → 【优化通道 B】实例化(chtpl-aml-optimization-default, exploration) + worker 绑定
 *   → 负向校验:探索模式下 twin_trial_run 被 dispatch 拒绝(EXPLORATION_MODE_NO_MODEL)
 *   → 【第一轮·探索式】批次1 内 optimization_explore ×N(割线策略收敛膜厚 50μm,
 *     真实写入走 dcw_control 全治理链:绑定鉴权/四层限界/60s 间隔/优化记录)
 *   → 激励采样:批次 2-3 阶跃(线速/模口间隙,为模型可辨识性;manual REST 写入,同样限频)
 *   → 【训练通道 A】实例化 + worker 绑定 → 场景发现/编译/冻结(用户确认令牌)
 *     → 骨架 PhysicsSpec → 数据集(控制=SP 回读,目标=膜厚) → hybrid_residual 训练
 *     → 晋升 shadow → snapshot → twin_trial_run×10(必传 model_id,UQ 才有效)
 *     → twin_gate_evaluate(12 判据) → 绑定模型到优化通道 B(fail-closed 校验)
 *   → 【第二轮·模型式】B 自动进入 aml 模式:mpc_optimize(model_id) → precise_search
 *     → 推荐经 optimization_explore 治理投用 → 复测膜厚;twin_bayes_optimize 收敛寻优
 *   → 透明度文档 bench/results/<rid>/OPTIMIZATION-LOG.md + state.json(可断点续跑)
 *
 * 运行: node scripts/live-optloop-two-modes.mjs [--run-id <rid>]
 *   断点续跑: 同 --run-id 重跑,已完成 Stage 自动跳过(state.json)。
 */
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  return i >= 0 ? process.argv[i + 1] : d
}
const AW_BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3061'
const AW_PORT = Number(new URL(AW_BASE).port)
const RUN_ID = arg('--run-id', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))
const OUT_DIR = join(REPO, 'bench', 'results', `${RUN_ID}-optloop-two-modes`)
mkdirSync(OUT_DIR, { recursive: true })
const LOG_PATH = join(OUT_DIR, 'live-run.log')
const STATE_PATH = join(OUT_DIR, 'state.json')
const DOC_PATH = join(OUT_DIR, 'OPTIMIZATION-LOG.md')
const AML_ROOT = process.env.AW_AML_DIR_LIVE ?? join(REPO, 'aml')
const HOME_DIR = process.env.AW_HOME_DIR ?? join(REPO, '.e2e-optloop-home')

// 模拟器端口/影子目录必须在 import sim.mjs 之前定死(模块级常量)
process.env.SIM_BASE = process.env.SIM_BASE ?? 'http://127.0.0.1:4012'
process.env.SIM_SHADOW_DIR = process.env.SIM_SHADOW_DIR ?? resolve(REPO, '..', 'plc-node-simulator-bench-4012')
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
const dataOf = r => r.json?.data ?? r.json

async function invoke(tool, args, agentId, token) {
  const r = await api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, token)
  const text = r.json?.data?.result?.text ?? r.json?.result?.text ?? JSON.stringify(r.json ?? {}).slice(0, 600)
  log(`  [invoke:${agentId.slice(-6)}] ${tool} → ${r.status}`)
  return { status: r.status, text, isError: Boolean(r.json?.data?.result?.isError ?? r.json?.result?.isError) }
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

/* ── 断点续跑状态 ── */
const ctx = {
  stages: {},
  ...(existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {}),
}
function saveState() {
  writeFileSync(STATE_PATH, JSON.stringify(ctx, null, 2))
}
async function stage(id, title, fn) {
  if (ctx.stages[id]?.done) {
    log(`↷ 跳过 Stage ${id} · ${title}(已于 ${ctx.stages[id].at} 完成)`)
    return
  }
  section(`Stage ${id} · ${title}`)
  await fn()
  ctx.stages[id] = { done: true, at: new Date().toISOString() }
  saveState()
}

/** 膜厚最近窗口均值(平台数采 = 闭环真实观测路径;samples 新→旧,须按 at 排序) */
async function thicknessMean(token, nodeId, windowS = 30) {
  const r = await api('GET', `/api/workshop/daq/${nodeId}/samples?bucketMs=1000&limit=${Math.max(60, windowS)}`, undefined, token)
  const pts = (dataOf(r)?.points ?? [])
    .map(p => ({ at: Number(p.at ?? 0), v: Number(p.avg ?? p.value) }))
    .filter(p => Number.isFinite(p.v))
    .sort((a, b) => a.at - b.at)
    .slice(-windowS)
  if (!pts.length) return null
  return pts.reduce((a, b) => a + b.v, 0) / pts.length
}

/** 平台重启后 DAQ 控制器为内存态不会自启 —— 快照/采样前必须显式拉起(幂等) */
async function ensureDaqRunning() {
  const r = await api('POST', '/api/workshop/daq/controller', { action: 'start' }, ctx.token)
  log(`  daq controller start → HTTP ${r.status}`)
  await sleep(4000)
}

/* ════════ S0 · 隔离平台 + 专用模拟器 ════════ */
await stage('S0', '隔离平台 + 专用模拟器(cast-film 预设)', async () => {
  const platformUp = async () => {
    try {
      const r = await fetch(`${AW_BASE}/api/users/setup-status`, { signal: AbortSignal.timeout(5000) })
      const j = await r.json().catch(() => null)
      return r.status === 200 && j?.data != null
    }
    catch { return false }
  }
  if (!(await platformUp())) {
    const out = appendFileSync === undefined ? 'ignore' : 'ignore'
    const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'start', '--port', String(AW_PORT)], {
      cwd: REPO,
      env: {
        ...process.env,
        AW_MODE: 'home',
        AW_HOME: HOME_DIR,
        AW_AML_DIR: AML_ROOT,
        NUXT_SESSION_PASSWORD: process.env.NUXT_SESSION_PASSWORD ?? 'e2e-session-password-0123456789abcdef',
        PORT: String(AW_PORT),
      },
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    log(`平台冷启: port=${AW_PORT} pid=${child.pid}(home 模式,AW_HOME=${HOME_DIR})`)
    log(`  AW_AML_DIR=${AML_ROOT}(复用真实训练 venv;模型工件落 repo ./aml)`)
    void out
  }
  await waitFor(platformUp, { timeoutMs: 180_000, what: '平台就绪' })
  log(`✔ 平台在线 ${AW_BASE}(home 模式,数据与生产实例零交集)`)

  const { ensureSimulator, applyPreset, simNodes } = await import('../bench/lib/sim.mjs')
  const sim = await ensureSimulator({ log: m => log(`[sim] ${m}`) })
  log(`✔ 模拟器在线: ${JSON.stringify(sim).slice(0, 140)}`)
  await applyPreset('cast-film-physics')
  ctx.simDevices = await simNodes()
  log(`✔ cast-film 预设应用,设备 ${ctx.simDevices.length} 台: ${ctx.simDevices.map(d => `${d.id}(${d.protocol})`).join(', ')}`)
})

/* ════════ S1 · admin 注册 + 产线 provisioning ════════ */
await stage('S1', 'admin 注册 + 产线 provisioning(6 DCW + 5 DAQ + 6 SP 回读)', async () => {
  const reg = await api('POST', '/api/workshop/users/register', { name: `optloop-${RUN_ID}` })
  ctx.token = reg.json?.data?.token
  const who = dataOf(reg)?.user ?? reg.json?.data
  if (!ctx.token) throw new Error(`注册失败: ${JSON.stringify(reg.json).slice(0, 200)}`)
  log(`✔ token 就绪(user=${who?.name ?? who?.email ?? '?'} role=${who?.role ?? '?'};home 模式首注册即 admin)`)

  const { provisionTwinLine, startTwinBatch } = await import('../bench/lib/closedloop.mjs')
  const { simExport } = await import('../bench/lib/sim.mjs')
  const call = async (m, p, b) => {
    const r = await api(m, p, b, ctx.token)
    return { status: r.status, ...(r.json ?? {}) }
  }
  const sfx = RUN_ID.slice(5, 16).replace(/-/g, '')
  ctx.sfx = sfx
  const twin = await provisionTwinLine({ call }, { simDevices: ctx.simDevices, sfx })
  for (const e of twin.ev) log('  ' + e)
  if (!twin.ok) throw new Error(`provision 失败: ${(twin.errors ?? []).join('; ')}`)
  ctx.lineId = twin.lineId
  ctx.productId = twin.productId
  ctx.dcw = twin.dcw
  ctx.daq = twin.daq
  log(`✔ lineId=${ctx.lineId} productId=${ctx.productId}`)
  log(`  DCW: ${JSON.stringify(ctx.dcw)}`)
  log(`  DAQ: ${JSON.stringify(ctx.daq)}`)

  // 控制器显式启动(采样节拍入口)
  const ctl = await api('POST', '/api/workshop/daq/controller', { action: 'start' }, ctx.token)
  log(`✔ daq controller start → HTTP ${ctl.status}`)

  // 膜厚语义补『厚度』(scene compile 的 target 词表推断依据)
  await api('PATCH', `/api/workshop/daq/${ctx.daq['film-thickness']}`, { semantics: '流延膜厚度测量(优化目标 goal,单位 μm;厚度质量输出)' }, ctx.token)

  // SP 设定点回读 DAQ 节点:AML 数据集的 control 输入取自数采时序库,执行器设定点必须有回读节点
  ctx.spReadback = {}
  for (const dev of ctx.simDevices) {
    const exp = await simExport(dev.id)
    const items = exp?.items ?? []
    for (const spId of Object.keys(ctx.dcw)) {
      if (ctx.spReadback[spId]) continue
      const sig = (dev.signals ?? []).find(s => s.id === spId)
      if (!sig) continue
      const item = items.find(i => i.signal === sig.name)
      if (!item?.driverConfig) continue
      const cfg = { ...item.driverConfig }
      if (cfg.jsonKey !== undefined && cfg.jsonPath === undefined) {
        cfg.jsonPath = cfg.jsonKey
        delete cfg.jsonKey
      }
      const r = await api('POST', '/api/workshop/daq', {
        name: `${sig.name} 回读 ${sfx}`, templateRef: 'daq-temp-tc', driver: dev.protocol, driverConfig: cfg,
        unit: sig.unit, min: sig.min, max: sig.max, lineId: ctx.lineId, intervalMs: 1000, publishIntervalMs: 0,
        semantics: `执行器设定点回读(AML control 输入) ${item.signal}`,
      }, ctx.token)
      if (dataOf(r)?.node?.id) ctx.spReadback[spId] = dataOf(r).node.id
    }
  }
  log(`✔ SP 回读 DAQ 节点 ${Object.keys(ctx.spReadback).length}/6: ${JSON.stringify(ctx.spReadback)}`)

  const batch = await startTwinBatch({ call }, { lineId: ctx.lineId, productId: ctx.productId, dcw: ctx.dcw, sfx })
  if (!batch.ok) throw new Error(`开跑失败: ${batch.errors?.join('; ')}`)
  ctx.recipeId = batch.recipeId
  log(`✔ 配方开跑 recipeId=${ctx.recipeId}`)
})

/* ════════ S2 · 优化通道 B(exploration)+ worker 绑定 + 门控负向校验 ════════ */
await stage('S2', '工艺优化通道 B 实例化(exploration)+ worker 绑定 + 探索期门控负向校验', async () => {
  const scene = { sceneId: `castfilm-hold-opt-${ctx.sfx}`, sceneVersion: '1.0.0', lineId: ctx.lineId, productId: ctx.productId, recipeId: ctx.recipeId }
  const inst = await api('POST', '/api/workshop/channel-templates/chtpl-aml-optimization-default/instantiate', {
    name: `双模式闭环优化 ${RUN_ID}`,
    toolProfile: 'aml_optimization',
    scene,
    objective: { objectiveId: 'thickness-50um', targets: { film_thickness: 50 }, weights: { film_thickness: 1 } },
    controlPolicy: 'recommendation_only',
    optimizationMode: 'exploration',
  }, ctx.token)
  const d = dataOf(inst)
  ctx.channelB = d?.channelId
  const worker = (d?.agents ?? []).find(a => a.role === 'worker' && a.name === '优化执行器') ?? (d?.agents ?? []).find(a => a.role === 'worker')
  ctx.workerB = worker?.id
  if (!ctx.channelB || !ctx.workerB) throw new Error(`优化通道实例化失败: ${JSON.stringify(inst.json).slice(0, 300)}`)
  log(`✔ 优化通道 B=${ctx.channelB} worker(优化执行器)=${ctx.workerB}`)

  for (const nodeId of Object.values(ctx.dcw)) await api('POST', '/api/workshop/agent-tools/bindings', { agentId: ctx.workerB, nodeId, kind: 'dcw', mode: 'auto' }, ctx.token)
  for (const nodeId of Object.values(ctx.daq)) await api('POST', '/api/workshop/agent-tools/bindings', { agentId: ctx.workerB, nodeId, kind: 'daq', mode: 'auto' }, ctx.token)
  log(`✔ workerB 绑定 ${Object.keys(ctx.dcw).length} DCW + ${Object.keys(ctx.daq).length} DAQ(auto 模式)`)

  // 注入面校验:工具清单应含 optimization_explore;探索模式下孪生工具被 dispatch 拒绝
  const list = await api('GET', `/api/workshop/agent-tools/list?agentId=${ctx.workerB}`, undefined, ctx.token)
  const names = (dataOf(list)?.tools ?? dataOf(list) ?? []).map(t => t.name ?? t)
  const hasExplore = names.includes('optimization_explore')
  const hasDcwDirect = names.includes('dcw_control')
  log(`✔ 工具面: optimization_explore=${hasExplore ? '√' : '✘'} dcw 直写(应为 false)=${hasDcwDirect ? '✘ 泄漏' : '√ 已收敛到探索治理链'}`)
  if (!hasExplore) throw new Error('优化通道工具面缺 optimization_explore')

  const neg = await invoke('twin_trial_run', { snapshot_id: 'fake-snap' }, ctx.workerB, ctx.token)
  const blocked = neg.isError && (neg.text.includes('探索') || neg.text.includes('EXPLORATION_MODE_NO_MODEL'))
  log(`✔ 负向校验: 探索模式 twin_trial_run 被拒 = ${blocked ? '√(EXPLORATION_MODE_NO_MODEL)' : `✘ ${neg.text.slice(0, 120)}`}`)
  if (!blocked) throw new Error('探索模式下孪生工具未被拒绝 —— 门控失效')
})

/* ════════ S3 · 第一轮:探索式闭环(批次1 内,optimization_explore 贪心多通道) ════════ */
await stage('S3', '第一轮·探索式闭环(optimization_explore 真实写入,贪心多通道收敛膜厚 50μm)', async () => {
  const film = ctx.daq['film-thickness']
  const TARGET = 50
  // 单步限制 = 参数基准限界层的 2% 量程(screw 3rpm / linespeed 2 / diegap 0.03,实测 6rpm 被拒 400)
  const CH = {
    screw: { node: ctx.dcw['screw-sp'], limit: 3, gain: 0.144, value: 150, unit: 'rpm' },
    linespeed: { node: ctx.dcw['linespeed-sp'], limit: 2, gain: -0.568, value: 95, unit: 'm/min' },
    diegap: { node: ctx.dcw['diegap-sp'], limit: 0.03, gain: 54, value: 1.0, unit: 'mm' },
  }
  let h = await thicknessMean(ctx.token, film, 20)
  log(`  探索起点: 膜厚≈${h?.toFixed(2) ?? '?'}μm(screw=150, v=95, diegap=1.0;目标 ${TARGET}μm)`)
  const traj = [{ step: 0, h }]
  // 首个写入前等过 60s 治理间隔(全新跑时 S1 配方下发刚写完各节点)
  await sleep(45_000)

  // 贪心策略:每步选「预计移动量 = |增益×限步| 最大」的通道,按残差在线修正增益;
  // 同通道两次写入 ≥60s(在线探索硬卡控)→ 相邻步强制换通道 + 步间 25s。
  let lastKey = ''
  let lastH = h
  for (let i = 1; i <= 9; i++) {
    if (h != null && Math.abs(h - TARGET) <= 1.2) {
      log(`  ✔ 第 ${i - 1} 步已入带: 膜厚 ${h.toFixed(2)}μm ∈ [${TARGET - 2},${TARGET + 2}],提前收敛`)
      break
    }
    await sleep(25_000)
    const err = TARGET - (h ?? TARGET)
    const candidates = Object.entries(CH)
      .filter(([k, c]) => k !== lastKey && Math.abs(c.gain) * c.limit > 0.05)
      .map(([k, c]) => ({ k, c, move: Math.abs(c.gain) * c.limit, dir: Math.sign(err) * Math.sign(c.gain) >= 0 ? 'up' : 'down' }))
    if (!candidates.length) break
    candidates.sort((a, b) => b.move - a.move)
    const pick = candidates[0]
    const c = pick.c
    const before = c.value
    const r = await invoke('optimization_explore', {
      control_node_id: c.node, target_node_id: film,
      direction: pick.dir, step: c.limit, settle_seconds: 15,
      hypothesis: `贪心探索(${pick.k}): h=${h?.toFixed(2)}μm → 目标 ${TARGET}μm,预计 ${pick.dir === 'up' ? '+' : '-'}${(Math.abs(c.gain) * c.limit).toFixed(2)}μm(增益 ${c.gain.toFixed(3)}μm/${c.unit}×限步${c.limit})`,
    }, ctx.workerB, ctx.token)
    if (r.isError) {
      log(`  ⚠ [${pick.k}#${i}] 被拒: ${r.text.split('\n').slice(0, 2).join(' ').slice(0, 150)}`)
      CH[pick.k].gain *= 0.3 // 降权避免反复撞墙
      continue
    }
    c.value = Math.round((before + (pick.dir === 'up' ? c.limit : -c.limit)) * 1000) / 1000
    lastKey = pick.k
    const hNow = await thicknessMean(ctx.token, film, 12)
    // 残差归因:实际响应与预计之差修正该通道增益(在线辨识)
    if (hNow != null && lastH != null) {
      const predicted = Math.abs(c.gain) * c.limit * (pick.dir === 'up' ? Math.sign(c.gain) : -Math.sign(c.gain))
      const observed = hNow - (h ?? hNow)
      if (Number.isFinite(observed)) c.gain = c.gain * 0.5 + (observed / (pick.dir === 'up' ? c.limit : -c.limit)) * 0.5
      log(`  [${pick.k}#${i}] ${pick.dir} ${c.limit} → ${pick.k}=${c.value} · h ${h?.toFixed(2)}→${hNow.toFixed(2)}μm(预计 ${predicted.toFixed(2)},实批 ${observed.toFixed(2)})`)
    }
    else log(`  [${pick.k}#${i}] ${pick.dir} ${c.limit} → ${pick.k}=${c.value} · 读数 n/a`)
    h = hNow
    lastH = h
    traj.push({ step: i, channel: pick.k, dir: pick.dir, value: c.value, h })
  }

  const hEnd = await thicknessMean(ctx.token, film, 30)
  const inBand = hEnd != null && Math.abs(hEnd - TARGET) <= 2
  ctx.exploration = {
    traj, hStart: traj[0]?.h ?? null, hEnd, inBand,
    screwEnd: CH.screw.value, linespeedEnd: CH.linespeed.value, diegapEnd: CH.diegap.value,
  }
  log(`${inBand ? '✔' : '▲'} 探索收敛: ${traj[0]?.h?.toFixed(2)} → ${hEnd?.toFixed(2)}μm(目标带 [48,52];screw=${CH.screw.value} v=${CH.linespeed.value} diegap=${CH.diegap.value})`)

  // 调控闭环判定收口:最近一条 open 优化记录落 keep(收敛)——真实 ledger 闭环
  const opts = await api('GET', `/api/workshop/dcw/optimizations?lineId=${ctx.lineId}&limit=10`, undefined, ctx.token)
  const openRec = (dataOf(opts)?.records ?? []).find(x => x.status === 'open')
  if (openRec && inBand) {
    const j = await invoke('dcw_judge', { record_id: openRec.id, verdict: 'keep', reason: `探索收敛: 膜厚 ${hEnd.toFixed(2)}μm 入带 [48,52]` }, ctx.workerB, ctx.token)
    log(`  dcw_judge keep(${openRec.nodeId.slice(-6)}) → ${j.isError ? j.text.slice(0, 120) : '已入册'}`)
  }

  // 批次1 保持至 ~450s(与批次2/3 同量级,保证样本量)
  await sleep(150_000)
  await api('POST', `/api/workshop/dcw/lines/${ctx.lineId}/stop`, {}, ctx.token)
  log('  批次1 停止(探索期数据已全部落 TSDB)')
})

/* ════════ S4 · 激励采样(批次2-3,阶跃辨识) ════════ */
await stage('S4', '激励采样:批次2-3 阶跃(线速/模口间隙;manual 写入,同受治理限频与 2% 单步限)', async () => {
  const BASE_SP = { 'linespeed-sp': 95, 'diegap-sp': 1.0 }
  // 阶跃幅度受参数单步限制(2% 量程:v ±2, diegap ±0.03,按**当前值**起算),越限写入会被 400 拒绝
  const EXCITE_RUNS = [
    [{ dls: 2.0, ddg: 0.03 }, { dls: -2.0, ddg: -0.03 }],
    [{ dls: -2.0, ddg: 0.03 }, { dls: 1.5, ddg: -0.03 }],
  ]
  const writeOrThrow = async (nodeId, value, tag) => {
    const w = await api('POST', `/api/workshop/dcw/${nodeId}/write`, { value }, ctx.token)
    if (w.status >= 400) throw new Error(`激励写入被拒(${tag} ← ${value}): ${JSON.stringify(w.json?.message ?? w.json).slice(0, 160)}`)
    log(`  ${tag} ← ${value} √`)
  }
  // 续跑安全:上一进程可能留下在跑批次,先停(未跑时忽略 409)
  await api('POST', `/api/workshop/dcw/lines/${ctx.lineId}/stop`, {}, ctx.token).catch(() => {})
  await sleep(3000)
  for (let run = 0; run < 2; run++) {
    // stop→start 竞态防护:stop 后等 8s;start 失败重试一次(409 常为状态机未落定)
    await api('POST', `/api/workshop/dcw/lines/${ctx.lineId}/stop`, {}, ctx.token).catch(() => {})
    await sleep(8000)
    let st = await api('POST', `/api/workshop/dcw/lines/${ctx.lineId}/start`, { recipeId: ctx.recipeId }, ctx.token)
    if (st.status !== 200) {
      log(`  批次 ${run + 2} 首次开跑 HTTP ${st.status}: ${JSON.stringify(st.json?.message ?? st.json).slice(0, 120)} → 8s 后重试`)
      await sleep(8000)
      st = await api('POST', `/api/workshop/dcw/lines/${ctx.lineId}/start`, { recipeId: ctx.recipeId }, ctx.token)
    }
    if (st.status !== 200) throw new Error(`批次 ${run + 2} 开跑失败: ${JSON.stringify(st.json).slice(0, 200)}`)
    log(`  批次 ${run + 2} 开跑(同配方 ${ctx.recipeId})`)
    await sleep(65_000)
    const [e1, e2] = EXCITE_RUNS[run]
    let curLs = BASE_SP['linespeed-sp']
    let curDg = BASE_SP['diegap-sp']
    curLs = Math.round((curLs + e1.dls) * 1000) / 1000
    await writeOrThrow(ctx.dcw['linespeed-sp'], curLs, `批次${run + 2} linespeed 阶跃1`)
    curDg = Math.round((curDg + e1.ddg) * 1000) / 1000
    await writeOrThrow(ctx.dcw['diegap-sp'], curDg, `批次${run + 2} diegap 阶跃1`)
    await sleep(150_000)
    curLs = Math.round((curLs + e2.dls) * 1000) / 1000
    await writeOrThrow(ctx.dcw['linespeed-sp'], curLs, `批次${run + 2} linespeed 阶跃2`)
    curDg = Math.round((curDg + e2.ddg) * 1000) / 1000
    await writeOrThrow(ctx.dcw['diegap-sp'], curDg, `批次${run + 2} diegap 阶跃2`)
    await sleep(290_000)
    const latest = await thicknessMean(ctx.token, ctx.daq['film-thickness'], 10)
    log(`  批次${run + 2} 完成(500s) · 膜厚当前≈${latest?.toFixed(2) ?? '?'} μm`)
  }
  await api('POST', `/api/workshop/dcw/lines/${ctx.lineId}/stop`, {}, ctx.token)
  log('✔ 采样完成(批次1 探索 + 批次2/3 各 500s),产线停止')
})

/* ════════ S4B · 补充扫描激励(扩大目标方差,提升可辨识性) ════════ */
await stage('S4B', '补充激励:模口间隙/线速宽扫描(2 批次;扩大 y 方差 → NRMSE 分母)', async () => {
  const writeOrThrow = async (nodeId, value, tag) => {
    const w = await api('POST', `/api/workshop/dcw/${nodeId}/write`, { value }, ctx.token)
    if (w.status >= 400) throw new Error(`扫描写入被拒(${tag} ← ${value}): ${JSON.stringify(w.json?.message ?? w.json).slice(0, 160)}`)
    log(`  ${tag} ← ${value} √`)
  }
  // 单步 ≤2% 限(dg ±0.03 / v ±2),按当前值起算;步间 80s(>60s 治理间隔)
  const SWEEPS = [
    { dg: [1.0, 0.97, 0.94, 0.97, 1.0], ls: null },
    { dg: [1.0, 1.03, 1.06, 1.03, 1.0], ls: [95, 97, 99, 97, 95] },
  ]
  for (let run = 0; run < SWEEPS.length; run++) {
    const sw = SWEEPS[run]
    // stop→start 竞态防护(同 S4):循环头先停+等 8s,start 失败重试一次
    await api('POST', `/api/workshop/dcw/lines/${ctx.lineId}/stop`, {}, ctx.token).catch(() => {})
    await sleep(8000)
    let st = await api('POST', `/api/workshop/dcw/lines/${ctx.lineId}/start`, { recipeId: ctx.recipeId }, ctx.token)
    if (st.status !== 200) {
      log(`  扫描批次 ${run + 1} 首次开跑 HTTP ${st.status} → 8s 后重试`)
      await sleep(8000)
      st = await api('POST', `/api/workshop/dcw/lines/${ctx.lineId}/start`, { recipeId: ctx.recipeId }, ctx.token)
    }
    if (st.status !== 200) throw new Error(`扫描批次 ${run + 1} 开跑失败: ${JSON.stringify(st.json).slice(0, 200)}`)
    log(`  扫描批次 ${run + 1} 开跑`)
    await sleep(65_000)
    for (let i = 1; i < sw.dg.length; i++) {
      await writeOrThrow(ctx.dcw['diegap-sp'], sw.dg[i], `扫描${run + 1} diegap#${i}`)
      if (sw.ls) await writeOrThrow(ctx.dcw['linespeed-sp'], sw.ls[i], `扫描${run + 1} linespeed#${i}`)
      await sleep(80_000)
    }
    await sleep(60_000)
    const latest = await thicknessMean(ctx.token, ctx.daq['film-thickness'], 10)
    log(`  扫描批次 ${run + 1} 完成 · 膜厚当前≈${latest?.toFixed(2) ?? '?'} μm`)
  }
  await api('POST', `/api/workshop/dcw/lines/${ctx.lineId}/stop`, {}, ctx.token)
  log('✔ 扫描激励完成(dg 0.94~1.06 / v 95~99 全覆盖)')
})

/* ════════ S5 · 训练通道 A:实例化 + 场景冻结 + PhysicsSpec ════════ */
await stage('S5', '训练通道 A 实例化 + worker 绑定 + 场景发现/编译/冻结 + 骨架 PhysicsSpec', async () => {
  const scene = { sceneId: `castfilm-hold-opt-${ctx.sfx}`, sceneVersion: '1.0.0', lineId: ctx.lineId, productId: ctx.productId, recipeId: ctx.recipeId }
  const inst = await api('POST', '/api/workshop/channel-templates/chtpl-hybrid-twin-mpc-default/instantiate', {
    name: `孪生训练 ${RUN_ID}`,
    toolProfile: 'hybrid_twin',
    scene,
    objective: { objectiveId: 'thickness-50um', targets: { film_thickness: 50 } },
    controlPolicy: 'recommendation_only',
  }, ctx.token)
  const d = dataOf(inst)
  ctx.channelA = d?.channelId
  const worker = (d?.agents ?? []).find(a => a.role === 'worker')
  ctx.workerA = worker?.id
  if (!ctx.channelA || !ctx.workerA) throw new Error(`训练通道实例化失败: ${JSON.stringify(inst.json).slice(0, 300)}`)
  log(`✔ 训练通道 A=${ctx.channelA} worker=${ctx.workerA}`)
  for (const nodeId of Object.values(ctx.dcw)) await api('POST', '/api/workshop/agent-tools/bindings', { agentId: ctx.workerA, nodeId, kind: 'dcw', mode: 'auto' }, ctx.token)
  for (const nodeId of Object.values(ctx.daq)) await api('POST', '/api/workshop/agent-tools/bindings', { agentId: ctx.workerA, nodeId, kind: 'daq', mode: 'auto' }, ctx.token)
  log(`✔ workerA 绑定 ${Object.keys(ctx.dcw).length} DCW + ${Object.keys(ctx.daq).length} DAQ`)

  const SCENE_ID = scene.sceneId
  ctx.sceneId = SCENE_ID
  const disco = await invoke('twin_scene_discover', {}, ctx.workerA, ctx.token)
  const targetOk = disco.text.includes('"target": 1') || disco.text.includes('"target":1')
  log(`  场景发现: target=1 ${targetOk ? '√' : '✘(检查膜厚语义)'}`)
  const compiled = await invoke('twin_scene_compile', {
    scene_id: SCENE_ID, scene_version: '1.0.0', line_id: ctx.lineId, product_id: ctx.productId, recipe_id: ctx.recipeId,
    prompt: '流延膜厚度闭环优化:目标膜厚 50μm。控制=6 个执行器设定点,观测=膜厚(目标)/熔温/熔压。约束:熔温 195~225℃,熔压 ≤22MPa。膜厚为目标输出。',
  }, ctx.workerA, ctx.token)
  if (compiled.isError) throw new Error(`场景编译失败: ${compiled.text.slice(0, 200)}`)
  const frozen = await invoke('twin_scene_freeze', {
    scene_id: SCENE_ID, scene_version: '1.0.0', confirmation: 'USER_CONFIRMED_SCENE_CONTRACT', approved_by: 'live-admin',
  }, ctx.workerA, ctx.token)
  if (frozen.isError) throw new Error(`场景冻结失败: ${frozen.text.slice(0, 200)}`)
  log(`✔ 场景已冻结 ${SCENE_ID}@1.0.0(用户确认令牌)`)

  const draft = await invoke('twin_physics_spec_draft', { dt_sec: 1 }, ctx.workerA, ctx.token)
  if (draft.isError) throw new Error(`骨架生成失败: ${draft.text.slice(0, 200)}`)
  const draftArtifactPath = (draft.text.match(/artifact:\s*([^\n]+)/) || [])[1]?.trim()
  if (!draftArtifactPath || !existsSync(draftArtifactPath)) throw new Error(`骨架 spec 工件缺失: ${draftArtifactPath}`)
  const physicsSpec = JSON.parse(readFileSync(draftArtifactPath, 'utf8'))
  log(`✔ 骨架 PhysicsSpec: model=${physicsSpec.modelId} 状态 ${physicsSpec.states.length} 观测 ${physicsSpec.observations.length}`)

  // 训练前对齐在 S6 数据集构建后做(spec 变量改绑回读节点 + 剔除数据集外变量)
  const dwToDn = {}
  for (const [sig, dn] of Object.entries(ctx.spReadback)) dwToDn[ctx.dcw[sig]] = dn
  ctx.physicsSpec = physicsSpec
  ctx.dwToDn = dwToDn
  writeFileSync(join(OUT_DIR, 'physics-spec-draft.json'), JSON.stringify(physicsSpec, null, 2))
})

/* ════════ S6 · 数据集构建 + hybrid_residual 训练 ════════ */
await stage('S6', 'AML 数据集构建 + hybrid_residual 训练(平台参考训练器)', async () => {
  const sampledControls = []
  for (const [sig, nodeId] of Object.entries(ctx.spReadback)) {
    const r = await api('GET', `/api/workshop/daq/${nodeId}/samples?bucketMs=60000&limit=1`, undefined, ctx.token)
    const has = (dataOf(r)?.points ?? []).length > 0
    log(`  回读采样检查 ${sig}: ${has ? '√' : '✘ 剔除'}`)
    if (has) sampledControls.push({ nodeId, role: 'control' })
  }
  if (sampledControls.length < 4) throw new Error(`可用 control 回读不足: ${sampledControls.length}`)
  const dsBody = {
    lineId: ctx.lineId, productId: ctx.productId, recipeId: ctx.recipeId,
    nodes: [
      ...sampledControls,
      { nodeId: ctx.daq['film-thickness'], role: 'target' },
      { nodeId: ctx.daq['melt-temp'], role: 'feature' },
      { nodeId: ctx.daq['melt-pressure'], role: 'feature' },
    ],
    beatMs: 1000, window: { historySteps: 8, horizonSteps: 4 },
    split: { valRatio: 0.34, testRatio: 0.33, seed: Number(process.env.OPTLOOP_SPLIT_SEED ?? 11) },
    purpose: 'mpc_surrogate',
    note: `双模式闭环数据集(探索+激励) ${RUN_ID}`,
  }
  const ds = await api('POST', '/api/workshop/aml/datasets', dsBody, ctx.token)
  const dataset = dataOf(ds)?.dataset
  if (!dataset) throw new Error(`数据集构建失败: ${JSON.stringify(ds.json).slice(0, 300)}`)
  ctx.datasetId = dataset.id
  log(`✔ 数据集 ${dataset.id}: ${dataset.rowCount} 窗 / ${dataset.runIds.length} 批`)

  // 训练前对齐(spec 变量改绑回读节点 + 剔除数据集外变量)
  const manifest = JSON.parse(readFileSync(join(AML_ROOT, 'datasets', dataset.id, 'manifest.json'), 'utf8'))
  const datasetNodes = new Set(manifest.allNodes)
  const physicsSpec = ctx.physicsSpec
  let remapped = 0
  for (const v of physicsSpec.variables) {
    if (v.nodeId && !datasetNodes.has(v.nodeId) && ctx.dwToDn[v.nodeId]) {
      v.nodeId = ctx.dwToDn[v.nodeId]
      remapped++
    }
  }
  const keptVars = physicsSpec.variables.filter(v => !v.nodeId || datasetNodes.has(v.nodeId))
  const keptIds = new Set(keptVars.map(v => v.id))
  physicsSpec.variables = keptVars
  physicsSpec.states = physicsSpec.states.filter((e) => {
    const base = e.lhs.endsWith('_next') ? e.lhs.slice(0, -5) : e.lhs
    return keptIds.has(base)
  })
  physicsSpec.observations = physicsSpec.observations.filter(e => keptIds.has(e.lhs))
  physicsSpec.guards = (physicsSpec.guards ?? []).filter(e => keptIds.has(e.lhs))
  physicsSpec.constraints = physicsSpec.constraints.filter(c => keptIds.has(c.id))
  writeFileSync(join(OUT_DIR, 'physics-spec-remapped.json'), JSON.stringify(physicsSpec, null, 2))
  log(`✔ 训练对齐: 控制改绑 ${remapped};保留变量 ${keptVars.length}`)

  const jobRes = await api('POST', '/api/workshop/aml/jobs', {
    datasetId: dataset.id,
    purpose: 'mpc_surrogate',
    changeNote: '双模式闭环:骨架物理+数据残差(全部 DCW → 膜厚 goal)',
    params: { epochs: Number(process.env.OPTLOOP_EPOCHS ?? 600), hidden: Number(process.env.OPTLOOP_HIDDEN ?? 128), lr: 0.0015, residual_scale: Number(process.env.OPTLOOP_RESIDUAL ?? 2.0), ensemble: 3 },
    seed: Number(process.env.OPTLOOP_SEED ?? 11),
    jobKind: 'hybrid_residual',
    sceneId: ctx.sceneId,
    sceneVersion: '1.0.0',
    objectiveId: 'thickness-50um',
    physicsSpec,
    providerId: physicsSpec.modelId,
    providerVersion: '1.0.0',
    providerHash: `sha256:${JSON.stringify(physicsSpec).length}`,
    modelName: `流延膜厚双模式闭环模型 ${ctx.sfx}`,
    modelDescription: `输入=全部 6 个 DCW 执行器(SP 回读);输出=膜厚 goal(50μm);场景 ${ctx.sceneId}@1.0.0;产线 ${ctx.lineId}/配方 ${ctx.recipeId};数据含探索式闭环真实写入`,
  }, ctx.token)
  const job = dataOf(jobRes)?.job
  if (!job) throw new Error(`作业提交失败: ${JSON.stringify(jobRes.json).slice(0, 300)}`)
  ctx.jobId = job.id
  log(`✔ 训练作业 ${job.id} 入队(hybrid_residual)`)

  let jobDone = null
  for (let i = 0; i < 210; i++) {
    await sleep(10_000)
    const st = await api('GET', `/api/workshop/aml/jobs/${job.id}`, undefined, ctx.token)
    const j = dataOf(st)?.job ?? dataOf(st)
    if (!j) continue
    log(`  [${i * 10}s] ${j.status} ${j.stage} ${j.progress}%`)
    if (['done', 'failed', 'cancelled', 'timeout'].includes(j.status)) {
      jobDone = j
      break
    }
  }
  if (!jobDone || jobDone.status !== 'done') throw new Error(`训练未成功: ${JSON.stringify(jobDone).slice(0, 300)}`)
  const gates = (() => {
    try {
      return JSON.parse(jobDone.gatesJson || '{}')
    }
    catch {
      return {}
    }
  })()
  ctx.platformGates = gates
  log(`✔ 训练完成 · 平台门禁: ${gates.passed === true ? '全部通过' : `未过(${JSON.stringify(gates).slice(0, 160)})`}`)
})

/* ════════ S7 · 模型校验 + 晋升 shadow ════════ */
await stage('S7', '模型注册校验 + 晋升 shadow', async () => {
  const modelsRes = await api('GET', '/api/workshop/aml/models', undefined, ctx.token)
  const model = (dataOf(modelsRes)?.models ?? []).find(m => m.datasetId === ctx.datasetId)
  if (!model) throw new Error('模型未登记')
  ctx.modelId = model.id
  const m = model.metrics ?? {}
  log(`✔ 模型 ${model.id} [${model.stage}] label=${model.label}`)
  log(`  G1 单步 NRMSE=${m.oneStepTest?.nrmse} · G2 滚动=${m.rolloutTest?.nrmse}`)
  log(`  hybrid=${JSON.stringify(m.hybrid ?? {}).slice(0, 200)}`)
  log(`  uncertainty=${JSON.stringify(m.uncertainty ?? {}).slice(0, 200)}`)
  const promo = await api('POST', `/api/workshop/aml/models/${model.id}/promote`, { toStage: 'shadow' }, ctx.token)
  log(`✔ 晋升 shadow → HTTP ${promo.status}`)
  if (promo.status >= 400) throw new Error(`晋升失败: ${JSON.stringify(promo.json).slice(0, 200)}`)
})

/* ════════ S8 · 候选试验(必传 model_id)→ Twin Gate ════════ */
await stage('S8', '候选试验 ×10(模型驱动 rollout)+ twin_gate_evaluate', async () => {
  await ensureDaqRunning()
  await api('POST', `/api/workshop/dcw/lines/${ctx.lineId}/start`, { recipeId: ctx.recipeId }, ctx.token)
  log('  产线重启(真实工况采快照)')
  await sleep(25_000)

  const snap = await invoke('twin_snapshot_create', { auto_daq: true, channel_id: ctx.channelA, phase: 'exploration' }, ctx.workerA, ctx.token)
  if (snap.isError) throw new Error(`快照失败: ${snap.text.slice(0, 240)}`)
  ctx.snapshotA = (snap.text.match(/snapshot_id:\s*([^\n]+)/) || [])[1]?.trim()
  log(`✔ 快照 ${ctx.snapshotA}`)

  const frozenPath = join(AML_ROOT, 'twins', 'scenes', `${ctx.sceneId}-1.0.0-frozen`, 'scenes.json')
  const frozenArtifact = JSON.parse(readFileSync(frozenPath, 'utf8'))
  const frozenScene = frozenArtifact.scene ?? frozenArtifact
  ctx.sceneControls = frozenScene.controls ?? []
  const speedCtl = ctx.sceneControls.find(c => (c.nodeId ?? '').includes('linespeed')) ?? ctx.sceneControls[0]
  const speedStep = speedCtl?.maxStep ?? 2
  let uqAllPass = true
  for (let k = 0; k < 10; k++) {
    const delta = (k % 2 === 0 ? 1 : -0.5) * speedStep * (0.3 + 0.07 * k)
    const cand = 95 + delta
    const t = await invoke('twin_trial_run', {
      snapshot_id: ctx.snapshotA,
      model_id: ctx.modelId,
      baseline_controls: { [speedCtl.id]: 95 },
      candidate_controls: [
        { [speedCtl.id]: cand }, { [speedCtl.id]: cand }, { [speedCtl.id]: cand }, { [speedCtl.id]: cand },
      ],
    }, ctx.workerA, ctx.token)
    const uqOk = t.text.includes('ood=accepted')
    if (!uqOk) uqAllPass = false
    log(`  trial#${k + 1} Δ=${delta.toFixed(2)} uq/ood=${uqOk ? '√' : '✘'} ${t.text.split('\n').find(x => x.includes('improvement'))?.trim().slice(0, 80) ?? ''}`)
  }
  if (!uqAllPass) log('  ⚠ 存在 UQ/OOD 未通过的候选(会影响 G7)')

  const gate = await invoke('twin_gate_evaluate', { model_id: ctx.modelId, scene_id: ctx.sceneId }, ctx.workerA, ctx.token)
  writeFileSync(join(OUT_DIR, 'twin-gate.txt'), gate.text)
  // 顶层 passed 解析:不能 text.includes('"passed": true') —— checks[] 每个子项也有
  // passed 字段,任意子项为 true 都会误判整门通过(实测 G7 false 仍被放行)。
  const gateTop = gate.text.match(/^\{[\s\S]*?"passed":\s*(true|false)/)
  const gatePassed = gateTop?.[1] === 'true'
  ctx.gatePassed = gatePassed
  for (const line of gate.text.split('\n').filter(x => x.includes('"id"') || x.includes('"passed"')).slice(0, 32)) log('    ' + line.trim())
  log(`${gatePassed ? '✔' : '✘'} Twin Gate(回写 twinEligibility + shadowEvidence)`)
  if (!gatePassed) throw new Error('Twin Gate 未全过 —— 绑定会被 fail-closed 拒绝')

  await api('POST', `/api/workshop/dcw/lines/${ctx.lineId}/stop`, {}, ctx.token)
})

/* ════════ S9 · 绑定模型到优化通道 B(fail-closed) ════════ */
await stage('S9', '绑定模型到优化通道 B(谱系+门禁 fail-closed 校验;自动切 aml 模式)', async () => {
  const patch = await api('PATCH', `/api/workshop/channels/${ctx.channelB}/twin-profile`, { boundModelId: ctx.modelId }, ctx.token)
  if (patch.status >= 400) throw new Error(`绑定失败: ${JSON.stringify(patch.json).slice(0, 300)}`)
  const prof = dataOf(patch)
  ctx.profileAfterBind = prof
  log(`✔ 绑定 ${ctx.modelId} → profile=${prof?.profile} mode=${prof?.mode}(探索期被拒的孪生工具现已放行)`)

  // 交叉校验:同一工具,aml 模式下不再被拒(快照不存在报错≠门控拒绝)
  const probeRun = await invoke('twin_trial_run', { snapshot_id: 'probe-nonexist', model_id: ctx.modelId }, ctx.workerB, ctx.token)
  const gateGone = !probeRun.text.includes('EXPLORATION_MODE_NO_MODEL')
  log(`  aml 模式孪生工具放行 = ${gateGone ? '√' : '✘'}(返回:${probeRun.text.split('\n')[0].slice(0, 100)})`)
  if (!gateGone) throw new Error('aml 模式下孪生工具仍被拒')
})

/* ════════ S10 · 第二轮:模型驱动参数优化(precise_search + 治理投用) ════════ */
await stage('S10', '第二轮·模型式优化:回到探索终点 → mpc_optimize(model_id) → precise_search → 治理投用 → 复测', async () => {
  await ensureDaqRunning()
  await api('POST', `/api/workshop/dcw/lines/${ctx.lineId}/start`, { recipeId: ctx.recipeId }, ctx.token)
  log('  产线重启(批次4;配方下发回到起始工况)')
  // 等 60s 治理写间隔 + 工艺稳定
  await sleep(65_000)

  // 回到第一轮探索终点(模型在终点邻域做精确微调 —— 两阶段设计的本意:探索找近,模型收准)。
  // 恢复也走治理链:单步 ≤2% 限,多轮逼近(每轮按产线真实当前值算剩余差,通道轮换保 60s 间隔)。
  const END = { screw: ctx.exploration?.screwEnd ?? 150, linespeed: ctx.exploration?.linespeedEnd ?? 95, diegap: ctx.exploration?.diegapEnd ?? 1.0 }
  const CH2 = {
    screw: { node: ctx.dcw['screw-sp'], limit: 3 },
    linespeed: { node: ctx.dcw['linespeed-sp'], limit: 2 },
    diegap: { node: ctx.dcw['diegap-sp'], limit: 0.03 },
  }
  const currentVals = async () => {
    const d = await api('GET', '/api/workshop/dcw', undefined, ctx.token)
    const map = {}
    for (const n of (dataOf(d)?.nodes ?? [])) map[n.id] = Number(n.value ?? 0)
    return map
  }
  for (let round = 0; round < 5; round++) {
    const vals = await currentVals()
    const pending = Object.entries(CH2).filter(([k, c]) => Math.abs(END[k] - (vals[c.node] ?? 0)) > c.limit * 0.3)
    if (pending.length === 0) break
    let moved = false
    for (const [k, c] of pending) {
      const cur = vals[c.node] ?? 0
      const delta = END[k] - cur
      if (moved) await sleep(30_000)
      const r = await invoke('optimization_explore', {
        control_node_id: c.node, target_node_id: ctx.daq['film-thickness'],
        direction: delta >= 0 ? 'up' : 'down', step: Math.min(c.limit, Math.abs(delta)), settle_seconds: 15,
        hypothesis: `恢复第一轮探索终点(${k}): ${cur.toFixed(2)}→${END[k]}(模型微调起点)`,
      }, ctx.workerB, ctx.token)
      log(`  恢复 ${k} ${cur.toFixed(2)}${delta >= 0 ? '+' : '-'}${Math.min(c.limit, Math.abs(delta)).toFixed(2)}: ${r.isError ? '被拒 ' + r.text.split('\n').slice(0, 2).join(' ').slice(0, 110) : '√'}`)
      if (!r.isError) moved = true
    }
    if (!moved) break
    await sleep(30_000)
  }
  await sleep(15_000)

  const snapB = await invoke('twin_snapshot_create', { auto_daq: true, channel_id: ctx.channelB, phase: 'exploration' }, ctx.workerB, ctx.token)
  if (snapB.isError) throw new Error(`B 快照失败: ${snapB.text.slice(0, 240)}`)
  ctx.snapshotB = (snapB.text.match(/snapshot_id:\s*([^\n]+)/) || [])[1]?.trim()
  log(`✔ 优化通道快照 ${ctx.snapshotB}(冻结场景按 sceneId 解析 = 训练通道冻结的同一契约)`)

  // 基线 = 当前真实设定(优化通道节点值)
  const dcwRes = await api('GET', '/api/workshop/dcw', undefined, ctx.token)
  const nodes = dataOf(dcwRes)?.nodes ?? []
  const valOf = nodeId => Number(nodes.find(n => n.id === nodeId)?.value ?? 0)
  const baseline = {}
  for (const c of ctx.sceneControls) baseline[c.id] = valOf(c.nodeId)
  log(`  基线(当前设定): ${JSON.stringify(baseline)}`)
  const hBefore = await thicknessMean(ctx.token, ctx.daq['film-thickness'], 30)
  log(`  投用前膜厚(30s 均值): ${hBefore?.toFixed(2) ?? '?'}μm`)

  const mpc = await invoke('mpc_optimize', {
    snapshot_id: ctx.snapshotB,
    model_id: ctx.modelId,
    baseline_controls: baseline,
    horizon_steps: 4,
  }, ctx.workerB, ctx.token)
  writeFileSync(join(OUT_DIR, 'mpc-recommendation.txt'), mpc.text)
  const mode = (mpc.text.match(/"mode":\s*"([^"]+)"/) || [])[1]
  const bestRaw = (mpc.text.match(/"bestCandidate":\s*\{([^}]*)\}/) || [])[1] ?? ''
  const best = {}
  for (const mm of bestRaw.matchAll(/"([^"]+)":\s*(-?[\d.]+(?:e[+-]?\d+)?)/gi)) best[mm[1]] = Number(mm[2])
  ctx.mpc = { mode, best, hBefore }
  log(`${mode === 'precise_search' ? '✔' : '▲'} MPC mode=${mode}(modelReady 升档判定)bestCandidate=${JSON.stringify(best)}`)
  if (mode !== 'precise_search' || Object.keys(best).length === 0) throw new Error(`MPC 未进入 precise_search 或无推荐: ${mpc.text.slice(0, 240)}`)

  // 推荐投用:经 optimization_explore 治理链(优化通道无 dcw 直写工具面 —— 设计如此)
  const idToNode = Object.fromEntries(ctx.sceneControls.map(c => [c.id, c.nodeId]))
  ctx.applied = []
  for (const [specId, target] of Object.entries(best)) {
    const nodeId = idToNode[specId]
    if (!nodeId || !Number.isFinite(target)) continue
    const cur = baseline[specId] ?? 0
    const delta = target - cur
    if (Math.abs(delta) < 1e-6) continue
    const r = await invoke('optimization_explore', {
      control_node_id: nodeId, target_node_id: ctx.daq['film-thickness'],
      direction: delta >= 0 ? 'up' : 'down', step: Math.abs(delta), settle_seconds: 15,
      hypothesis: `AML 模型推荐投用(precise_search, cost 最优候选): ${specId} ${cur.toFixed(2)}→${Number(target).toFixed(2)}`,
    }, ctx.workerB, ctx.token)
    ctx.applied.push({ specId, nodeId, from: cur, to: target, ok: !r.isError })
    log(`  投用 ${specId}: ${cur.toFixed(2)} → ${Number(target).toFixed(2)} ${r.isError ? '被拒 ' + r.text.split('\n')[0].slice(0, 100) : '√(治理链直写)'}`)
  }
  if (ctx.applied.length === 0) {
    // 推荐与基线一致 = 模型判定当前设定点即最优(探索终点已落在模型最优点上)。
    // 这是 precise_search 的合法输出 —— 投用为空操作,后续复测验证膜厚保持在带内。
    log('  模型判定: 当前设定点即最优(推荐=基线),无需变更 —— 由复测确认带内保持')
  }

  log('  等待 90s 工艺响应(settling)…')
  await sleep(90_000)
  const hAfter = await thicknessMean(ctx.token, ctx.daq['film-thickness'], 45)
  ctx.round2 = { hBefore, hAfter, inBand: hAfter != null && Math.abs(hAfter - 50) <= 2 }
  log(`${ctx.round2.inBand ? '✔' : '▲'} 模型式投用后膜厚: ${hBefore?.toFixed(2)} → ${hAfter?.toFixed(2)}μm(目标 50μm,带 [48,52])`)
})

/* ════════ S11 · 贝叶斯寻优(模型 surrogate + UCB) ════════ */
await stage('S11', 'twin_bayes_optimize:模型 surrogate + UCB 多轮收敛寻优', async () => {
  // 新鲜快照(S10 投用 + 90s settling 已使上一快照过期)
  await ensureDaqRunning()
  const snapC = await invoke('twin_snapshot_create', { auto_daq: true, channel_id: ctx.channelB, phase: 'exploration' }, ctx.workerB, ctx.token)
  if (snapC.isError) throw new Error(`快照失败: ${snapC.text.slice(0, 240)}`)
  const snapshotC = (snapC.text.match(/snapshot_id:\s*([^\n]+)/) || [])[1]?.trim()
  const dcwRes = await api('GET', '/api/workshop/dcw', undefined, ctx.token)
  const nodes = dataOf(dcwRes)?.nodes ?? []
  const valOf = nodeId => Number(nodes.find(n => n.id === nodeId)?.value ?? 0)
  const baseline = {}
  for (const c of ctx.sceneControls) baseline[c.id] = valOf(c.nodeId)
  const bayes = await invoke('twin_bayes_optimize', {
    snapshot_id: snapshotC,
    baseline_controls: baseline,
    rounds: 3,
    candidates_per_round: 4,
    horizon_steps: 4,
  }, ctx.workerB, ctx.token)
  writeFileSync(join(OUT_DIR, 'bayes-run.txt'), bayes.text)
  const rounds = (bayes.text.match(/"rounds":\s*(\d+)/) || [])[1]
  const evalCount = (bayes.text.match(/"candidatesEvaluated":\s*(\d+)/) || [])[1]
  ctx.bayes = { rounds: Number(rounds), evaluated: Number(evalCount), ok: !bayes.isError }
  log(`${bayes.isError ? '✘' : '✔'} 贝叶斯寻优: ${rounds} 轮 / 评估 ${evalCount} 候选 → ${OUT_DIR.replace(REPO + '/', '')}/bayes-run.txt`)
})

/* ════════ S12 · 透明度文档 ════════ */
await stage('S12', '生成透明度文档', async () => {
  const okR1 = ctx.exploration?.inBand ? '✔ 入带' : '▲ 未入带'
  const okR2 = ctx.round2?.inBand ? '✔ 入带' : '▲ 未入带'
  const doc = [
    `# 双模式闭环优化 · 实机透明度记录(探索式 → AML 模型式)`,
    '',
    `- 运行: ${RUN_ID} · 平台 ${AW_BASE}(home 隔离实例) · 模拟器 cast-film 预设(${process.env.SIM_BASE} 影子)`,
    `- 产线 ${ctx.lineId} · 配方 ${ctx.recipeId} · 优化通道 \`${ctx.channelB}\`(aml_optimization) · 训练通道 \`${ctx.channelA}\`(hybrid_twin)`,
    `- 模型 \`${ctx.modelId}\` · Twin Gate ${ctx.gatePassed ? '全过' : '未过'} · MPC mode=${ctx.mpc?.mode}`,
    '',
    `## 第一轮 · 探索式(optimization_explore 治理写入)`,
    '',
    `- 起点 ${ctx.exploration?.hStart?.toFixed?.(2)}μm → 终点 ${ctx.exploration?.hEnd?.toFixed?.(2)}μm ${okR1}(screw 150→${ctx.exploration?.screwEnd})`,
    '- 每步 = 真实 DCW 写入(绑定鉴权/四层限界/60s 间隔/优化记录)+ settle + 目标均值回读 + 学习摘要;',
    '  探索记录落 optimization_explorations,写控动作全量入册 ops.log。',
    '',
    '```json',
    JSON.stringify(ctx.exploration?.traj ?? [], null, 2).slice(0, 2600),
    '```',
    '',
    `## 第二轮 · AML 模型式(precise_search + 治理投用)`,
    '',
    `- 投用前 ${ctx.round2?.hBefore?.toFixed?.(2)}μm → 投用后 ${ctx.round2?.hAfter?.toFixed?.(2)}μm ${okR2}`,
    `- MPC 推荐: \`${JSON.stringify(ctx.mpc?.best)}\` → 投用 ${JSON.stringify(ctx.applied)}`,
    `- 贝叶斯寻优: ${ctx.bayes?.rounds} 轮 / ${ctx.bayes?.evaluated} 候选(surrogate+UCB,recommendation-only)`,
    '',
    '## 门禁与治理链',
    '',
    '- 探索模式:孪生工具 fail-closed(EXPLORATION_MODE_NO_MODEL,已负向校验);',
    '- 绑定:谱系一致 + Twin Gate 全过(12 判据)+ stage=shadow 才可 PATCH boundModelId;',
    '- 模式切换:绑定即 optimizationMode exploration→aml,mpc_optimize 由 safe_small_step 升档 precise_search;',
    '- 投用:推荐经 optimization_explore(dcw_control 全治理链)真实写入,VirtualTrial/MPC 恒 candidateExecuted=false。',
    '',
    '## 全程事件日志',
    '',
    '```text',
    L.join('\n').slice(-60_000),
    '```',
  ].join('\n')
  writeFileSync(DOC_PATH, doc)
  log(`✔ 透明度文档: ${DOC_PATH}`)
})

log('')
log('ALL STAGES DONE ✔ 双模式闭环(探索式 + AML 模型式)全链路完成')
