/**
 * bench/lib/scenarios.mjs —— 多场景并行闭环基准(2026-09)。
 *
 * 覆盖三个新增 PLC 模拟器默认工业场景(与 BOPET 双拉/流延薄膜互补的控制问题形态):
 *   injection —— 注塑成型:克重窗口寻优(保压/保压时间/模温,飞边-缩痕权衡)
 *   wwtp      —— A2O 污水生化处理:排放达标 + 药耗/气耗最小化(多目标)
 *   anneal    —— 连续退火:硬度/抗拉质量窗 + 线速产能最大化
 *
 * 四步(每场景独立,三场景并发执行):
 *   ① ensureScenarioLine:以预设蓝图(GET /api/presets/<key>,dry-run)为工程清单,对现场
 *      按 id+信号+端口差分探测——缺失补建/漂移修复/停机拉起;再 PUT /api/plant/config
 *      {upsert:true} 增量装载该场景物理引擎(warm 热态直起)。**幂等:已接入的场景零改动跳过**,
 *      现场其他场景(cast-film/biax/彼此)不受影响——多引擎同实例并存。
 *   ② provisionScenarioLine:平台建线(每设备 /export 真实 driverConfig → DCW/DAQ 节点),
 *      一配方纳管全部 SP 并开跑;**接入幂等**:按场景标签(AWB-SCEN:<id>)查找已建产线,
 *      节点齐备且配方可寻 → 直接复用,不重复建线建节点。
 *   ③ 任务板 + Channel:每场景一个 mission Channel(mock lead+worker 剧本)+ 一个工具执行器
 *      (toolHarness,host 工具直调),绑定本线全部节点。
 *   ④ runXxxMission:确定性闭环策略(不经 LLM):daq_query 读数 → dcw_control 受治理下发
 *      (自动开优化记录)→ 物理随动等待 → dcw_judge 收口 → 达标/守卫判定。
 *      三场景 Promise.all 并行,全轨迹落盘(每轮:读数/写值/记录/判定/守卫)。
 */
import { sleep } from './util.mjs'
import { simApi, simNodes, simExport, plantReset } from './sim.mjs'
import { runBiaxMission } from './biax.mjs'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const isSp = s => /-sp$/.test(s.id)
const isScalar = s => (s.format ?? 'scalar') === 'scalar'
const r2 = (v) => Number(Number(v).toFixed(2))
const r3 = (v) => Number(Number(v).toFixed(3))

// ─────────────────────────────────────────────────────────────
// 场景目录(与 plc-node-simulator presets.ts 一一对应)
// ─────────────────────────────────────────────────────────────

export const SCENARIOS = {
  injection: {
    id: 'injection',
    key: 'injection-line',
    prefix: 'inj-',
    zh: '注塑成型质量窗口寻优',
    story: '家用电器面板(PP)注塑:规格克重 32.5±0.35 g、飞边 ≤0.4%、缩痕 ≤1.5%、尺寸偏差 ±0.05 mm。起始保压偏低 → 克重 ≈31.3 g 偏轻 + 缩痕超标;闭环把保压/保压时间/模温调回窗口,同时守住飞边上限。',
    pv: { sig: 'part-weight', target: 32.5, tol: 0.35, unit: 'g', label: '制品克重' },
    guards: [
      { sig: 'flash-rate', max: 0.4, label: '飞边率' },
      { sig: 'sink-mark', max: 1.5, label: '缩痕指数' },
    ],
    knobs: [
      { sig: 'hold-pressure-sp', share: 0.55, gain: 0.052, lo: 20, hi: 110 }, // 克重-保压近似增益(g/bar)
      { sig: 'hold-time-sp', share: 0.4, gain: 0.05, lo: 3, hi: 15 }, // 克重-保压时间(g/s)
    ],
    daqWindows: {
      'part-weight': [32.15, 32.85],
      'flash-rate': [0, 0.8],
      'sink-mark': [0, 2.0],
      'MeltTemp': [235, 262],
    },
    settleMs: 9000,
  },
  wwtp: {
    id: 'wwtp',
    key: 'wwtp-line',
    prefix: 'wwtp-',
    zh: 'A2O 污水生化处理达标降耗',
    story: '城镇污水厂 A2O 工艺:排放硬约束 COD<50、氨氮<5、总磷<0.5 mg/L、pH 6~9、浊度<10 NTU。起始风机 26Hz/NaOH 12/PAC 30 → DO 塌陷+pH 超下限+TP 超标;闭环先达标(DO 3.2±0.6 带),再在达标约束内逐级「脱气退药」降低运行成本。',
    pv: { sig: 'do-pv', target: 3.4, tol: 0.6, unit: 'mg/L', label: '好氧池溶解氧' },
    guards: [
      { sig: 'eff-cod', max: 50, label: '出水COD' },
      { sig: 'eff-nh3', max: 5, label: '出水氨氮' },
      { sig: 'eff-tp', max: 0.5, label: '出水总磷' },
      { sig: 'eff-ph', min: 6.0, max: 9.0, label: '出水pH' },
      { sig: 'eff-turbidity', max: 10, label: '出水浊度' },
    ],
    knobs: [
      { sig: 'blower-hz-sp', share: 0.7, gain: 0.55 }, // DO-Hz 近似增益(mg/L 每 Hz,低 DO 段)
      { sig: 'naoh-dose-sp', share: 0.7, gain: 0.041 }, // pH-药量增益
      { sig: 'pac-dose-sp', share: 0.6, gain: -0.006 }, // TP-药量增益(负)
    ],
    daqWindows: {
      DO: [2.2, 4.6],
      CodOut: [0, 50],
      Nh3Out: [0, 5],
      TpOut: [0, 0.5],
      PhOut: [6.0, 9.0],
    },
    settleMs: 12000,
  },
  anneal: {
    id: 'anneal',
    key: 'anneal-line',
    prefix: 'anneal-',
    zh: '连续退火质量窗内产能最大化',
    story: '冷轧低碳钢带连续退火(DC04 类):硬度 95±6 HV、抗拉 300±25 MPa、表面缺陷 ≤0.5%。起始炉温偏低+线速偏快 → 欠退火(硬度 ≈135 HV);先把均热炉温调回再结晶窗,再在质量窗内逐级推高线速(产能),触边即回退。',
    pv: { sig: 'hardness', target: 95, tol: 6, unit: 'HV', label: '维氏硬度' },
    guards: [
      { sig: 'tensile', min: 275, max: 325, label: '抗拉强度' },
      { sig: 'surface-defect', max: 0.5, label: '表面缺陷率' },
    ],
    knobs: [
      { sig: 'zone3-sp', share: 0.5, gain: -8 }, // 硬度-区3近似增益(HV 每 ℃,负)
      { sig: 'zone2-sp', share: 0.35, gain: -6 },
    ],
    daqWindows: {
      Hardness: [89, 101],
      Tensile: [275, 325],
      SurfaceDef: [0, 0.5],
    },
    settleMs: 10000,
  },
  biax: {
    id: 'biax',
    key: 'biax-line',
    prefix: 'biax-',
    zh: '双拉(BOPET)薄膜产线多节点闭环',
    story: '双拉(BOPET)薄膜产线:9 设备五协议、30 SP + 19 PV。起始厚度偏离 25.0±0.7 μm 目标带;闭环在铸片辊速度/MDO快速拉伸/TDI轨道 3 个执行节点间轮流受治理写,物理随动后收敛入带,超窗尝试自动回退。',
    pv: { sig: 'biax-thickness', target: 25, tol: 0.7, unit: 'μm', label: '成品膜厚' },
    guards: [],
    knobs: [],
    daqWindows: {
      'biax-thickness': [24.3, 25.7],
      'melt-temp': [268, 300],
    },
    settleMs: 10000,
    plantWhole: true, // 物理引擎整包装载(与 lib/biax.mjs 同款语义;不按场景 id 拆分)
  },
}

