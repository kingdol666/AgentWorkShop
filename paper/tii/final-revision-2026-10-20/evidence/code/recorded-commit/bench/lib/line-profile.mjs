/**
 * line-profile —— 模拟产线画像 + AgentTeam 闭环调优过程的采集与报告章节渲染。
 *
 * 目的:benchmark 报告此前只回答「测过了什么、过没过」,不回答「模拟的到底是什么产线、
 * PLC 都是什么协议什么节点、有哪些可调控参数、AgentTeam 是怎么连接并在线调优的」。
 * 本模块把这两块结构化采集并渲染成报告章节,供论文 exp 章节与第三方复现者直接引用。
 *
 * 数据源(全部运行时真实拉取,非静态文案):
 *   - 模拟器 GET /api/nodes            —— 设备/协议/信号清单(名称/单位/量程/精度/策略/物理绑定)
 *   - 模拟器 GET /api/plant/state      —— plant-model 物理引擎状态(相位/种子)
 *   - 平台   GET /api/workshop/dcw|daq —— AW 侧产线/节点映射(模板/驱动/量程/所属产线)
 */

import { simNodes } from './sim.mjs'

/** 每个预设的场景叙事(与 plc-node-simulator/src/server/presets.ts 的预设语义一一对应) */
const SCENARIOS = {
  'film-line': {
    name: 'Film-line five-protocol matrix (coating oven line)',
    process: 'A coating-oven film line instrumented with exactly one PLC per field protocol: '
      + 'a Modbus-TCP "Coating Oven PLC" (temp-pv first-order plant, temp-sp manual register), a Modbus-RTU '
      + 'gel-counter slave, an OPC-UA furnace node, an MQTT thickness gauge and an HTTP push device. '
      + 'Used to prove that every fieldbus dialect drives the same governance semantics.',
    physics: 'Signal strategies only (first-order lag / sine / random-walk / manual); no cross-signal plant model.',
  },
  'cast-film-physics': {
    name: 'Cast-film extrusion digital twin (plant-model physics engine)',
    process: 'An extrusion cast-film line: resin → screw melting → die → casting → thickness gauge. '
      + 'Six writable setpoints (3 zone temperatures, screw speed, line speed, die gap) act on a physics engine '
      + 'whose observable process quantities are melt temperature, melt pressure, film thickness, defect rate and gels count.',
    physics: 'Deterministic plant model (seeded): first-order thermal lag on melt temperature, algebraic thickness '
      + 'h ∝ N/v from mass conservation, pressure/defect couplings — scored by J = 55·J_thick + 25·J_quality + 8·J_energy + 7·J_throughput.',
  },
  'biax-line': {
    name: 'Biax (BOPET) full line — dryer → extruder → pump → casting → MDO → TDO → gauge → inspector → winder',
    process: 'A biaxially-oriented PET (BOPET) line across nine PLCs: dryer, extruder, metering pump, casting roll, '
      + 'MDO (machine-direction orientation), TDO (transverse-direction orientation), thickness gauge, inspector and winder. '
      + 'Thirty setpoints and nineteen process quantities span all five field protocols; the closed-loop mission drives '
      + 'film thickness to a target window through governed multi-node writes.',
    physics: 'Biax plant engine (kind=biax) with thickness as the controlled process quantity and per-device signal strategies.',
  },
}

/** 从驱动配置生成一行的「端点」描述(协议方言各不相同) */
function describeEndpoint(protocol, cfg) {
  if (!cfg) return '—'
  try {
    switch (protocol) {
      case 'modbus-tcp':
      case 'modbus-rtu':
        return `${cfg.host ?? '127.0.0.1'}:${cfg.port}${cfg.unitId ? ` unit=${cfg.unitId}` : ''}${cfg.register ? ` @${cfg.register}` : ''}`
      case 'opcua':
        return cfg.endpoint ?? `opc.tcp://${cfg.host ?? '127.0.0.1'}:${cfg.port ?? 4840}`
      case 'mqtt':
        return `${cfg.brokerUrl ?? cfg.broker ?? (cfg.host ? `${cfg.host}:${cfg.port ?? 1883}` : 'broker')}${cfg.topic ? ` topic=${cfg.topic}` : ''}`
      case 'http':
        return cfg.url ?? cfg.endpoint ?? 'http endpoint'
      default:
        return JSON.stringify(cfg).slice(0, 60)
    }
  }
  catch {
    return '—'
  }
}

