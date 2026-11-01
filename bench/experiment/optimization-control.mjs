#!/usr/bin/env node
/**
 * bench/experiment/optimization-control.mjs —— E2 闭环优化控制对照（C0 阴性对照 / C1 脚本策略）
 *
 * 背景（EXPERIMENT-PIPELINE §1 D1、§3 E2）：
 *   论文现有「优化有效」是单次 run 的 J/J*，既无「不写」的阴性对照，也没有统一预算。
 *   本 runner 把两个条件放在同一场景、同一 seed、同一 fresh 起点上跑：
 *
 *   C0 静态保持(不写)：阴性对照。若它也达标，说明场景起点本来就在目标带内，
 *                     那么任何优化结果都不构成证据 —— 整个 E2 作废。
 *   C1 确定性脚本策略：阳性对照。复用 lib/scenarios.mjs 的既有 mission（受治理写 + 物理随动 + 复测）。
 *
 *   C2（确定性工具链）与 C3（Agent goal-loop）不在此 runner：C2 见 pipeline P4，
 *   C3 见 bench/optloop.mjs（无 --seed，每次独立 run，不得与 C1 按 seed 配对）。
 *
 * 用法（B 态平台；与 PIPELINE.md §0 同一隔离环境块）：
 *   node bench/experiment/optimization-control.mjs --condition C0 --seed 42
 *   node bench/experiment/optimization-control.mjs --condition C1 --seed 42
 *   node bench/experiment/optimization-control.mjs --condition C0 --duration 240 --scenarios injection
 *
 * 产物：bench/results/<runId>-optcontrol/{optimization-control.csv,.md,run.json}
 * 退出码：0 = 该条件按预期完成（C0 判「未达标」也是完成）；1 = 环境/执行失败。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeApi, sha256, sleep } from '../lib/util.mjs'
import { ensureSimulator, simApi, simUp, SIM_BASE } from '../lib/sim.mjs'
import { ensurePlatform } from '../lib/platform.mjs'
import { SCENARIOS, SCENARIO_IDS, ensureScenarioLine, provisionScenarioLine, readPvMean, runScenarioBench } from '../lib/scenarios.mjs'
import { ensureGateway } from '../lib/provision.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const has = (k) => args.includes(`--${k}`)

const condition = String(arg('condition', 'C0')).toUpperCase()
if (!['C0', 'C1'].includes(condition)) throw new Error('--condition 只支持 C0（静态保持）或 C1（脚本策略）')
const seed = Number(arg('seed', 42))
const durationS = Math.max(30, Number(arg('duration', 180)))
const base = arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:3001')
const autostart = !has('no-autostart')
const only = (arg('scenarios', '') || process.env.AW_SCENARIOS || '').split(',').map(s => s.trim()).filter(Boolean)
const list = (only.length ? only : SCENARIO_IDS.filter(id => id !== 'biax')).filter(id => SCENARIOS[id])

const rid = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-optcontrol-${condition.toLowerCase()}`
const outDir = resolve(arg('out', join(REPO, 'bench', 'results', rid)))
const gitCommit = await (async () => {
  try {
    const { execSync } = await import('node:child_process')
    return execSync('git rev-parse --short HEAD', { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  }
  catch { return 'unknown' }
})()

const isSp = s => /-sp$/.test(String(s.id))
const r3 = v => (Number.isFinite(v) ? Number(v.toFixed(3)) : null)

function guardOk(g, value) {
  if (value == null || !Number.isFinite(value)) return false
  if (Number.isFinite(g.min) && value < g.min) return false
  if (Number.isFinite(g.max) && value > g.max) return false
  return true
}

async function readGuards(api, scen, line) {
  const out = {}
  for (const g of scen.guards ?? []) {
    const id = line.daq[g.sig]
    out[g.label] = id ? r3(await readPvMean(api, id)) : null
  }
  return out
}

/** 与 runScenario 的 fresh 语义逐字一致：先写回蓝图 SP，再复位引擎（带 seed）。 */
async function freshStart(scen, blueprint, seed) {
  for (const dev of blueprint.nodes ?? []) {
    for (const s of dev.signals ?? []) {
      if (!isSp(s)) continue
      const v = Number(s.strategy?.value ?? s.value)
      if (Number.isFinite(v)) await simApi('POST', `/api/nodes/${dev.id}/signals/${s.id}/manual`, { value: v })
    }
  }
  const body = scen.plantWhole
    ? { warm: true, disturbances: { heaterDecay: 1, feedDriftPerMin: 0 }, seed }
    : { id: scen.id, warm: true, disturbances: { heaterDecay: 1, feedDriftPerMin: 0 }, seed }
  await simApi('POST', '/api/plant/reset', body)
}

/** 等采样通道给出跟动读数（最多 60s）；读不到就记 error，绝不拿旧基线假装闭环。 */
async function waitPv(api, pvId, timeoutMs = 60_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await readPvMean(api, pvId, 5)
    if (v != null) return v
    await sleep(4000)
  }
  return null
}

