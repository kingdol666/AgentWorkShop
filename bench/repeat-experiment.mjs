#!/usr/bin/env node
/**
 * repeat-experiment —— 论文级重复闭环实验驱动器(2026-10-27)
 *
 * 设计:
 *   每场景 × 每 seed,三臂配对(同初始状态+同扰动种子):
 *     B0  开环基线   —— 复位后不写任何设定值,观测 HORIZON 秒(PV 应停在蓝图初始=窗外)
 *     B1  一步式基线 —— 按场景增益做一次校正写(无后续反馈),settle 后判读
 *     T   处理组     —— 确定性闭环 mission(反馈逐轮校正),跑至自然收敛
 *   每臂前 resetArm():SP 复位到蓝图初值 + 物理引擎按 seed 复位(warm)。
 *
 *   主终点:终末 |PV−target|(各场景原生单位;分场景报告,不做跨场景汇总)
 *   次终点:入窗率、入窗时间、写次数、守卫违规、采样覆盖率
 *   纳入/排除:轨迹因基础设施错误(写被拒/采样断流/哨兵失败)即记 excluded 并原样保留数据
 *
 * 用法:
 *   node bench/repeat-experiment.mjs --base http://127.0.0.1:3600 \
 *     --scenarios injection,wwtp,anneal,biax --seeds 42,43 --tag pilot
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCENARIOS, ensureScenarioLine, provisionScenarioLine, setupMissionChannel, MISSIONS } from './lib/scenarios.mjs'
import { ensureGateway } from './lib/provision.mjs'
import { simApi, simNodes } from './lib/sim.mjs'
import { makeApi } from './lib/util.mjs'

const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:3600')
const seeds = (arg('seeds', '42,43')).split(',').map(Number).filter(Number.isFinite)
const scenIds = (arg('scenarios', 'injection,wwtp,anneal,biax')).split(',').map(s => s.trim()).filter(Boolean)
const tag = arg('tag', `exp${Date.now().toString(36).slice(-4)}`)
const OUT = join(process.cwd(), 'bench', 'results', `repeat-${tag}`)
mkdirSync(OUT, { recursive: true })

// 每臂观测时窗(秒):基线臂固定;处理臂由 mission 自然时长决定,但观测器同样跑 HORIZON 作对照序列
const HORIZON = { injection: 60, wwtp: 90, anneal: 60, biax: 90 }

const api = makeApi(base)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const r2 = x => Number(x.toFixed(2))
const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m)

const login = await api.login(process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local', process.env.AW_ADMIN_PASS ?? 'admin123')
if (!login.ok) { console.error('✘ 平台鉴权失败'); process.exit(1) }
if (!await ensureGateway(api)) { console.error('✘ DAQ 采样总控启动失败'); process.exit(1) }
log('平台就绪,采样总控已启动')

const isSp = s => /-sp$|SP$/.test(s.id) || /SP/.test(s.id)
const pvOf = scen => scen.pv.sig

/** 复位一个臂:SP→蓝图初值(manual 语义,与 bench fresh 同路)+ 物理引擎按 seed 热复位 */
async function resetArm(scen, seed) {
  const en = await ensureScenarioLine(scen)
  for (const dev of en.blueprint.nodes) {
    for (const s of dev.signals ?? []) {
      if (!isSp(s)) continue
      const v = Number(s.strategy?.value ?? s.value)
      if (!Number.isFinite(v)) continue
      await simApi('POST', `/api/nodes/${dev.id}/signals/${s.id}/manual`, { value: v })
    }
  }
  const fb = scen.plantWhole
    ? { warm: true, disturbances: { heaterDecay: 1, feedDriftPerMin: 0 } }
    : { id: scen.id, warm: true, disturbances: { heaterDecay: 1, feedDriftPerMin: 0 } }
  if (seed != null) fb.seed = seed
  const rr = await simApi('POST', '/api/plant/reset', fb)
  if (rr.status >= 400) throw new Error(`plant reset 失败: ${rr.status} ${rr.message}`)
  await sleep(2500)
}

