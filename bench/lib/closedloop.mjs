/**
 * bench/lib/closedloop.mjs —— 闭环优化参数 benchmark（cast-film 数字孪生）。
 *
 * 目标：在**真实协议链路 + 治理管线**下，测量"从偏离工况出发、由闭环控制器把工艺参数
 * 拉回最优"的能力，并按与模拟器**逐字一致**的目标函数 J 与离线网格最优 W* 对照。
 *
 * 与 scripts/experiment-castfilm-closedloop.mjs（单次 LLM 案例）的分工：
 *   - 本模块是**可复现的多 seed benchmark**：确定性策略 + 固定 seed + 每 seed 独立
 *     夹具，产出逐迭代轨迹与聚合指标（J/J*、迭代数、写次数、拒绝数、回退数）。
 *   - 该案例是 LLM Agent 的端到端存在性证明（单 seed）。
 *
 * 目标函数（与 plc-node-simulator/src/server/engine/plant-model.ts 的 scoreWindow 完全一致）：
 *   J = 55·J_thick + 25·J_quality + 8·J_energy + 7·J_throughput
 *   s.t. meltTemp ∈ [195,225]℃, pressure ≤ 22MPa
 */
import { sleep } from './util.mjs'
import { simExport, plantOptimum, plantPhase, plantState } from './sim.mjs'
import { mean, r3 } from './metrics.mjs'

/* ── cast-film 孪生的执行器 / 传感器清单（与模拟器 plantModel.controls/outputs 对齐）── */
export const CASTFILM_ACTUATORS = ['zone1-sp', 'zone2-sp', 'zone3-sp', 'screw-sp', 'linespeed-sp', 'diegap-sp']
export const CASTFILM_SENSORS = ['melt-temp', 'melt-pressure', 'film-thickness', 'defect-rate', 'gels-count']
/** 起始（偏离最优）工况：与 cast-film 案例一致 */
export const START_POINT = { zone: 200, screw: 150, lineSpeed: 95, dieGap: 1.0 }
/** 物理量程（= 配方窗口上下限；软联锁在批次期间按此校验） */
export const RANGE = {
  zone: { min: 195, max: 225 },
  screw: { min: 50, max: 200 },
  lineSpeed: { min: 20, max: 120 },
  dieGap: { min: 0.5, max: 2.0 },
}

/** 与模拟器 scoreWindow 逐字一致；约束外返回 null（不可评） */
export function scoreJ({ thickness, defect, meltTemp, pressure, screw, lineSpeed }) {
  if (meltTemp < 195 || meltTemp > 225 || pressure > 22) return null
  const thErr = Math.abs(thickness - 50)
  const jTh = thErr <= 2 ? 1 : Math.max(0, 1 - (thErr - 2) / 10)
  const jQuality = 1 - Math.min(defect, 8) / 8
  const jEnergy = 1 - (screw - 50) / 150
  const jThrough = lineSpeed / 120
  return 55 * jTh + 25 * jQuality + 8 * jEnergy + 7 * jThrough
}

/** 拉取离线最优 W*（真值基准） */
export async function offlineOptimum() {
  const o = await plantOptimum()
  return o && Number.isFinite(Number(o.score)) ? o : null
}

/**
 * 在一条产线上建立 cast-film 的全部执行器(DCW)与传感器(DAQ)节点。
 * 驱动配置全部取自模拟器 /export（含 mqtt 命令主题与 http 可写端点）。
 */