const isSp = sig => /-sp$/i.test(sig.id ?? '') || /(^|\s)SP/i.test(sig.name ?? '')
const strat = sig => sig.strategy?.kind ?? (sig.plantBinding ? 'plant-bound' : '—')

/** 采集产线画像(全部运行时真实拉取;任何失败都降级为字段缺省,不让报告挂掉) */
export async function collectLineProfile({ preset, api }) {
  const simNodeList = (await simNodes().catch(() => [])) ?? []
  const devices = simNodeList.filter(n => n.enabled !== false).map(n => ({
    id: n.id,
    name: n.name,
    protocol: n.protocol,
    endpoint: describeEndpoint(n.protocol, n.config ?? n.driverConfig),
    signals: (n.signals ?? []).map(sg => ({
      id: sg.id, name: sg.name, unit: sg.unit ?? '', min: sg.min, max: sg.max,
      decimals: sg.decimals ?? 2, strategy: strat(sg), plantBinding: sg.plantBinding ?? null,
      kind: isSp(sg) ? 'SP (writable setpoint)' : 'PV (process quantity)',
    })),
  }))

  let plant = null
  try {
    const st = await (await import('./sim.mjs')).plantState()
    if (st) plant = { phase: st.phase ?? null, seed: st.seed ?? null, kind: st.kind ?? st.engine ?? 'plant-model' }
  }
  catch { /* 非物理引擎预设没有 plant state */ }

  const dcwLines = []
  const dcwNodes = []
  const daqNodes = []
  try {
    const d = await api.call('GET', '/api/workshop/dcw')
    dcwLines.push(...(d.data?.lines ?? []))
    dcwNodes.push(...(d.data?.nodes ?? []))
    const q = await api.call('GET', '/api/workshop/daq')
    daqNodes.push(...(q.data?.nodes ?? []))
  }
  catch { /* 平台不可达时报告仍渲染模拟器侧 */ }

  const protocols = [...new Set(devices.map(d => d.protocol))]
  const spTotal = devices.reduce((a, d) => a + d.signals.filter(x => x.kind.startsWith('SP')).length, 0)
  const pvTotal = devices.reduce((a, d) => a + d.signals.filter(x => x.kind.startsWith('PV')).length, 0)

  return {
    preset,
    scenario: SCENARIOS[preset] ?? { name: preset, process: '(preset narrative not catalogued)', physics: '—' },
    plant,
    totals: {
      devices: devices.length, protocols: protocols.length, protocolsList: protocols.join(', '),
      spSignals: spTotal, pvSignals: pvTotal,
      awDcwNodes: dcwNodes.length, awDaqNodes: daqNodes.length, awLines: dcwLines.length,
    },
    devices,
    aw: {
      lines: dcwLines.map(l => ({ id: l.id, name: l.name, state: l.state ?? null })),
      dcw: dcwNodes.map(n => ({ id: n.id, name: n.name, driver: n.driver, lineId: n.lineId, unit: n.unit, min: n.min, max: n.max, templateRef: n.templateRef ?? null })),
      daq: daqNodes.map(n => ({ id: n.id, name: n.name, driver: n.driver, lineId: n.lineId, unit: n.unit, min: n.min, max: n.max, templateRef: n.templateRef ?? null })),
    },
  }
}

