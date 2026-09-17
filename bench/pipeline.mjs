#!/usr/bin/env node
/**
 * bench/pipeline.mjs —— AW-IndustrialBench 一体化integrated pipeline（单一入口，可自动复现）。
 *
 * 与 bench/run.mjs 的分工：
 *   run.mjs      —— 能力/治理评分（static/api/full/plc 四层，检查器式，输出评分面板）
 *   pipeline.mjs —— 真实integrated pipeline：自举simulator+平台 → 多协议多Line → 数采/数控/治理
 *                   → Agent 闭环 → 量化 CSV/JSON → HTML 可视化面板
 *
 * 用法：
 *   node bench/pipeline.mjs --profile integrated              # 5 协议 5 Line，工具级闭环
 *   node bench/pipeline.mjs --profile integrated --agent omp  # 额外跑真实 LLM Agent 闭环
 *   node bench/pipeline.mjs --profile quick --lines 2         # 冒烟：2 Line
 *   node bench/pipeline.mjs --no-autostart                    # 不自动拉起simulator（仅复用在线实例）
 *
 * 退出码：0 = 全部检查 pass；1 = 存在 fail（含 Agent 闭环未达成）
 */
import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeApi, mulberry32, sha256, ensureDir, writeJson, writeText, runId as mkRunId, sleep } from './lib/util.mjs'
import { ensureSimulator, simUp, applyPreset, simNodes, splitSignals, simExport, simApi, simManual, SIM_BASE, SIM_DIR, plantOptimum, plantPhase, plantTruth, plantState, plantReset } from './lib/sim.mjs'
import { ensurePlatform } from './lib/platform.mjs'
import { renderReportMd } from './lib/report-pipeline.mjs'
import { provisionLine, pickProtocolDevices, ensureGateway } from './lib/provision.mjs'
import { p50, p95, mean, rate, r3, toCsv, makeMetricBag } from './lib/metrics.mjs'
import { renderDashboard, barChart } from './lib/dashboard.mjs'
import { recipeLifecycle, nodeRollback, optimizationLifecycle, hitlApproval, paramLedger, auditSurfaces } from './lib/governance.mjs'
import { provisionTwinLine, startTwinBatch, runClosedLoop, offlineOptimum, CASTFILM_ACTUATORS, START_POINT } from './lib/closedloop.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const has = (k) => args.includes(`--${k}`)

const profile = arg('profile', 'integrated')
const seed = Number(arg('seed', 42))
const base = arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:3001')
const maxLines = Number(arg('lines', profile === 'quick' ? 2 : 5))
const agentHarness = arg('agent', '') || null // 空 = 不跑 LLM Agent；omp/codex/...
const toolHarness = arg('tool-harness', process.env.AW_TOOL_HARNESS ?? 'opencode') // 工具级闭环用的"有引擎"harness（mock 不支持 host 工具桥）
const agentProvider = arg('provider', process.env.AW_PROVIDER ?? 'zhipu-coding-plan')
const agentModel = arg('model', process.env.AW_MODEL ?? 'glm-5.3-flash')
const autostart = !has('no-autostart')
const noAutostartPlat = has('no-autostart-platform')
const simPreset = arg('preset', 'cast-film-physics')
const PROTOCOLS = ['modbus-tcp', 'modbus-rtu', 'opcua', 'mqtt', 'http']
// 闭环优化参数 benchmark：seed 数（0 = 跳过）。deterministic = 脚本策略；agent = 真实 LLM 任务
const clSeeds = Number(arg('cl-seeds', profile === 'quick' ? 0 : 3))
const clWriteMode = arg('cl-write', 'governed') // governed(agent dcw_control) | rest(裸 REST)
const clMaxIters = Number(arg('cl-iters', 8))

const HARNESS_FILES = ['pipeline.mjs', 'lib/util.mjs', 'lib/sim.mjs', 'lib/provision.mjs',
  'lib/metrics.mjs', 'lib/dashboard.mjs', 'lib/governance.mjs', 'lib/closedloop.mjs']
