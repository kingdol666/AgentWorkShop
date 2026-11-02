#!/usr/bin/env node
/**
 * bench/experiment/scenario-protocol-probes.mjs —— E1 多场景 × 多协议「写准入」探针
 *
 * 背景（EXPERIMENT-PIPELINE §1 D6）：
 *   `bench/scenarios.mjs` 只跑闭环达标，三个场景线**没有任何受治理写探针**，
 *   所以论文的「多场景 × 多协议」只能拿出 2/6 场景的拦截图。
 *
 * 本脚本对每个场景的每条可写 DCW 路由做三类探针，并给出**误拦率的分母**：
 *   legal  ：区间内 3 个值 + 上边界 → 必须全部受理（false_block=0/N）
 *   struct ：<min−5%span、>max+5%span、1e6、−50 → 必须全部拒绝
 *   readback：每次合法写后独立读回，与写入值比对（容差 = writeTolerance）
 *
 * 注意（诚实边界）：
 *   - 这三个场景的配方窗口 == 工程量程（`provisionScenarioLine` 用 sig.min/max 建配方），
 *     所以**软窗类探针在此处退化**，本脚本只报 `structural`；软窗类证据见 cast-film
 *     流水线 P3（每路由 6 条 = 4 结构 + 2 软窗）。
 *   - 必须在 B 态平台（AW_BENCH_MODE=1）执行：否则 60s 写间隔会让 200 次写跑成 3 小时；
 *     B 态下步长限/60s/保持窗被整体豁免——这正是本脚本**只测量程与受理**的原因。
 *   - 探针会改变 SP（场景 mission 自己会 fresh 复位），不要与 mission 并行跑。
 *
 * 用法（与 PIPELINE.md §0 同一隔离环境块）：
 *   node bench/experiment/scenario-protocol-probes.mjs --scenarios injection,wwtp,anneal
 *   node bench/experiment/scenario-protocol-probes.mjs --no-autostart --base http://127.0.0.1:3005
 *   node bench/experiment/scenario-protocol-probes.mjs --max-nodes 3      # 冒烟
 *
 * 退出码：0 = 合法全受理且结构探针全拒绝；1 = 任一违反或环境失败。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeApi, sha256, sleep, writeTolerance } from '../lib/util.mjs'
import { ensureSimulator, simUp, SIM_BASE } from '../lib/sim.mjs'
import { ensurePlatform } from '../lib/platform.mjs'
import { SCENARIOS, SCENARIO_IDS, ensureScenarioLine, provisionScenarioLine } from '../lib/scenarios.mjs'
import { ensureGateway } from '../lib/provision.mjs'
import { ensureBiaxLine, provisionBiaxLine } from '../lib/biax.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const has = (k) => args.includes(`--${k}`)

const seed = Number(arg('seed', 42))
const base = arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:3001')
const autostart = !has('no-autostart')
const maxNodes = Number(arg('max-nodes', 0))
const lineIdArg = arg('line-id', '')
const only = (arg('scenarios', '') || process.env.AW_SCENARIOS || '').split(',').map(s => s.trim()).filter(Boolean)
// fail-closed(2026-11-02):显式请求的场景若不在 SCENARIOS 映射里,必须报错退出。
// 旧实现静默过滤 → 零探针仍打印「PASS」,是典型的假绿(cast-film 实测踩中)。
const unknown = only.filter(id => !SCENARIOS[id])
if (unknown.length) {
  console.error(`✘ 未知场景: ${unknown.join(', ')}(可用: ${SCENARIO_IDS.join(', ')})`)
  process.exit(1)
}
const list = (only.length ? only : SCENARIO_IDS).filter(id => SCENARIOS[id])
if (!list.length) { console.error('✘ 零场景:拒绝执行(空探针不得判 PASS)'); process.exit(1) }

const rid = `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-scenario-probes`
const outDir = resolve(arg('out', join(REPO, 'bench', 'results', rid)))
const gitCommit = await (async () => {
  try {
    const { execSync } = await import('node:child_process')
    return execSync('git rev-parse --short HEAD', { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  }
  catch { return 'unknown' }
})()

const rows = []
const notes = []

const round = (v, decimals) => Number(Number(v).toFixed(Math.max(0, Math.min(6, decimals ?? 2))))

async function writeNode(api, nodeId, value) {
  const t0 = Date.now()
  const r = await api.call('POST', `/api/workshop/dcw/${nodeId}/write`, { value })
  // 200 只代表治理层受理；驱动写失败时回包带 outcome.ok=false（如设备离线）。
  // 误把这种算「受理」会伪造误拦分母（2026-11-01 实测：对着已下线设备探针仍报 24/24）。
  const outcome = r.data?.outcome ?? {}
  const driverOk = outcome.ok !== false
  return { status: r.status, code: r.code ?? '', message: String(r.message || outcome.message || '').slice(0, 180), ms: Date.now() - t0, driverOk }
}

async function readNode(api, nodeId) {
  // 回读可能瞬时失败（OPC UA/MQTT 冷连接、HTTP 端点抖动）：重试 3 次再判空，
  // 否则一次抖动会把「可用」写成「不可用」，回读分母随 run 漂移（2026-11-01 实测 100→99）。
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await api.call('POST', `/api/workshop/dcw/${nodeId}/read`, {})
    const v = Number(r.data?.read?.value ?? r.data?.value)
    if (Number.isFinite(v)) return v
    await sleep(250)
  }
  return null
}

/**
 * 合法值固定为「区间内 3 点 + 上边界」：
 *   - 只在候选之间去重（decimals 舍入可能把两点并成一点），**不按当前值过滤** ——
 *     按当前值过滤会让分母随上一轮写留下的现场而变化（2026-11-01 实测：首跑 95 笔、
 *     重启后 77 笔），分母不可复现就等于没有分母。
 *   - 与当前值相同的写仍返回 200（控制器不产生记录），作为准入探针完全有效。
 */