export const SCENARIO_IDS = Object.keys(SCENARIOS)

// ─────────────────────────────────────────────────────────────
// ① 差分 ensure(模拟器侧,幂等;蓝图 dry-run → 缺失补建/漂移修复/停机拉起 → 引擎增量装载)
// ─────────────────────────────────────────────────────────────

export async function scenarioBlueprint(key) {
  const r = await simApi('GET', `/api/presets/${key}`)
  if (r.status >= 400 || !r.data?.nodes) throw new Error(`蓝图 ${key} 拉取失败: ${r.status} ${r.message}`)
  return r.data
}

/** 幂等建场:已接入且无漂移 → 零改动跳过(报告里如实记录 untouched);引擎按 id 增量装载 */
export async function ensureScenarioLine(scen) {
  const bp = await scenarioBlueprint(scen.key)
  const before = await simNodes()
  const byId = new Map(before.map(n => [n.id, n]))
  const portOf = n => n.config?.port ?? n.config?.brokerUrl ?? null
  const report = { missing: [], drifted: [], created: [], repaired: [], started: [], untouched: [] }

  for (const dev of bp.nodes) {
    const cur = byId.get(dev.id)
    if (!cur) {
      report.missing.push(dev.id)
      const r = await simApi('POST', '/api/nodes', dev)
      if (r.status >= 400) throw new Error(`补建设备 ${dev.id} 失败: ${r.message}`)
      report.created.push(dev.id)
      continue
    }
    const have = new Set((cur.signals ?? []).map(s => s.id))
    const lack = (dev.signals ?? []).filter(s => !have.has(s.id)).map(s => s.id)
    const drift = cur.protocol !== dev.protocol || portOf(cur) !== portOf(dev) || lack.length > 0
    if (drift) {
      report.drifted.push({ id: dev.id, lack })
      const r = await simApi('PATCH', `/api/nodes/${dev.id}`, { signals: dev.signals, config: dev.config, enabled: true })
      if (r.status >= 400) throw new Error(`修复设备 ${dev.id} 失败: ${r.message}`)
      report.repaired.push(dev.id)
    }
    if (!cur.runtime?.running) {
      await simApi('POST', `/api/nodes/${dev.id}/start`)
      report.started.push(dev.id)
    }
    if (!drift && cur.runtime?.running) report.untouched.push(dev.id)
  }

  // 端点就绪等待(OPC UA 重栈 boot 可能晚于 POST 返回;≤12s 有界轮询)
  {
    const want = new Set(bp.nodes.map(d => d.id))
    const t0 = Date.now()
    for (;;) {
      const now = await simNodes()
      const notRunning = [...want].filter(id => !now.find(n => n.id === id)?.runtime?.running)
      if (notRunning.length === 0 || Date.now() - t0 > 12_000) break
      await sleep(1500)
    }
  }

  // 物理引擎增量装载(upsert 按 id;warm 热态直起标称工况;其他场景引擎不受影响)
  const pc = scen.plantWhole
    ? await simApi('PUT', '/api/plant/config', { plantModel: bp.plantModel, warm: true })
    : await simApi('PUT', '/api/plant/config', { plantModel: bp.plantModel, id: scen.id, upsert: true, warm: true })
  if (pc.status >= 400) throw new Error(`${scen.id} 物理引擎装载失败: ${pc.message}`)
  // 确定性根修:清零随机漂移(与 biax 同款纪律)
  const resetBody = scen.plantWhole
    ? { warm: true, disturbances: { heaterDecay: 1, feedDriftPerMin: 0 } }
    : { id: scen.id, warm: true, disturbances: { heaterDecay: 1, feedDriftPerMin: 0 } }
  await simApi('POST', '/api/plant/reset', resetBody)
  await sleep(1200) // 首拍覆写绑定信号

  // 终验
  const after = await simNodes()
  const mine = after.filter(n => (bp.nodes ?? []).some(d => d.id === n.id))
  const sigs = mine.flatMap(n => n.signals ?? [])
  const verified = {
    devices: mine.length,
    expectDevices: bp.nodes.length,
    signals: sigs.length,
    sp: sigs.filter(isSp).length,
    pv: sigs.filter(s => !isSp(s) && isScalar(s)).length,
    descMissing: sigs.filter(s => !s.description).length,
    protocols: [...new Set(mine.map(n => n.protocol))],
  }
  return { report, verified, blueprint: bp }
}

// ─────────────────────────────────────────────────────────────
// ② 平台建线(真实协议 driverConfig;接入幂等:按标签复用已建产线)
// ─────────────────────────────────────────────────────────────

const SCALAR_TEMPLATE_DAQ = 'daq-temp-tc'
const SCALAR_TEMPLATE_DCW = 'dcw-temp-sp'
const lineTag = (id) => `AWB-SCEN:${id}`
const dcwName = (id, sig) => `scen-${id}:dcw:${sig}`
const daqName = (id, sig) => `scen-${id}:daq:${sig}`

/**
 * 平台建线:每设备 /export → 每 SP 一个 DCW 节点 + 每标量 PV 一个 DAQ 节点(全真实协议链路),
 * 一个配方纳管全部参数并开跑。已接入(标签命中 + 节点齐 + 配方可寻)→ 直接复用。
 */