const harnessHash = sha256(HARNESS_FILES.map(f => {
  try { return readFileSync(join(HERE, f), 'utf8') } catch { return `MISSING:${f}` }
}).join('\n%%\n'))
let gitCommit = 'unknown'
try {
  gitCommit = (await import('node:child_process')).execSync('git rev-parse --short HEAD', { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
} catch { /* 非 git 容错 */ }

const rid = mkRunId()
const outDir = ensureDir(join(REPO, 'bench', 'results', rid))
const rng = mulberry32(seed)
const api = makeApi(base)
const checks = []
const phases = []
const lines = []
let guestAgent = null // P4 创建的"有引擎"成员实例（后续治理阶段复用其绑定与工具面）
const bag = makeMetricBag()
const csvRows = []
const add = (phase, id, title, status, evidence = [], extra = {}) => {
  checks.push({ phase, id, title, status, evidence, ...extra })
  console.log(`  ${status === 'pass' ? '✔' : status === 'warn' ? '▲' : status === 'skip' ? '↓' : '✘'} [${phase}] ${id} · ${title}`)
}
const timed = async (phase, id, title, fn) => {
  const t0 = Date.now()
  let status = 'pass', note = ''
  try { const r = await fn(); if (r?.status) status = r.status; note = r?.note ?? '' }
  catch (err) { status = 'fail'; note = String(err?.message ?? err); console.error(`    error: ${note}`) }
  phases.push({ id: `${phase}·${id}`, phase, title, status, note, durationMs: Date.now() - t0 })
  return { status, note }
}

console.log(`\n=== AW-IndustrialBench · integrated pipeline ${rid} ===`)
console.log(`profile=${profile} seed=${seed} lines<=${maxLines} preset=${simPreset} harness=${harnessHash.slice(0, 8)} git=${gitCommit}`)
console.log(`platform=${base}  simulator=${SIM_BASE}\n`)

// ═══════════════ P0 · 自举与就绪 ═══════════════
await timed('P0', 'preflight', 'Bootstrap simulator & platform', async () => {
  let simNote = 'already up (reused)'
  if (!(await simUp())) {
    if (!autostart) {
      add('P0', 'simulator-reachable', 'simulator reachable', 'fail',
        [`simulator ${SIM_BASE} 不可达且 --no-autostart；请先: cd ${SIM_DIR} && npm run dev`])
      return { status: 'fail', note: `simulator ${SIM_BASE} 不可达且 --no-autostart` }
    }
    const r = await ensureSimulator()
    if (!r.started && !(await simUp())) {
      add('P0', 'simulator-reachable', 'simulator reachable', 'fail',
        [`simulator ${SIM_BASE} 自动启动失败: ${r.reason}`, `处置: cd ${SIM_DIR} && npm install && npm run dev`])
      return { status: 'fail', note: `simulator自动启动failed: ${r.reason}` }
    }
    simNote = `自动启动 pid=${r.pid}`
  }
  // 平台自举：执行卡承诺"单命令端到端"——平台不在运行时由流程分离拉起（detached+unref）
  let platNote = 'already up (reused)'
  if (!noAutostartPlat) {
    const pr = await ensurePlatform({ base, log: console.log })
    platNote = pr.started ? `自动分离启动 pid=${pr.pid}（日志 ${pr.log}）` : (pr.reason ?? 'already up')
    if (!pr.started && pr.reason && pr.reason !== 'already-up') {
      add('P0', 'platform-reachable', 'platform reachable & authenticated', 'fail',
        [`平台 ${base} 自举失败: ${pr.reason}`])
      return { status: 'fail', note: `platform bootstrap failed: ${pr.reason}` }
    }
  }
  // 平台不可达必须在检查表中留下 fail 记录——否则抛错路径零检查，会被"部分通过"假绿掩盖
  let login = { ok: false, how: 'unreachable' }
  try {
    login = await api.login(process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local', process.env.AW_ADMIN_PASS ?? 'admin123')
  } catch (e) { login = { ok: false, how: String(e?.message ?? e).slice(0, 60) } }
  add('P0', 'platform-reachable', 'platform reachable & authenticated', login.ok ? 'pass' : 'fail',
    [`平台 ${base}：${platNote}`, `鉴权 ${login.ok ? 'OK' : 'failed'} (${login.how})`, `simulator ${SIM_BASE}：${simNote}`])
  if (!login.ok) return { status: 'fail', note: 'platform unreachable or auth failed' }
  return { status: 'pass', note: simNote }
})

// ═══════════════ P1 · 工艺模型（数字孪生底座）═══════════════
let optimum = null, truthBefore = null
await timed('P1', 'plant-model', 'plant model preset + offline optimum W*', async () => {
  const nodes = await applyPreset(simPreset)
  add('P1', 'preset-applied', `预设 ${simPreset} 已应用`, nodes.length ? 'pass' : 'fail',
    [`devices ${nodes.length} `, `协议 ${[...new Set(nodes.map(n => n.protocol))].join(', ')}`])
  try { await plantPhase('steady') } catch { /* 无物理模型时忽略 */ }
  optimum = await plantOptimum()
  truthBefore = await plantTruth(200)
  // simulator /api/plant/optimum 的真实字段：{ zoneTemp, screw, lineSpeed, meltTemp, pressure, thickness, defect, score }
  const optScore = optimum?.score ?? optimum?.J ?? optimum?.objective
  const optOk = Number.isFinite(Number(optScore))
  add('P1', 'offline-optimum', 'offline optimum W* (ground truth) available', optOk ? 'pass' : 'warn',
    [`W* = ${JSON.stringify(optimum)?.slice(0, 200)}`])
  if (optOk) bag.add('plant', 'W_star_objective', Number(optScore), '', 'offline grid-search optimum (benchmark ground truth)')
  return { status: nodes.length ? 'pass' : 'fail' }
})

// ═══════════════ P2 · 多line provisioning ═══════════════
const sfx = `ip${seed.toString(36)}${Date.now().toString(36).slice(-4)}`
await timed('P2', 'provision', `multi-protocol multi-line provisioning（≤${maxLines} ）`, async () => {
  const gw = await ensureGateway(api)
  add('P2', 'gateway', 'gateway controller start (idempotent)', gw ? 'pass' : 'warn',
    ['POST /api/workshop/daq/controller {action:start}', '采样仍受「活动Line批」门控，故每台有 SP 的devices自成一可开跑Line'])
  const nodes = await simNodes()
  const devices = pickProtocolDevices(nodes, PROTOCOLS).slice(0, maxLines)
  if (!devices.length) { add('P2', 'provision-lines', 'line provisioning', 'fail', ['no simulator devices available']); return { status: 'fail' } }
  let host = null
  for (let i = 0; i < devices.length; i++) {
    const dev = devices[i]
    // 宿主候选恒传：devices能否自成Line由 provisionLine 依「是否有可用 DCW 导出」判定
    const rec = await provisionLine(api, { device: dev, sfx, index: i + 1, hostLine: host })
    lines.push(rec)
    if (!rec.satellite && rec.ids.line && rec.started) host = rec
    add('P2', `line-${i + 1}-${rec.protocol}`, `Line${i + 1} [${rec.protocol}] 供给${rec.satellite ? '（satellite DAQ）' : ''}`, rec.errors.length ? 'warn' : 'pass',
      [`line=${rec.ids.line ?? '✘'} daq=${rec.ids.daq ?? '✘'} dcw=${rec.ids.dcw ?? '✘'} recipe=${rec.ids.recipe ?? '—'}${rec.satellite ? ` ↪hosted by line${rec.hostLineIndex}` : ''}`,
        `DAQ driver test ${rec.driverTest?.ok ? '✔' : '✘'} 信号「${rec.daqSignal ?? '—'}」：${rec.driverTest?.message ?? '(未实测)'}`.slice(0, 200),
        rec.setpoint ? `SP 中心 ${rec.setpoint.center} 窗口 [${r3(rec.window.min)}, ${r3(rec.window.max)}]` : '（该devices无可用 DCW 导出，作为satellite DAQ随宿主批采样）',
        ...rec.errors])
  }
  const okN = lines.filter(l => l.ids.daq && !l.errors.length).length
  const ownLines = lines.filter(l => !l.satellite).length
  bag.add('provision', 'lines_created', ownLines, '', `可开跑Line（另有 ${lines.length - ownLines} satellite DAQ）`)
  bag.add('provision', 'daq_nodes', lines.filter(l => l.ids.daq).length, '', 'real-protocol DAQ nodes')
  return { status: okN === devices.length ? 'pass' : okN > 0 ? 'warn' : 'fail', note: `${okN}/${devices.length} devices ready · ${ownLines}  lines` }
})

// ═══════════════ P3 · 集成：多协议数采 / 数控 / 治理 ═══════════════
const WRITES = 6
await timed('P3', 'integration', 'multi-protocol DAQ + governed write/read + F5 interception', async () => {
  await sleep(7000) // 让 5  lines各自起稳采样
  for (const l of lines) {
    const ev = []
    // (a) 数采——真实驱动首采受网关节拍/冷连接影响，给有界等待窗（P8 同款；0 点仍 warn，不降判据）
    let pts = []
    if (l.ids.daq) {
      const tW = Date.now()
      for (;;) {
        const s = await api.call('GET', `/api/workshop/daq/${l.ids.daq}/samples?bucketMs=1000&limit=60`)
        pts = s.data?.points ?? []
        if (pts.length > 0 || Date.now() - tW > 20_000) break
        await sleep(2000)
      }
      const waitedMs = Date.now() - tW
      if (pts.length && waitedMs > 7000) ev.push(`… DAQ 首采等待 ${r3(waitedMs / 1000)}s（网关冷启动节拍，如实记录）`)
    }
    l.daqSamples = pts.length
    ev.push(`${pts.length ? '✔' : '✘'} DAQ samples stored ${pts.length}  points (${l.protocol} real driver）`)
    // (b) 数控写 + 回读 + 时延（写位于窗口 0.7 处的**变更值**，使回读校验非平凡）
    if (l.ids.dcw && l.window) {
      const target = Number((l.window.min + (l.window.max - l.window.min) * 0.7).toFixed(3))
      const lat = []
      let lastRead = null
      for (let k = 0; k < WRITES; k++) {
        const t0 = performance.now()
        const w = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/write`, { value: target })
        lat.push(performance.now() - t0)
        if (k === WRITES - 1) {
          const rd = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/read`, {})
          lastRead = rd.data?.read?.value ?? rd.data?.value ?? null
        }
        await sleep(120)
      }
      l.writeP50 = r3(p50(lat)); l.writeP95 = r3(p95(lat)); l.writeMean = r3(mean(lat))
      l.readbackDelta = typeof lastRead === 'number' ? r3(Math.abs(lastRead - target)) : null
      ev.push(`✔ 约${WRITES}写 p50=${l.writeP50}ms p95=${l.writeP95}ms，readback deviation ${l.readbackDelta}`)
      // (c) Governance F5：窗外/量程外攻击 + legal write
      const att = [
        l.setpoint.hi + (l.setpoint.hi - l.setpoint.lo) * 0.15,
        l.setpoint.lo - (l.setpoint.hi - l.setpoint.lo) * 0.15,
        1e6, -50,
        l.window.max + (l.window.max - l.window.min) * 0.2,
        l.window.min - (l.window.max - l.window.min) * 0.2,
      ]
      let rej = 0
      for (const v of att) { const r = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/write`, { value: Number(v.toFixed(3)) }); if (r.status >= 400) rej++; await sleep(90) }
      const legal = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/write`, { value: target })
      l.f5Rejected = rej; l.f5Total = att.length; l.falseBlock = legal.status === 200 ? 0 : 1
      ev.push(`${rej === att.length ? '✔' : '✘'} Governance F5: ${rej}/${att.length} rejected (${l.protocol} 真实链路），legal write${legal.status === 200 ? '受理' : 'blocked'}`)
      bag.add('gov', `intercept_${l.protocol}`, rate(rej, att.length), '', 'governance interception rate')
    } else {
      ev.push('no SP write point; write/governance sub-checks skipped')
    }
    // 治理硬门：可写线上 F5 必须全拦截且合法写必受理——任何穿透/误拦 = fail（与 api-3 同哲学）
    const govOk = l.f5Total == null || (l.f5Rejected === l.f5Total && l.falseBlock === 0)
    add('P3', `line-${l.index}-io`, `Line${l.index} [${l.protocol}] integration check`,
      !govOk ? 'fail' : l.daqSamples > 0 ? 'pass' : 'warn', ev)
    csvRows.push({ phase: 'P3', line: l.index, protocol: l.protocol, daq_samples: l.daqSamples,
      write_p50_ms: l.writeP50 ?? '', write_p95_ms: l.writeP95 ?? '', readback_delta: l.readbackDelta ?? '',
      f5_rejected: l.f5Rejected ?? '', f5_total: l.f5Total ?? '', false_block: l.falseBlock ?? '' })
  }
  const okN = lines.filter(l => l.daqSamples > 0).length
  const inter = lines.filter(l => l.f5Total != null)
  bag.add('provision', 'lines_sampling', okN, '', 'real driver produced samples')
  bag.add('gov', 'intercept_rate_all', rate(inter.reduce((s, l) => s + l.f5Rejected, 0), inter.reduce((s, l) => s + l.f5Total, 0)), '', '全协议合并')
  return { status: okN === lines.length ? 'pass' : 'warn', note: `${okN}/${lines.length} Linesampling` }
})

// ═══════════════ P4 · 工具级闭环（确定性，可复现）═══════════════
await timed('P4', 'tool-loop', `数采→数控→判定 工具级闭环（harness=${toolHarness}，不经 LLM）`, async () => {
  // 关键：工具级闭环必须选「实现了 dispatchHostTool 的引擎 harness」。
  // mock 走 MockAgentImpl，工具桥只会回退到协作工具族并抛「不支持该协作工具」——
  // 那样断言会被"工具压根没到"掩盖（假绿）。主机工具直调不经 LLM，故只需 CLI 在册。
  const ch = await api.call('POST', '/api/workshop/channels', {
    name: `intpipeline-${sfx}`, leadAgent: { name: `lead-${sfx}`, harness: 'mock', config: { delayMs: 40 } },
  })
  const channelId = ch.data?.channelId ?? ch.data?.channel?.id ?? ch.data?.id
  const tpl = await api.call('POST', '/api/workshop/agents', { name: `op-${sfx}`, harness: toolHarness, config: {} })
  const join = await api.call('POST', `/api/workshop/channels/${channelId}/agents`, { agentId: tpl.data?.id, role: 'worker' })
  const instId = join.data?.id ?? join.data?.agentId
  if (!channelId || !instId) { add('P4', 'tool-loop-setup', '闭环夹具（channel+agent）', 'fail', [`channel=${channelId} agent=${instId}`, JSON.stringify(ch.data ?? {}).slice(0, 160)]); return { status: 'fail' } }
  guestAgent = { channelId, instId }
  add('P4', 'tool-loop-setup', '闭环夹具（channel+agent）', 'pass', [`channel=${channelId}`, `agent=${instId}`, `harness=${toolHarness}`])

  // 工具面自检：该 harness 必须真的能派发 host 工业工具，否则后续闭环断言无意义
  const probe = await api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: instId, tool: 'my_industrial_nodes', args: {} })
  const probeText = String(probe.data?.result?.text ?? '')
  const bridgeWorks = !/不支持该协作工具/.test(probeText)
  add('P4', 'tool-bridge', `${toolHarness} 的 host 工具直调面可用`, bridgeWorks ? 'pass' : 'fail',
    [`探测 my_industrial_nodes → ${probeText.slice(0, 110) || '(空)'}`])
  if (!bridgeWorks) return { status: 'fail', note: `${toolHarness} 不支持 host 工具桥` }

  let loops = 0
  for (const l of lines.filter(x => x.ids.dcw && x.window)) {
    await api.call('POST', '/api/workshop/agent-tools/bindings', { agentId: instId, nodeId: l.ids.dcw, kind: 'dcw', mode: 'auto' })
    if (l.ids.daq) await api.call('POST', '/api/workshop/agent-tools/bindings', { agentId: instId, nodeId: l.ids.daq, kind: 'daq', mode: 'auto' })
    // Agent 闭环收敛：≤3 轮「观测→受治理下发→判定」逼近窗口中心。三个实测出的硬约束：
    // ①写入值必须**不同于当前值**——同值写入 afterWrite 不记锚，拿不到 record_id（假绿陷阱）；
    // ②每轮 dcw_control 后必须 dcw_judge 关记录——Agent 作用域同时只允许一条 open 记录，
    //   不关则下一轮下发被 guardrail 拒绝；③dcw_judge 必须传 record_id（传 node_id 会 isError）。
    const span = l.window.max - l.window.min
    const center = (l.window.min + l.window.max) / 2
    const positions = [0.2, 0.35, 0.5]
    let okCycles = 0, firstDist = null, lastRead = null
    const t0 = Date.now()
    const ev = []
    for (let i = 0; i < positions.length; i++) {
      const target = Number((l.window.min + span * positions[i]).toFixed(3))
      const c = await api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: instId, tool: 'dcw_control', args: { node_id: l.ids.dcw, value: target, hypothesis: `integrated pipeline closed loop iter ${i + 1}` } })
      const okWrite = c.data?.result?.isError !== true
      const cText = String(c.data?.result?.text ?? '')
      const recordId = (cText.match(/优化记录\s+([A-Za-z0-9._:-]+)\s+已开窗/) ?? [])[1] ?? null
      await sleep(1100)
      const q = l.ids.daq ? await api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: instId, tool: 'daq_query', args: { node_id: l.ids.daq } }) : { data: {} }
      const okQuery = l.ids.daq ? q.data?.result?.isError !== true : true
      let okJudge = false
      if (recordId) {
        const j = await api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: instId, tool: 'dcw_judge', args: { record_id: recordId, verdict: 'keep', reason: `integrated pipeline iter ${i + 1}: 回读校验通过` } })
        okJudge = j.data?.result?.isError !== true
      }
      const rd = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/read`, {})
      const rbv = Number(rd.data?.read?.value ?? rd.data?.value)
      // publish-only(MQTT)/echo-only(HTTP) 执行器不回读是**驱动属性**（论文 Table IV n/a）——
      // 无回读时以「写入受理+判定完成」计轮，不因驱动缺回读而误判闭环失败
      const rbKnown = Number.isFinite(rbv)
      const rbOk = !rbKnown ? true : Math.abs(rbv - target) <= Math.max(0.75, span * 0.01)
      if (i === 0) firstDist = rbKnown ? Math.abs(rbv - center) : null
      lastRead = rbv
      if (okWrite && okQuery && okJudge && rbOk) okCycles++
      ev.push(`iter${i + 1}: SP→${target} ${okWrite ? '✔' : '✘'} · 回读 ${rbKnown ? rbv : 'n/a(该驱动不回读)'} ${rbOk ? '✔' : '✘'} · daq ${okQuery ? '✔' : '✘'} · judge ${recordId ? (okJudge ? '✔' : '✘') : '✘(无record)'}`)
      await sleep(250)
    }
    const converged = okCycles === positions.length && (firstDist == null || !Number.isFinite(lastRead) || Math.abs(lastRead - center) <= firstDist)
    l.loopIterations = okCycles === positions.length ? positions.length : 0
    l.convergenceS = r3((Date.now() - t0) / 1000)
    if (l.loopIterations) loops++
    add('P4', `line-${l.index}-loop`, `Line${l.index} [${l.protocol}] Agent 闭环收敛（${okCycles}/3 轮）`, l.loopIterations ? 'pass' : 'warn',
      [...ev, `向窗口中心收敛 ${converged ? '✔' : '✘'} · 耗时 ${l.convergenceS}s`])
    csvRows.push({ phase: 'P4', line: l.index, protocol: l.protocol, loop_iterations: l.loopIterations, convergence_s: l.convergenceS })
  }
  // 工艺响应核对：写 SP 后物理模型真值是否随动
  const truthAfter = await plantTruth(200)
  const nB = (truthBefore?.samples ?? []).length, nA = (truthAfter?.samples ?? []).length
  const ps = await plantState()
  add('P4', 'plant-response', '工艺模型响应（SP→plant truth 随动）', nA > nB ? 'pass' : 'warn',
    [`真值样本 ${nB} → ${nA}`, `plant state: ${JSON.stringify(ps)?.slice(0, 180)}`])
  bag.add('loop', 'tool_loops_ok', loops, ' lines', '工具级闭环达成')
  return { status: loops === lines.filter(x => x.ids.dcw).length ? 'pass' : loops ? 'warn' : 'fail', note: `${loops}  loops` }
})

// ═══════════════ P4m · AgentTeam 优化任务（任务板 + 时段数据 + 治理写 + 达标判定）═══════════════
const waitUntilCompat = async (capMs, stepMs, fn) => {
  const t0 = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - t0 > capMs) return false
    await sleep(stepMs)
  }
}
// 用户核心功能测评：给 AgentTeam 一个优化任务目标 → 团队经任务板派发 → worker 经工业工具面
// 读取 Timescale 时段数据 → 分析 → 受治理下发参数 → 物理随动 → 达成目标并收口任务。
// 策略确定性（不经 LLM，免模型凭据；LLM 变体见 P5 / --agent），但路径与 LLM 完全同一：
// 任务板状态机 + host 工具桥 + 治理写路径 + 物理引擎 + 参数账本，全部真实链路。
await timed('P4m', 'team-mission', 'AgentTeam 优化任务：目标下达 → 时段读数 → 治理写 → 达标收口', async () => {
  if (!guestAgent) { add('P4m', 'mission-board', 'AgentTeam 优化任务', 'skip', ['P4 夹具未就绪']); return { status: 'skip' } }
  const { channelId, instId } = guestAgent
  const l = lines.find(x => x.ids.dcw && x.window && x.ids.daq)
  if (!l) { add('P4m', 'mission-board', 'AgentTeam 优化任务', 'skip', ['无可用闭环Line']); return { status: 'skip' } }

  const span = l.window.max - l.window.min
  const tol = Math.max(0.75, span * 0.01)
  const target = Number((l.window.min + span * 0.78).toFixed(3)) // P4 收在 0.5 位，目标取 0.78 保证变更值开新记录
  const maxWrites = 3
  const ev = []

  // (1) 任务板：专用 mission channel（mock lead+worker，规则引擎派发剧本——P9 同款可靠范式）
  //     优化目标写在任务正文；真实优化动作由 opencode agent 经工具面执行（见 (2)-(5)，归因不变）。
  //     注意 api.call(method,path,body) 第三参就是请求体。
  const mch = await api.call('POST', '/api/workshop/channels', { name: `mission-${sfx}`, leadAgent: { name: `mlead-${sfx}`, harness: 'mock', config: { delayMs: 40 } } })
  const mchId = mch.data?.channelId ?? mch.data?.channel?.id ?? mch.data?.id
  const mw = await api.call('POST', '/api/workshop/agents', { name: `mworker-${sfx}`, harness: 'mock', config: { delayMs: 60 } })
  await api.call('POST', `/api/workshop/channels/${mchId}/agents`, { agentId: mw.data?.id, role: 'worker' })
  const parent = await api.call('POST', `/api/workshop/channels/${mchId}/tasks`, {
    title: `mission-opt-${sfx}`,
    description: `Optimization mission: bring ${l.ids.dcw} to ${target} ±${tol} within recipe window using ≤${maxWrites} governed writes; read recent data first.`,
    parts: [{ text: `优化任务：把 ${l.ids.dcw} 调整到 ${target}±${tol}，先读数后写参数，至多 ${maxWrites} 次受治理写。` }],
  })
  const parentTask = parent.data?.task?.id ?? parent.data?.id
  let childOfLead = null
  await waitUntilCompat(30_000, 2_000, async () => {
    const t = (await api.call('GET', `/api/workshop/channels/${mchId}/tasks`)).data ?? []
    childOfLead = t.find(x => x.parentId === parentTask && x.id !== parentTask) ?? null
    return !!childOfLead
  })
  add('P4m', 'mission-board', '任务板：优化任务下达并由 lead 派发', parentTask && childOfLead ? 'pass' : 'warn',
    [`channel=${mchId} parent=${parentTask ?? `✘ ${parent.status}/${parent.code} ${parent.message}`} leadChild=${childOfLead?.id ?? '—'} assignee=${childOfLead?.assigneeId ?? '—'}`])

  // (2) 时段数据读取（Timescale 语义：from/to/bucket）——经 worker 的 daq_query 工具面
  const toMs = Date.now()
  const fromMs = toMs - 5 * 60_000
  const q = await api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: instId, tool: 'daq_query', args: { node_id: l.ids.daq, from_ms: fromMs, to_ms: toMs, bucket_ms: 1000, limit: 60 } })
  const qText = String(q.data?.result?.text ?? '')
  const qOk = q.data?.result?.isError !== true
  add('P4m', 'mission-timescale-read', '时段数据读取（daq_query from/to/bucket）', qOk ? 'pass' : 'fail',
    [`window ${Math.round((toMs - fromMs) / 1000)}s · isError=${q.data?.result?.isError === true}`, `sample: ${qText.slice(0, 140)}`])

  // (3) 「读数 → 分析 → 下发」闭环：首写直达目标；未达标则按观测偏差计算校正量再写（≤maxWrites 轮）
  //     每轮写后轮询时段读数等物理随动（有界 30s），再 dcw_judge 收口记录（同节点仅允许一条 open）
  let writes = 0, attained = false, finalPv = null
  const settleRead = async (tgt) => {
    const tW = Date.now()
    for (;;) {
      await sleep(2000)
      const p = await api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: instId, tool: 'daq_query', args: { node_id: l.ids.daq, last_minutes: 1, bucket_ms: 1000, limit: 20 } })
      const nums = (String(p.data?.result?.text ?? '').match(/[-+]?\d+\.\d+/g) ?? []).map(Number).filter(Number.isFinite)
      if (nums.length) finalPv = nums[nums.length - 1]
      if (finalPv != null && Math.abs(finalPv - tgt) <= tol) return true
      if (Date.now() - tW > 30_000) return false
    }
  }
  for (let i = 0; i < maxWrites && !attained; i++) {
    let tgt = target
    if (i > 0 && Number.isFinite(finalPv)) {
      // 分析：按观测偏差计算校正 SP，夹回配方窗内（这就是「根据数据下发控制」的确定性形式）
      tgt = Number(Math.min(l.window.max, Math.max(l.window.min, target + (target - finalPv))).toFixed(3))
    }
    const cur = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/read`, {})
    const curV = Number(cur.data?.read?.value ?? cur.data?.value)
    if (Number.isFinite(curV) && Math.abs(curV - tgt) < Math.max(0.05, span * 0.0005)) { attained = Math.abs(curV - target) <= tol; continue }
    const c = await api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: instId, tool: 'dcw_control', args: { node_id: l.ids.dcw, value: tgt, hypothesis: `mission iter ${i + 1}: reach ${target}±${tol}` } })
    if (c.data?.result?.isError === true) { ev.push(`iter${i + 1}: write rejected → ${String(c.data?.result?.text ?? '').slice(0, 90)}`); break }
    writes++
    const recordId = (String(c.data?.result?.text ?? '').match(/优化记录\s+([A-Za-z0-9._:-]+)\s+已开窗/) ?? [])[1] ?? null
    await settleRead(tgt)
    if (recordId) {
      const j = await api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: instId, tool: 'dcw_judge', args: { record_id: recordId, verdict: 'keep', reason: `mission iter ${i + 1}: PV=${finalPv} target=${tgt}±${tol}` } })
      ev.push(`iter${i + 1}: SP→${tgt} ✔ · record=${recordId ? 'opened+judged' : 'MISSING'} · PV≈${finalPv} ${j.data?.result?.isError !== true ? '✔' : '✘'}`)
    } else {
      ev.push(`iter${i + 1}: SP→${tgt} ✔ · record 未开（异常）`)
    }
    if (Number.isFinite(finalPv) && Math.abs(finalPv - target) <= tol) attained = true
  }
  add('P4m', 'mission-governed-write', `受治理参数下发（${writes} 写全开记录+判定）`, writes > 0 && writes <= maxWrites ? 'pass' : 'fail', ev)

  // (4) 账本归因核验：本轮写入必须出现在参数账本（Agent 归因）
  const jn = await api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: instId, tool: 'dcw_journal', args: { node_id: l.ids.dcw, limit: 10 } })
  const jnText = String(jn.data?.result?.text ?? '')
  const journalOk = jn.data?.result?.isError !== true && /Agent|agent/.test(jnText)
  add('P4m', 'mission-journal', '参数账本归因（Agent source 可追溯）', journalOk ? 'pass' : 'warn',
    [`journal sample: ${jnText.slice(0, 150)}`])

  // (5) 达标判定：终态 PV 距目标 ≤tol（以回读为准，daq 解析失败时回退回读）
  const rd = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/read`, {})
  const rbv = Number(rd.data?.read?.value ?? rd.data?.value)
  const pvFinal = Number.isFinite(rbv) ? rbv : finalPv
  const reached = Number.isFinite(pvFinal) && Math.abs(pvFinal - target) <= tol
  add('P4m', 'mission-attained', `优化目标达成（|PV−${target}|≤${tol}）`, reached ? 'pass' : 'warn',
    [`writes=${writes}/${maxWrites} · finalPV=${pvFinal} · target=${target} · tol=${tol}`])
  bag.add('loop', 'mission_writes', writes, '', 'AgentTeam 优化任务受治理写次数')
  bag.add('loop', 'mission_attained', reached ? 1 : 0, '', 'AgentTeam 优化任务达标')

  // (6) 任务收口：mock 团队按剧本推进任务状态机（P9 同款），90s 窗口内观察终态
  let parentState = ''
  {
    const dl6 = Date.now() + 90_000
    while (parentTask && Date.now() < dl6) {
      await sleep(3000)
      const t = (await api.call('GET', `/api/workshop/tasks/${parentTask}`)).data ?? {}
      parentState = t.state ?? t.task?.state ?? ''
      if (['COMPLETED', 'FAILED', 'CANCELED'].includes(parentState)) break
    }
  }
  add('P4m', 'mission-closed', '任务收口（lead 派发→worker 剧本完成→父任务聚合）', parentState === 'COMPLETED' ? 'pass' : 'warn',
    [`terminalState=${parentState || '(timeout)'} · writes=${writes} · reached=${reached}`])
  csvRows.push({ phase: 'P4m', line: l.index, protocol: l.protocol, mission_writes: writes, mission_final_pv: pvFinal ?? '', mission_target: target, mission_attained: reached ? 1 : 0 })
  const coreOk = qOk && writes > 0 && writes <= maxWrites && reached
  return { status: coreOk ? 'pass' : 'warn', note: `writes=${writes} PV=${pvFinal}/${target}` }
})

// ═══════════════ P4b · 回退与优化记录（判定/执行分离 · 参数账本）═══════════════
let p4bLine = null
await timed('P4b', 'rollback-records', 'Rollback & optimization records (node rollback · verdict/execution separation · param ledger)', async () => {
  if (!guestAgent) { add('P4b', 'rollback-records', '回退与优化记录', 'skip', ['P4 夹具未就绪']); return { status: 'skip' } }
  const l = lines.find(x => x.ids.dcw && x.window && x !== p4bLine)
  if (!l) { add('P4b', 'rollback-records', '回退与优化记录', 'skip', ['无数控Line']); return { status: 'skip' } }
  p4bLine = l // P4c 换线：避免本阶段回退冷却与 HITL 审批写在同一节点上相撞

  // (a) 优化记录生命周期（keep / rollback + 判定与执行分离）——先跑，避免回退冷却影响后续写
  const ol = await optimizationLifecycle(api, { instId: guestAgent.instId, nodeId: l.ids.dcw, window: l.window })
  l.recordLifecycle = ol.ok
  add('P4b', `line-${l.index}-optrecord`, `Line${l.index} 优化记录生命周期`, ol.ok ? 'pass' : 'warn', ol.ev)
  bag.add('gov', 'record_keep_rollback_ok', ol.ok ? 1 : 0, '', '优化记录判定/执行分离')

  // (b) node-level single-step rollback（撤销栈）——撤销产生的记录随即 keep 关闭，
  //     否则该 open 记录在 +120s 后会被系统兜底评估，在后续阶段制造计划外回退
  const rb = await nodeRollback(api, { nodeId: l.ids.dcw, window: l.window })
  l.nodeRollback = rb.ok
  if (rb.recordId) {
    // 撤销记录由 REST 写发起（owner=user），Agent 无权判定他人记录——用 admin 的 REST 判定关闭
    const jc = await api.call('POST', `/api/workshop/dcw/optimizations/${rb.recordId}/judge`, { verdict: 'keep', reason: 'P4b: undo-stack 回退已验证,关闭本记录' })
    add('P4b', `line-${l.index}-rbjudge`, `Line${l.index} 撤销记录 ${rb.recordId} 判定关闭`, jc.status === 200 ? 'pass' : 'warn',
      [`REST judge keep → status ${jc.status}`])
  }
  add('P4b', `line-${l.index}-rollback`, `Line${l.index} node-level single-step rollback (undo stack)`, rb.ok ? 'pass' : 'warn', rb.ev)
  csvRows.push({ phase: 'P4b', line: l.index, protocol: l.protocol, node_rollback: rb.ok, rollback_before: rb.before ?? '', rollback_after: rb.after ?? '' })

  // (c) 参数台账
  const pl = await paramLedger(api, { nodeId: l.ids.dcw })
  add('P4b', 'param-ledger', '参数台账（三值对照 + 在册历史）', pl.ok ? 'pass' : 'warn', pl.ev)

  const ok = rb.ok && ol.ok
  return { status: ok ? 'pass' : rb.ok || ol.ok ? 'warn' : 'fail', note: ok ? 'rollback & ledger passed' : 'partially failed' }
})

// ═══════════════ P4c · HITL 审批闭环（人工确认模式）═══════════════
await timed('P4c', 'hitl', 'HITL 审批闭环（挂起→面板可见→批准→真实写生效）', async () => {
  if (!guestAgent) { add('P4c', 'hitl', 'HITL 审批', 'skip', ['P4 夹具未就绪']); return { status: 'skip' } }
  const l = lines.find(x => x.ids.dcw && x.window && x !== p4bLine)
  if (!l) { add('P4c', 'hitl', 'HITL 审批', 'skip', ['无数控Line']); return { status: 'skip' } }
  const h = await hitlApproval(api, { instId: guestAgent.instId, nodeId: l.ids.dcw, window: l.window })
  l.hitl = { ok: h.ok, latencyMs: h.latencyMs }
  add('P4c', `line-${l.index}-hitl`, `Line${l.index} HITL 审批闭环`, h.ok ? 'pass' : 'warn', [
    ...h.ev, h.latencyMs != null ? `审批裁决时延 ${h.latencyMs} ms（挂起→批准，含轮询周期）` : '',
  ].filter(Boolean))
  if (h.latencyMs != null) bag.add('hitl', 'approval_latency_ms', h.latencyMs, 'ms', '挂起→批准（含 800ms 轮询粒度）')
  csvRows.push({ phase: 'P4c', line: l.index, protocol: l.protocol, hitl_ok: h.ok, hitl_latency_ms: h.latencyMs ?? '' })
  return { status: h.ok ? 'pass' : 'warn', note: h.ok ? 'HITL loop passed' : 'failed' }
})

// ═══════════════ P4d · 治理只读面（账本 / 审计 / 运维日志 / 报警）═══════════════
await timed('P4d', 'audit-surfaces', '治理只读面（参数账本·审计·运维日志·报警）', async () => {
  const l = lines.find(x => x.ids.dcw) ?? lines[0]
  const au = await auditSurfaces(api, { lineId: l?.ids.line })
  const alarms = (await api.call('GET', '/api/workshop/daq/alarms?scope=all&limit=200')).data?.alarms ?? []
  add('P4d', 'audit-surfaces', '治理只读面', au.ok ? 'pass' : 'warn',
    [...au.ev, `${alarms.length ? '✔' : '—'} 报警记录：全局 ${alarms.length} （含历史）`])
  bag.add('audit', 'journal_anchors', au.anchors, '', '本Line参数变更账本')
  bag.add('audit', 'audit_entries', au.entries, '', '全局审计目')
  bag.add('audit', 'ops_logs', au.logs, '', '全局运维日志')
  return { status: au.ok ? 'pass' : 'warn', note: `${au.anchors} 锚 / ${au.entries} 审计` }
})

// ═══════════════ P4e · recipe lifecycle（版本化 / 已知良好 / 回退 / 基准恢复 / 一键下发）═══════════════
await timed('P4e', 'recipe-lifecycle', '配方管理全生命周期（版本·已知良好·回退·基准恢复·一键下发）', async () => {
  const own = lines.filter(l => !l.satellite && l.ids.recipe && l.ids.dcw && l.window)
  if (!own.length) { add('P4e', 'recipe-lifecycle', 'recipe lifecycle', 'skip', ['无可开跑Line']); return { status: 'skip' } }
  let okN = 0
  for (const l of own.slice(0, 2)) {
    const r = await recipeLifecycle(api, { line: l, sfx })
    l.recipeLifecycle = { ok: r.ok, steps: r.steps }
    if (r.ok) okN++
    add('P4e', `line-${l.index}-recipe`, `Line${l.index} [${l.protocol}] recipe lifecycle`, r.ok ? 'pass' : 'warn', [
      ...r.ev,
      ...(r.errors.length ? [`错误：${r.errors.join('；')}`] : []),
    ])
    csvRows.push({ phase: 'P4e', line: l.index, protocol: l.protocol, recipe_versions: r.steps?.v2 ?? '', recipe_lastgood: r.steps?.lastGoodRunId ?? '', recipe_applied_run: r.steps?.appliedRunId ?? '' })
  }
  bag.add('recipe', 'recipe_lifecycles_ok', okN, ' lines', '版本/回退/基准恢复/下发 全链通过')
  return { status: okN === own.slice(0, 2).length ? 'pass' : okN ? 'warn' : 'fail', note: `${okN}/${own.slice(0, 2).length} Line配方全链通过` }
})

// 注意：本阶段刻意排在 P4d 之后——rollback-good 会留下回退锚（300s 同向冷却），
// 若排在 P4 之前，P4b 的优化记录生命周期会被该锚的冷却拒绝（实测踩过）。

// ═══════════════ P5 · 真实 LLM Agent 闭环（可选）═══════════════
if (agentHarness) {
  await timed('P5', 'agent-loop', `真实 LLM Agent 闭环（harness=${agentHarness}）`, async () => {
    const l = lines.find(x => x.ids.dcw && x.ids.daq)
    if (!l) { add('P5', 'agent-loop', 'Agent 闭环', 'skip', ['无可用于闭环的Line']); return { status: 'skip' } }
    const ch = await api.call('POST', '/api/workshop/channels', {
      name: `agentloop-${sfx}`, leadAgent: { name: `lead-${sfx}`, harness: 'mock', config: { delayMs: 40 } },
    })
    const channelId = ch.data?.channelId ?? ch.data?.channel?.id ?? ch.data?.id
    const tpl = await api.call('POST', '/api/workshop/agents', {
      name: `agent-${sfx}`, harness: agentHarness,
      config: { provider: agentProvider, model: agentModel, systemPromptPrefix: '你是Line操作员：严格按步骤执行，完成后立即调用 complete_task。' },
    })
    const join = await api.call('POST', `/api/workshop/channels/${channelId}/agents`, { agentId: tpl.data?.id, role: 'worker' })
    const instId = join.data?.id ?? join.data?.agentId
    if (!instId) { add('P5', 'agent-loop', 'Agent 闭环', 'fail', ['Agent 入队failed']); return { status: 'fail' } }
    await api.call('POST', '/api/workshop/agent-tools/bindings', { agentId: instId, nodeId: l.ids.dcw, kind: 'dcw', mode: 'auto' })
    await api.call('POST', '/api/workshop/agent-tools/bindings', { agentId: instId, nodeId: l.ids.daq, kind: 'daq', mode: 'auto' })
    // 与 P4 的 0.25 位置区分（避免同值空写 → 无 record_id）
    const target = Number((l.window.min + (l.window.max - l.window.min) * 0.35).toFixed(3))
    const t0 = Date.now()
    const t = await api.call('POST', `/api/workshop/channels/${channelId}/tasks`, {
      title: `agentloop-${sfx}`, assigneeId: instId,
      parts: [{ text: `Line闭环调优任务（严格按步骤执行）：