function planValues(node) {
  const { min, max, decimals } = node
  const span = max - min
  const dec = decimals ?? 2
  const candidates = [0.35, 0.5, 0.65].map(f => round(min + span * f, dec))
  const boundary = round(max, dec)
  const legal = [...new Set([...candidates, boundary])].filter(v => v >= min && v <= max)
  const structural = [...new Set([
    round(min - span * 0.05, dec),
    round(max + span * 0.05, dec),
    1e6,
    -50,
  ])].filter(v => v < min || v > max)
  return { legal, structural, boundary, dec }
}

async function probeLine(api, { sceneId, lineId, blueprintDevices }) {
  // 线级授权:探针走 REST manual 身份(admin),不需要切 auto;保持现场控制模式不变
  const snapshot = await api.call('GET', '/api/workshop/dcw')
  const allNodes = snapshot.data?.nodes ?? []
  const lineNodes = allNodes.filter(n => n.lineId === lineId)
  const writable = lineNodes.filter(n => n.enabled !== false)
  const picked = maxNodes > 0 ? writable.slice(0, maxNodes) : writable

  const sceneRow = { scene: sceneId, lineId, blueprintDevices: blueprintDevices ?? null, nodes: 0, legal: [0, 0], structural: [0, 0], readback: [0, 0] }

  for (const node of picked) {
    const original = Number(node.value ?? node.readValue)
    const { legal, structural, dec } = planValues(node)
    const tol = writeTolerance(node.min, node.max, node.decimals ?? 2)
    sceneRow.nodes++

    let lastAccepted = null
    for (const v of legal) {
      const w = await writeNode(api, node.id, v)
      const accepted = w.status === 200 && w.driverOk
      sceneRow.legal[1]++
      if (accepted) sceneRow.legal[0]++
      let readback = null
      let delta = null
      let withinTol = null
      if (accepted) {
        lastAccepted = v
        readback = await readNode(api, node.id)
        if (readback != null) {
          delta = Number(Math.abs(readback - v).toFixed(4))
          withinTol = delta <= tol
          sceneRow.readback[1]++
          if (withinTol) sceneRow.readback[0]++
        }
      }
      rows.push({
        scene: sceneId, protocol: String(node.driver ?? ''), signal: nodeName(node), nodeId: node.id,
        probeClass: v === round(node.max, dec) ? 'boundary' : 'legal',
        value: v, expect: 'accept', got: accepted ? 'accept' : 'reject',
        status: w.status, code: w.code, ms: w.ms,
        readback, delta, tolerance: tol, withinTolerance: withinTol,
        note: w.driverOk ? w.message : `驱动未成功: ${w.message}`,
      })
      await sleep(60)
    }

    for (const v of structural) {
      const w = await writeNode(api, node.id, v)
      const rejected = w.status >= 400
      sceneRow.structural[1]++
      if (rejected) sceneRow.structural[0]++
      rows.push({
        scene: sceneId, protocol: String(node.driver ?? ''), signal: nodeName(node), nodeId: node.id,
        probeClass: 'structural', value: v, expect: 'reject', got: rejected ? 'reject' : 'ACCEPTED',
        status: w.status, code: w.code, ms: w.ms,
        readback: null, delta: null, tolerance: tol, withinTolerance: null,
        note: w.message,
      })
      await sleep(60)
    }
    // 恢复现场：探针把 SP 写到了上边界，mission 虽会 fresh 复位，但单独跑探针时
    // 现场应保持可用（不留「最后一个探针值=量程上限」这种状态）。
    // 恢复写不计入合法语料分母（probeClass=restore），但照常记录状态。
    if (Number.isFinite(original) && original !== lastAccepted) {
      const r = await writeNode(api, node.id, original)
      rows.push({
        scene: sceneId, protocol: String(node.driver ?? ''), signal: nodeName(node), nodeId: node.id,
        probeClass: 'restore', value: original, expect: 'accept', got: r.status === 200 ? 'accept' : 'reject',
        status: r.status, code: r.code, ms: r.ms, readback: null, delta: null, tolerance: tol, withinTolerance: null,
        note: r.message,
      })
      await sleep(60)
    }
    if (lastAccepted != null) sceneRow.lastLegalValue = lastAccepted
  }
  return sceneRow
}