export async function provisionScenarioLine(api, scen, { sfx }) {
  const errors = []
  const outErrorsFixed = []
  const rec = { reused: false, devices: [], dcw: {}, daq: {}, driverTests: [], errors, lineName: '' }
  const bp = await scenarioBlueprint(scen.key)
  const expectDcw = new Map()
  const expectDaq = new Map()
  for (const dev of bp.nodes) {
    for (const s of dev.signals ?? []) {
      if (isSp(s)) expectDcw.set(s.id, dev)
      else if (isScalar(s)) expectDaq.set(s.id, dev)
    }
  }

  // ── 接入检查:标签命中的既有产线 + 全部期望节点存在 → 复用 ──
  // 注意:DCW 节点在 /api/workshop/dcw,nodes 是 DCW 列表;DAQ 节点要另查 /api/workshop/daq(实测踩过:只查 dcw 会恒判 daq 不齐而重复建线)
  const snap = await api.call('GET', '/api/workshop/dcw')
  const daqSnap = await api.call('GET', '/api/workshop/daq')
  const lines = snap.data?.lines ?? []
  const nodes = snap.data?.nodes ?? []
  const daqNodes = daqSnap.data?.nodes ?? []
  const recipes = snap.data?.recipes ?? []
  const hit = lines.find(l => String(l.description ?? '').includes(lineTag(scen.id)))
  if (hit) {
    const mineDcw = nodes.filter(n => n.lineId === hit.id && (n.name ?? '').startsWith(`scen-${scen.id}:dcw:`))
    const mineDaq = daqNodes.filter(n => n.lineId === hit.id && (n.name ?? '').startsWith(`scen-${scen.id}:daq:`))
    const dcwComplete = [...expectDcw.keys()].every(sig => mineDcw.some(n => (n.name ?? '').endsWith(`:${sig}`)))
    const daqComplete = [...expectDaq.keys()].every(sig => mineDaq.some(n => (n.name ?? '').endsWith(`:${sig}`)))
    const recipe = recipes.filter(r => r.lineId === hit.id).sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0]
    if (dcwComplete && daqComplete && recipe) {
      // 修复式复用:既有 DAQ 节点 decimals 与蓝图不符(旧版建线缺省 1 位小数)→ PATCH 对齐
      for (const n of mineDaq) {
        const sig = (n.name ?? '').split(':').pop()
        const def = [...expectDaq.entries()].find(([sid]) => sid === sig)?.[1]
        const want = (def?.signals ?? []).find(s => s.id === sig)?.decimals ?? 3
        if (Number.isFinite(n.decimals) && n.decimals !== want) {
          const p = await api.call('PATCH', `/api/workshop/daq/${n.id}`, { decimals: want }).catch(() => null)
          if (p?.status === 200) outErrorsFixed.push(`${n.name}:${n.decimals}→${want}`)
        }
      }
      for (const n of mineDcw) {
        const sig = (n.name ?? '').split(':').pop()
        if (!rec.dcw[sig]) rec.dcw[sig] = n.id
      }
      for (const n of mineDaq) {
        const sig = (n.name ?? '').split(':').pop()
        if (!rec.daq[sig]) rec.daq[sig] = n.id
      }
      rec.reused = true
      rec.ids = { lineId: hit.id, productId: recipe.productId, recipeId: recipe.id }
      rec.lineName = hit.name
      if (outErrorsFixed.length) rec.decimalsFixed = outErrorsFixed
      // 未在跑则重新开跑(幂等:运行中重启报错按 ok 处理)
      const running = String(hit.state ?? '').toLowerCase().includes('run')
      if (!running) {
        const st = await api.call('POST', `/api/workshop/dcw/lines/${hit.id}/start`, { recipeId: recipe.id }).catch(e => ({ status: 0, message: String(e) }))
        if (st.status >= 400 && !/运行|running|已/.test(String(st.message ?? ''))) errors.push(`复用产线开跑失败: ${st.message}`)
        rec.ids.started = st.status === 200
      }
      else rec.ids.started = true
      rec.devices = [...new Set([...mineDcw, ...mineDaq].map(n => n.name.split(':')[1] ?? ''))].filter(Boolean).map(d => ({ id: d, protocol: '?' }))
      return rec
    }
    errors.push(`标签产线 ${hit.id} 节点/配方不齐(dcw=${dcwComplete} daq=${daqComplete} recipe=${!!recipe})→ 新建`)
  }

  // ── 新建 ──
  const devices = (await simNodes()).filter(n => n.id.startsWith(scen.prefix) && n.enabled)
  const line = await api.call('POST', '/api/workshop/dcw/lines', {
    name: `${scen.zh} ${scen.id}-${sfx}`,
    description: `${scen.story} [${lineTag(scen.id)} 重复接入自动复用本线]`,
  })
  const lineId = line.data?.line?.id
  if (!lineId) { rec.errors.push(`建线失败: ${line.message}`); return rec }
  rec.lineName = line.data?.line?.name ?? ''
  const product = await api.call('POST', '/api/workshop/dcw/products', { lineId, name: `scen-${scen.id}-product-${sfx}` })
  const productId = product.data?.product?.id

  const recipeParams = []
  const daqWindows = []
  for (const dev of devices) {
    const exp = await simExport(dev.id)
    const items = exp?.items ?? []
    const byName = new Map(items.map(i => [i.signal, i]))
    // 每设备取一个标量代表项做 test-driver 实测(真实协议连通证据;boot 竞态有界重试)
    const probe = items.find(i => i.format !== 'vector' && i.format !== 'image')
    if (probe) {
      let t = null
      for (let a = 0; a < 3; a++) {
        t = await api.call('POST', '/api/workshop/daq/test-driver', { driver: probe.driver, driverConfig: probe.driverConfig })
        if (t.data?.test?.ok !== false) break
        await sleep(2000)
      }
      rec.driverTests.push({ device: dev.id, signal: probe.signal, ok: t.data?.test?.ok !== false, message: t.data?.test?.message ?? '' })
    }
    for (const sig of dev.signals ?? []) {
      const item = byName.get(sig.name)
      if (!item?.driverConfig) { if (isSp(sig) || isScalar(sig)) errors.push(`${dev.id}/${sig.id} 无导出项`); continue }
      if (isSp(sig)) {
        const d = await api.call('POST', '/api/workshop/dcw', {
          name: dcwName(scen.id, sig.id), templateRef: SCALAR_TEMPLATE_DCW,
          driver: dev.protocol, driverConfig: item.driverConfig,
          unit: sig.unit ?? '', min: sig.min ?? 0, max: sig.max ?? 100, decimals: sig.decimals ?? 2,
          lineId, holdIntervalMs: 0,
          semantics: `${dev.description ?? dev.name}｜${sig.description ?? sig.name}(可写 SP,真实 ${dev.protocol} 链路)`,
        })
        const id = d.data?.node?.id
        if (id) {
          rec.dcw[sig.id] = id
          const v = Number(sig.value ?? sig.strategy?.value ?? ((sig.min + sig.max) / 2))
          recipeParams.push({ nodeId: id, value: Number(v.toFixed(sig.decimals ?? 2)), min: sig.min, max: sig.max })
        }
        else errors.push(`建 DCW ${sig.id} 失败: ${d.message}`)
      }
      else if (isScalar(sig)) {
        const q = await api.call('POST', '/api/workshop/daq', {
          name: daqName(scen.id, sig.id), templateRef: SCALAR_TEMPLATE_DAQ,
          driver: dev.protocol, driverConfig: item.driverConfig,
          unit: sig.unit ?? '', min: sig.min ?? 0, max: sig.max ?? 100,
          // decimals 必须显式传:模板默认 1 位小数会把 TP(0.42~0.5)这类近限值量化到 0.1 步长,
          // 读数在 0.4/0.5 间跳变恰好打在排放限值上(实测踩过:终态 TP 量化 0.500 误判超标)
          decimals: sig.decimals ?? 3,
          lineId, intervalMs: 1000, publishIntervalMs: 0,
          semantics: `${sig.description ?? sig.name}(采集,真实 ${dev.protocol} 链路)`,
        })
        const id = q.data?.node?.id
        if (id) {
          rec.daq[sig.id] = id
          const win = scen.daqWindows[sig.id] ?? scen.daqWindows[sig.name]
          if (win) daqWindows.push({ nodeId: id, min: win[0], max: win[1] })
        }
        else errors.push(`建 DAQ ${sig.id} 失败: ${q.message}`)
      }
    }
    rec.devices.push({ id: dev.id, protocol: dev.protocol })
  }

  if (!productId || recipeParams.length === 0) { rec.errors.push(...errors); return rec }
  const recipe = await api.call('POST', '/api/workshop/dcw/recipes', {
    productId, name: `scen-${scen.id}-recipe-${sfx}`,
    description: `${scen.zh} 标准工况(${recipeParams.length} 参数全窗纳管)`,
    params: recipeParams, daqWindows,
  })
  const recipeId = recipe.data?.recipe?.id
  if (!recipeId) errors.push('建配方失败: ' + JSON.stringify(recipe).slice(0, 200))
  const st = recipeId ? await api.call('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId }) : null
  rec.ids = { lineId, productId, recipeId, started: st?.status === 200 }
  rec.errors.push(...errors)
  return rec
}

// ─────────────────────────────────────────────────────────────
// 共享闭环工具(读数 / 受治理写 / 判定 / 收敛等待)
// ─────────────────────────────────────────────────────────────

/** 经平台 REST 读 DAQ 均值(权威读数;桶化 = avg,非桶化 = value) */
export async function readPvMean(api, nodeId, limit = 5) {
  if (!nodeId) return null
  const s = await api.call('GET', `/api/workshop/daq/${nodeId}/samples?bucketMs=1000&limit=${limit}`)
  const vs = (s.data?.points ?? []).map(p => Number(p.avg ?? p.value)).filter(Number.isFinite)
  return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null
}

async function readSp(api, dcwId) {
  const rd = await api.call('POST', `/api/workshop/dcw/${dcwId}/read`, {})
  const v = Number(rd.data?.read?.value ?? rd.data?.value)
  return Number.isFinite(v) ? v : null
}