/** 采样线程:每 2s 读 PV 节点现值,直到 stop;返回 {series, stop} */
function startPoller(api2, pvNodeId) {
  const series = []
  const t0 = Date.now()
  let stop = false
  ;(async () => {
    while (!stop) {
      try {
        const to = Date.now(), from = to - 6000
        const s = await api2.call('GET', `/api/workshop/daq/${pvNodeId}/samples?bucketMs=1000&from=${from}&to=${to}&limit=8`)
        const pts = s.data?.points ?? []
        const last = pts.length ? Number(pts[pts.length - 1].avg) : null
        if (last != null && Number.isFinite(last)) series.push({ t: Date.now() - t0, pv: last })
      }
      catch { /* 瞬断容忍 */ }
      await sleep(2000)
    }
  })()
  return { series, stop: () => { stop = true } }
}

const firstInWindow = (series, target, tol) => {
  const hit = series.find(p => Math.abs(p.pv - target) <= tol)
  return hit ? hit.t / 1000 : null
}

/** 治理写(与 bench mission 同一入口:agent-tools/invoke recipe_trial) */
async function governedWrite(api2, instId, recipeId, nodeId, value, hypothesis) {
  const c = await api2.call('POST', '/api/workshop/agent-tools/invoke', {
    agentId: instId, tool: 'recipe_trial',
    args: { recipe_id: recipeId, params: [{ node_id: nodeId, value }], hypothesis },
  })
  const text = String(c.data?.result?.text ?? '')
  if (c.data?.result?.isError === true) return { ok: false, reason: text.slice(0, 200) }
  const batchId = (text.match(/批次\s+([A-Za-z0-9-]+)/) ?? [])[1] ?? null
  return { ok: true, batchId, text: text.slice(0, 200) }
}

/** E1 写入生效性矩阵:每 DCW 节点一发治理写,三层验证(批次/平台回读/模拟器信号) */
async function writeEffectivenessMatrix(api2, scen, line, sfx) {
  const rows = []
  await ensureScenarioLine(scen)
  for (const [sigId, nodeId] of Object.entries(line.dcw)) {
    // 模拟器设备定位:优先「场景前缀 + 信号 id」——信号名跨设备会重名(如 zone1-sp 同时
    // 存在于挤出机/退火炉),无前缀的 find 会写错设备(2026-10-27 biax E1 实测)。
    const locate = async () => {
      const all = await simNodes()
      const dev = all.find(n => n.id.startsWith(scen.prefix) && (n.signals ?? []).some(x => x.id === sigId))
        ?? all.find(n => (n.signals ?? []).some(x => x.id === sigId))
      const sig = dev?.signals?.find(x => x.id === sigId)
      return { dev, sig, cur: sig ? (sig.runtime?.value ?? sig.value) : null, min: sig?.min, max: sig?.max }
    }
    const { dev, cur, min, max } = await locate()
    const span = (Number(max) || 100) - (Number(min) || 0)
    const value = r2(Math.max((Number(min) || 0) + span * 0.1, Math.min((Number(max) || 100) - span * 0.1, (Number(cur) || 0) + span * 0.1)))
    const t0 = Date.now()
    const w = await governedWrite(api2, line.ids.instId, line.ids.recipeId, nodeId, value, `E1 写入生效性: ${sigId} → ${value}`)
    // 慢信号(热工一阶)等待稳定:连续两次读数差 ≤ span*0.5% 或 ≤20s
    let simVal = (await locate()).cur
    const stableTol = Math.max(0.05, span * 0.005)
    for (let w2 = 0; w2 < 6; w2++) {
      await sleep(3000)
      const again = (await locate()).cur
      if (Number.isFinite(again) && Math.abs(again - simVal) <= stableTol) { simVal = again; break }
      simVal = again
    }
    const rd = await api2.call('POST', `/api/workshop/dcw/${nodeId}/read`, {})
    const platVal = Number(rd.data?.read?.value ?? rd.data?.value)
    rows.push({
      scenario: scen.id, signal: sigId, node: nodeId, protocol: dev?.protocol ?? '?',
      written: value, batchId: w.batchId, accepted: w.ok,
      platformReadback: Number.isFinite(platVal) ? platVal : null,
      simSignal: Number.isFinite(simVal) ? simVal : null,
      // 落达判定:平台驱动回读(真设备读)或模拟器信号(物理事实源),任一吻合即可;
      // 平台回读 NaN(MQTT 无同步读)不否定 —— 以模拟器信号为准。
      landed: (Number.isFinite(platVal) && Math.abs(platVal - value) <= Math.max(0.05, Math.abs(value) * 0.01))
        || (Number.isFinite(simVal) && Math.abs(simVal - value) <= Math.max(0.05, Math.abs(value) * 0.01)),
      latencyMs: Date.now() - t0,
    })
    log(`  E1 ${scen.id}/${sigId}(${dev?.protocol}): ${w.ok ? '✔' : '✘'} sim=${simVal} 平台=${platVal} 目标=${value}`)
  }
  return rows
}