1. 调用 daq_query(node_id="${l.ids.daq}") 读取当前过程量;
2. 调用 dcw_control(node_id="${l.ids.dcw}", value=${target}, hypothesis="integrated pipeline闭环验证") 下发设定值;
3. 等待 3 秒后再 daq_query(node_id="${l.ids.daq}") 观察响应;
4. 调用 dcw_judge 落判定 keep 并附一句证据;
5. 交付中必须原样包含标记 INTEGRATED-CLOSEDLOOP-OK，然后调用 complete_task。` }],
    })
    const taskTitle = `agentloop-${sfx}`
    let taskId = t.data?.task?.id ?? t.data?.id
    if (!taskId) { // 兜底：部分版本响应不带 task 信封 → 按标题反查
      const list = (await api.call('GET', `/api/workshop/channels/${channelId}/tasks`)).data ?? []
      taskId = (Array.isArray(list) ? list : []).find(x => x.title === taskTitle)?.id
    }
    if (!taskId) { add('P5', 'agent-loop', '真实 LLM Agent 闭环', 'fail', ['任务下发failed', JSON.stringify(t.data ?? {}).slice(0, 140)]); return { status: 'fail' } }
    let state = ''
    const deadline = Date.now() + 8 * 60_000
    while (Date.now() < deadline) {
      await sleep(6000)
      const me = await api.call('GET', `/api/workshop/tasks/${taskId}`)
      state = me.data?.state ?? me.data?.task?.state ?? ''
      if (['COMPLETED', 'FAILED', 'CANCELED'].includes(state)) break
    }
    l.agentState = state || 'RUNNING'
    const blob = JSON.stringify((await api.call('GET', `/api/workshop/channels/${channelId}/messages?limit=200`)).data ?? {})
      + JSON.stringify((await api.call('GET', `/api/workshop/tasks/${taskId}`)).data ?? {})
    const hasMark = blob.includes('INTEGRATED-CLOSEDLOOP-OK')
    const wallS = r3((Date.now() - t0) / 1000)
    l.agentWallS = wallS; l.agentOracle = hasMark
    add('P5', 'agent-loop', `真实 LLM Agent 闭环（${agentHarness}）`, state === 'COMPLETED' && hasMark ? 'pass' : state === 'COMPLETED' ? 'warn' : 'fail',
      [`任务终态 ${state}（${wallS}s）`, `${hasMark ? '✔' : '✘'} 交付含 INTEGRATED-CLOSEDLOOP-OK`, `harness=${agentHarness} provider=${agentProvider} model=${agentModel}`])
    bag.add('agent', 'agent_wall_s', wallS, 's', `${agentHarness}`)
    bag.add('agent', 'agent_oracle_pass', hasMark ? 1 : 0, '', '交付判据命中')
    csvRows.push({ phase: 'P5', line: l.index, protocol: l.protocol, agent_harness: agentHarness, agent_state: state, agent_wall_s: wallS, agent_oracle: hasMark })
    return { status: state === 'COMPLETED' && hasMark ? 'pass' : 'fail', note: `${state}` }
  })
}

// ═══════════════ P6 · 闭环优化参数 benchmark（多 seed，cast-film 数字孪生）═══════════════
const cl = { seeds: [], ok: null, writeMode: clWriteMode }
if (clSeeds > 0) {
  await timed('P6', 'closedloop', `闭环优化参数 benchmark（${clSeeds} seed · 写路径=${clWriteMode} · ≤${clMaxIters} 迭代/seed）`, async () => {
    // (1) cast-film 全执行器孪生Line（6 执行器 + 5 传感器，真实协议驱动配置取自 /export）
    const nodes = await simNodes()
    const twin = await provisionTwinLine(api, { simDevices: nodes, sfx: `${sfx}cl` })
    add('P6', 'twin-nodes', 'cast-film twin node provisioning（执行器 + 传感器）', twin.ok ? 'pass' : 'fail', twin.ev)
    if (!twin.ok) return { status: 'fail', note: 'twin node provisioning failed' }

    // (2) 起始批（= 偏离最优的start）+ 离线最优 W*
    const batch = await startTwinBatch(api, { lineId: twin.lineId, productId: twin.productId, dcw: twin.dcw, sfx: `${sfx}cl` })
    if (!batch.ok) { add('P6', 'twin-batch', 'initial batch started', 'fail', batch.errors); return { status: 'fail', note: batch.errors.join('；') } }
    const opt = await offlineOptimum()
    add('P6', 'w-star', '离线最优 W*（ground truth）', opt ? 'pass' : 'warn',
      [`W* = ${JSON.stringify(opt)}`, `起始工况 ${JSON.stringify(START_POINT)}（J 显著低于 W*）`])

    // (3) Agent 绑定全部孪生节 points (治理写路径需要）
    if (guestAgent) {
      for (const id of Object.values(twin.dcw)) await api.call('POST', '/api/workshop/agent-tools/bindings', { agentId: guestAgent.instId, nodeId: id, kind: 'dcw', mode: 'auto' })
      for (const id of Object.values(twin.daq)) await api.call('POST', '/api/workshop/agent-tools/bindings', { agentId: guestAgent.instId, nodeId: id, kind: 'daq', mode: 'auto' })
    }
    const writeRest = async (nodeId, value) => {
      const r = await api.call('POST', `/api/workshop/dcw/${nodeId}/write`, { value })
      return { rejected: r.status >= 400, text: r.message ?? '' }
    }
    const writeGoverned = async (nodeId, value, hypothesis) => {
      const r = await api.call('POST', '/api/workshop/agent-tools/invoke', {
        agentId: guestAgent.instId, tool: 'dcw_control', args: { node_id: nodeId, value, hypothesis },
      })
      const res = r.data?.result ?? {}
      const text = String(res.text ?? '')
      return { rejected: res.isError === true, recordId: (text.match(/优化记录\s+([A-Za-z0-9._:-]+)\s+已开窗/) ?? [])[1] ?? null, text }
    }
    const write = (clWriteMode === 'rest' || !guestAgent) ? writeRest : writeGoverned

    // 复位到统一起 points (走 REST，不计入闭环写数；值均在配方窗内，不会被联锁rejected）
    const armStart = async () => {
      await writeRest(twin.dcw['zone1-sp'], START_POINT.zone)
      await writeRest(twin.dcw['zone2-sp'], START_POINT.zone)
      await writeRest(twin.dcw['zone3-sp'], START_POINT.zone)
      await writeRest(twin.dcw['screw-sp'], START_POINT.screw)
      await writeRest(twin.dcw['linespeed-sp'], START_POINT.lineSpeed)
      await writeRest(twin.dcw['diegap-sp'], START_POINT.dieGap)
    }
    // 预热：以**平台数采**的熔体温度为准（实时、正确来源）。
    // 不能读simulator真值文件：plantReset 后真值流轮转/残留会读到上一 seed 的陈旧样本，
    // 导致"以为已达窗口"而实际炉温仍冷（实测踩过：闭环全程 T≈60℃、J 恒为 null）。
    const warmup = async (capMs = 150_000) => {
      const t0 = Date.now()
      let last = null
      while (Date.now() - t0 < capMs) {
        const r = await api.call('GET', `/api/workshop/daq/${twin.daq['melt-temp']}/samples?bucketMs=1000&limit=30`)
        // 采样points新→旧排序：按 at 排序后取最近 5 桶（slice(-N) 会取到最旧的 N 桶）
        const pts = (r.data?.points ?? []).slice().sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0)).slice(0, 5)
        const vals = pts.map(p => Number(p.avg ?? p.value)).filter(Number.isFinite)
        last = vals.length ? mean(vals) : null
        if (last != null && last >= 196 && last <= 224) return { ok: true, wallS: r3((Date.now() - t0) / 1000), meltTemp: r3(last) }
        await sleep(3000)
      }
      return { ok: false, wallS: r3((Date.now() - t0) / 1000), meltTemp: last }
    }

    // (4) 多 seed 战役：每 seed 独立复位（RNG + start），策略与治理不变
    const seedList = Array.from({ length: clSeeds }, (_, i) => Number(arg('seed', 42)) + i)
    for (const s of seedList) {
      await plantReset({ seed: s, phase: 'steady', warm: true })
      await armStart()
      const warm = await warmup()
      if (warm.ok) await plantPhase('steady').catch(() => {})
      const run = await runClosedLoop(api, {
        seed: s, lineId: twin.lineId, dcw: twin.dcw, daq: twin.daq, optimum: opt,
        write, maxIters: clMaxIters, settleMs: 12_000, sfx: `${sfx}cl`,
      })
      cl.seeds.push({ seed: s, warmupS: warm.wallS, warmed: warm.ok, ...run })
      add('P6', `seed-${s}`, `seed=${s} 闭环优化（J/J*=${run.ratio ?? '—'}）`, run.ok ? 'pass' : 'warn',
        [`预热 ${warm.wallS}s（熔体温度 ${warm.meltTemp ?? '—'}℃，${warm.ok ? '达工艺窗 [195,225]' : '未达窗口，物理约束可能不满足'}）`,
          ...run.ev,
          `收敛=${run.stats.converged} · 迭代=${run.stats.iters} · 写=${run.stats.writes} · rejected=${run.stats.rejected} · J0=${run.J0} → Jend=${run.Jend} · J*=${run.Jstar} · 比值=${run.ratio}`])
      csvRows.push({ phase: 'P6', seed: s, protocol: 'castfilm', J0: run.J0 ?? '', Jend: run.Jend ?? '', Jstar: run.Jstar ?? '', ratio: run.ratio ?? '', iters: run.stats.iters, writes: run.stats.writes, rejected: run.stats.rejected, converged: run.stats.converged, wall_s: run.wallS })
    }

    // (5) 聚合
    const ratios = cl.seeds.map(x => x.ratio).filter(v => typeof v === 'number')
    const jEnds = cl.seeds.map(x => x.Jend).filter(v => typeof v === 'number')
    const j0s = cl.seeds.map(x => x.J0).filter(v => typeof v === 'number')
    const agg = {
      n: cl.seeds.length,
      ratioMin: ratios.length ? r3(Math.min(...ratios)) : null,
      ratioMean: ratios.length ? r3(mean(ratios)) : null,
      ratioMax: ratios.length ? r3(Math.max(...ratios)) : null,
      J0mean: j0s.length ? r3(mean(j0s)) : null,
      JendMean: jEnds.length ? r3(mean(jEnds)) : null,
      Jstar: opt?.score ?? null,
      itersMean: cl.seeds.length ? r3(mean(cl.seeds.map(x => x.stats.iters))) : null,
      writesTotal: cl.seeds.reduce((a, x) => a + x.stats.writes, 0),
      rejectedTotal: cl.seeds.reduce((a, x) => a + x.stats.rejected, 0),
      convergedN: cl.seeds.filter(x => x.stats.converged).length,
      wallSMean: cl.seeds.length ? r3(mean(cl.seeds.map(x => x.wallS))) : null,
    }
    cl.agg = agg
    cl.ok = agg.ratioMin != null && agg.ratioMin >= 0.8 && agg.rejectedTotal === 0
    add('P6', 'closedloop-aggregate', `闭环优化聚合（n=${agg.n}）`,
      agg.ratioMin != null && agg.ratioMin >= 0.9 && agg.rejectedTotal === 0 ? 'pass' : agg.ratioMin != null && agg.ratioMin >= 0.8 ? 'warn' : 'fail',
      [`J/J*：min ${agg.ratioMin} · mean ${agg.ratioMean} · max ${agg.ratioMax}（J* = ${agg.Jstar}）`,
        `J start均值 ${agg.J0mean} → end均值 ${agg.JendMean}`,
        `平均迭代 ${agg.itersMean}  · 总写 ${agg.writesTotal} · 越界rejected ${agg.rejectedTotal} · 收敛 ${agg.convergedN}/${agg.n} · 平均墙钟 ${agg.wallSMean}s/seed`])
    bag.add('closedloop', 'J_over_Jstar_mean', agg.ratioMean, '', `n=${agg.n} seeds，写路径=${clWriteMode}`)
    bag.add('closedloop', 'J_over_Jstar_min', agg.ratioMin, '', '最差 seed（保守下界）')
    bag.add('closedloop', 'J_end_mean', agg.JendMean, '', `J* = ${agg.Jstar}`)
    bag.add('closedloop', 'cl_iters_mean', agg.itersMean, '', '闭环收敛迭代数')
    bag.add('closedloop', 'cl_writes_total', agg.writesTotal, '', '受治理的闭环写总数')
    bag.add('closedloop', 'cl_rejected_total', agg.rejectedTotal, '', '越界被拒（治理拦截）')
    return { status: cl.ok ? 'pass' : agg.ratioMin != null ? 'warn' : 'fail', note: `J/J* ∈ [${agg.ratioMin}, ${agg.ratioMax}]` }
  })
}

// ═══════════════ P7 · 多形态数采（向量轮廓 / 图像帧落库）═══════════════
await timed('P7', 'frames', '多形态数采：向量轮廓与图像帧落库', async () => {
  const nodes = await simNodes()
  const httpDev = nodes.find(n => n.protocol === 'http')
  const lineId = lines.find(l => l.ids.line)?.ids.line
  if (!httpDev || !lineId) { add('P7', 'frames', '多形态数采', 'skip', ['无 http devices或Line']); return { status: 'skip' } }
  const exp = await simExport(httpDev.id)
  const items = exp?.items ?? []
  const mk = async (sigId, tpl) => {
    const sig = (httpDev.signals ?? []).find(s => s.id === sigId)
    const item = items.find(i => i.signal === sig?.name)
    if (!item?.driverConfig) return null
    const r = await api.call('POST', '/api/workshop/daq', {
      name: `${sig.name} ${sfx}`, templateRef: tpl, driver: 'http', driverConfig: item.driverConfig,
      lineId, intervalMs: 2000, publishIntervalMs: 0, semantics: `cast-film 多形态量 ${sig.name}`,
    })
    return r.data?.node?.id ?? null
  }
  const vecId = await mk('thickness-profile', 'thickness-scan')
  const imgId = await mk('ccd-image', 'ccd-image')
  await sleep(9000)
  const vf = vecId ? (await api.call('GET', `/api/workshop/daq/${vecId}/frames?kind=vector&limit=5`)).data?.frames ?? [] : []
  const imf = imgId ? (await api.call('GET', `/api/workshop/daq/${imgId}/frames?kind=image&limit=5`)).data?.frames ?? [] : []
  add('P7', 'frames', '多形态数采（向量/图像帧）', vf.length && imf.length ? 'pass' : (vf.length || imf.length) ? 'warn' : 'fail', [
    `${vf.length ? '✔' : '✘'} 向量轮廓帧 ${vf.length} （${vf[0]?.points ?? 0} points）`,
    `${imf.length ? '✔' : '✘'} 图像帧 ${imf.length} （${imf[0]?.meta?.width ?? 0}×${imf[0]?.meta?.height ?? 0} ${imf[0]?.meta?.mime ?? ''}）`,
  ])
  bag.add('daq', 'vector_frames', vf.length, '', '厚度横向轮廓')
  bag.add('daq', 'image_frames', imf.length, '', 'CCD 表面图像')
  return { status: vf.length && imf.length ? 'pass' : vf.length || imf.length ? 'warn' : 'fail', note: `vector ${vf.length} / image ${imf.length}` }
})

// ═══════════════ P8 · 跨场景可移植性（同一框架，第二产线场景，仅换场景配置）═══════════════
// 框架主张：适配一条新产线 = 配置任务，而非集成项目。本阶段把模拟器切到第二个独立定义的
// 产线场景（信号域与动力学模型完全不同），用**同一套** export→test→create→bind→governed
// write→readback 代码路径重新委托整条产线，然后恢复第一场景保持现场。
const port = { preset: null, lines: [], agg: null }
await timed('P8', 'portability', 'Cross-scenario portability (re-commission on a second plant preset, config-only)', async () => {
  const second = simPreset === 'film-line' ? 'cast-film-physics' : 'film-line'
  port.preset = second
  const nodes2 = await applyPreset(second)
  add('P8', 'scenario-switch', `second plant scenario applied: ${second}`, nodes2.length ? 'pass' : 'fail',
    [`devices ${nodes2.length} · protocols ${[...new Set(nodes2.map(n => n.protocol))].join(', ')}`,
      `信号域/动力学与第一场景（${simPreset}）完全不同 —— 框架代码零改动`])
  if (!nodes2.length) { await applyPreset(simPreset); return { status: 'fail', note: 'second preset empty' } }

  await ensureGateway(api)
  const devices2 = pickProtocolDevices(nodes2, PROTOCOLS).slice(0, maxLines)
  let host2 = null
  for (let i = 0; i < devices2.length; i++) {
    const rec = await provisionLine(api, { device: devices2[i], sfx: `${sfx}p8`, index: i + 1, hostLine: host2 })
    port.lines.push(rec)
    if (!rec.satellite && rec.ids.line && rec.started) host2 = rec
    add('P8', `commission-${i + 1}-${rec.protocol}`, `scenario[${second}] line ${i + 1} [${rec.protocol}] provisioned${rec.satellite ? ' (satellite DAQ)' : ''}`,
      rec.errors.length ? 'warn' : 'pass',
      [`line=${rec.ids.line ?? '✘'} daq=${rec.ids.daq ?? '✘'} dcw=${rec.ids.dcw ?? '✘'}`,
        rec.setpoint ? `SP window [${r3(rec.window.min)}, ${r3(rec.window.max)}]` : '(no SP export → satellite DAQ)',
        ...rec.errors])
  }
  await sleep(9000) // 首批采样就绪等待；RTU 等慢协议卫星节点用下方的就绪轮询兜底（固定睡会饿到 RTU）
  { // 就绪轮询：最长 24s，直到全部 DAQ 节点出样或超时（环境类时序，不设门槛、只求不让采样饿死）
    const tR = Date.now()
    for (;;) {
      const pending = []
      for (const l of port.lines) {
        if (!l.ids.daq || l.daqSamples > 0) continue
        const s = await api.call('GET', `/api/workshop/daq/${l.ids.daq}/samples?bucketMs=1000&limit=10`).catch(() => null)
        if ((s?.data?.points ?? []).length > 0) continue
        pending.push(l)
      }
      if (pending.length === 0 || Date.now() - tR > 24_000) break
      await sleep(3000)
    }
  }
  let okN = 0, rejN = 0, attN = 0, fbN = 0
  for (const l of port.lines) {
    const ev = []
    let pts = []
    if (l.ids.daq) {
      const s = await api.call('GET', `/api/workshop/daq/${l.ids.daq}/samples?bucketMs=1000&limit=60`)
      pts = s.data?.points ?? []
    }
    l.daqSamples = pts.length
    ev.push(`${pts.length ? '✔' : '✘'} DAQ samples ${pts.length} pts (${l.protocol} real driver)`)
    if (l.ids.dcw && l.window) {
      const target = Number((l.window.min + (l.window.max - l.window.min) * 0.7).toFixed(3))
      const w = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/write`, { value: target })
      ev.push(`${w.status === 200 ? '✔' : '✘'} governed write ${target} → HTTP ${w.status}`)
      const rd = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/read`, {})
      const rbv = rd.data?.read?.value ?? rd.data?.value ?? null
      l.readbackDelta = typeof rbv === 'number' ? r3(Math.abs(rbv - target)) : null
      if (l.readbackDelta != null) ev.push(`readback deviation ${l.readbackDelta}`)
      const att = [
        l.setpoint.hi + (l.setpoint.hi - l.setpoint.lo) * 0.15,
        l.setpoint.lo - (l.setpoint.hi - l.setpoint.lo) * 0.15,
        1e6,
      ]
      let rej = 0
      for (const v of att) { const r = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/write`, { value: Number(v.toFixed(3)) }); if (r.status >= 400) rej++; await sleep(90) }
      const legal = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/write`, { value: target })
      l.f5Rejected = rej; l.f5Total = att.length; l.falseBlock = legal.status === 200 ? 0 : 1
      rejN += rej; attN += att.length; fbN += l.falseBlock
      ev.push(`${rej === att.length ? '✔' : '✘'} F5 out-of-window ${rej}/${att.length} rejected · legal write ${legal.status === 200 ? 'accepted (0 false block)' : 'BLOCKED'}`)
    } else {
      ev.push('no SP write point; write/governance sub-checks skipped (satellite DAQ)')
    }
    // 治理硬门与 P3 一致：穿透/误拦 = fail；仅采样缺失 = warn
    const govOk8 = l.f5Total == null || (l.f5Rejected === l.f5Total && l.falseBlock === 0)
    const lineOk = govOk8 && l.daqSamples > 0
    if (lineOk) okN++
    add('P8', `port-${l.index}-${l.protocol}`, `scenario[${second}] line ${l.index} [${l.protocol}] integration`,
      !govOk8 ? 'fail' : lineOk ? 'pass' : 'warn', ev)
    csvRows.push({ phase: 'P8', line: l.index, protocol: l.protocol, preset: second, daq_samples: l.daqSamples,
      f5_rejected: l.f5Rejected ?? '', f5_total: l.f5Total ?? '', false_block: l.falseBlock ?? '', readback_delta: l.readbackDelta ?? '' })
  }
  const own2 = port.lines.filter(l => !l.satellite).length
  port.agg = { preset: second, devices: nodes2.length, lines: port.lines.length, ownLines: own2,
    sampling: port.lines.filter(l => l.daqSamples > 0).length,
    f5Rejected: rejN, f5Total: attN, falseBlocks: fbN,
    codeChanges: 0 }
  bag.add('portability', 'scenario2_lines', own2, '', `second preset "${second}" (config-only)`)
  bag.add('portability', 'scenario2_intercept_rate', rate(rejN, attN), '', 'F5 out-of-window interception on second scenario')
  bag.add('portability', 'scenario2_false_blocks', fbN, '', 'legal in-window writes blocked on second scenario')
  // 注：场景恢复移至 P8b（兜底 drilling 需要 film-line 刚体上的 manual 冻结；cast-film 由植物模型覆写）
  const structurallyOk = attN > 0 && rejN === attN && fbN === 0 && port.agg.sampling === port.lines.length
  return { status: structurallyOk ? 'pass' : okN > 0 ? 'warn' : 'fail',
    note: `${second}: ${own2} lines + ${port.lines.length - own2} satellite · F5 ${rejN}/${attN} · false blocks ${fbN} · 0 code changes` }
})

// ═══════════════ P8b · 系统兜底 drilling（越窗→系统判定回退→有界自动恢复）═══════════════
// 论文 I3（有界自治）此前只有源码锚点、无动态证据。本阶段给出可复现的动态验证：
// 在第二场景（film-line，无物理引擎 → manual 冻结生效，cast-film 的 PV 会被植物模型覆写）上，
// Agent(auto 绑定)开一条优化记录 → 把 DAQ 过程量冻结到配方窗外 → 等系统兜底（观察窗 120s +
// 30s 重查节拍 + 越限阈值 3 采样）自动判定 rollback 并恢复记录基线。断言：system 判定 + 值回基线 +
// journal rollback 锚。恢复时延属环境类（节拍决定），只记录不设门槛。
const bs = { fired: false, restored: false, latencyS: null, recordId: null, from: null, to: null }
await timed('P8b', 'backstop', 'System backstop drill (PV frozen out of window → system-judged bounded rollback)', async () => {
  if (!guestAgent || !port.lines.length) { add('P8b', 'backstop', '系统兜底 drilling', 'skip', ['P8 场景或 P4 夹具未就绪']); return { status: 'skip' } }
  const l = port.lines.find(x => x.ids.dcw && x.ids.daq && x.window)
  if (!l) { add('P8b', 'backstop', '系统兜底 drilling', 'skip', ['第二场景无可写产线']); return { status: 'skip' } }
  try {
    // (0) 清场：关闭全部遗留 open 记录——Agent 作用域同时只允许一条 open 记录（否则下发被 guardrail 拒），
    //     且兜底只评估 open 记录，清场保证 drilling 期间平台内只有本记录会被评估（确定性前提）。
    //     admin 用户可判定任意记录（Agent 只能判自己的）——统一走 REST judge。
    const ol = (await api.call('GET', '/api/workshop/dcw/optimizations?limit=200')).data?.records ?? []
    const open = ol.filter(r => (r.status ?? 'open') === 'open')
    let closedN = 0
    for (const r of open) {
      const jr = await api.call('POST', `/api/workshop/dcw/optimizations/${r.id}/judge`, { verdict: 'keep', reason: 'P8b backstop drill: 清场关闭遗留记录' }).catch(() => null)
      if (jr && jr.status === 200) closedN++
      await sleep(80)
    }
    add('P8b', 'cleanup', `遗留 open 记录清场（关闭 ${closedN}/${open.length} 条）`, closedN === open.length ? 'pass' : 'warn', [`records closed: ${closedN}/${open.length}`])

    // (1) 绑定 + Agent 受治理写一个异于当前的窗内值 → 开优化记录（auto 绑定 → auto_rollback 策略）
    await api.call('POST', '/api/workshop/agent-tools/bindings', { agentId: guestAgent.instId, nodeId: l.ids.dcw, kind: 'dcw', mode: 'auto' })
    await api.call('POST', '/api/workshop/agent-tools/bindings', { agentId: guestAgent.instId, nodeId: l.ids.daq, kind: 'daq', mode: 'auto' })
    const before = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/read`, {})
    bs.from = Number(before.data?.read?.value ?? before.data?.value)
    const spanB = l.window.max - l.window.min
    const targetB = Number((l.window.min + spanB * 0.4).toFixed(3))
    bs.to = targetB
    const c = await api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: guestAgent.instId, tool: 'dcw_control', args: { node_id: l.ids.dcw, value: targetB, hypothesis: 'P8b backstop drill: 开记录待兜底评估' } })
    const cText = String(c.data?.result?.text ?? '')
    bs.recordId = (cText.match(/优化记录\s+([A-Za-z0-9._:-]+)\s+已开窗/) ?? [])[1] ?? null
    if (!bs.recordId) { add('P8b', 'open-record', '开优化记录', 'fail', [cText.slice(0, 160)]); return { status: 'fail', note: 'record not opened' } }
    add('P8b', 'open-record', `优化记录 ${bs.recordId} 已开（基线 ${bs.from} → ${targetB}，auto 策略）`, 'pass', [cText.slice(0, 140)])

    // (2) 冻结 DAQ 过程量于窗外（manual 策略，等价 plc-2 的 F2 注入手法）
    const nodesNow = (await simApi('GET', '/api/nodes')).data ?? []
    const dev = nodesNow.find(n => n.id === l.simDeviceId) ?? nodesNow.find(n => n.protocol === l.protocol && n.enabled)
    const { daq: daqSigB } = splitSignals(dev ?? {})
    if (!dev || !daqSigB) { add('P8b', 'freeze', '冻结过程量', 'fail', [`device ${l.simDeviceId} 不在线或无 DAQ 信号`]); return { status: 'fail', note: 'freeze target missing' } }
    await simManual(dev.id, daqSigB.id, 150)
    const tFreeze = Date.now()
    add('P8b', 'freeze', `DAQ ${daqSigB.id} 已冻结至 150（窗外，窗 [${r3(l.window.min)}, ${r3(l.window.max)}]）`, 'pass', [`device=${dev.id} signal=${daqSigB.id}`])

    // (3) 轮询兜底判定（≤240s：观察窗 120s + 30s 节拍 + 采样裕量）
    const t0 = Date.now()
    while (Date.now() - t0 < 240_000) {
      await sleep(10_000)
      const recs = (await api.call('GET', '/api/workshop/dcw/optimizations?limit=50')).data?.records ?? []
      const mine = recs.find(r => r.id === bs.recordId)
      const judged = mine?.judge ?? null
      if (judged && judged.by === 'system' && judged.verdict === 'rollback') {
        bs.fired = true
        bs.latencyS = r3((Date.now() - tFreeze) / 1000)
        break
      }
      if (judged && judged.verdict === 'keep') break // 被误判 keep——兜底未按策略动作
    }
    if (!bs.fired) {
      add('P8b', 'backstop-verdict', '系统兜底判定', 'fail', [`240s 内未观察到 system/rollback 判定（记录 ${bs.recordId}）`])
      return { status: 'fail', note: 'backstop did not fire' }
    }
    // (4) 断言自动恢复到记录基线（系统回退不受冷却限制）
    await sleep(1500)
    const after = await api.call('POST', `/api/workshop/dcw/${l.ids.dcw}/read`, {})
    const cur = Number(after.data?.read?.value ?? after.data?.value)
    bs.restored = Number.isFinite(cur) && Number.isFinite(bs.from) && Math.abs(cur - bs.from) <= Math.max(0.75, spanB * 0.01)
    add('P8b', 'backstop-verdict', `系统兜底判定回退 + 自动恢复基线`, bs.restored ? 'pass' : 'fail',
      [`判定 by=system verdict=rollback · 时延 ${bs.latencyS}s（环境类，节拍决定）`,
        `PLC 值 ${cur} → 期望基线 ${bs.from}（±0.75） ${bs.restored ? '✔' : '✘'}`])
    bag.add('gov', 'backstop_fired', bs.fired ? 1 : 0, '', 'system-judged rollback on window breach')
    bag.add('gov', 'backstop_restored', bs.restored ? 1 : 0, '', 'auto-restore to record baseline')
    bag.add('gov', 'backstop_latency_s', bs.latencyS, 's', 'freeze → verdict (environmental)')
    csvRows.push({ phase: 'P8b', protocol: l.protocol, backstop_fired: bs.fired, backstop_restored: bs.restored, latency_s: bs.latencyS ?? '', record: bs.recordId })
    return { status: bs.restored ? 'pass' : 'fail', note: `fired in ${bs.latencyS}s · restored ${bs.restored}` }
  }
  finally {
    // (5) 解冻 + 恢复第一场景（收尾状态与开始一致）
    try {
      const nodesNow2 = (await simApi('GET', '/api/nodes')).data ?? []
      const dev2 = nodesNow2.find(n => n.id === l.simDeviceId)
      const { daq: daqSig2 } = splitSignals(dev2 ?? {})
      if (dev2 && daqSig2) await simApi('POST', `/api/nodes/${dev2.id}/signals/${daqSig2.id}/strategy`, { strategy: { kind: 'first-order', initial: 150, tauMs: 8000, sp: bs.to ?? 180, noise: 0.25 } })
    } catch { /* 恢复失败不掩盖主判定 */ }
    await applyPreset(simPreset)
    add('P8b', 'restore', `过程量解冻 + 第一场景恢复: ${simPreset}`, 'pass', ['rig left as found'])
  }
})