/** 受治理写(dcw_control 开优化记录)+ 判定收口(dcw_judge)。返回 {ok, recordId, from} */
async function governedWrite(api, instId, { nodeId, value, hypothesis }) {
  const c = await api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: instId, tool: 'dcw_control', args: { node_id: nodeId, value, hypothesis } })
  if (c.data?.result?.isError === true) return { ok: false, reason: String(c.data?.result?.text ?? '').slice(0, 120) }
  const recordId = (String(c.data?.result?.text ?? '').match(/优化记录\s+([A-Za-z0-9._:-]+)\s+已开窗/) ?? [])[1] ?? null
  let judgeOk = false
  if (recordId) {
    const j = await api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: instId, tool: 'dcw_judge', args: { record_id: recordId, verdict: 'keep', reason: hypothesis } })
    judgeOk = j.data?.result?.isError !== true
  }
  return { ok: true, recordId, judgeOk }
}

/** 物理随动等待:等 PV 稳定(连续两次读数差 < eps)或超时 */
async function settlePv(api, scen, pvId, eps) {
  let prev = await readPvMean(api, pvId, 3)
  const t0 = Date.now()
  for (;;) {
    await sleep(4000)
    const cur = await readPvMean(api, pvId, 3)
    const stable = prev != null && cur != null && Math.abs(cur - prev) < eps
    prev = cur
    if (stable || Date.now() - t0 > scen.settleMs + 8000) break
  }
  return prev
}

/** 任务板:每场景一个 mission Channel(mock lead+worker 剧本派发)+ 工具执行器绑定 */
export async function setupMissionChannel(api, scen, { sfx, toolHarness, line }) {
  const ch = await api.call('POST', '/api/workshop/channels', { name: `scen-${scen.id}-mission-${sfx}`, leadAgent: { name: `scen-${scen.id}-lead-${sfx}`, harness: 'mock', config: { delayMs: 40 } } })
  const chId = ch.data?.channelId ?? ch.data?.channel?.id ?? ch.data?.id
  const mw = await api.call('POST', '/api/workshop/agents', { name: `scen-${scen.id}-worker-${sfx}`, harness: 'mock', config: { delayMs: 60 } })
  await api.call('POST', `/api/workshop/channels/${chId}/agents`, { agentId: mw.data?.id, role: 'worker' })
  const tp = await api.call('POST', '/api/workshop/agents', { name: `scen-${scen.id}-tool-${sfx}`, harness: toolHarness, config: {} })
  const join = await api.call('POST', `/api/workshop/channels/${chId}/agents`, { agentId: tp.data?.id, role: 'worker' })
  const instId = join.data?.id ?? join.data?.agentId
  for (const nid of [...Object.values(line.dcw), ...Object.values(line.daq)]) {
    if (!nid) continue
    const isDcw = Object.values(line.dcw).includes(nid)
    await api.call('POST', '/api/workshop/agent-tools/bindings', { agentId: instId, nodeId: nid, kind: isDcw ? 'dcw' : 'daq', mode: 'auto' })
  }
  const goal = scen.id === 'injection'
    ? `把制品克重收敛到 ${scen.pv.target}±${scen.pv.tol}${scen.pv.unit},全程飞边 ≤0.4%、缩痕 ≤1.5%。`
    : scen.id === 'wwtp'
      ? `出水稳定达标(COD<50/氨氮<5/总磷<0.5/pH 6~9/浊度<10),达标后逐步下调风机与药量降低运行成本。`
      : `硬度调回 ${scen.pv.target}±${scen.pv.tol}${scen.pv.unit} 且抗拉 300±25,然后在质量窗内逐级推高线速提升产能。`
  const parent = await api.call('POST', `/api/workshop/channels/${chId}/tasks`, {
    title: `scen-${scen.id}-opt-${sfx}`,
    description: `${scen.zh} 闭环优化:${goal} 读数先行,受治理下发,每轮判定收口。`,
    parts: [{ text: `${scen.zh} 优化任务:${goal} 先 daq_query 读数,再对 ${scen.knobs.map(k => line.dcw[k.sig]).filter(Boolean).join(', ')} 等执行节点受治理下发,写后等工艺响应并 dcw_judge。` }],
  })
  const parentTask = parent.data?.task?.id ?? parent.data?.id
  return { chId, instId, parentTask }
}

// ─────────────────────────────────────────────────────────────
// ④ 三个场景的确定性闭环策略(全轨迹记录)
// ─────────────────────────────────────────────────────────────

export async function runInjectionMission(api, scen, { instId, line }) {
  const out = { attained: false, writes: 0, rounds: 0, traj: [], ev: [], guardsFinal: {}, final: null }
  const pvId = line.daq[scen.pv.sig]
  const eps = scen.pv.tol / 6
  let w = await readPvMean(api, pvId)
  out.final = w
  out.traj.push({ iter: 0, phase: 'baseline', knob: null, from: null, to: null, pv: w })
  out.ev.push(`baseline 克重=${w?.toFixed(2)}g(目标 ${scen.pv.target}±${scen.pv.tol})`)
  for (let i = 1; i <= 8; i++) {
    out.rounds = i
    const guards = {}
    for (const g of scen.guards) guards[g.label] = await readPvMean(api, line.daq[g.sig])
    if (w != null && Math.abs(w - scen.pv.target) <= scen.pv.tol) { out.attained = true; out.guardsFinal = guards; break }
    // 守卫优先:飞边超限 → 反向退保压
    if (guards['飞边率'] != null && guards['飞边率'] > 0.4) {
      const nid = line.dcw['hold-pressure-sp']
      const cur = await readSp(api, nid)
      const next = r2(clamp(cur - 6, 20, 110))
      const r = await governedWrite(api, instId, { nodeId: nid, value: next, hypothesis: `inj iter${i}: 飞边 ${guards['飞边率']?.toFixed(2)}% 超限,退保压 ${cur}→${next}` })
      out.ev.push(`iter${i}: 飞边守卫触发,保压 ${cur}→${next} ${r.ok ? '✔' : `✘ ${r.reason ?? ''}`}`)
      if (r.ok) { out.writes++; out.traj.push({ iter: i, phase: 'guard-flash', knob: 'hold-pressure-sp', from: cur, to: next, pv: await settlePv(api, scen, pvId, eps) }); w = out.traj.at(-1).pv }
      continue
    }
    if (w == null) { out.ev.push(`iter${i}: 克重读数缺失,跳过`); continue }
    // 主控:保压(增益近似校正 × share);接近饱和再动保压时间
    const dW = scen.pv.target - w
    const knob = Math.abs(dW) > scen.pv.tol * 2.5 ? scen.knobs[0] : scen.knobs[Math.min(i % 2 === 0 ? 1 : 0, 1)]
    const nid = line.dcw[knob.sig]
    if (!nid) { out.ev.push(`iter${i}: 旋钮 ${knob.sig} 缺平台节点`); continue }
    const cur = await readSp(api, nid)
    if (cur == null) { out.ev.push(`iter${i}: ${knob.sig} 读失败`); continue }
    const raw = cur + dW / knob.gain * knob.share
    const next = r2(clamp(raw, knob.lo ?? 20, knob.hi ?? 110))
    if (Math.abs(next - cur) < 0.6) { out.ev.push(`iter${i}: ${knob.sig} 校正量过小(${cur}→${next}),换旋钮`); continue }
    const r = await governedWrite(api, instId, { nodeId: nid, value: next, hypothesis: `inj iter${i}: 克重 ${w.toFixed(2)}g 偏${dW > 0 ? '轻' : '重'},经 ${knob.sig} 校正 ${cur}→${next}` })
    if (!r.ok) { out.ev.push(`iter${i}: ${knob.sig} 写被拒 → ${r.reason}`); continue }
    out.writes++
    const pvAfter = await settlePv(api, scen, pvId, eps)
    w = pvAfter ?? w
    out.final = w
    out.traj.push({ iter: i, phase: 'converge', knob: knob.sig, from: cur, to: next, record: r.recordId, judge: r.judgeOk, pv: w })
    out.ev.push(`iter${i}: ${knob.sig} ${cur}→${next} ✔ record=${r.recordId ? 'yes' : 'no'} · 克重→${w?.toFixed(2)}g`)
  }
  const guardsFinal = {}
  for (const g of scen.guards) guardsFinal[g.label] = await readPvMean(api, line.daq[g.sig])
  out.guardsFinal = guardsFinal
  out.attained = out.attained || (out.final != null && Math.abs(out.final - scen.pv.target) <= scen.pv.tol
    && (guardsFinal['飞边率'] ?? 0) <= 0.4 && (guardsFinal['缩痕指数'] ?? 0) <= 1.5)
  out.ev.push(`outcome: writes=${out.writes} final=${out.final?.toFixed(2)}g attained=${out.attained} guards=${JSON.stringify(guardsFinal)}`)
  return out
}