async function runC0(api, scen) {
  const sfx = `c0${seed.toString(36)}${Date.now().toString(36).slice(-4)}`
  const en = await ensureScenarioLine(scen)
  const line = await provisionScenarioLine(api, scen, { sfx })
  const row = { condition: 'C0', scene: scen.id, seed, attained: false, writes: 0, rounds: 0, pv: null, target: scen.pv.target, tol: scen.pv.tol, guards: {}, errors: [...(line.errors ?? [])] }
  if (!line.ids?.lineId) { row.errors.push('建线/复用失败'); return row }

  await freshStart(scen, en.blueprint, seed)
  const pvId = line.daq[scen.pv.sig] ?? Object.values(line.daq)[0]
  const before = await waitPv(api, pvId)
  row.before = r3(before)
  await sleep(durationS * 1000)
  const after = await readPvMean(api, pvId, 5)
  row.pv = r3(after)
  row.guards = await readGuards(api, scen, line)
  const pvOk = after != null && Math.abs(after - scen.pv.target) <= scen.pv.tol
  const guardsAll = Object.entries(row.guards).every(([label, v]) => {
    const g = (scen.guards ?? []).find(x => x.label === label)
    return g ? guardOk(g, v) : true
  })
  // 阴性对照的判据是「不达标」；达标与否如实记录，由报告判读
  row.attained = pvOk && guardsAll
  row.pvOk = pvOk
  row.guardsOk = guardsAll
  row.wallS = durationS
  return row
}

/**
 * C1 前置清理：上一轮 Agent 写留下的 open 优化记录会触发「Agent 互斥」
 * （`beforeWrite`: open 记录属主 ≠ 本次 actor → 409），而孤儿接管阈值默认 30 分钟。
 * 不清就会表现为「本轮 0 写、未达标」——实测 2026-11-01（同一注入线连跑第三次时）。
 * 清理只做判定收口（keep），不改现场值；fresh reset 随后把 SP 复位到蓝图起点。
 */
async function closeLeftoverRecords(api, scen) {
  const sfx = `pre${seed.toString(36)}${Date.now().toString(36).slice(-4)}`
  const en = await ensureScenarioLine(scen)
  const line = await provisionScenarioLine(api, scen, { sfx })
  if (!line.ids?.lineId) return { lineId: null, closed: 0 }
  const snap = await api.call('GET', '/api/workshop/dcw')
  const nodeIds = new Set((snap.data?.nodes ?? []).filter(n => n.lineId === line.ids.lineId).map(n => n.id))
  const all = await api.call('GET', '/api/workshop/dcw/optimizations')
  const open = (all.data?.records ?? []).filter(r => r.status === 'open' && nodeIds.has(r.nodeId))
  let closed = 0
  for (const rec of open) {
    const j = await api.call('POST', `/api/workshop/dcw/optimizations/${rec.id}/judge`, {
      verdict: 'keep',
      reason: `E2 ${condition} 前置清理：上一轮遗留 open 记录（属主 ${String(rec.agentId ?? '').slice(0, 8)}）在本轮开始前收口，避免 Agent 写互斥导致假性 0 写`,
    })
    if (j.status === 200) closed++
  }
  return { lineId: line.ids.lineId, closed, blueprintDevices: en.verified?.devices ?? null }
}

async function runC1(api) {
  const sfx = `c1${seed.toString(36)}${Date.now().toString(36).slice(-4)}`
  const bench = await runScenarioBench(api, {
    scenarios: list, sfx, toolHarness: 'opencode', fresh: true, seed,
    onLog: (m) => console.log(`  ${m}`),
  })
  return bench.results.map((r) => ({
    condition: 'C1', scene: r.id, seed,
    attained: Boolean(r.mission?.attained),
    writes: r.mission?.writes ?? null,
    rounds: r.mission?.rounds ?? null,
    pv: r3(r.mission?.final),
    target: SCENARIOS[r.id]?.pv?.target ?? null,
    tol: SCENARIOS[r.id]?.pv?.tol ?? null,
    guards: r.mission?.guardsFinal ?? {},
    wallS: bench.wallS,
    errors: r.errors ?? [],
    // 诊断：0 写 + 未达标几乎总是写被拒（互斥/门禁），把 mission 过程行带进 run.json
    suspect: (r.mission?.writes ?? 0) === 0 && !r.mission?.attained ? 'zero-writes' : undefined,
    ev: r.mission?.ev ?? [],
  }))
}