export async function provisionTwinLine(api, { simDevices, sfx }) {
  const ev = []
  const line = await api.call('POST', '/api/workshop/dcw/lines', { name: `CastFilm线 ${sfx}` })
  const lineId = line.data?.line?.id
  if (!lineId) return { ok: false, ev: ['line creation failed'], errors: [line.message] }
  const product = await api.call('POST', '/api/workshop/dcw/products', { lineId, name: `CastFilm产品 ${sfx}` })
  const productId = product.data?.product?.id

  const dcw = {}, daq = {}, meta = {}
  for (const dev of simDevices) {
    const exp = await simExport(dev.id)
    const items = exp?.items ?? []
    const sigOf = id => (dev.signals ?? []).find(s => s.id === id)
    const nameOf = id => sigOf(id)?.name

    for (const id of CASTFILM_ACTUATORS) {
      const sig = sigOf(id)
      if (!sig) continue
      const item = items.find(i => i.signal === nameOf(id))
      if (!item?.driverConfig) { ev.push(`✘ 执行器 ${id}(${dev.protocol}) 无导出配置`); continue }
      const r = await api.call('POST', '/api/workshop/dcw', {
        name: `${sig.name} ${sfx}`, templateRef: 'dcw-temp-sp', driver: dev.protocol, driverConfig: item.driverConfig,
        unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, holdIntervalMs: 0,
        semantics: `cast-film 执行器 ${sig.name}（${sig.unit}），真实 ${dev.protocol} 链路`,
      })
      if (r.data?.node?.id) { dcw[id] = r.data.node.id; meta[id] = { unit: sig.unit, min: sig.min, max: sig.max } }
      else ev.push(`✘ 建 DCW ${id} 失败: ${r.message}`)
    }
    for (const id of CASTFILM_SENSORS) {
      const sig = sigOf(id)
      if (!sig) continue
      const item = items.find(i => i.signal === nameOf(id))
      if (!item?.driverConfig) continue
      const r = await api.call('POST', '/api/workshop/daq', {
        name: `${sig.name} ${sfx}`, templateRef: 'daq-temp-tc', driver: dev.protocol, driverConfig: item.driverConfig,
        unit: sig.unit, min: sig.min, max: sig.max, lineId, intervalMs: 1000, publishIntervalMs: 0,
        semantics: `cast-film process quantity ${sig.name}（${sig.unit}），真实 ${dev.protocol} 链路`,
      })
      if (r.data?.node?.id) daq[id] = r.data.node.id
    }
  }
  const expAct = CASTFILM_ACTUATORS.filter(a => dcw[a]), expSen = CASTFILM_SENSORS.filter(s => daq[s])
  ev.push(`${expAct.length === CASTFILM_ACTUATORS.length ? '✔' : '▲'} actuator nodes ${expAct.length}/${CASTFILM_ACTUATORS.length}：${expAct.join(', ')}`)
  ev.push(`${expSen.length === CASTFILM_SENSORS.length ? '✔' : '▲'} sensor nodes ${expSen.length}/${CASTFILM_SENSORS.length}：${expSen.join(', ')}`)
  return { ok: expAct.length > 0 && expSen.length > 0, lineId, productId, dcw, daq, meta, ev, errors: [] }
}