export async function runWwtpMission(api, scen, { instId, line }) {
  const out = { attained: false, writes: 0, rounds: 0, traj: [], ev: [], guardsFinal: {}, final: null, cost: {} }
  const eps = 0.08
  const readAll = async () => {
    const g = {}
    for (const x of scen.guards) g[x.label] = await readPvMean(api, line.daq[x.sig])
    g['DO'] = await readPvMean(api, line.daq['do-pv'])
    return g
  }
  const compliantOf = (g) => (g['出水COD'] ?? 99) < 50 && (g['出水氨氮'] ?? 99) < 5 && (g['出水总磷'] ?? 99) < 0.5
    && (g['出水pH'] ?? 0) > 6.0 && (g['出水pH'] ?? 0) < 9.0 && (g['出水浊度'] ?? 99) < 10
  // 带裕度达标(降耗试探用):限值就贴在刀刃上时(COD/NH3 随 DO 指数变化),无裕度保留会把
  // 终态留在噪声翻转区(实测踩过:16 写全回退、终态 COD 54 非达标)。保留判据必须留缓冲。
  // 且试探判据解耦:风机试探只看它影响的 COD/氨氮;NaOH 试探只看它影响的 pH——
  // 避免被对方写入后的慢暂态连坐误回退。
  const compliantMargin = (g) => (g['出水COD'] ?? 99) < 46 && (g['出水氨氮'] ?? 99) < 4.5 && (g['出水总磷'] ?? 99) < 0.47
    && (g['出水pH'] ?? 0) > 6.3 && (g['出水pH'] ?? 0) < 8.7 && (g['出水浊度'] ?? 99) < 9
  const blowerTrimOk = (g) => (g['出水COD'] ?? 99) < 46 && (g['出水氨氮'] ?? 99) < 4.5
  const naohTrimOk = (g) => (g['出水pH'] ?? 0) > 6.3 && (g['出水pH'] ?? 0) < 8.7
  const writeKnob = async (i, phase, sig, next, why) => {
    const nid = line.dcw[sig]
    const cur = await readSp(api, nid)
    if (cur == null || Math.abs(next - cur) < 0.5) return { skip: `${sig} 校正量过小或读失败(${cur})` }
    const r = await governedWrite(api, instId, { nodeId: nid, value: r2(next), hypothesis: `wwtp iter${i}(${phase}): ${why} ${cur}→${r2(next)}` })
    if (r.ok) out.writes++
    return r
  }

  let g = await readAll()
  out.final = g['DO']
  out.traj.push({ iter: 0, phase: 'baseline', pv: g['DO'], guards: g })
  out.ev.push(`baseline DO=${g['DO']?.toFixed(2)} COD=${g['出水COD']?.toFixed(0)} NH3=${g['出水氨氮']?.toFixed(1)} TP=${g['出水总磷']?.toFixed(2)} pH=${g['出水pH']?.toFixed(2)} → ${compliantOf(g) ? '达标' : '不达标'}`)

  // 阶段 A:曝气调 DO 入带且出水 COD/氨氮两个 DO 派生约束同时满足(≤6 轮)。
  // 注意:DO 带只是代理——COD<50 实际需要 DO≥3.0、氨氮<5 需要 DO≥2.9(MLSS 4675 时),
  // 单看带宽会在 2.6 提前收手(实测踩过):退出条件 = 带内 且 COD<48 且 NH3<4.5。
  for (let i = 1; i <= 6; i++) {
    out.rounds++
    if (g['DO'] == null) break
    const inBand = Math.abs(g['DO'] - scen.pv.target) <= scen.pv.tol
    const proximal = (g['出水COD'] ?? 99) < 48 && (g['出水氨氮'] ?? 99) < 4.5
    if (inBand && proximal) break
    const dDO = scen.pv.target - g['DO']
    const nid = line.dcw['blower-hz-sp']
    const cur = await readSp(api, nid)
    const next = r2(clamp(cur + Math.max(0.8, dDO / scen.knobs[0].gain * scen.knobs[0].share), 20, 50))
    const r = await writeKnob(i, 'blower', 'blower-hz-sp', next, `DO ${g['DO']?.toFixed(2)} 校正,风机`)
    out.ev.push(`iter${i}(曝气): 风机 ${cur}→${r2(next)} ${r.ok ? '✔' : `✘ ${r.reason ?? r.skip ?? ''}`}`)
    if (!r.ok) break
    out.traj.push({ iter: i, phase: 'blower', knob: 'blower-hz-sp', from: cur, to: r2(next), record: r.recordId, judge: r.judgeOk, pv: await settlePv(api, scen, line.daq['do-pv'], eps) })
    g = await readAll()
  }
  // 阶段 B:pH 中和(≤3 轮)
  for (let i = 5; i <= 7; i++) {
    out.rounds++
    if (g['出水pH'] == null) break
    if (g['出水pH'] >= 6.5) break
    const dPh = 7.0 - g['出水pH']
    const nid = line.dcw['naoh-dose-sp']
    const cur = await readSp(api, nid)
    const next = r2(clamp(cur + dPh / scen.knobs[1].gain * scen.knobs[1].share, 0, 120))
    const r = await writeKnob(i, 'ph', 'naoh-dose-sp', next, `pH ${g['出水pH']?.toFixed(2)} 校正,NaOH`)
    out.ev.push(`iter${i}(中和): NaOH ${cur}→${r2(next)} ${r.ok ? '✔' : `✘ ${r.reason ?? r.skip ?? ''}`}`)
    if (!r.ok) break
    out.traj.push({ iter: i, phase: 'ph', knob: 'naoh-dose-sp', from: cur, to: r2(next), record: r.recordId, judge: r.judgeOk, pv: await settlePv(api, scen, line.daq['eff-ph'], 0.03) })
    g = await readAll()
  }
  // 阶段 C:除磷达标(≤3 轮)。退出阈值 0.45(而非限值 0.5):TP 在 0.45 上下时
  // 量化/噪声会把读数打在限值刀刃上;把裕度建在工况里(PAC 75 → 真值 0.42)而非读数上。
  for (let i = 8; i <= 10; i++) {
    out.rounds++
    if (g['出水总磷'] == null) break
    if (g['出水总磷'] < 0.45) break
    const nid = line.dcw['pac-dose-sp']
    const cur = await readSp(api, nid)
    const next = r2(clamp(cur + 15, 0, 90))
    const r = await writeKnob(i, 'tp', 'pac-dose-sp', next, `TP ${g['出水总磷']?.toFixed(2)} 超标,PAC+15`)
    out.ev.push(`iter${i}(除磷): PAC ${cur}→${r2(next)} ${r.ok ? '✔' : `✘ ${r.reason ?? r.skip ?? ''}`}`)
    if (!r.ok) break
    out.traj.push({ iter: i, phase: 'tp', knob: 'pac-dose-sp', from: cur, to: r2(next), record: r.recordId, judge: r.judgeOk, pv: await settlePv(api, scen, line.daq['eff-tp'], 0.02) })
    g = await readAll()
  }

  // 首个达标成本快照
  let firstCost = null
  {
    g = await readAll()
    if (compliantOf(g)) {
      const b = await readSp(api, line.dcw['blower-hz-sp']) ?? 0
      const n = await readSp(api, line.dcw['naoh-dose-sp']) ?? 0
      const p = await readSp(api, line.dcw['pac-dose-sp']) ?? 0
      firstCost = Math.pow(b / 30, 2.6) * 100 + 0.30 * n + 0.45 * p
      out.ev.push(`达标确认 ✔ 首个达标运行成本 ≈${firstCost.toFixed(1)}(风机 ${b}/NaOH ${n}/PAC ${p})`)
    } else {
      out.ev.push(`达标未确认:${JSON.stringify(g)}`)
    }
  }
  // 阶段 D:达标降耗(逐级退气退药;保留判据 = 带裕度达标,不达标即回退)
  let trimmed = 0
  if (firstCost != null) {
    for (let i = 11; i <= 12; i++) {
      out.rounds++
      const curB = await readSp(api, line.dcw['blower-hz-sp'])
      const nextB = r2(curB - 1.2)
      let r = await writeKnob(i, 'trim', 'blower-hz-sp', nextB, '降耗:风机-1.2Hz')
      if (r.ok) {
        await settlePv(api, scen, line.daq['do-pv'], eps)
        g = await readAll()
        if (blowerTrimOk(g)) {
          trimmed++
          out.ev.push(`iter${i}(降耗): 风机 ${curB}→${nextB} ✔ 带裕度复测达标,保留`)
        } else {
          const back = await writeKnob(i, 'trim-revert', 'blower-hz-sp', curB, '降耗回退:复测非裕度达标,恢复风机')
          out.ev.push(`iter${i}(降耗): 风机 ${curB}→${nextB} 复测非裕度达标(${(g['出水COD'] ?? 0).toFixed(0)}/${(g['出水氨氮'] ?? 0).toFixed(1)}) → 回退 ${back.ok ? '✔' : '✘'}`)
          await settlePv(api, scen, line.daq['do-pv'], eps)
        }
      }
      const curN = await readSp(api, line.dcw['naoh-dose-sp'])
      const nextN = r2(curN - 4)
      r = await writeKnob(i, 'trim', 'naoh-dose-sp', nextN, '降耗:NaOH-4')
      if (r.ok) {
        await settlePv(api, scen, line.daq['eff-ph'], 0.03)
        g = await readAll()
        if (naohTrimOk(g)) {
          trimmed++
          out.ev.push(`iter${i}(降耗): NaOH ${curN}→${nextN} ✔ 带裕度复测达标,保留`)
        } else {
          const back = await writeKnob(i, 'trim-revert', 'naoh-dose-sp', curN, '降耗回退:复测非裕度达标,恢复NaOH')
          out.ev.push(`iter${i}(降耗): NaOH ${curN}→${nextN} 复测非裕度达标(pH ${(g['出水pH'] ?? 0).toFixed(2)}) → 回退 ${back.ok ? '✔' : '✘'}`)
          await settlePv(api, scen, line.daq['eff-ph'], 0.03)
        }
      }
      if (trimmed >= 2) break
    }
  }
  // 收尾恢复步:降耗试探可能把工况留在限值刀刃附近(回退写后的慢暂态)——
  // 按哪个参数失守就修哪个:COD/氨氮失守 → 风机 +1.5Hz;TP 失守 → PAC +15(有界各 1 写)。
  g = await readAll()
  if (!compliantOf(g)) {
    if ((g['出水总磷'] ?? 0) >= 0.5) {
      const curP = await readSp(api, line.dcw['pac-dose-sp'])
      const r = await writeKnob(15, 'recover', 'pac-dose-sp', r2(curP + 15), `终态 TP ${(g['出水总磷'] ?? 0).toFixed(2)} 失守,PAC+15 拉回达标区`)
      out.ev.push(`recover(TP): PAC ${curP}→${r2(curP + 15)} ${r.ok ? '✔' : `✘ ${r.reason ?? r.skip ?? ''}`}`)
      if (r.ok) await settlePv(api, scen, line.daq['eff-tp'], 0.02)
    }
    if ((g['出水COD'] ?? 0) >= 50 || (g['出水氨氮'] ?? 0) >= 5) {
      const curB = await readSp(api, line.dcw['blower-hz-sp'])
      const nextB = r2(curB + 1.5)
      const r = await writeKnob(15, 'recover', 'blower-hz-sp', nextB, `终态非达标(COD ${(g['出水COD'] ?? 0).toFixed(0)}),风机+1.5Hz 拉回达标区`)
      out.ev.push(`recover: 风机 ${curB}→${nextB} ${r.ok ? '✔' : `✘ ${r.reason ?? r.skip ?? ''}`}`)
      if (r.ok) await settlePv(api, scen, line.daq['do-pv'], eps)
    }
    g = await readAll()
  }
  out.final = g['DO']
  out.guardsFinal = g
  const finalB = await readSp(api, line.dcw['blower-hz-sp']) ?? 0
  const finalN = await readSp(api, line.dcw['naoh-dose-sp']) ?? 0
  const finalP = await readSp(api, line.dcw['pac-dose-sp']) ?? 0
  out.cost.final = Math.pow(finalB / 30, 2.6) * 100 + 0.30 * finalN + 0.45 * finalP
  out.cost.firstCompliant = firstCost
  out.cost.saving = firstCost != null ? r2(firstCost - out.cost.final) : null
  out.attained = compliantOf(g) && (firstCost == null || out.cost.final <= firstCost)
  out.ev.push(`outcome: writes=${out.writes} DO=${out.final?.toFixed(2)} compliant=${compliantOf(g)} cost ${firstCost?.toFixed(1) ?? '—'}→${out.cost.final.toFixed(1)}(省 ${out.cost.saving ?? '—'}) attained=${out.attained}`)
  return out
}

