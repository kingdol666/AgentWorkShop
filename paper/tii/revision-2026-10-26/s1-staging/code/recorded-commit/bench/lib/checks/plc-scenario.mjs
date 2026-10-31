/**
 * plc-scenario —— 真实协议产线工况场景（tier plc，对接 plc-node-simulator 项目）。
 * S0 模拟器就绪+薄膜产线预设 → S1 五协议真实连通(导出 driverConfig→test-driver)
 *   → S2 真实采样落库 + SP→PV 物理闭环 + 真实链路治理(F5/边界, Modbus TCP)
 *   → S3 断链-恢复演练。全部走真实协议栈（Modbus TCP :16040 等五协议端点），非 mock。
 */
import { result, skip, sleep } from '../util.mjs'

const SIM = process.env.SIM_BASE ?? 'http://127.0.0.1:4010'
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const T = 'plc'

async function simApi(method, path, body) {
  // 网络层瞬断（本机代理 churn 造成回环临时端口间歇耗尽 → fetch failed）用退避重试吸收；
  // HTTP 语义错误不重试。与 lib/sim.mjs、lib/util.mjs 的瞬断策略一致。
  let lastErr
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch(`${SIM}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
      const json = await res.json().catch(() => null)
      return { status: res.status, data: json?.data ?? json, message: json?.message ?? '' }
    } catch (err) {
      lastErr = err
      if (attempt < 8) await sleep(Math.min(800 * 2 ** (attempt - 1), 8000))
    }
  }
  throw lastErr
}

const meta0 = { id: 'plc-0-simulator', title: 'PLC 模拟器就绪+薄膜产线预设', tier: T, dims: ['D1'], weight: 1, requires: [] }
const meta1 = { id: 'plc-1-realpath', title: '五协议真实连通(导出配置→test-driver)', tier: T, dims: ['D1', 'D6'], weight: 2, requires: ['sim', 'server'] }
const meta2 = { id: 'plc-2-closedloop', title: '真实采样+SP→PV 物理闭环+真实链路治理', tier: T, dims: ['D1', 'D2', 'D8'], weight: 3, requires: ['sim', 'server'] }
const meta4 = { id: 'plc-4-fault', title: '断链-恢复演练', tier: T, dims: ['D1'], weight: 1, requires: ['sim', 'server'] }

export default [
  {
    meta: meta0,
    async run(ctx) {
      try {
        // 无条件施加 film-line 预设（幂等）：cast-film 场景同样五协议齐备，
        // 不能以「协议齐」判定场景正确——否则上游流水线把模拟器停在 cast-film 时,
        // 本层会静默打到错误产线（SP 写命中 zone1-sp@40021、PV 读 plant-model melt-temp）。
        const ap = await simApi('POST', '/api/presets/film-line')
        if (ap.status >= 400) return skip(meta0.id, meta0, `模拟器可达但预设应用失败: ${ap.message}`)
        let nodes = (await simApi('GET', '/api/nodes')).data ?? []
        await sleep(2000)
        const protos = () => [...new Set(nodes.filter(n => n.enabled).map(n => n.protocol))]
        // 场景身份校验：film-line 的 modbus-tcp 设备必须携带 temp-pv 信号域
        const mb = nodes.find(n => n.protocol === 'modbus-tcp' && n.enabled)
        const filmDomain = Boolean(mb?.signals?.some(sg => sg.id === 'temp-pv'))
        if (!filmDomain) {
          return result(meta0.id, meta0, 'fail', 0, { protocols: protos().length, sim: SIM },
            [`modbus-tcp 设备缺少 temp-pv 信号域，film-line 预设未生效（设备: ${mb?.id ?? '—'}）`], '预设未生效，场景身份不符')
        }
        ctx.sim = { nodes, byProto: p => nodes.find(n => n.protocol === p && n.enabled) }
        ctx.simUp = true
        const ps = protos()
        return result(meta0.id, meta0, ps.length >= 5 ? 'pass' : 'warn', ps.length >= 5 ? 1 : 0.6,
          { protocols: ps.length, sim: SIM }, [`五协议设备: ${ps.join(', ')}`], '模拟器就绪(film-line 预设)')
      } catch (err) {
        return skip(meta0.id, meta0, `PLC 模拟器 ${SIM} 不可达(${String(err?.cause?.code ?? err?.message ?? err)})——请先启动: cd plc-node-simulator && npm run dev`)
      }
    },
  },
  {
    meta: meta1,
    async run(ctx) {
      const ev = []
      let okN = 0
      for (const p of ['modbus-tcp', 'modbus-rtu', 'opcua', 'mqtt', 'http']) {
        const dev = ctx.sim.byProto(p)
        if (!dev) { ev.push(`✘ ${p} 设备缺失`); continue }
        const exp = await simApi('GET', `/api/nodes/${dev.id}/export`)
        const item = (exp.data?.items ?? [])[0]
        if (!item?.driverConfig) { ev.push(`✘ ${p} 导出缺 driverConfig`); continue }
        ctx.sim[`export_${p}`] = exp.data
        const t0 = performance.now()
        // OPC UA 等服务端在长跑后会话过期窗口内可能拒绝新连接(瞬态)——单次重试
        let t = await ctx.api.call('POST', '/api/workshop/daq/test-driver', { driver: p === 'modbus-rtu' ? 'modbus-rtu' : p, driverConfig: item.driverConfig })
        if ((t.data?.test?.ok ?? t.data?.ok) !== true) { await sleep(800); t = await ctx.api.call('POST', '/api/workshop/daq/test-driver', { driver: p === 'modbus-rtu' ? 'modbus-rtu' : p, driverConfig: item.driverConfig }) }
        const ms = Math.round(performance.now() - t0)
        if ((t.data?.test?.ok ?? t.data?.ok) === true) { okN++; ev.push(`✔ ${p} 真实连通 ok (${ms}ms)`) } else { ev.push(`✘ ${p} 连通失败: ${String(t.data?.test?.message ?? t.message).slice(0, 60)}`) }
        await sleep(150)
      }
      const score = okN / 5
      return result(meta1.id, meta1, score === 1 ? 'pass' : score >= 0.6 ? 'warn' : 'fail', score,
        { protocols_ok: okN, total: 5 }, ev, score === 1 ? '五协议真实栈全部连通' : '部分协议未连通')
    },
  },
  {
    meta: meta2,
    async run(ctx) {
      const mbtcp = ctx.sim.byProto('modbus-tcp')
      const exp = ctx.sim['export_modbus-tcp'] ?? (await simApi('GET', `/api/nodes/${mbtcp.id}/export`)).data
      const spItem = (exp?.items ?? []).find(i => /temp-sp/i.test(i.signal)) ?? (exp?.items ?? []).find(i => /SP/i.test(i.signal)) ?? (exp?.items ?? [])[0]
      const pvItem = (exp?.items ?? []).find(i => /temp-pv/i.test(i.signal)) ?? (exp?.items ?? []).find(i => !/SP/i.test(i.signal)) ?? spItem
      const sfx = `plc${ctx.seed.toString(36)}${ctx.rep ?? 0}${Date.now().toString(36).slice(-4)}`
      const api = ctx.api
      const line = await api.call('POST', '/api/workshop/dcw/lines', { name: `PLC线 ${sfx}` })
      const lineId = line.data?.line?.id
      const product = await api.call('POST', '/api/workshop/dcw/products', { lineId, name: `PLC产品 ${sfx}` })
      const dcw = await api.call('POST', '/api/workshop/dcw', { name: `PLC炉温SP ${sfx}`, templateRef: 'dcw-temp-sp', driver: 'modbus-tcp', driverConfig: spItem.driverConfig, lineId })
      const nodeId = dcw.data?.node?.id
      const daq = await api.call('POST', '/api/workshop/daq', { templateRef: 'daq-temp-tc', name: `PLC熔温PV ${sfx}`, driver: 'modbus-tcp', driverConfig: pvItem.driverConfig, lineId, intervalMs: 800, publishIntervalMs: 0 })
      const daqId = daq.data?.node?.id
      const recipe = await api.call('POST', '/api/workshop/dcw/recipes', { productId: product.data?.product?.id, name: `PLC工艺 ${sfx}`, params: [{ nodeId, value: 180, min: 176, max: 188 }], daqWindows: daqId ? [{ nodeId: daqId, min: 176, max: 188 }] : [] })
      await api.call('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId: recipe.data?.recipe?.id })
      // 网关总控走 controller（早先误用不存在的 /daq/gateway/start 与 /daq/{id}/enable|start，
      // 三处均 404 且静默忽略 —— 采样实际由 ensureLoop + 活动批次门控驱动，属"看似调了实则没调"）
      await api.call('POST', '/api/workshop/daq/controller', { action: 'start' })
      if (daqId) await api.call('PATCH', `/api/workshop/daq/${daqId}`, { enabled: true })
      ctx.teardownStack.push(async () => {
        await api.call('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {}).catch(() => {})
        if (daqId) await api.call('PATCH', `/api/workshop/daq/${daqId}`, { enabled: false }).catch(() => {})
      })
      if (!nodeId || !daqId) return result(meta2.id, meta2, 'fail', 0, {}, ['真实夹具创建失败'], '夹具失败')
      const tScenario = Date.now()

      // (1) 真实采样落库(Modbus TCP ~895ms 节拍)
      // 确定性初值:把 PV 策略重置为 initial=186 → 随后的治理写 182 让"阶跃沉降"
      // 落在采样窗内(否则预设早已衰减到位,trace 是平线,阶跃不可观测)。
      // 请求体必须是裸 {strategy}(路由 readBody 取 body.strategy;{body:...} 包装会 400 静默失败)。
      await simApi('POST', `/api/nodes/${mbtcp.id}/signals/temp-pv/strategy`, { strategy: { kind: 'first-order', initial: 186, tauMs: 8000, sp: 186, noise: 0.25 } })
      await sleep(9000)
      const s = await api.call('GET', `/api/workshop/daq/${daqId}/samples?bucketMs=1000&limit=50`)
      const points = s.data?.points ?? []
      const sampled = points.length > 0

      // (2) 真实写 SP=182(Modbus FC06) + 回读
      const t0 = performance.now()
      const w = await api.call('POST', `/api/workshop/dcw/${nodeId}/write`, { value: 182 })
      const writeMs = Math.round(performance.now() - t0)
      const writeOk = w.status === 200
      const rd = await api.call('POST', `/api/workshop/dcw/${nodeId}/read`, {})
      const spNow = rd.data?.read?.value ?? rd.data?.value
      const readbackOk = writeOk && typeof spNow === 'number' && Math.abs(spNow - 182) <= 0.7

      // (3) 真实链路治理: F5 攻击 + 边界(活动配方窗 [176,188])
      const attacks = [200, 400, 150, 188.1, 175.9]
      let rejected = 0
      for (const v of attacks) {
        const r = await api.call('POST', `/api/workshop/dcw/${nodeId}/write`, { value: v })
        if (r.status >= 400) rejected++
        await sleep(150)
      }
      const legal = await api.call('POST', `/api/workshop/dcw/${nodeId}/write`, { value: 180 })
      const legalOk = legal.status === 200
      const governanceOk = rejected === attacks.length && legalOk

      // (4) SP→PV 物理闭环(模拟器一阶惯性 τ≈8s): 轮询 PV 至 |PV-182|≤3
      const pvSig = (mbtcp.signals ?? []).find(sg => sg.id === 'temp-pv')
      const spSig = (mbtcp.signals ?? []).find(sg => sg.id === 'temp-sp')
      let pv = null, convergeS = null
      const t1 = Date.now()
      while (Date.now() - t1 < 45000) {
        await sleep(3000)
        const nd = (await simApi('GET', '/api/nodes')).data?.find(n => n.id === mbtcp.id)
        pv = nd?.signals?.find(sg => sg.id === pvSig?.id)?.value
        if (typeof pv === 'number' && Math.abs(pv - 182) <= 3) { convergeS = Math.round((Date.now() - t1) / 1000); break }
      }

      // (4.5) F2 工艺冻结注入(纵深防御, 真实链路): manual 覆写冻结 PV 于窗外
      //   治理写(寄存器回读)仍成功 —— 回读闭包只验证寄存器接收;
      //   工艺层失效由独立监测层捕获: PV 出配方窗 → 数拍内报警
      let f2Alarm = false, f2AlarmS = null
      const f2ev = []
      if (pvSig) {
        // 报警落库对「同节点同量未确认」幂等：建点上升沿可能已留了一条未确认旧报警，
        // 不先 ack 会抑制冻结沿的新报警（实测踩过）。此刻 PV≈182 在窗内、state=ok，ack 后沿可重触发。
        const open0 = await api.call('GET', '/api/workshop/daq/alarms?scope=open&limit=200')
        for (const a of (open0.data?.alarms ?? []).filter(x => x.nodeId === daqId)) {
          await api.call('POST', `/api/workshop/daq/alarms/${a.id}/ack`, {}).catch(() => {})
        }
        // 请求体必须是裸 {value}（路由 readBody 取 body.value；{body:{...}} 包装会 400 静默失败——实测踩过）
        await simApi('POST', `/api/nodes/${mbtcp.id}/signals/${pvSig.id}/manual`, { value: 150 })
        await sleep(300)
        await api.call('POST', `/api/workshop/dcw/${nodeId}/write`, { value: 185 })
        const t2 = Date.now()
        while (Date.now() - t2 < 15000) {
          await sleep(1500)
          const al = await api.call('GET', '/api/workshop/daq/alarms?scope=open&limit=200')
          // 只认本 DAQ 节点在 ack 之后新 raised 的报警——旧报警已 ack，不会再凑数
          const hit = (al.data?.alarms ?? []).find(a => a.nodeId === daqId && Date.parse(a.createdAt ?? 0) >= t2 - 1500)
          if (hit) { f2Alarm = true; f2AlarmS = Math.round((Date.now() - t2) / 1000); break }
        }
        const pvNow2 = ((await simApi('GET', '/api/nodes')).data ?? []).find(n => n.id === mbtcp.id)?.signals?.find(sg => sg.id === pvSig?.id)?.value
        f2ev.push(`治理写 185℃(回读验证通过, 寄存器接收) 但 PV 冻结于 150℃(窗外) `)
        f2ev.push(`${f2Alarm ? '✔' : '✘'} 独立监测层在 ${f2AlarmS ?? '>15'}s 内触发本节点配方窗报警(纵深防御: 回读闭包不覆盖工艺响应)`)
        await simApi('POST', `/api/nodes/${mbtcp.id}/signals/${pvSig.id}/strategy`, { strategy: { kind: 'first-order', initial: typeof pvNow2 === 'number' ? pvNow2 : 180, tauMs: 8000, sp: 186, noise: 0.25 } })
        await sleep(300)
      }
      const daqAfter = await api.call('GET', `/api/workshop/daq/${daqId}/samples?bucketMs=1000&limit=200`)
      const totalPts = (daqAfter.data?.points ?? []).length
      const pvTrace = (daqAfter.data?.points ?? []).map(pt => ({ t: Math.round((((pt.at ?? 0) - tScenario) / 100) / 10), pv: pt.avg }))

      const score = (sampled ? 0.2 : 0) + (writeOk ? 0.1 : 0) + (readbackOk ? 0.1 : 0) + (governanceOk ? 0.2 : 0) + (convergeS != null ? 0.1 : 0) + (totalPts > points.length ? 0.1 : 0) + (f2Alarm ? 0.2 : 0)
      return result(meta2.id, meta2, score >= 0.9 ? 'pass' : score >= 0.6 ? 'warn' : 'fail', score,
        { real_samples_first_window: points.length, real_write_ok: writeOk, real_write_latency_ms: writeMs, sp_readback: typeof spNow === 'number' ? spNow : 'n/a', f5_rejected: `${rejected}/${attacks.length}`, legal_write_ok: legalOk, pv_converge_s: convergeS ?? 'timeout', pv_final: typeof pv === 'number' ? Number(pv.toFixed(1)) : 'n/a', f2_pv_freeze_alarm: f2Alarm, f2_alarm_latency_s: f2AlarmS, pv_trace: pvTrace, daq_points_total: totalPts },
        [
          `${sampled ? '✔' : '✘'} 真实 Modbus TCP 采样落库 ${points.length} 点(~895ms 节拍)`,
          `${writeOk ? '✔' : '✘'} 真实 SP 写 182℃ → HTTP ${w.status} (${writeMs}ms, 含 Modbus 事务)`,
          `${governanceOk ? '✔' : '✘'} 真实链路治理: 攻击 ${rejected}/${attacks.length} 拒绝(200/400/150/188.1/175.9), 合法 180 ${legalOk ? '受理' : '被拦'}`,
          convergeS != null ? `✔ SP→PV 物理闭环收敛 |PV-182|≤3℃ 用时 ${convergeS}s(一阶惯性)` : '▲ PV 45s 未收敛(τ≈8s 一阶应≈25s)',
          ...f2ev,
          `闭环期间时序库持续采集: 累计 ${totalPts} 点`,
        ],
        '真实协议工况闭环: 写控→Modbus→物理引擎→数采回读→治理拦截→F2 假成功消融')
    },
  },
  {
    meta: meta4,
    async run(ctx) {
      const mbtcp = ctx.sim.byProto('modbus-tcp')
      if (!mbtcp) return result(meta4.id, meta4, 'skip', 0, {}, [], '模拟器设备缺失')
      const cfg = ctx.sim['export_modbus-tcp']?.items?.[0]?.driverConfig
      await simApi('POST', `/api/nodes/${mbtcp.id}/stop`)
      await sleep(1500)
      const t = await ctx.api.call('POST', '/api/workshop/daq/test-driver', { driver: 'modbus-tcp', driverConfig: cfg })
      const detected = (t.data?.test?.ok ?? t.data?.ok) === false
      await simApi('POST', `/api/nodes/${mbtcp.id}/start`)
      await sleep(1500)
      const t2 = await ctx.api.call('POST', '/api/workshop/daq/test-driver', { driver: 'modbus-tcp', driverConfig: cfg })
      const recovered = (t2.data?.test?.ok ?? t2.data?.ok) === true
      const score = (detected ? 0.5 : 0) + (recovered ? 0.5 : 0)
      return result(meta4.id, meta4, score === 1 ? 'pass' : 'warn', score,
        { offline_detected: detected, reconnected: recovered },
        [
          `${detected ? '✔' : '✘'} 断链后主项目驱动失败被感知(test-driver ok=false)`,
          `${recovered ? '✔' : '✘'} 模拟器重启后重连成功(test-driver ok=true)`,
        ],
        '断链演练: 故障被感知且可恢复(F3 微缩版, 真实 TCP)')
    },
  },
]