/** 建配方（起始工况 = START_POINT）+ 开跑，返回 recipeId / runId */
export async function startTwinBatch(api, { lineId, productId, dcw, sfx, start = START_POINT }) {
  const val = { 'zone1-sp': start.zone, 'zone2-sp': start.zone, 'zone3-sp': start.zone, 'screw-sp': start.screw, 'linespeed-sp': start.lineSpeed, 'diegap-sp': start.dieGap }
  const params = Object.entries(dcw).map(([id, nodeId]) => {
    const r = RANGE[{ 'zone1-sp': 'zone', 'zone2-sp': 'zone', 'zone3-sp': 'zone', 'screw-sp': 'screw', 'linespeed-sp': 'lineSpeed', 'diegap-sp': 'dieGap' }[id]]
    return { nodeId, value: val[id], min: r.min, max: r.max }
  })
  const recipe = await api.call('POST', '/api/workshop/dcw/recipes', {
    productId, name: `CastFilm工艺 ${sfx}`, description: 'closed-loop benchmark start point', params,
  })
  const recipeId = recipe.data?.recipe?.id
  if (!recipeId) return { ok: false, errors: [`建配方失败: ${recipe.message}`] }
  const st = await api.call('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId })
  return { ok: st.status === 200, recipeId, started: st.status === 200, errors: st.status === 200 ? [] : [`开跑失败: ${st.message}`] }
}

/** 从平台数采取最近窗口均值（= 闭环真实"观测"路径，非模拟器直读）。
 *  ⚠️ `/daq/:id/samples` 返回的点是**新→旧**排序：取"最近 N 桶"必须按 at 排序后取头部，
 *  用 slice(-N) 会取到 limit 窗口里最旧的 N 桶（实测会让闭环读到 ~60s 前的陈旧值，
 *  表现为"连续多轮读数逐位不变"）。厚度/压力为代数式，最近 6 桶即代表变更后稳态。 */
async function observedMean(api, nodeId) {
  if (!nodeId) return null
  const r = await api.call('GET', `/api/workshop/daq/${nodeId}/samples?bucketMs=1000&limit=60`)
  const pts = (r.data?.points ?? [])
  if (!pts.length) return null
  const newest = [...pts].sort((a, b) => (Number(b.at ?? 0) - Number(a.at ?? 0))).slice(0, 6)
  const vals = newest.map(p => Number(p.avg ?? p.value)).filter(Number.isFinite)
  return vals.length ? mean(vals) : null
}

async function readNode(api, nodeId) {
  if (!nodeId) return null
  const r = await api.call('POST', `/api/workshop/dcw/${nodeId}/read`, {})
  const v = r.data?.read?.value ?? r.data?.value
  return typeof v === 'number' ? v : null
}

/** 执行器信号 id ↔ 命令状态键 */
const ACT_KEY = { 'screw-sp': 'screw', 'linespeed-sp': 'lineSpeed', 'zone3-sp': 'zone' }

/** 采集一次完整状态：观测量(h/defect/P/T)走**数采**（真实测量路径）；
 *  受控量(N/v/zone)取**已下发设定值**（命令语义，与 scoreWindow 的 screw/lineSpeed 定义一致）——
 *  不以 DCW 回读为准：mqtt 等协议的回读面可能不可用（实测 lineSpeed 回读为 null，
 *  会让策略短路成 0 次写）。 */
export async function observe(api, { daq, dcw, cmd }) {
  const h = await observedMean(api, daq['film-thickness'])
  const d = await observedMean(api, daq['defect-rate'])
  const p = await observedMean(api, daq['melt-pressure'])
  const t = await observedMean(api, daq['melt-temp'])
  const N = cmd?.screw ?? await readNode(api, dcw['screw-sp'])
  const v = cmd?.lineSpeed ?? await readNode(api, dcw['linespeed-sp'])
  const z = cmd?.zone ?? await readNode(api, dcw['zone3-sp'])
  const st = { thickness: h, defect: d, pressure: p, meltTemp: t, screw: N, lineSpeed: v, zone: z }
  st.J = (h != null && d != null && p != null && t != null && N != null && v != null) ? scoreJ(st) : null
  return st
}

/**
 * 确定性闭环策略（无 LLM，可复现）。控制器设计：
 *  - **厚度通道为主**：由质量守恒 h ∝ N/v，在固定 v 下乘性反演 N_target = N·(50/h) 使 h→50μm，
 *    步长限幅 ±22 rpm（避免大跳引发工艺瞬态）。
 *  - **线速保持起始值**：不动 v——实测中"在线速上做产能推进"会在热态漂移期引发
 *    大瞬态（压力骤降 → 缺陷率暴涨），破坏闭环可用性；产能项的价值由起点选择体现。
 *  - **温度通道仅纠偏**：熔体温度越出 [196,224]℃ 时才对加热区做小步纠偏。
 */
export function scriptedPolicy(s) {
  const next = { screw: s.screw, lineSpeed: s.lineSpeed, zone: s.zone ?? START_POINT.zone }
  if (s.thickness == null || s.screw == null || s.lineSpeed == null) return next
  const h = s.thickness, N = s.screw
  const want = N * (50 / h)
  const step = Math.max(-22, Math.min(22, want - N))
  next.screw = Math.round(Math.max(RANGE.screw.min, Math.min(RANGE.screw.max, N + step)))
  if (s.meltTemp != null && (s.meltTemp < 196 || s.meltTemp > 224)) {
    const dZ = s.meltTemp < 196 ? 2 : -2
    next.zone = Math.max(RANGE.zone.min, Math.min(RANGE.zone.max, (s.zone ?? START_POINT.zone) + dZ))
  }
  return next
}

/**
 * 跑一次闭环优化（单 seed）。write 由调用方注入：REST 直写（pipeline 层）或
 * Agent dcw_control（治理层，需绑定），从而把"治理是否影响闭环质量"变成可测维度。
 */
export async function runClosedLoop(api, {
  seed, lineId, dcw, daq, optimum, write, maxIters = 6, settleMs = 12_000, sfx = '',
  startCmd = { screw: START_POINT.screw, lineSpeed: START_POINT.lineSpeed, zone: START_POINT.zone },
}) {
  const traj = []
  const ev = []
  const stats = { writes: 0, rejected: 0, records: 0, iters: 0, converged: false, worstViolation: null }
  const t0 = Date.now()
  let cmd = { ...startCmd }
  await plantPhase('steady').catch(() => {})
  // 起始观测前先等满一个采样窗：plantReset/armStart 刚执行完时，数采窗口里仍是
  // **上一 seed 的陈旧样本**；直接观测会让闭环"瞬间收敛"在旧状态上（实测踩过：
  // 两个 seed 的 iter0 读数逐位相同、写次数 0）。等待一个 settleMs 后窗口必然刷新。
  await sleep(settleMs)

  // 迭代 0：起始观测
  let s = await observe(api, { daq, dcw, cmd })
  traj.push({ iter: 0, ...s, wallS: 0 })
  const J0 = s.J
  ev.push(`iter0 起点：h=${fmt(s.thickness, 2)}μm defect=${fmt(s.defect, 3)}% P=${fmt(s.pressure, 2)}MPa T=${fmt(s.meltTemp, 1)}℃ N=${fmt(s.screw, 0)} v=${fmt(s.lineSpeed, 1)} → J=${fmtJ(s.J)}`)

  for (let k = 1; k <= maxIters; k++) {
    const prev = traj[traj.length - 1]
    if (isConverged(prev) && isConverged(traj[traj.length - 2] ?? prev)) { stats.converged = true; ev.push(`✔ 连续两次评估满足收敛判据，第 ${k} 轮前终止`); break }
    const next = scriptedPolicy(prev)
    const tStep = Date.now()
    // 下发（受治理）；受控量以"命令状态"为准，同值空写跳过（否则拿不到优化记录）
    for (const [id, value] of [['screw-sp', next.screw], ['linespeed-sp', next.lineSpeed], ['zone3-sp', next.zone]]) {
      const nodeId = dcw[id]
      const key = ACT_KEY[id]
      if (!nodeId || value == null) continue
      if (cmd[key] != null && Math.abs(cmd[key] - value) < 1e-6) continue
      const r = await write(nodeId, value, `bench seed=${seed} iter=${k}`)
      stats.writes++
      if (r?.rejected) stats.rejected++
      else { cmd = { ...cmd, [key]: value }; if (r?.recordId) stats.records++ }
    }
    await sleep(settleMs)
    s = await observe(api, { daq, dcw, cmd })
    stats.iters = k
    traj.push({ iter: k, ...s, wallS: r3((Date.now() - t0) / 1000), cmd: { ...next } })
    const bad = s.J == null ? '(out of constraints: T or P exceeded)' : ''
    ev.push(`iter${k} 下发 N=${next.screw} v=${next.lineSpeed} z=${next.zone} → h=${fmt(s.thickness, 2)}μm defect=${fmt(s.defect, 3)}% P=${fmt(s.pressure, 2)}MPa T=${fmt(s.meltTemp, 1)}℃ → J=${fmtJ(s.J)} ${bad}`)
    if (s.J == null) stats.worstViolation = { iter: k, meltTemp: s.meltTemp, pressure: s.pressure }
  }
  const last = traj[traj.length - 1]
  // 终点 J：取最后两次可评的均值（与案例口径一致，避免单点噪声）
  const valid = traj.filter(x => x.J != null).slice(-2)
  const Jend = valid.length ? mean(valid.map(x => x.J)) : null
  if (isConverged(last)) stats.converged = true
  const Jstar = optimum?.score ?? null
  const ratio = (Jend != null && Jstar) ? Jend / Jstar : null
  return {
    seed, traj, stats, ev,
    J0: J0 != null ? r3(J0) : null,
    Jend: Jend != null ? r3(Jend) : null,
    Jstar,
    ratio: ratio != null ? r3(ratio) : null,
    wallS: r3((Date.now() - t0) / 1000),
    ok: ratio != null && ratio >= 0.8 && stats.rejected === 0,
  }
}

export function isConverged(s) {
  return s && s.thickness != null && Math.abs(s.thickness - 50) <= 2
    && s.defect != null && s.defect < 2
    && s.pressure != null && s.pressure <= 22
}
const fmt = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—')
const fmtJ = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : 'n/a')