export async function runAnnealMission(api, scen, { instId, line }) {
  const out = { attained: false, writes: 0, rounds: 0, traj: [], ev: [], guardsFinal: {}, final: null, throughput: {} }
  const eps = 0.5
  const readAll = async () => ({
    hardness: await readPvMean(api, line.daq['hardness']),
    tensile: await readPvMean(api, line.daq['tensile']),
    surface: await readPvMean(api, line.daq['surface-defect']),
    speed: await readPvMean(api, line.daq['act-speed-pv']),
  })
  const inWindow = (g) => g.hardness != null && Math.abs(g.hardness - scen.pv.target) <= scen.pv.tol
    && (g.tensile ?? 0) > 275 && (g.tensile ?? 0) < 325 && (g.surface ?? 9) <= 0.5

  let g = await readAll()
  out.final = g.hardness
  out.throughput.start = g.speed
  out.traj.push({ iter: 0, phase: 'baseline', pv: g.hardness })
  out.ev.push(`baseline 硬度=${g.hardness?.toFixed(1)}HV 抗拉=${g.tensile?.toFixed(0)}MPa 线速=${g.speed?.toFixed(0)}m/min → ${inWindow(g) ? '窗内' : '窗外'}`)

  // 阶段 A:调回再结晶窗(≤5 轮:zone3/zone2 轮换)
  for (let i = 1; i <= 5; i++) {
    out.rounds++
    if (inWindow(g)) break
    if (g.hardness == null) break
    const err = (g.hardness - scen.pv.target) / scen.pv.target // >0 = 偏硬(欠退火) → 需要加温
    const knob = scen.knobs[(i - 1) % scen.knobs.length]
    const nid = line.dcw[knob.sig]
    const cur = await readSp(api, nid)
    if (cur == null) { out.ev.push(`iter${i}: ${knob.sig} 读失败`); continue }
    const next = Math.round(clamp(err > 0 ? cur * (1 + err * 1.6 * knob.share) : cur * (1 + err * 1.6 * knob.share), 600, 850))
    if (Math.abs(next - cur) < 3) { out.ev.push(`iter${i}: ${knob.sig} 校正量过小(${cur})`); continue }
    const r = await governedWrite(api, instId, { nodeId: nid, value: next, hypothesis: `anneal iter${i}: 硬度 ${g.hardness.toFixed(1)}HV 偏${err > 0 ? '硬(欠退火)' : '软(过退火)'},${knob.sig} ${cur}→${next}` })
    out.ev.push(`iter${i}: ${knob.sig} ${cur}→${next} ${r.ok ? '✔' : `✘ ${r.reason ?? ''}`}`)
    if (!r.ok) continue
    out.writes++
    const pvAfter = await settlePv(api, scen, line.daq['hardness'], eps)
    g = await readAll()
    out.final = g.hardness
    out.traj.push({ iter: i, phase: 'converge', knob: knob.sig, from: cur, to: next, record: r.recordId, judge: r.judgeOk, pv: g.hardness })
  }

  // 阶段 A2:裕度修剪 —— 产能推进前把硬度压到带内下部(≤ target+tol−3),
  // 给线速提升的 SMP 爬升留出空间。实测(2026-09-21 run2):收敛后 100.2HV 贴上限,
  // +12 线速即爬到 100.5 超裕度线被回退,产能永远推不出去。标准工业实践:
  // 质量留裕度再提产能。修剪走 zone2(区3 已收敛在 850 上限,无上探余量)。
  if (inWindow(g)) {
    const trimCeil = scen.pv.target + scen.pv.tol - 3.0 // 98 HV
    const knob = scen.knobs[1] // zone2-sp
    for (let t = 1; t <= 2 && g.hardness != null && g.hardness > trimCeil; t++) {
      out.rounds++
      const nid = line.dcw[knob.sig]
      const cur = await readSp(api, nid)
      if (cur == null) { out.ev.push(`trim${t}: ${knob.sig} 读失败`); break }
      const next = Math.round(clamp(cur + 12, 600, 850))
      if (Math.abs(next - cur) < 3) { out.ev.push(`trim${t}: ${knob.sig} 已无上探余量(${cur})`); break }
      const r = await governedWrite(api, instId, { nodeId: nid, value: next, hypothesis: `anneal 裕度修剪${t}: 硬度 ${g.hardness.toFixed(1)}HV 贴上限,${knob.sig} ${cur}→${next} 下压留产能裕度` })
      if (!r.ok) { out.ev.push(`trim${t}: 写被拒 → ${r.reason ?? ''}`); break }
      out.writes++
      await settlePv(api, scen, line.daq['hardness'], eps)
      g = await readAll()
      out.traj.push({ iter: `trim${t}`, phase: 'margin', knob: knob.sig, from: cur, to: next, record: r.recordId, judge: r.judgeOk, pv: g.hardness })
      out.ev.push(`trim${t}: ${knob.sig} ${cur}→${next} 硬度→${g.hardness?.toFixed(1)}HV(修剪线 ≤${trimCeil.toFixed(0)})`)
    }
  }

  // 阶段 B:质量窗内推产能(线速 +12 逐级;触边回退)。
  // ⚠️ 验收带 1.0HV 裕度:带温/绥冷是一阶滞后,验收读数之后硬度仍会继续爬
  // (SMP 随驻留进一步下降),贴边推进会让「迭代时窗内、终验出窗」(2026-09-21 实测
  // 100.7→101.5 越 101 上限)。留出裕度后,终验仍落窗内的概率覆盖滞后爬升量。
  if (inWindow(g)) {
    const EDGE_MARGIN = 1.0
    const hardOk = (h) => h != null && (scen.pv.target + scen.pv.tol - EDGE_MARGIN) >= h && h >= scen.pv.target - scen.pv.tol
    const baseSpeed = (await readSp(api, line.dcw['line-speed-sp'])) ?? 140
    let pushed = 0
    for (let i = 6; i <= 9; i++) {
      out.rounds++
      const cur = await readSp(api, line.dcw['line-speed-sp'])
      const next = Math.round(clamp(cur + 12, 60, 220))
      const r = await governedWrite(api, instId, { nodeId: line.dcw['line-speed-sp'], value: next, hypothesis: `anneal iter${i}(产能): 窗内提线速 ${cur}→${next}` })
      if (!r.ok) { out.ev.push(`iter${i}(产能): 写被拒 → ${r.reason}`); break }
      out.writes++
      await settlePv(api, scen, line.daq['hardness'], eps)
      const g2 = await readAll()
      if (inWindow(g2) && hardOk(g2.hardness) && (g2.tensile == null || Math.abs(g2.tensile - 300) <= 25)) {
        pushed++
        out.ev.push(`iter${i}(产能): 线速 ${cur}→${next} ✔ 硬度 ${g2.hardness.toFixed(1)}HV 留裕度窗内`)
        g = g2
        out.traj.push({ iter: i, phase: 'throughput', knob: 'line-speed-sp', from: cur, to: next, record: r.recordId, judge: r.judgeOk, pv: g2.hardness })
      } else {
        const back = await governedWrite(api, instId, { nodeId: line.dcw['line-speed-sp'], value: cur, hypothesis: `anneal iter${i}(产能回退): 硬度 ${g2.hardness?.toFixed(1)}HV 触边/无裕度,恢复 ${next}→${cur}` })
        out.ev.push(`iter${i}(产能): 线速 ${cur}→${next} 硬度 ${g2.hardness?.toFixed(1)}HV 出窗/无裕度 → 回退 ${back.ok ? '✔' : '✘'}`)
        await settlePv(api, scen, line.daq['hardness'], eps)
        break
      }
    }
    // 终态稳定化:验收读之后硬度仍持续爬升(SMP 随驻留收敛,约 +2HV/分钟),
    // 「验收时窗内、终验出窗」是早读低估稳态的必然(2026-09-22 run2 实测 99.4→101.4)。
    // 有界回退:20s 蠕变窗后复测,稳态超窗则退一档线速(至多 2 档,不低于 baseSpeed),
    // 保证终态「真稳态在窗内」且尽量保留产能。
    for (let b = 0; b < 2; b++) {
      await sleep(20000)
      g = await readAll()
      if (inWindow(g) && g.hardness <= scen.pv.target + scen.pv.tol - 0.5) break
      const cur = await readSp(api, line.dcw['line-speed-sp'])
      if (cur == null || cur <= baseSpeed) break
      const back = Math.round(Math.max(baseSpeed, cur - 12))
      const r = await governedWrite(api, instId, { nodeId: line.dcw['line-speed-sp'], value: back, hypothesis: `anneal 终态回退${b + 1}: 稳态硬度 ${g.hardness?.toFixed(1)}HV 超窗,线速 ${cur}→${back}` })
      out.ev.push(`终态回退${b + 1}: 线速 ${cur}→${back}（稳态硬度 ${g.hardness?.toFixed(1)}HV 超窗）${r.ok ? '✔' : '✘'}`)
      if (!r.ok) break
      out.writes++
      await settlePv(api, scen, line.daq['hardness'], eps)
    }
    out.throughput.finalSp = await readSp(api, line.dcw['line-speed-sp'])
    out.throughput.gain = r2(((out.throughput.finalSp ?? baseSpeed) - baseSpeed) / baseSpeed * 100)
    out.ev.push(`产能推进: 线速 ${baseSpeed}→${out.throughput.finalSp}(+${out.throughput.gain}%),pushed=${pushed}`)
  }
  g = await readAll()
  out.final = g.hardness
  out.guardsFinal = { 抗拉强度: g.tensile, 表面缺陷率: g.surface }
  out.attained = inWindow(g) && (out.throughput.gain ?? 0) >= 5
  out.ev.push(`outcome: writes=${out.writes} final=${out.final?.toFixed(1)}HV attained=${out.attained}(窗内+产能≥5%)`)
  return out
}

