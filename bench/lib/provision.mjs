/**
 * bench/lib/provision.mjs —— 多产线供给：把一个模拟器设备变成一条平台产线（或挂到既有产线上）。
 *
 * 平台的两条硬约束（本项目实测得出，务必遵守）：
 *  1) DAQ 采样被「活动产线批次（LineRun）」门控 —— 没有开跑的配方，节点即便 enabled 也不采
 *     （daq-controller.sweep: `if (!host.lineRun.activeRun(node.lineId)) continue`）。
 *  2) 开跑要求「配方归属本产线产品**且含工艺参数（params）**」——纯采集设备（无 SP 写点）
 *     无法自成一条可开跑的产线。
 *
 * 因此建模为：
 *  - 有 SP 写点的设备 → 独占一条产线：line + product + DAQ + DCW + recipe(params) + 开跑；
 *  - 无 SP 写点的设备 → **卫星数采**：DAQ 节点挂到第一条可开跑产线的 lineId 上，
 *    随该产线的活动批次一起采样（真实产线里计数/称重类传感器也多是挂线式的）。
 *
 * 驱动配置全部取自模拟器 /export（driverConfig 不手抄）；网关启停由 pipeline 统一处理。
 */
import { sleep } from './util.mjs'
import { simExport, splitSignals } from './sim.mjs'

const SCALAR_TEMPLATE_DAQ = 'daq-temp-tc' // → daqKeyFromRef 归一化为 'temp-tc'
const SCALAR_TEMPLATE_DCW = 'dcw-temp-sp' // → dcwKeyFromRef 归一化为 'temp-sp'

const pick = (items, predicate) => (items ?? []).find(predicate)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** 该设备是否有可写设定值（决定它是"自成产线"还是"卫星数采"） */
export const hasSetpoint = (device) => Boolean(splitSignals(device).dcw)

/**
 * 供给一条产线（或把设备作为卫星数采挂到 hostLine 上）。
 * @param hostLine 卫星模式下的宿主产线记录（须已有 ids.line / ids.product / 已开跑）
 * @returns {Promise<object>} line 记录（含 platform ids、sim 设备、节点、窗口、导出证据）
 */
