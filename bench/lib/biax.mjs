/**
 * bench/lib/biax.mjs —— 双拉薄膜产线(BOPET 类)评测段:探测补建 → 多节点建线 → AgentTeam 多节点闭环。
 *
 * 设计要点(与用户诉求一一对应):
 *  1)「PIPELINE 识别 PLC 模拟器是否建出了对应节点,没有则创建」——ensureBiaxLine():
 *     以模拟器预设蓝图(GET /api/presets/biax-line,dry-run,不动现场)为工程清单,
 *     对现场节点做按 id + 信号集 + 协议端口的差分;缺→POST /api/nodes(固定 id 补建),
 *     漂移→PATCH 修复,停机→start;再 PUT /api/plant/config 热态装载双拉物理引擎。
 *     全程不整包 applyPreset——现场已有设备(如 cast-film 线)不被破坏。
 *  2)「系统按真实协议连接节点」——provisionBiaxLine():每设备 /export 的 driverConfig
 *     (Modbus TCP/RTU、OPC UA、MQTT、HTTP 五协议真实链路)建平台 DAQ/DCW 节点;
 *     模拟器信号上的工艺描述(description)原样进平台 semantics → Agent 语义卡。
 *  3)「AgentTeam 对多节点操控闭环优化」——runBiaxMission():任务板下达目标(厚度 25.0±0.7μm),
 *     worker 经 daq_query 读数 → 在 ≥3 个不同执行节点(铸速/纵拉快辊/出口轨宽)上轮流
 *     dcw_control 受治理下发 → 物理随动 → dcw_judge 收口 → 达标判定 + 任务收口。
 */
import { sleep } from './util.mjs'
import { simApi, simNodes, simExport, plantReset } from './sim.mjs'

const SCALAR_TEMPLATE_DAQ = 'daq-temp-tc'
const SCALAR_TEMPLATE_DCW = 'dcw-temp-sp'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const isSp = s => /-sp$/.test(s.id)
const isScalar = s => (s.format ?? 'scalar') === 'scalar'

/** 厚度三执行器(旋钮轮换;shares 偏保守 → 需要 3~4 轮才收敛,保证多节点参与) */
const KNOBS = [
  { sig: 'cast-spd-sp', share: 0.5 },
  { sig: 'fast-roll-sp', share: 0.35 },
  { sig: 'rail-out-sp', share: 0.3 },
]
const THICKNESS_TARGET = 25.0
const THICKNESS_TOL = 0.7

// ─────────────────────────────────────────────────────────────
// (1) 探测 → 补建(不动现场其它设备)
// ─────────────────────────────────────────────────────────────

/** 拉预设蓝图(dry-run 工程清单:期望节点 + 物理模型配置) */
export async function biaxBlueprint() {
  const r = await simApi('GET', '/api/presets/biax-line')
  if (r.status >= 400 || !r.data?.nodes) throw new Error(`蓝图拉取失败: ${r.status} ${r.message}`)
  return r.data
}

/**
 * 幂等建线:识别缺失/漂移并补建/修复,最后热态装载 biax 物理引擎。
 * @returns {{report:object, verified:object}} report = {missing,drifted,repaired,started,untouched} + verified 计数
 */