/** biax 场景策略:直接复用 lib/biax.mjs 的已验证 mission(厚度误差 → 三执行器轮换),
 *  并把结果映射回场景框架的统一形状(traj.thickness → traj.pv)。 */
export function biaxMissionToScenarioResult(m) {
  return {
    attained: m.attained,
    writes: m.writes,
    rounds: m.traj.filter(x => x.knob).length,
    traj: m.traj.map(x => ({
      iter: x.iter,
      phase: x.note ? 'rebase' : (x.knob == null ? 'baseline' : (String(x.knob).includes('speed') ? 'throughput' : 'converge')),
      knob: x.knob, from: x.from, to: x.to,
      pv: x.thickness, record: x.record ?? null,
      judge: x.record ? true : undefined,
    })),
    ev: m.ev,
    final: m.thickness,
    guardsFinal: {},
    journalOk: m.journalOk, boardOk: m.boardOk, parentState: m.parentState,
    distinctCount: m.distinctNodes instanceof Set ? m.distinctNodes.size : (m.distinctNodes ?? 0),
  }
}

export async function runBiaxScenarioMission(api, scen, { instId, line, sfx }) {
  const simDevices = (await simNodes()).filter(n => n.id.startsWith('biax-'))
  const m = await runBiaxMission(api, { instId, line, simDevices, sfx })
  return biaxMissionToScenarioResult(m)
}