const nodeName = (n) => String(n.name ?? '').split(':').pop() ?? ''

async function probeScene(api, scen) {
  const sfx = `pr${seed.toString(36)}${Date.now().toString(36).slice(-4)}`
  const en = await ensureScenarioLine(scen)
  const line = await provisionScenarioLine(api, scen, { sfx })
  if (!line.ids?.lineId) throw new Error(`[${scen.id}] 建线/复用失败: ${(line.errors ?? []).join('; ') || 'no line id'}`)
  return probeLine(api, { sceneId: scen.id, lineId: line.ids.lineId, blueprintDevices: en.verified?.devices })
}

/** 双拉线：30 个可写 SP、5 类协议（9 设备）—— 用独立 provisioning 入口。 */
async function probeBiax(api) {
  const sfx = `pb${seed.toString(36)}${Date.now().toString(36).slice(-4)}`
  const en = await ensureBiaxLine()
  const line = await provisionBiaxLine(api, { sfx })
  if (!line.ids?.lineId) throw new Error(`[biax] 建线/复用失败: ${(line.errors ?? []).join('; ') || 'no line id'}`)
  return probeLine(api, { sceneId: 'biax', lineId: line.ids.lineId, blueprintDevices: en.verified?.devices })
}

const main = async () => {
  const simOk = autostart ? await ensureSimulator({ log: (m) => console.log(`[sim] ${m}`) }) : { started: false, reason: 'no-autostart' }
  if (autostart && !(await simUp())) throw new Error('PLC 模拟器不可达（检查 SIM_BASE）')
  const plat = autostart ? await ensurePlatform({ base, log: (m) => console.log(`[platform] ${m}`) }) : { started: false, reason: 'no-autostart' }
  const api = makeApi(base)
  const login = await api.login('admin@awshop.local', 'admin123')
  if (!login.ok) throw new Error(`平台鉴权失败: ${login.how}`)
  const gw = await ensureGateway(api)
  if (!gw) throw new Error('DAQ 采样总控启动失败')

  const sceneRows = []
  if (lineIdArg) {
    const snap = await api.call('GET', '/api/workshop/dcw')
    const ln = (snap.data?.lines ?? []).find(l => l.id === lineIdArg)
    const label = arg('scene-label', ln?.name ?? lineIdArg)
    console.log(`
=== 既有产线 ${label} (${lineIdArg}) ===`)
    const r = await probeLine(api, { sceneId: label, lineId: lineIdArg, blueprintDevices: null })
    sceneRows.push(r)
    console.log(`  nodes=${r.nodes} legal=${r.legal[0]}/${r.legal[1]} structural=${r.structural[0]}/${r.structural[1]} readback=${r.readback[0]}/${r.readback[1]}`)
  }
  for (const id of lineIdArg ? [] : list) {
    const scen = SCENARIOS[id]
    console.log(`\n=== ${id} ${scen.zh} ===`)
    const r = scen.id === 'biax' ? await probeBiax(api) : await probeScene(api, scen)
    sceneRows.push(r)
    console.log(`  nodes=${r.nodes} legal=${r.legal[0]}/${r.legal[1]} structural=${r.structural[0]}/${r.structural[1]} readback=${r.readback[0]}/${r.readback[1]}`)
  }

  const totals = sceneRows.reduce((a, r) => ({
    legal: [a.legal[0] + r.legal[0], a.legal[1] + r.legal[1]],
    structural: [a.structural[0] + r.structural[0], a.structural[1] + r.structural[1]],
    readback: [a.readback[0] + r.readback[0], a.readback[1] + r.readback[1]],
  }), { legal: [0, 0], structural: [0, 0], readback: [0, 0] })

  // fail-closed:零探针/零分母不得判 PASS(旧实现空场景也打印 PASS,实测假绿)。
  if (rows.length === 0 || totals.legal[1] === 0) {
    throw new Error(`零探针分母: scenes=${list.join(',')} rows=${rows.length} legalDen=${totals.legal[1]} —— 拒绝空跑 PASS`)
  }
  const pass = totals.legal[0] === totals.legal[1] && totals.structural[0] === totals.structural[1] && totals.readback[0] === totals.readback[1]
  const header = 'scene,protocol,signal,nodeId,probeClass,value,expect,got,status,code,ms,readback,delta,tolerance,withinTolerance,note'
  const csv = [header, ...rows.map(r => [
    r.scene, r.protocol, r.signal, r.nodeId, r.probeClass, r.value, r.expect, r.got, r.status, r.code, r.ms,
    r.readback ?? '', r.delta ?? '', r.tolerance ?? '', r.withinTolerance ?? '', String(r.note ?? '').replaceAll(',', ';'),
  ].join(','))].join('\n')

  const md = [
    '# E1 场景 × 协议写准入探针',
    '',
    `- run: \`${rid}\`（git ${gitCommit}, seed ${seed}, base ${base}, sim ${SIM_BASE}）`,
    `- 场景: ${list.join(', ')}`,
    `- 模拟器: ${simOk.reason ?? (simOk.started ? 'started' : 'up')} · 平台: ${plat.reason ?? (plat.started ? 'started' : 'up')}`,
    '',
    '| 场景 | 节点 | 合法受理 | 结构探针拒绝 | 回读一致 |',
    '|---|---|---|---|---|',
    ...sceneRows.map(r => `| ${r.scene} | ${r.nodes} | ${r.legal[0]}/${r.legal[1]} | ${r.structural[0]}/${r.structural[1]} | ${r.readback[0]}/${r.readback[1]} |`),
    `| **合计** | | **${totals.legal[0]}/${totals.legal[1]}** | **${totals.structural[0]}/${totals.structural[1]}** | **${totals.readback[0]}/${totals.readback[1]}** |`,
    '',
    '## 口径（论文脚注）',
    '',
    '1. `legal` 列即**误拦率分母**：每节点固定 3 个区间内值 + 1 个上边界（共 4 笔），全部受理才记 `false_block=0/N`；`restore` 行是收尾复位，不计入分母。',
    '2. 三个场景的配方窗口等于工程量程 → **软窗探针在此退化**，本表只有结构类；',
    '   软窗类证据在 cast-film 流水线 P3（每路由 4 结构 + 2 软窗）。',
    '3. B 态平台全局豁免步长限/60s 间隔/保持窗，因此本表**不**证明这三层；它们是 E4 的 P 态臂。',
    '4. 探针会改写 SP（mission 自己 fresh 复位），未被写到的节点保持原值。',
    '',
    pass ? '**判定：PASS** — 合法全受理、结构全拒绝、回读全一致。' : '**判定：FAIL** — 见 CSV 中 `got=ACCEPTED`（穿透）或 `withinTolerance=false`（回读不符）的行。',
    '',
  ].join('\n')

  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'scenario-protocol-probes.csv'), `${csv}\n`)
  writeFileSync(join(outDir, 'scenario-protocol-probes.md'), md)
  writeFileSync(join(outDir, 'run.json'), JSON.stringify({
    runId: rid, at: new Date().toISOString(), gitCommit, seed, base, simBase: SIM_BASE,
    scenarios: list, scenes: sceneRows, totals, pass,
    harnessHash: sha256([join(HERE, 'scenario-protocol-probes.mjs'), join(REPO, 'bench', 'lib', 'scenarios.mjs')]
      .map(f => { try { return readFileSync(f, 'utf8') } catch { return `MISSING:${f}` } }).join('\n%%\n')),
    reproCmd: `node bench/experiment/scenario-protocol-probes.mjs --scenarios ${list.join(',')} --seed ${seed}`,
  }, null, 2))
  console.log(`\n${md}`)
  console.log(`产物: ${outDir}`)
  if (!pass) process.exitCode = 1
}

main().catch((err) => {
  console.error(`\nFAIL: ${err?.message ?? err}`)
  process.exitCode = 1
})