export async function ensureBiaxLine() {
  const bp = await biaxBlueprint()
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
    const lack = dev.signals.filter(s => !have.has(s.id)).map(s => s.id)
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

  // 端点就绪等待:POST /nodes 的 boot 对 OPC UA 这类重栈可能先于监听返回——
  // 有界轮询(≤12s)等全部期望设备 runtime.running,消除下游 driver 实测的 boot 竞态。
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

  // 物理引擎热态装载(绑定指向上面确保存在的节点;warm=true → 标称工况直起,免冷态预热)
  const pc = await simApi('PUT', '/api/plant/config', { plantModel: bp.plantModel, warm: true })
  if (pc.status >= 400) throw new Error(`biax 物理引擎装载失败: ${pc.message}`)
  // 确定性根修:cast-film 预设的 feedDriftPerMin(0.15,gauss 随机游走)会被引擎继承,
  // 运行时长越长越把 1 区温度随机走出高弹态窗口→破膜(P10 成败交替的根因)。
  // 双拉基准窗口内显式清零随机漂移,保留标称倍率 heaterDecay=1。
  await simApi('POST', '/api/plant/reset', { warm: true, disturbances: { heaterDecay: 1, feedDriftPerMin: 0 } })
  await sleep(1500) // 首拍覆写绑定信号

  // 终验:节点/信号/SP/描述齐备,plant 运行且厚度有限
  const after = await simNodes()
  const biax = after.filter(n => bp.nodes.some(d => d.id === n.id))
  const sigs = biax.flatMap(n => n.signals ?? [])
  const verified = {
    devices: biax.length,
    expectDevices: bp.nodes.length,
    signals: sigs.length,
    sp: sigs.filter(isSp).length,
    pv: sigs.filter(s => !isSp(s) && isScalar(s)).length,
    descMissing: sigs.filter(s => !s.description).length,
    protocols: [...new Set(biax.map(n => n.protocol))],
    plant: pc.data ?? null,
  }
  return { report, verified, blueprint: bp }
}

// ─────────────────────────────────────────────────────────────
// (2) 平台多节点建线(真实协议 driverConfig + 描述 → semantics)
// ─────────────────────────────────────────────────────────────

/** DAQ 监控窗口(配方级,越限报警):按物理量名匹配 */
const DAQ_WINDOWS = {
  biaxThick: [24, 26],
  biaxDefect: [0, 1.5],
  熔体温度: [268, 300],
  实际收卷张力: [55, 120],
  切片残水: [0, 30],
  biaxHaze: [0, 2.5],
  biaxSigma: [0, 1.0],
}

/**
 * 在平台上把双拉全线建成**一条**产线:每设备 /export → 每个 SP 一个 DCW 节点 + 每个
 * 标量 PV 一个 DAQ 节点(全真实协议链路),一个配方纳管全部参数并开跑。
 * @returns {{ids:object, dcw:object, daq:object, driverTests:array, errors:array}}
 */
export async function provisionBiaxLine(api, { sfx }) {
  const devices = (await simNodes()).filter(n => n.id.startsWith('biax-') && n.enabled)
  const errors = []
  const rec = { devices: [], dcw: {}, daq: {}, driverTests: [], errors }

  const line = await api.call('POST', '/api/workshop/dcw/lines', { name: `双拉薄膜产线 biax-${sfx}`, description: 'BOPET 双向拉伸全线数字孪生:干燥→挤出铸片→MDO 纵拉→TDO 横拉→测厚→电晕→收卷' })
  const lineId = line.data?.line?.id
  if (!lineId) { rec.errors.push(`建线失败: ${line.message}`); return rec }
  const product = await api.call('POST', '/api/workshop/dcw/products', { lineId, name: `BOPET-25μm biax-${sfx}` })
  const productId = product.data?.product?.id

  const recipeParams = []
  const daqWindows = []

  for (const dev of devices) {
    const exp = await simExport(dev.id)
    const items = exp?.items ?? []
    const byName = new Map(items.map(i => [i.signal, i]))
    // 每设备取一个代表项做 test-driver 实测(真实协议连通证据)。
    // 节点刚补建/修复后协议端点(尤其 OPC UA 服务端)可能仍在 boot——有界重试 3 次×2s,
    // 终局仍失败才记 ✘(判定口径不变:全部 ok 才 pass)。
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
          name: `${sig.name}·${sfx}`, templateRef: SCALAR_TEMPLATE_DCW,
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
          name: `${sig.name}·${sfx}`, templateRef: SCALAR_TEMPLATE_DAQ,
          driver: dev.protocol, driverConfig: item.driverConfig,
          unit: sig.unit ?? '', min: sig.min ?? 0, max: sig.max ?? 100,
          lineId, intervalMs: 1000, publishIntervalMs: 0,
          semantics: `${sig.description ?? sig.name}(采集,真实 ${dev.protocol} 链路)`,
        })
        const id = q.data?.node?.id
        if (id) {
          rec.daq[sig.id] = id
          const win = DAQ_WINDOWS[sig.name]
          if (win) daqWindows.push({ nodeId: id, min: win[0], max: win[1] })
        }
        else errors.push(`建 DAQ ${sig.id} 失败: ${q.message}`)
      }
    }
    rec.devices.push({ id: dev.id, protocol: dev.protocol, dcw: Object.keys(rec.dcw).length })
  }

  if (!productId || recipeParams.length === 0) { rec.errors.push(...errors); return rec }
  const recipe = await api.call('POST', '/api/workshop/dcw/recipes', {
    productId, name: `BOPET-25μm 标准工艺 biax-${sfx}`,
    description: '双拉全线标准工况(30 参数全窗纳管;厚度规格 25.0±0.8μm)',
    params: recipeParams, daqWindows,
  })
  const recipeId = recipe.data?.recipe?.id
  const st = recipeId ? await api.call('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId }) : null
  rec.ids = { lineId, productId, recipeId, started: st?.status === 200 }
  rec.errors.push(...errors)
  return rec
}