const MISSIONS = {
  injection: runInjectionMission,
  wwtp: runWwtpMission,
  anneal: runAnnealMission,
  biax: runBiaxScenarioMission,
}

// ─────────────────────────────────────────────────────────────
// 单场景全流程(ensure → 建线 → channel → mission)+ 三场景并行编排
// ─────────────────────────────────────────────────────────────

export async function runScenario(api, scen, ctx) {
  const { sfx, toolHarness, onLog, fresh = true } = ctx
  const t0 = Date.now()
  const res = { id: scen.id, zh: scen.zh, story: scen.story, ev: [], errors: [] }
  try {
    const en = await ensureScenarioLine(scen)
    res.ensure = en.report
    res.verified = en.verified
    res.blueprint = { nodes: en.blueprint.nodes, plantModel: { kind: en.blueprint.plantModel?.kind, id: en.blueprint.plantModel?.id } }
    onLog?.(`[${scen.id}] ensure ✔ devices=${en.verified.devices}/${en.verified.expectDevices} sp=${en.verified.sp} pv=${en.verified.pv} created=${en.report.created.length} repaired=${en.report.repaired.length} untouched=${en.report.untouched.length}`)
    if (en.report.created.length === 0 && en.report.repaired.length === 0) res.ev.push(`接入检查:场景已完整接入,零改动复用(untouched ${en.report.untouched.length} 台设备)`)

    const line = await provisionScenarioLine(api, scen, { sfx })
    res.line = { ids: line.ids, reused: line.reused, name: line.lineName, dcw: Object.keys(line.dcw).length, daq: Object.keys(line.daq).length, driverTests: line.driverTests, errors: line.errors }
    onLog?.(`[${scen.id}] 平台建线${line.reused ? '(复用既有产线)' : '(新建)'} ✔ line=${line.ids?.lineId} dcw=${Object.keys(line.dcw).length} daq=${Object.keys(line.daq).length}`)
    if (line.errors?.length) res.errors.push(...line.errors)

    // fresh(默认开):把 SP 复位到蓝图次优起点(只动本场景的信号值,不重连/不重建任何东西),
    // mission 才有确定的优化轨迹可跑;--no-fresh 时保留现场当前工况(续跑语义)。
    if (fresh) {
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
      await simApi('POST', '/api/plant/reset', fb)
      // 复位核对:逐 SP 回读,断言「现场=蓝图默认值」——防御残留工况/坏写混入使命起点
      // (2026-09-21 run2:上一轮的残留使 anneal 起点偏移,trim 后产能仍差一步;核对可当场拦截)
      const cfgR = (await simApi('GET', '/api/config')).data ?? {}
      const liveSig = new Map()
      for (const n of (cfgR.nodes ?? [])) for (const s of (n.signals ?? [])) liveSig.set(`${n.id}/${s.id}`, s.runtime?.value)
      let checked = 0
      const bad = []
      for (const dev of en.blueprint.nodes) {
        for (const s of dev.signals ?? []) {
          if (!isSp(s)) continue
          const v = Number(s.strategy?.value ?? s.value)
          if (!Number.isFinite(v)) continue
          checked++
          const lv = Number(liveSig.get(`${dev.id}/${s.id}`))
          if (!Number.isFinite(lv) || Math.abs(lv - v) > 0.05) bad.push(`${dev.id}/${s.id}=${lv}≠${v}`)
        }
      }
      if (bad.length) {
        res.ev.push(`⚠ 起点复位核对: ${checked} 个 SP 中 ${bad.length} 个与蓝图不符(${bad.slice(0, 3).join('; ')})`)
        res.errors.push(`fresh 复位后 ${bad.length} 个 SP 与蓝图默认值不符: ${bad.slice(0, 5).join('; ')}`)
      }
      else res.ev.push(`起点复位核对: ${checked}/${checked} SP=蓝图默认值 ✔`)
      res.ev.push('起点复位:SP 已回到蓝图次优工况(fresh;接入与产线不受影响)')
    }

    const mc = await setupMissionChannel(api, scen, { sfx, toolHarness, line })
    res.channel = mc
    onLog?.(`[${scen.id}] channel=${mc.chId} toolAgent=${mc.instId} task=${mc.parentTask}`)

    // 等待首采(有界)
    const tW = Date.now()
    for (;;) {
      const n = await readPvMean(api, line.daq[scen.pv.sig])
      if (n != null || Date.now() - tW > 30_000) break
      await sleep(2500)
    }
    // 稳定等待:引擎 warm 复位按「标称工况」起控,现场信号的实际 SP 可能不同
    // (重复接入时是上一轮的终态)→ 先等受控量进入当前 SP 下的稳态,mission 才开工,
    // 否则基线读数落在暂态斜坡上,策略会把暂态当响应(实测踩过)。
    // 连接预热:冷环境首写常因 OPC UA 会话未就绪被拒(BadConnectionClosed,实测踩过)
    // → 对全部 DCW 节点各做一次空读触发自动重连,再等受控量进入稳态。
    for (const nid of Object.values(line.dcw)) await readSp(api, nid).catch(() => null)
    await settlePv(api, { settleMs: 14_000 }, line.daq[scen.pv.sig], scen.id === 'wwtp' ? 0.08 : scen.pv.tol / 6)

    const mission = await MISSIONS[scen.id](api, scen, { instId: mc.instId, line })
    res.mission = mission
    res.wallS = r2((Date.now() - t0) / 1000)
    onLog?.(`[${scen.id}] mission ✔ writes=${mission.writes} attained=${mission.attained} wall=${res.wallS}s`)
    // 任务板收口(mock 剧本推进;观察终态)
    if (mc.parentTask) {
      const dl = Date.now() + 60_000
      while (Date.now() < dl) {
        await sleep(3000)
        const t = (await api.call('GET', `/api/workshop/tasks/${mc.parentTask}`)).data ?? {}
        const state = t.state ?? t.task?.state ?? ''
        if (['COMPLETED', 'FAILED', 'CANCELED'].includes(state)) { res.channel.terminal = state; break }
      }
    }
  } catch (err) {
    res.errors.push(String(err?.message ?? err))
    onLog?.(`[${scen.id}] ERROR ${err?.message ?? err}`)
  }
  return res
}

/** 三场景并行闭环基准(核心入口) */
export async function runScenarioBench(api, { scenarios = SCENARIO_IDS, sfx, toolHarness = 'opencode', fresh = true, onLog = () => {} } = {}) {
  const t0 = Date.now()
  const list = scenarios.map(id => SCENARIOS[id]).filter(Boolean)
  onLog?.(`并行启动 ${list.length} 个场景闭环:${list.map(s => s.id).join(', ')}${fresh ? '(fresh 起点复位)' : ''}`)
  const results = await Promise.all(list.map(s => runScenario(api, s, { sfx, toolHarness, fresh, onLog })))
  const wallS = r2((Date.now() - t0) / 1000)
  const ok = results.every(r => !r.errors.length && r.mission?.attained)
  return { results, wallS, ok }
}