const main = async () => {
  if (autostart) {
    await ensureSimulator({ log: (m) => console.log(`[sim] ${m}`) })
    if (!(await simUp())) throw new Error('PLC 模拟器不可达（检查 SIM_BASE）')
    await ensurePlatform({ base, log: (m) => console.log(`[platform] ${m}`) })
  }
  const api = makeApi(base)
  const login = await api.login('admin@awshop.local', 'admin123')
  if (!login.ok) throw new Error(`平台鉴权失败: ${login.how}`)
  if (!(await ensureGateway(api))) throw new Error('DAQ 采样总控启动失败')

  const rows = []
  if (condition === 'C0') {
    for (const id of list) {
      console.log(`\n=== C0 静态保持 ${id}（${durationS}s，不写）===`)
      const row = await runC0(api, SCENARIOS[id])
      rows.push(row)
      console.log(`  pv=${row.pv} target=${row.target}±${row.tol} attained=${row.attained} guards=${JSON.stringify(row.guards)}`)
    }
  }
  else {
    console.log(`\n=== C1 脚本策略 ${list.join(',')} seed=${seed} ===`)
    const cleanup = []
    for (const id of list) {
      const c = await closeLeftoverRecords(api, SCENARIOS[id])
      cleanup.push({ scene: id, ...c })
      if (c.closed > 0) console.log(`  [${id}] 前置清理：收口 ${c.closed} 条上一轮遗留 open 记录（避免 Agent 写互斥）`)
    }
    const rowsC1 = await runC1(api)
    for (const r of rowsC1) {
      r.cleanup = cleanup.find(c => c.scene === r.scene) ?? null
    }
    rows.push(...rowsC1)
    for (const r of rowsC1) console.log(`  [${r.scene}] attained=${r.attained} writes=${r.writes} rounds=${r.rounds} pv=${r.pv}${r.suspect ? ` ⚠ ${r.suspect}` : ''}`)
  }

  const errors = rows.flatMap(r => (r.errors ?? []).map(e => `${r.scene}: ${e}`))
  const header = 'condition,scene,seed,attained,pv,target,tol,writes,rounds,guards,wallS,errors'
  const csv = [header, ...rows.map(r => [
    r.condition, r.scene, r.seed, r.attained, r.pv ?? '', r.target ?? '', r.tol ?? '',
    r.writes ?? '', r.rounds ?? '', JSON.stringify(r.guards ?? {}).replaceAll(',', ';'), r.wallS ?? '', (r.errors ?? []).join(' | ').replaceAll(',', ';'),
  ].join(','))].join('\n')

  const md = [
    `# E2 优化控制对照 · ${condition}`,
    '',
    `- run: \`${rid}\`（git ${gitCommit}, seed ${seed}, base ${base}, sim ${SIM_BASE}）`,
    `- 场景: ${list.join(', ')}${condition === 'C0' ? ` · 保持 ${durationS}s · 写次数恒 0` : ' · 确定性脚本策略（受治理写）'}`,
    '',
    '| 条件 | 场景 | seed | 达标 | PV | 目标 | 写次数 | 轮次 | 前置清理 | guards |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.condition} | ${r.scene} | ${r.seed} | ${r.attained}${r.suspect ? ' ⚠' : ''} | ${r.pv ?? '—'} | ${r.target ?? '—'}±${r.tol ?? '—'} | ${r.writes ?? '—'} | ${r.rounds ?? '—'} | ${r.cleanup?.closed ?? '—'} | ${JSON.stringify(r.guards ?? {})} |`),
    '',
    '## 判读规则（EXPERIMENT-PIPELINE §3 E2）',
    '',
    '- **C0 必须 0/N 达标**：若 C0 也达标，说明起点已在目标带内，E2 的阳性结果全部作废。',
    '- **C1 必须 ≥4/5 seed 达标**：否则先修场景/策略，不得进入条件比较。',
    '- C0 与 C1 必须同 seed 同 fresh 复位；写预算按 C1 的实际写次数登记，C2/C3 不得超过。',
    errors.length ? `\n**执行错误**：\n${errors.map(e => `- ${e}`).join('\n')}` : '',
    '',
  ].join('\n')

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'optimization-control.csv'), `${csv}\n`)
  writeFileSync(join(outDir, 'optimization-control.md'), md)
  writeFileSync(join(outDir, 'run.json'), JSON.stringify({
    runId: rid, at: new Date().toISOString(), gitCommit, seed, base, simBase: SIM_BASE,
    condition, durationS: condition === 'C0' ? durationS : null, scenarios: list, rows, errors,
    harnessHash: sha256([join(HERE, 'optimization-control.mjs'), join(REPO, 'bench', 'lib', 'scenarios.mjs')]
      .map(f => { try { return readFileSync(f, 'utf8') } catch { return `MISSING:${f}` } }).join('\n%%\n')),
    reproCmd: `node bench/experiment/optimization-control.mjs --condition ${condition} --seed ${seed} --scenarios ${list.join(',')}`,
  }, null, 2))
  console.log(`\n${md}`)
  console.log(`产物: ${outDir}`)
  if (errors.length) process.exitCode = 1
}

main().catch((err) => {
  console.error(`\nFAIL: ${err?.message ?? err}`)
  process.exitCode = 1
})