/** 产线画像章节 */
export function renderLineProfileMd(p) {
  if (!p) return []
  const L = []
  L.push('## Simulated production line profile')
  L.push('')
  L.push(`> Preset \`${p.preset}\` — ${p.scenario.name}. ${p.scenario.process}`)
  L.push('')
  L.push(`**Physics.** ${p.scenario.physics}`)
  if (p.plant) L.push(` Plant engine state at report time: phase=\`${p.plant.phase ?? '—'}\`, seed=\`${p.plant.seed ?? '—'}\`.`)
  L.push('')
  L.push(`**Totals.** ${p.totals.devices} PLC devices across ${p.totals.protocols} protocols (${p.totals.protocolsList}); `
    + `**${p.totals.spSignals} writable setpoints (SP → DCW nodes)** and **${p.totals.pvSignals} process quantities (PV → DAQ nodes)**; `
    + `the platform side provisions ${p.totals.awLines} lines with ${p.totals.awDcwNodes} write nodes and ${p.totals.awDaqNodes} acquisition nodes.`)
  L.push('')
  L.push('### Devices & fieldbus endpoints')
  L.push('')
  L.push('| # | Device | Protocol | Endpoint | Signals (SP+PV) |')
  L.push('|---:|---|---|---|---:|')
  p.devices.forEach((d, i) => {
    L.push(`| ${i + 1} | ${d.name} | \`${d.protocol}\` | \`${d.endpoint}\` | ${d.signals.length} |`)
  })
  L.push('')
  L.push('### Signal inventory (writable setpoints first, then process quantities)')
  L.push('')
  L.push('| Device | Signal | Kind | Unit | Range | Decimals | Strategy |')
  L.push('|---|---|---|---|---|---:|---|')
  for (const d of p.devices) {
    const ordered = [...d.signals.filter(x => x.kind.startsWith('SP')), ...d.signals.filter(x => x.kind.startsWith('PV'))]
    for (const sg of ordered) {
      L.push(`| ${d.name} | ${sg.name} (\`${sg.id}\`) | ${sg.kind} | ${sg.unit || '—'} | [${sg.min}, ${sg.max}] | ${sg.decimals} | \`${sg.strategy}\`${sg.plantBinding ? ` → plant \`${sg.plantBinding}\`` : ''} |`)
    }
  }
  L.push('')
  if (p.aw?.dcw?.length || p.aw?.daq?.length) {
    L.push('### Platform-side node mapping (AW write-control / acquisition nodes)')
    L.push('')
    L.push('| Node | Kind | Driver | Line | Unit | Range |')
    L.push('|---|---|---|---|---|---|')
    for (const n of p.aw.dcw.slice(0, 40)) {
      L.push(`| ${n.name} (\`${n.id.slice(0, 10)}\`) | DCW write | \`${n.driver}\` | ${(p.aw.lines.find(l => l.id === n.lineId)?.name ?? n.lineId ?? '—').toString().slice(0, 24)} | ${n.unit ?? '—'} | [${n.min ?? '—'}, ${n.max ?? '—'}] |`)
    }
    for (const n of p.aw.daq.slice(0, 24)) {
      L.push(`| ${n.name} (\`${n.id.slice(0, 10)}\`) | DAQ acquire | \`${n.driver}\` | ${(p.aw.lines.find(l => l.id === n.lineId)?.name ?? n.lineId ?? '—').toString().slice(0, 24)} | ${n.unit ?? '—'} | [${n.min ?? '—'}, ${n.max ?? '—'}] |`)
    }
    const dcwShown = Math.min(p.aw.dcw.length, 40)
    const daqShown = Math.min(p.aw.daq.length, 24)
    if (p.aw.dcw.length > dcwShown || p.aw.daq.length > daqShown) {
      L.push('')
      L.push(`_(showing first ${dcwShown} DCW / ${daqShown} DAQ nodes; full inventory in \`line-profile.json\`)_`)
    }
    L.push('')
  }
  return L
}