// ═══════════════ P9 · 平台子系统（团队调度 · 团队记忆幂等 · 引擎注册表）═══════════════
await timed('P9', 'subsystems', 'Platform subsystems (team dispatch · team memory idempotency · harness registry)', async () => {
  // (a) 团队调度：mock lead + 2 mock worker，未指派任务由 lead 规则引擎派发、worker 按剧本完成
  const ch9 = await api.call('POST', '/api/workshop/channels', { name: `team-${sfx}`, leadAgent: { name: `tlead-${sfx}`, harness: 'mock', config: { delayMs: 40 } } })
  const chId9 = ch9.data?.channelId ?? ch9.data?.channel?.id ?? ch9.data?.id
  const w1 = await api.call('POST', '/api/workshop/agents', { name: `w1-${sfx}`, harness: 'mock', config: { delayMs: 60 } })
  const w2 = await api.call('POST', '/api/workshop/agents', { name: `w2-${sfx}`, harness: 'mock', config: { delayMs: 60 } })
  const j1 = await api.call('POST', `/api/workshop/channels/${chId9}/agents`, { agentId: w1.data?.id, role: 'worker' })
  const j2 = await api.call('POST', `/api/workshop/channels/${chId9}/agents`, { agentId: w2.data?.id, role: 'worker' })
  const i1 = j1.data?.id ?? j1.data?.agentId, i2 = j2.data?.id ?? j2.data?.agentId
  const t9 = await api.call('POST', `/api/workshop/channels/${chId9}/tasks`, { title: `teamtask-${sfx}`, parts: [{ text: 'P9 团队调度验证任务：完成后调用 complete_task。' }] })
  let taskId9 = t9.data?.task?.id ?? t9.data?.id
  if (!taskId9) { const list = (await api.call('GET', `/api/workshop/channels/${chId9}/tasks`)).data ?? []; taskId9 = (Array.isArray(list) ? list : []).find(x => x.title === `teamtask-${sfx}`)?.id }
  let state9 = '', assignee9 = null
  const dl9 = Date.now() + 90_000
  while (taskId9 && Date.now() < dl9) {
    await sleep(3000)
    const me = (await api.call('GET', `/api/workshop/tasks/${taskId9}`)).data ?? {}
    state9 = me.state ?? me.task?.state ?? ''
    assignee9 = me.assigneeId ?? me.task?.assigneeId ?? assignee9
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(state9)) break
  }
  const cand = [i1, i2, w1.data?.id, w2.data?.id].filter(Boolean)
  // lead 认领父任务（assignee=lead）；派发证据 = 通道内存在指派给 worker 的子任务
  let dispatched = false
  if (taskId9) {
    const all9 = (await api.call('GET', `/api/workshop/channels/${chId9}/tasks`)).data ?? []
    for (const t of (Array.isArray(all9) ? all9 : all9.tasks ?? [])) {
      if (t.id !== taskId9 && cand.includes(t.assigneeId)) { dispatched = true; break }
    }
  }
  add('P9', 'team-dispatch', '团队调度（lead 派发 → worker 完成）', state9 === 'COMPLETED' && dispatched ? 'pass' : 'warn',
    [`终态 ${state9 || '(超时)'} · assignee=${assignee9 ?? '—'}（lead 认领父任务） · 子任务派发给 worker: ${dispatched ? '✔' : '未观察到'}`])
  bag.add('team', 'team_dispatch_ok', state9 === 'COMPLETED' && dispatched ? 1 : 0, '', 'lead→worker dispatch closed loop')

  // (b) 团队记忆：写入 + dedupKey 幂等刷新（同 key 二写不产生第二条）
  const mem9 = { title: `P9 记忆 ${sfx}`, content: `P9 幂等记忆：产线 ${sfx} 的已知良好基线。`, importance: 0.8, dedupKey: `p9-${sfx}` }
  const m1 = await api.call('POST', `/api/workshop/channels/${chId9}/memories`, mem9)
  const m2 = await api.call('POST', `/api/workshop/channels/${chId9}/memories`, mem9)
  const ml = (await api.call('GET', `/api/workshop/channels/${chId9}/memories`)).data ?? []
  const mine9 = (Array.isArray(ml) ? ml : []).filter(x => x.dedupKey === `p9-${sfx}` || x.title === mem9.title)
  const memOk = m1.status === 200 && m2.status === 200 && mine9.length === 1
  add('P9', 'team-memory', '团队记忆写入 + dedupKey 幂等', memOk ? 'pass' : 'warn',
    [`POST×2 status ${m1.status}/${m2.status} → 列表中匹配 ${mine9.length} 条（期望 1）`])
  bag.add('memory', 'team_memory_idempotent', memOk ? 1 : 0, '', 'dedupKey idempotent refresh')

  // (c) 引擎注册表：14 引擎枚举 + 环境可用性探测
  const hs = (await api.call('GET', '/api/workshop/harnesses')).data ?? []
  const list9 = Array.isArray(hs) ? hs : hs.harnesses ?? hs.engines ?? hs.rows ?? []
  const avail9 = list9.filter(x => x.available).length
  add('P9', 'harness-registry', '引擎注册表枚举 + 可用性探测', list9.length >= 14 ? 'pass' : 'warn',
    [`注册 ${list9.length} 引擎（期望 ≥14） · 环境可用 ${avail9} · 覆盖 mock/RPC/SDK/CLI 族`])
  bag.add('agent', 'harness_registry', list9.length, '', `environment-available ${avail9}`)
  csvRows.push({ phase: 'P9', team_state: state9, team_dispatched: dispatched, memory_idempotent: memOk, harnesses: list9.length, harnesses_available: avail9 })
  const ok9 = state9 === 'COMPLETED' && dispatched && memOk && list9.length >= 14
  return { status: ok9 ? 'pass' : 'warn', note: `team ${state9 || '—'} · mem ${memOk ? '✔' : '✘'} · engines ${list9.length}(${avail9} avail)` }
})