/** 等某个 DAQ 节点出首个样本(有界),返回样本数 */
export async function waitBiaxSamples(api, nodeId, capMs = 30_000) {
  const t0 = Date.now()
  for (;;) {
    const s = await api.call('GET', `/api/workshop/daq/${nodeId}/samples?bucketMs=1000&limit=10`)
    const pts = s.data?.points ?? []
    if (pts.length > 0) return pts.length
    if (Date.now() - t0 > capMs) return 0
    await sleep(2000)
  }
}

// ─────────────────────────────────────────────────────────────
// (3) AgentTeam 多节点闭环(目标驱动;策略确定性,路径与 LLM 完全同一)
// ─────────────────────────────────────────────────────────────

const parseLastFloats = (text, n = 3) => {
  const nums = (String(text).match(/[-+]?\d+\.\d+/g) ?? []).map(Number).filter(Number.isFinite)
  return nums.slice(-n)
}

/** 经平台 REST 读 DAQ 样本均值(权威读数,绕开文本解析歧义;取最近 N 个采样)。
 *  点形状:桶化 = {at, avg, min, max, cnt}(ORDER BY at DESC);非桶化 = {at, value, state}。 */
async function readPvMean(api, nodeId, limit = 5) {
  const s = await api.call('GET', `/api/workshop/daq/${nodeId}/samples?bucketMs=1000&limit=${limit}`)
  const vs = (s.data?.points ?? []).map(p => Number(p.avg ?? p.value)).filter(Number.isFinite)
  return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null
}

/**
 * AgentTeam 优化任务:任务板下达厚度目标 → worker 经工具面在多个执行节点上受治理写 →
 * 物理随动 → 达标收口。返回全轨迹与判定原料。
 */