export async function provisionLine(api, { device, sfx, index, hostLine = null }) {
  const { dcw: dcwSig, daq: daqSig } = splitSignals(device)
  const exp = await simExport(device.id)
  const items = exp?.items ?? []
  // 标量可采项：向量/图像端点（profile/ccd 帧）不能作为标量 DAQ，必须剔除
  const scorable = (it) => it && it.format !== 'vector' && it.format !== 'image'
  const byName = (sig) => (sig ? pick(items, i => i.signal === sig.name) : null)
  const dcwCand = byName(dcwSig)
  const dcwItem = scorable(dcwCand) ? dcwCand : null

  // DAQ 逐候选实测（POST /api/workshop/daq/test-driver）：取第一个「标量取值可提取」的项，
  // 首选语义匹配信号；实测同时作为对接证据（避免"配好了却采不到"的静默失败）。
  const preferred = byName(daqSig)
  const ordered = [preferred, ...items.filter(i => i !== preferred)].filter(scorable)
  let daqItem = null, daqTest = null
  for (const it of ordered) {
    if (it === dcwItem) continue
    const t = await api.call('POST', '/api/workshop/daq/test-driver', { driver: it.driver, driverConfig: it.driverConfig })
    const test = t.data?.test ?? {}
    const scalarOk = test.ok !== false && (test.sampleValue == null || Number.isFinite(Number(test.sampleValue)))
    if (!daqItem) { daqItem = it; daqTest = test } // 兜底：至少留一个候选
    if (scalarOk) { daqItem = it; daqTest = test; break } // 优先：标量可采
  }

  // 卫星模式：该设备**没有可用的 DCW 导出**（有 SP 信号但无导出项 = 建不了写控/配方）
  // + 有宿主产线 → 只建 DAQ，复用宿主 line/product，随宿主批次采样。
  // （例：cast-film 的 mqtt 设备只有 thick 一个 topic，linespeed-sp 没有导出项）
  const canOwn = Boolean(dcwSig && dcwItem?.driverConfig)
  const satellite = Boolean(hostLine) && !canOwn

  const rec = {
    index, protocol: device.protocol, simDeviceId: device.id, simDeviceName: device.name,
    dcwSignal: dcwSig?.id ?? null, daqSignal: daqItem?.signal ?? daqSig?.id ?? null,
    satellite, hostLineIndex: satellite ? hostLine.index : null,
    driverTest: daqTest ? { ok: daqTest.ok !== false, message: daqTest.message ?? '' } : null,
    exports: {}, node: {}, ids: {}, window: null, errors: [],
  }
  if (!daqItem?.driverConfig) { rec.errors.push(`设备 ${device.id} 无可用标量 DAQ 导出`); return rec }

  // ── 平台：产线 + 产品（卫星复用宿主）──
  if (satellite) {
    rec.ids.line = hostLine.ids.line
    rec.ids.product = hostLine.ids.product
    rec.ids.recipe = hostLine.ids.recipe
  }
  else {
    const line = await api.call('POST', '/api/workshop/dcw/lines', { name: `Integrated线${index} ${sfx}` })
    rec.ids.line = line.data?.line?.id
    if (!rec.ids.line) { rec.errors.push(`建线失败: ${line.message}`); return rec }
    const product = await api.call('POST', '/api/workshop/dcw/products', { lineId: rec.ids.line, name: `Integrated产品${index} ${sfx}` })
    rec.ids.product = product.data?.product?.id
  }

  // ── DAQ 节点（真实协议驱动，挂在目标产线 lineId 上）──
  const daqUnit = daqSig?.unit ?? '℃'
  const daq = await api.call('POST', '/api/workshop/daq', {
    name: `L${index}-DAQ-${device.protocol} ${sfx}${satellite ? '(sat)' : ''}`,
    templateRef: SCALAR_TEMPLATE_DAQ,
    driver: device.protocol, driverConfig: daqItem.driverConfig,
    unit: daqUnit, min: daqSig?.min ?? 0, max: daqSig?.max ?? 100,
    lineId: rec.ids.line, intervalMs: 1000, publishIntervalMs: 0,
    semantics: `模拟器设备「${device.name}」的 ${daqSig?.name ?? 'process quantity'}（真实 ${device.protocol} 链路）`,
  })
  rec.ids.daq = daq.data?.node?.id
  rec.exports.daq = daqItem.driverConfig
  if (!rec.ids.daq) rec.errors.push(`建 DAQ 失败(${device.protocol}): ${daq.message}`)

  // ── DCW 节点 + 配方 + 开跑（仅"自成产线"且确有可用 DCW 导出）──
  if (!satellite && canOwn) {
    const lo = dcwSig.min ?? 0, hi = dcwSig.max ?? 100
    const span = hi - lo
    const target = clamp(Number(dcwSig.value ?? dcwSig.runtime?.value ?? (lo + hi) / 2), lo, hi)
    const win = { min: Math.max(lo, target - span * 0.06), max: Math.min(hi, target + span * 0.06) }
    const dcw = await api.call('POST', '/api/workshop/dcw', {
      name: `L${index}-DCW-${device.protocol} ${sfx}`, templateRef: SCALAR_TEMPLATE_DCW,
      driver: device.protocol, driverConfig: dcwItem.driverConfig,
      unit: dcwSig.unit ?? '℃', min: lo, max: hi, decimals: dcwSig.decimals ?? 2,
      lineId: rec.ids.line, holdIntervalMs: 0,
      semantics: `模拟器设备「${device.name}」的 ${dcwSig.name}（真实 ${device.protocol} 写控）`,
    })
    rec.ids.dcw = dcw.data?.node?.id
    rec.exports.dcw = dcwItem.driverConfig
    rec.window = win
    rec.setpoint = { lo, hi, center: target, decimals: dcwSig.decimals ?? 2 }
    if (!rec.ids.dcw) rec.errors.push(`建 DCW 失败(${device.protocol}): ${dcw.message}`)

    if (rec.ids.dcw) {
      const recipe = await api.call('POST', '/api/workshop/dcw/recipes', {
        productId: rec.ids.product, name: `Integrated工艺${index} ${sfx}`, description: 'integrated pipeline',
        params: [{ nodeId: rec.ids.dcw, value: target, min: Number(win.min.toFixed(3)), max: Number(win.max.toFixed(3)) }],
        daqWindows: rec.ids.daq ? [{ nodeId: rec.ids.daq, min: win.min, max: win.max }] : [],
      })
      rec.ids.recipe = recipe.data?.recipe?.id
      if (rec.ids.recipe) {
        const st = await api.call('POST', `/api/workshop/dcw/lines/${rec.ids.line}/start`, { recipeId: rec.ids.recipe })
        rec.started = st.status === 200
        if (!rec.started) rec.errors.push(`开跑失败: ${st.message}`)
      }
      else rec.errors.push(`建配方失败: ${recipe.message}`)
    }
  }
  else if (satellite) {
    rec.started = Boolean(hostLine.started) // 随宿主批次采样
  }

  rec.teardown = async () => {
    if (!satellite && rec.ids.line) await api.call('POST', `/api/workshop/dcw/lines/${rec.ids.line}/stop`, {}).catch(() => {})
    if (rec.ids.daq) await api.call('PATCH', `/api/workshop/daq/${rec.ids.daq}`, { enabled: false }).catch(() => {})
  }
  await sleep(400)
  return rec
}

/** 采集总控：确保网关 running（幂等；POST /api/workshop/daq/controller） */
export async function ensureGateway(api) {
  const r = await api.call('POST', '/api/workshop/daq/controller', { action: 'start' })
  return r.status === 200
}

/** 取一组稳定的标量需求：每个协议一个设备（有 SP 的优先，保证"可开跑产线"占先） */
export function pickProtocolDevices(nodes, protocols = ['modbus-tcp', 'modbus-rtu', 'opcua', 'mqtt', 'http']) {
  const used = new Set()
  const out = []
  for (const p of protocols) {
    const d = (nodes ?? []).find(n => n.protocol === p && !used.has(n.id))
    if (d) { used.add(d.id); out.push(d) }
  }
  // 稳定排序：有 SP 写点的设备排前，使前 N 条都是可开跑的真实产线
  return out.map((d, i) => ({ d, i })).sort((a, b) => (hasSetpoint(b.d) - hasSetpoint(a.d)) || (a.i - b.i)).map(x => x.d)
}