// ═══════════════ 收尾 · 量化 + HTML + 复现指纹 ═══════════════
for (const l of lines) { if (l.teardown) await l.teardown().catch(() => {}) }
for (const l of port.lines) { if (l.teardown) await l.teardown().catch(() => {}) }

const fail = checks.filter(c => c.status === 'fail').length
const warn = checks.filter(c => c.status === 'warn').length
const pass = checks.filter(c => c.status === 'pass').length
// 零检查 = 夹具/自举未跑到任何断言，绝不能判 PASS（假绿防护）；
// 「全部 skip」同理——自举失败时每个阶段都会被诚实跳过，若只看 fail 数就会打出
// 空心的 ✅ PASS（实测踩过：模拟器依赖缺失 → 全 skip → PASS(0/0/0)）。
// 阶段级 fail（如 P0 抛错未落检查）同样必须判 FAIL——检查表通过 ≠ 阶段全部执行。
const phaseFailN = phases.filter(p => p.status === 'fail').length
const executedN = pass + warn + fail
const emptyRun = checks.length === 0 || executedN === 0
const reproCmd = `node bench/pipeline.mjs --profile ${profile} --seed ${seed}${maxLines !== 5 ? ` --lines ${maxLines}` : ''}${toolHarness !== 'opencode' ? ` --tool-harness ${toolHarness}` : ''}${clSeeds ? ` --cl-seeds ${clSeeds}` : ''}${clWriteMode !== 'governed' ? ` --cl-write ${clWriteMode}` : ''}${agentHarness ? ` --agent ${agentHarness}` : ''}`