// ── 主流程 ──
const experiment = { tag, base, seeds, scenarios: scenIds, startedAt: new Date().toISOString(), platform: base, scenariosData: {} }
const sfx = `exp${tag}`

for (const id of scenIds) {
  const scen = SCENARIOS[id]
  if (!scen) { console.error('未知场景', id); continue }
  log(`══ 场景 ${id}(${scen.zh}) ══`)
  const tOn0 = Date.now()
  const en = await ensureScenarioLine(scen)
  const line = await provisionScenarioLine(api, scen, { sfx })
  const cm = await api.call('PATCH', `/api/workshop/dcw/lines/${line.ids.lineId}`, { controlMode: 'auto', confirm: true })
  const ch = await setupMissionChannel(api, scen, { sfx, toolHarness: 'mock', line })
  const onboardingMs = Date.now() - tOn0
  log(`  接入完成 ${onboardingMs}ms line=${line.ids.lineId} dcw=${Object.keys(line.dcw).length} daq=${Object.keys(line.daq).length} controlMode=${cm.status === 200 ? 'auto' : 'FAIL'}`)

  // 采样活性等待(≤60s)
  const pvNodeId = line.daq[pvOf(scen)]
  let sampleOk = false
  for (let w = 0; w < 12 && !sampleOk; w++) {
    const to = Date.now()
    const s = await api.call('GET', `/api/workshop/daq/${pvNodeId}/samples?bucketMs=1000&from=${to - 30000}&to=${to}&limit=5`)
    sampleOk = (s.data?.points ?? []).length > 0
    if (!sampleOk) await sleep(5000)
  }
  if (!sampleOk) { log('  ✘ 采样断流,场景跳过(排除)'); experiment.scenariosData[id] = { excluded: 'sampling-starved' }; continue }

  // E1 写入生效性矩阵(一次/场景;失败即中止整个战役)
  log('  E1 写入生效性矩阵…')
  const e1 = await writeEffectivenessMatrix(api, scen, { ...line, ids: { ...line.ids, instId: ch.instId } })
  const e1Fail = e1.filter(r => !r.landed)
  if (e1Fail.length) {
    log(`  ✘ E1 有 ${e1Fail.length} 项未落达,中止(先保证写入生效)`)
    experiment.scenariosData[id] = { excluded: 'write-effectiveness-failed', e1 }
    writeFileSync(join(OUT, `e1-${id}.json`), JSON.stringify(e1, null, 2))
    continue
  }
  writeFileSync(join(OUT, `e1-${id}.json`), JSON.stringify(e1, null, 2))

  const target = scen.pv.target, tol = scen.pv.tol
  const knob = (scen.knobs ?? [])[0] // B1 一步式用首旋钮(与 mission 主控同源)
  const scenTrajs = []
  for (const seed of seeds) {
    log(`  ── seed=${seed} ──`)
    // B0 开环
    await resetArm(scen, seed)
    const p0 = startPoller(api, pvNodeId)
    await sleep((HORIZON[id] ?? 60) * 1000)
    p0.stop()
    const b0 = { arm: 'B0', seed, series: p0.series, finalErr: p0.series.length ? r2(Math.abs(p0.series[p0.series.length - 1].pv - target)) : null, inWindow: p0.series.some(p => Math.abs(p.pv - target) <= tol), writes: 0 }
    scenTrajs.push(b0)
    log(`    B0 final|err|=${b0.finalErr} inWindow=${b0.inWindow}`)

    // B1 一步式
    await resetArm(scen, seed)
    const w0 = (await api.call('GET', `/api/workshop/daq/${pvNodeId}/samples?bucketMs=1000&from=${Date.now() - 8000}&to=${Date.now()}&limit=5`))
    const pv0Pts = w0.data?.points ?? []
    const pv0 = pv0Pts.length ? Number(pv0Pts[pv0Pts.length - 1].avg) : null
    const p1 = startPoller(api, pvNodeId)
    let b1 = { arm: 'B1', seed, series: p1.series, writes: 0 }
    if (pv0 != null && knob) {
      const nid = line.dcw[knob.sig]
      const rd = await api.call('POST', `/api/workshop/dcw/${nid}/read`, {})
      const cur = Number(rd.data?.read?.value ?? rd.data?.value)
      const next = r2(Math.max(knob.lo ?? 0, Math.min(knob.hi ?? 1e9, cur + (target - pv0) / knob.gain * knob.share)))
      const w = await governedWrite(api, ch.instId, line.ids.recipeId, nid, next, `B1 一步式基线 seed=${seed}: ${knob.sig} → ${next}`)
      b1.writes = w.ok ? 1 : 0
      b1.write = { from: cur, to: next, ok: w.ok, batchId: w.batchId }
    }
    await sleep((HORIZON[id] ?? 60) * 1000)
    p1.stop()
    b1.finalErr = p1.series.length ? r2(Math.abs(p1.series[p1.series.length - 1].pv - target)) : null
    b1.inWindow = p1.series.some(p => Math.abs(p.pv - target) <= tol)
    scenTrajs.push(b1)
    log(`    B1 final|err|=${b1.finalErr} inWindow=${b1.inWindow} writes=${b1.writes}`)

    // T 处理组(确定性闭环 mission)
    await resetArm(scen, seed)
    const pt = startPoller(api, pvNodeId)
    const mStart = Date.now()
    let out
    try { out = await MISSIONS[id](api, scen, { instId: ch.instId, line, sfx: `${sfx}-${seed}` }) }
    catch (e) { out = { errors: [String(e).slice(0, 200)], traj: [], writes: 0, final: null } }
    const wallS = r2((Date.now() - mStart) / 1000)
    await sleep(4000)
    pt.stop()
    const t2w = firstInWindow(pt.series, target, tol)
    const t = {
      arm: 'T', seed, series: pt.series, traj: out.traj ?? [], writes: out.writes ?? 0,
      guards: out.guards ?? {}, ev: (out.ev ?? []).slice(-6),
      finalPv: out.final ?? (pt.series.length ? pt.series[pt.series.length - 1].pv : null),
      finalErr: pt.series.length ? r2(Math.abs(pt.series[pt.series.length - 1].pv - target)) : null,
      inWindow: pt.series.some(p => Math.abs(p.pv - target) <= tol),
      timeToWindowS: t2w, missionWallS: wallS,
      errors: out.errors ?? [],
      excluded: (out.errors ?? []).length > 0,
    }
    scenTrajs.push(t)
    log(`    T final|err|=${t.finalErr} inWindow=${t.inWindow} t2w=${t2w} writes=${t.writes} errors=${t.errors.length}`)
    writeFileSync(join(OUT, `traj-${id}-seed${seed}.json`), JSON.stringify({ scenario: id, seed, b0, b1, t, target, tol, unit: scen.pv.unit, pvSignal: pvOf(scen) }, null, 2))
  }
  experiment.scenariosData[id] = { onboardingMs, e1Rows: e1.length, trajectories: scenTrajs.map(t => ({ arm: t.arm, seed: t.seed, finalErr: t.finalErr, inWindow: t.inWindow, writes: t.writes, excluded: Boolean(t.excluded) })) }
}

writeFileSync(join(OUT, 'experiment.json'), JSON.stringify(experiment, null, 2))
log(`实验数据写入 ${OUT}`)