/** AgentTeam 闭环调优过程章节(组队→绑定→目标→逐轮监控→收口) */
export function renderAgentTeamMd({ biax, cl }) {
  const L = []
  L.push('## AgentTeam closed-loop tuning walkthrough')
  L.push('')
  L.push('How an optimization team is assembled and drives the line, end to end: '
    + '(1) a mission channel is created with a **lead** (dispatcher) and **worker** agents; '
    + '(2) every industrial node is **bound** to the worker via agent-tool bindings — `my_industrial_nodes` then '
    + 'returns the semantic card of each bound node (physical quantity, unit, safe range, active recipe window); '
    + '(3) the optimization goal is posted to the task board as a parent task and dispatched by the lead; '
    + '(4) tuning runs as observe → analyze → **governed write** (`dcw_control`, recipe-window interlocked, every write '
    + 'opens an optimization record) → re-observe → judge (`dcw_judge` keep/rollback) cycles until the target window is met; '
    + '(5) the closing artifact set is the parameter journal (agent-attributed), optimization records and a versioned recipe update.')
  L.push('')
  let any = false

  // biax mission trace
  const bt = biax?.traj ?? []
  if (bt.length) {
    any = true
    L.push('### Biax (BOPET) multi-node mission — iteration trace')
    L.push('')
    L.push('| Iter | Knob | Node | From → To | Thickness μm | Note |')
    L.push('|---|---|---|---|---:|---|')
    for (const t of bt) {
      const move = (t.from != null || t.to != null) ? `${t.from ?? '—'} → ${t.to ?? '—'}` : '—'
      L.push(`| ${t.iter} | ${t.knob ?? '—'} | \`${String(t.node ?? '—').slice(0, 12)}\` | ${move} | ${t.thickness != null ? Number(t.thickness).toFixed(2) : '—'} | ${t.note ?? ''} |`)
    }
    L.push('')
    if (biax?.writes != null) {
      L.push(`Governed writes: **${biax.writes}** on ${biax.distinctKnobs ?? '—'} distinct knob(s) · optimization records: ${biax.records ?? 0} · `
        + `target window 25 ± 0.7 μm · final thickness reading **${bt.at(-1)?.thickness != null ? Number(bt.at(-1).thickness).toFixed(2) : '—'} μm** · target attained: **${biax.attained ? 'yes' : 'no'}**.`)
      L.push('')
    }
  }

  // closed-loop per-seed iteration traces
  for (const seed of cl?.seeds ?? []) {
    const traj = seed.traj ?? []
    if (!traj.length) continue
    any = true
    L.push(`### Deterministic closed-loop benchmark — seed ${seed.seed} iteration trace`)
    L.push('')
    L.push('| Iter | h μm | defect % | P MPa | T ℃ | N rpm | v m/min | zone ℃ | J | wall s |')
    L.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (const t of traj) {
      const f = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d))
      L.push(`| ${t.iter} | ${f(t.thickness)} | ${f(t.defect, 3)} | ${f(t.pressure)} | ${f(t.meltTemp, 1)} | ${f(t.screw, 0)} | ${f(t.lineSpeed, 1)} | ${f(t.zone, 1)} | ${f(t.J)} | ${t.wallS ?? '—'} |`)
    }
    L.push('')
    L.push(`Convergence: thickness → 50 ± 2 μm with defect < 2 % and P ≤ 22 MPa; final J / offline optimum J* = **${seed.ratio != null ? (seed.ratio * 100).toFixed(1) : '—'} %**; `
      + `governed writes ${seed.stats?.writes ?? '—'} (rejected ${seed.stats?.rejected ?? 0}), optimization records ${seed.stats?.records ?? 0}.`)
    L.push('')
  }
  if (!any) {
    L.push('_(no AgentTeam trajectory recorded in this run — missions skipped)_')
    L.push('')
  }
  return L
}