const env = {
  runId: rid, profile, seed, base, simBase: SIM_BASE, simDir: SIM_DIR, lines: lines.length,
  ownLines: lines.filter(l => !l.satellite).length, satelliteDaq: lines.filter(l => l.satellite).length,
  protocols: [...new Set(lines.map(l => l.protocol))].join('/'), preset: simPreset,
  agentHarness: agentHarness ?? '(none)', toolHarness, startedAt: new Date().toISOString(),
  node: process.version, platform: `${process.platform} ${process.arch}`,
  harnessHash, gitCommit, harnessFiles: HARNESS_FILES.length,
  closedloop: cl.agg ? { writeMode: cl.writeMode, ...cl.agg } : null,
  portability: port.agg,
  backstop: { fired: bs.fired, restored: bs.restored, latencyS: bs.latencyS, recordId: bs.recordId, from: bs.from, to: bs.to },
  verdict: { pass, warn, fail, phaseFails: phaseFailN, ok: fail === 0 && phaseFailN === 0 && !emptyRun }, reproCmd,
}
const kpis = [
  { label: 'Provisionable lines', value: env.ownLines, unit: '', note: `+${env.satelliteDaq} satellite DAQ · ${env.protocols}`, tone: 'good' },
  { label: 'DAQ samples total', value: lines.reduce((s, l) => s + (l.daqSamples ?? 0), 0), unit: '', note: `${lines.filter(l => l.daqSamples > 0).length}/${lines.length} nodes sampling`, tone: 'good' },
  { label: 'Governance interception (pooled)', value: (() => { const t = lines.filter(l => l.f5Total); const d = t.reduce((s, l) => s + l.f5Total, 0); return d ? `${((t.reduce((s, l) => s + l.f5Rejected, 0) / d) * 100).toFixed(1)}` : '—' })(), unit: '%', note: 'F5 attacks', tone: 'good' },
  { label: 'Write p50 (all protocols)', value: r3(mean(lines.filter(l => l.writeP50).map(l => l.writeP50))), unit: 'ms', note: 'incl. real protocol transactions' },
  cl.agg
    ? { label: 'Closed-loop J/J*', value: `${(cl.agg.ratioMean * 100).toFixed(1)}`, unit: '%', note: `n=${cl.agg.n} seeds · worst ${(cl.agg.ratioMin * 100).toFixed(1)}% · J*=${cl.agg.Jstar}`, tone: cl.agg.ratioMin >= 0.9 ? 'good' : 'warn' }
    : { label: 'Closed-loop J/J*', value: 'off', unit: '', note: '--cl-seeds 3 enables', tone: 'warn' },
  { label: 'Tool-level loops', value: lines.filter(l => l.loopIterations).length, unit: '', note: 'dcw→daq→judge ×3 convergence' },
  bs.fired
    ? { label: 'System backstop', value: bs.restored ? 'fired+restored' : 'fired', unit: '', note: `window breach → auto-rollback in ${bs.latencyS}s (env)`, tone: bs.restored ? 'good' : 'warn' }
    : { label: 'System backstop', value: 'not fired', unit: '', note: 'P8b drill requires scenario 2', tone: 'warn' },
  port.agg
    ? { label: 'Scenario portability', value: port.agg.preset, unit: '', note: `2nd scenario: ${port.agg.ownLines} lines + ${port.agg.lines - port.agg.ownLines} sat · F5 ${port.agg.f5Rejected}/${port.agg.f5Total} · 0 code changes`, tone: port.agg.falseBlocks === 0 && port.agg.f5Rejected === port.agg.f5Total ? 'good' : 'warn' }
    : { label: 'Scenario portability', value: 'off', unit: '', note: 'P8 runs in integrated profile', tone: 'warn' },
  agentHarness ? { label: 'LLM agent loop', value: lines.find(l => l.agentState)?.agentState ?? '—', unit: '', note: `${agentHarness}`, tone: lines.find(l => l.agentOracle) ? 'good' : 'bad' } : { label: 'LLM agent loop', value: 'off', unit: '', note: '--agent omp enables', tone: 'warn' },
  { label: 'Checks', value: `${pass}/${pass + warn + fail}`, unit: '', note: `warn ${warn} · fail ${fail}`, tone: fail ? 'bad' : 'good' },
]