export async function runBiaxMission(api, { instId, line, simDevices, sfx, maxRounds = 6 }) {
  const ev = []
  const thickDaq = line.daq['biax-thickness']
  const meltDaq = line.daq['melt-temp']
  const out = { writes: 0, distinctNodes: new Set(), records: [], attained: false, thickness: null, parentState: '', boardOk: false, readOk: false, journalOk: false, traj: [] }

  // (1) 任务板:专用 mission channel(mock lead+worker 剧本派发——P4m 同款可靠范式)
  const mch = await api.call('POST', '/api/workshop/channels', { name: `biax-mission-${sfx}`, leadAgent: { name: `blead-${sfx}`, harness: 'mock', config: { delayMs: 40 } } })
  const mchId = mch.data?.channelId ?? mch.data?.channel?.id ?? mch.data?.id
  const mw = await api.call('POST', '/api/workshop/agents', { name: `bworker-${sfx}`, harness: 'mock', config: { delayMs: 60 } })
  await api.call('POST', `/api/workshop/channels/${mchId}/agents`, { agentId: mw.data?.id, role: 'worker' })
  const knobDesc = KNOBS.map(k => `${line.dcw[k.sig]}(${k.sig})`).join(' / ')
  const parent = await api.call('POST', `/api/workshop/channels/${mchId}/tasks`, {
    title: `biax-opt-${sfx}`,
    description: `Biax line mission: bring finished thickness to ${THICKNESS_TARGET}±${THICKNESS_TOL} μm by governing ≥3 actuators (${KNOBS.map(k => k.sig).join(', ')}), ≤${maxRounds} writes, observe via daq_query first.`,
    parts: [{ text: `双拉产线优化任务:把成品厚度收敛到 ${THICKNESS_TARGET}±${THICKNESS_TOL}μm。先 daq_query 读测厚仪,再在 ${knobDesc} 间轮流受治理下发(每次写后等待工艺响应并 dcw_judge),至多 ${maxRounds} 次。` }],
  })
  const parentTask = parent.data?.task?.id ?? parent.data?.id
  let childOfLead = null
  const t0 = Date.now()
  while (Date.now() - t0 < 30_000) {
    const t = (await api.call('GET', `/api/workshop/channels/${mchId}/tasks`)).data ?? []
    childOfLead = t.find(x => x.parentId === parentTask && x.id !== parentTask) ?? null
    if (childOfLead) break
    await sleep(2000)
  }
  out.boardOk = Boolean(parentTask && childOfLead)
  ev.push(`1. task board: channel=${mchId} parent=${parentTask} leadChild=${childOfLead?.id ?? '—'}`)

  // (2) 时段读数(经 worker 工具面;含熔温安全判读)
  const toMs = Date.now(), fromMs = toMs - 5 * 60_000
  const q = await api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: instId, tool: 'daq_query', args: { node_id: thickDaq, from_ms: fromMs, to_ms: toMs, bucket_ms: 1000, limit: 60 } })
  out.readOk = q.data?.result?.isError !== true
  ev.push(`2. daq_query(测厚仪, from/to/bucket): isError=${q.data?.result?.isError === true} · tail=${JSON.stringify(parseLastFloats(String(q.data?.result?.text ?? ''), 3))}`)

  // (3) 读数 → 多节点轮流受治理写 → 物理随动 → 判定
  const sigInfo = new Map()
  for (const dev of simDevices) for (const s of dev.signals ?? []) if (isSp(s)) sigInfo.set(s.id, s)
  let thickness = await readPvMean(api, thickDaq)
  out.thickness = thickness
  out.traj.push({ iter: 0, knob: null, node: null, from: null, to: null, record: null, thickness })
  ev.push(`3. initial thickness=${thickness != null ? thickness.toFixed(2) : '?'} μm(目标 ${THICKNESS_TARGET}±${THICKNESS_TOL})`)
  // (2.5) 起跑健康门:post-provision 瞬态或残留扰动可能压破薄膜(读数 <10μm = 断膜量级)。
  // 偏离目标(如蓝图稳态 28μm)是任务的合法起点,交给闭环写收敛;只有「断膜」才恢复:
  // warm 复位(已零漂移)+ 配方重下,并等待 ≥运输滞后(读数回 >15μm 或 60s),至多 2 次。
  let rebases = 0
  while (thickness != null && thickness < 10 && rebases < 2) {
    rebases++
    const rs = await plantReset({ warm: true, disturbances: { heaterDecay: 1, feedDriftPerMin: 0 } })
    ev.push(`2.5 断膜恢复#${rebases}: warm 复位(${rs.status != null && rs.status < 400 ? '✔' : `✘ ${rs.message ?? ''}`}) + 配方基线重下`)
    await api.call('POST', `/api/workshop/dcw/recipes/${line.ids.recipe}/apply`, {}).catch(() => {})
    for (let w = 0; w < 12; w++) { // 运输滞后 12m+:每 5s 一拍,至多 60s 等膜重新成形
      await sleep(5000)
      thickness = await readPvMean(api, thickDaq)
      if (thickness != null && thickness >= 15) break
    }
    out.thickness = thickness
    out.traj.push({ iter: 0, knob: null, node: null, from: null, to: null, record: null, thickness, note: `post-rebase#${rebases}` })
    ev.push(`2.5 恢复后基线: ${thickness != null ? thickness.toFixed(2) : '?'} μm`)
  }
  for (let i = 0; i < maxRounds && !(thickness != null && Math.abs(thickness - THICKNESS_TARGET) <= THICKNESS_TOL); i++) {
    const knob = KNOBS[i % KNOBS.length]
    const nodeId = line.dcw[knob.sig]
    const sig = sigInfo.get(knob.sig)
    if (!nodeId || !sig) { ev.push(`iter${i + 1}: 旋钮 ${knob.sig} 缺平台节点`); continue }
    if (thickness == null) { ev.push(`iter${i + 1}: 测厚读数缺失,跳过`); continue }
    const err = (thickness - THICKNESS_TARGET) / thickness // >0 = 偏厚
    const rd = await api.call('POST', `/api/workshop/dcw/${nodeId}/read`, {})
    const cur = Number(rd.data?.read?.value ?? rd.data?.value)
    if (!Number.isFinite(cur)) { ev.push(`iter${i + 1}: ${knob.sig} 当前值读取失败`); continue }
    const dec = sig.decimals ?? 2
    const next = Number(clamp(cur * (1 + err * knob.share), sig.min, sig.max).toFixed(dec))
    if (Math.abs(next - cur) < Math.max(10 ** -dec, (sig.max - sig.min) * 0.002)) { ev.push(`iter${i + 1}: ${knob.sig} 变更量过小(cur=${cur}),换下一旋钮`); continue }
    const c = await api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: instId, tool: 'dcw_control', args: { node_id: nodeId, value: next, hypothesis: `biax mission iter ${i + 1}: 厚度 ${thickness.toFixed(2)}μm 偏${err > 0 ? '厚' : '薄'},经 ${knob.sig} 校正 ${cur}→${next}` } })
    if (c.data?.result?.isError === true) { ev.push(`iter${i + 1}: ${knob.sig} 写被拒 → ${String(c.data?.result?.text ?? '').slice(0, 100)}`); continue }
    out.writes++
    out.distinctNodes.add(knob.sig)
    const recordId = (String(c.data?.result?.text ?? '').match(/优化记录\s+([A-Za-z0-9._:-]+)\s+已开窗/) ?? [])[1] ?? null
    if (recordId) out.records.push(recordId)
    // 物理随动:运输滞后(铸片→测厚 ≈8s 实际)+ 一阶收敛;先等最小窗,再等稳定(有界 60s)
    const tw = Date.now()
    let h = thickness
    for (;;) {
      await sleep(4000)
      h = await readPvMean(api, thickDaq)
      const waited = Date.now() - tw
      if (h != null && waited > 12_000 && Math.abs(h - thickness) < 0.08) break // 已稳定在新水平
      if (waited > 60_000) break
    }
    thickness = h ?? thickness
    out.thickness = thickness
    // 断膜卫兵:BOPET 目标 25μm,读数跌破 20% 目标 = 流量/拉伸已在植物侧塌落
    //   (多协议写簇下的模拟器竞态,2026-09-18 P10 实测:泵压→0、速比→1、厚度→0±噪声;
    //   平台侧全部写入均回读一致)。死基线上继续纠偏只会把旋钮推向下限——
    //   先重下配方基线恢复一次,仍死则如实终止。
    if (thickness != null && thickness < THICKNESS_TARGET * 0.2 && !out.rebased) {
      out.rebased = true
      ev.push(`iter${i + 1}: 检出断膜量级读数(${thickness.toFixed(2)}μm << 目标 ${THICKNESS_TARGET}μm)——暂停纠偏,重下配方基线恢复`)
      const ra = await api.call('POST', `/api/workshop/dcw/recipes/${line.ids?.recipeId ?? ''}/apply`, {}).catch(() => null)
      await sleep(15_000)
      const hr = await readPvMean(api, thickDaq)
      thickness = hr ?? thickness
      out.thickness = thickness
      out.traj.push({ iter: `${i + 1}.rebase`, knob: 'recipe-apply', node: line.ids?.recipeId ?? '', from: null, to: null, record: null, thickness })
      ev.push(`iter${i + 1}.rebase: 配方一键下发 ${ra && ra.status === 200 ? '✔' : '✘'} · thickness→${thickness?.toFixed(2) ?? '?'}μm`)
      if (thickness != null && Math.abs(thickness - THICKNESS_TARGET) <= THICKNESS_TOL) break
      if (thickness == null || thickness < THICKNESS_TARGET * 0.2) {
        ev.push(`iter${i + 1}: 基线恢复失败,如实终止(植物侧流量/拉伸异常,非治理写路径或任务数学缺陷)`)
        break
      }
      continue
    }
    let meltNow = null
    if (meltDaq) meltNow = await readPvMean(api, meltDaq, 4)
    out.traj.push({ iter: i + 1, knob: knob.sig, node: nodeId, from: cur, to: next, record: recordId, thickness, meltTemp: meltNow })
    if (recordId) {
      const j = await api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: instId, tool: 'dcw_judge', args: { record_id: recordId, verdict: 'keep', reason: `biax mission iter ${i + 1}: PV=${thickness?.toFixed(2)}μm target=${THICKNESS_TARGET}±${THICKNESS_TOL}` } })
      ev.push(`iter${i + 1}: ${knob.sig} ${cur}→${next} ✔ record=${recordId.slice(0, 10)}… · thickness→${thickness?.toFixed(2)}μm · judge=${j.data?.result?.isError !== true ? 'keep✔' : '✘'}`)
    }
    else ev.push(`iter${i + 1}: ${knob.sig} ${cur}→${next} ✔ record 未开(异常)`)
    if (meltNow != null) ev.push(`        meltTemp=${meltNow.toFixed(1)}℃(安全窗 268~300)`)
  }
  out.attained = out.thickness != null && Math.abs(out.thickness - THICKNESS_TARGET) <= THICKNESS_TOL

  // (4) 账本归因(多节点抽查:铸速)
  const jn = await api.call('POST', '/api/workshop/agent-tools/invoke', { agentId: instId, tool: 'dcw_journal', args: { node_id: line.dcw['cast-spd-sp'], limit: 10 } })
  out.journalOk = jn.data?.result?.isError !== true && /Agent|agent/.test(String(jn.data?.result?.text ?? ''))
  ev.push(`4. journal(铸速节点)归因 Agent: ${out.journalOk ? '✔' : '✘'} · ${String(jn.data?.result?.text ?? '').slice(0, 120)}`)
  ev.push(`5. outcome: writes=${out.writes} distinctKnobs=${out.distinctNodes.size} final=${out.thickness?.toFixed(2) ?? '?'}μm attained=${out.attained}`)

  // (5) 任务收口(mock 剧本)
  {
    const dl = Date.now() + 90_000
    while (parentTask && Date.now() < dl) {
      await sleep(3000)
      const t = (await api.call('GET', `/api/workshop/tasks/${parentTask}`)).data ?? {}
      out.parentState = t.state ?? t.task?.state ?? ''
      if (['COMPLETED', 'FAILED', 'CANCELED'].includes(out.parentState)) break
    }
  }
  ev.push(`6. task terminal=${out.parentState || '(timeout)'}`)
  out.ev = ev
  out.distinctCount = out.distinctNodes.size
  return out
}