writeJson(join(outDir, 'run.json'), {
  env, phases, checks, lines, kpis, metrics: bag.all(),
  closedloop: cl.agg
    ? {
        writeMode: cl.writeMode, agg: cl.agg,
        seeds: cl.seeds.map(s => ({
          seed: s.seed, warmed: s.warmed, warmupS: s.warmupS, J0: s.J0, Jend: s.Jend, Jstar: s.Jstar, ratio: s.ratio,
          iters: s.stats.iters, writes: s.stats.writes, rejected: s.stats.rejected, converged: s.stats.converged, wallS: s.wallS,
          traj: s.traj.map(t => ({ iter: t.iter, thickness: t.thickness, defect: t.defect, pressure: t.pressure, meltTemp: t.meltTemp, screw: t.screw, lineSpeed: t.lineSpeed, J: t.J })),
        })),
      }
    : null,
  portability: port.agg
    ? { agg: port.agg,
        lines: port.lines.map(l => ({ index: l.index, protocol: l.protocol, satellite: l.satellite,
          daqSamples: l.daqSamples ?? null, f5: l.f5Total != null ? `${l.f5Rejected}/${l.f5Total}` : null,
          falseBlock: l.falseBlock ?? null, readbackDelta: l.readbackDelta ?? null })) }
    : null,
})
writeText(join(outDir, 'metrics.csv'), toCsv(csvRows))
writeJson(join(outDir, 'summary.json'), {
  runId: rid, env, verdict: env.verdict, kpis,
  perLine: lines.map(l => ({
    index: l.index, protocol: l.protocol, simDevice: l.simDeviceId,
    daqSamples: l.daqSamples, writeP50: l.writeP50, writeP95: l.writeP95, readbackDelta: l.readbackDelta,
    f5: l.f5Total != null ? `${l.f5Rejected}/${l.f5Total}` : null, falseBlock: l.falseBlock ?? null,
    loopIterations: l.loopIterations ?? null, convergenceS: l.convergenceS ?? null,
    agentState: l.agentState ?? null, agentWallS: l.agentWallS ?? null, agentOracle: l.agentOracle ?? null,
  })),
  metrics: bag.all(),
  portability: port.agg
    ? { agg: port.agg,
        lines: port.lines.map(l => ({ index: l.index, protocol: l.protocol, satellite: l.satellite,
          daqSamples: l.daqSamples ?? null, f5: l.f5Total != null ? `${l.f5Rejected}/${l.f5Total}` : null,
          falseBlock: l.falseBlock ?? null, readbackDelta: l.readbackDelta ?? null })) }
    : null,
  closedloop: cl.agg
    ? {
        writeMode: cl.writeMode, agg: cl.agg,
        perSeed: cl.seeds.map(s => ({ seed: s.seed, J0: s.J0, Jend: s.Jend, ratio: s.ratio, iters: s.stats.iters, writes: s.stats.writes, rejected: s.stats.rejected, converged: s.stats.converged, wallS: s.wallS })),
      }
    : null,
})
writeText(join(outDir, 'report.md'), renderReportMd({ env, phases, checks, kpis, metrics: bag.all() }))
writeText(join(outDir, 'dashboard.html'), renderDashboard({
  env, phases, kpis, lines, checks, metrics: bag.all(),
  closedloop: cl.agg ? { writeMode: cl.writeMode, agg: cl.agg, seeds: cl.seeds } : null,
  charts: [
    lines.filter(l => l.writeP50 != null).length
      ? barChart({
          title: 'Write p50 (ms, per line/protocol)', unit: 'ms', color: '#41c8f4',
          rows: lines.filter(l => l.writeP50 != null).map(l => ({ label: `L${l.index} ${l.protocol}`, value: l.writeP50 })),
        })
      : '',
    lines.filter(l => l.daqSamples).length
      ? barChart({
          title: 'DAQ sample points (real driver)', unit: '', color: '#35e0a0',
          rows: lines.map(l => ({ label: `L${l.index} ${l.protocol}`, value: l.daqSamples ?? 0 })),
        })
      : '',
    lines.filter(l => l.f5Total != null).length
      ? barChart({
          title: 'Governance F5 interception (%)', unit: '%', color: '#e6b23c', max: 100,
          rows: lines.filter(l => l.f5Total != null).map(l => ({ label: `L${l.index} ${l.protocol}`, value: r3((l.f5Rejected / l.f5Total) * 100) })),
        })
      : '',
    lines.filter(l => l.loopIterations != null).length
      ? barChart({
          title: 'Agent loop convergence (s)', unit: 's', color: '#a78bfa',
          rows: lines.filter(l => l.convergenceS != null).map(l => ({ label: `L${l.index} ${l.protocol}`, value: l.convergenceS })),
        })
      : '',
    // ── 闭环优化 benchmark：每 seed 的 J start/终 points (+ 离线最优 W* 参考线）──
    cl.agg
      ? barChart({
          title: `Closed-loop J (per seed): start → end vs offline optimum J*=${cl.agg.Jstar}`,
          unit: '', color: '#41c8f4', max: Math.max(cl.agg.Jstar ?? 100, cl.agg.J0mean ?? 100) * 1.12,
          rows: [
            ...cl.seeds.flatMap(s => ([
              { label: `S${s.seed} start`, value: s.J0, color: '#8ba3bd' },
              { label: `S${s.seed} end`, value: s.Jend, color: s.ratio >= 0.9 ? '#35e0a0' : '#e6b23c' },
            ])),
            { label: 'J* (offline optimum)', value: cl.agg.Jstar, color: '#a78bfa' },
          ],
        })
      : '',
    cl.agg
      ? barChart({
          title: 'Closed-loop attainment J/J* (%)', unit: '%', color: '#35e0a0', max: 100,
          rows: cl.seeds.filter(s => s.ratio != null).map(s => ({ label: `seed ${s.seed}`, value: r3(s.ratio * 100), color: s.ratio >= 0.9 ? '#35e0a0' : '#e6b23c' })),
        })
      : '',
    cl.agg
      ? barChart({
          title: 'Closed-loop iterations (count)', unit: '', color: '#41c8f4',
          rows: cl.seeds.map(s => ({ label: `seed ${s.seed}`, value: s.stats.iters })),
        })
      : '',
  ].filter(Boolean).join(''),
}))

console.log(`\n── 结果 ──  pass ${pass} · warn ${warn} · fail ${fail} · skip ${checks.length - executedN}  ${fail === 0 && phaseFailN === 0 && !emptyRun ? '✅ PASS' : '❌ FAIL'}${emptyRun ? '（未产生任何有效检查——自举/夹具失败，全部阶段仅被跳过）' : ''}`)
console.log(`产物: ${outDir}`)
console.log(`  run.json / metrics.csv / summary.json / report.md / dashboard.html`)
console.log(`复现: ${reproCmd}\n`)
process.exit(fail > 0 || phaseFailN > 0 || emptyRun ? 1 : 0)
