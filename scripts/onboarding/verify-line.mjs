/**
 * scripts/onboarding/verify-line.mjs —— 接入验收(skill 阶段5;未全绿不得宣告完成)。
 * 断言面:
 *  V1 数采落库:每个 daq 节点 2 分钟窗内 samples 有点(五协议真实在采)
 *  V2 量程联锁:对每个 dcw 节点做越界写(max+步长量级)必须被 400 拒(NODE_RANGE/RANGE 类)
 *  V3 合法写回环:max- 步长量级的合法值写成功且回读一致(manual 来源,审计留痕)
 *    命令通道本身无读能力的协议(MQTT commandTopic 等)按平台 ACK 口径显式声明
 *    `ackMode:"transport-ack"` + `observeDaqId`:断言写被 broker 受理,并用独立 DAQ
 *    节点观测物理量跟随到目标值(设备侧生效由观测面证实,而非虚报回读)。
 *  V4 配方在册:recipeId 在 /dcw 聚合可见且参数节点映射正确
 *  V5 频道绑定:频道 lineId 正确、成员≥2、插件开启生效
 *  V6 受保护线保留 journal 前后不变(不能证明零扰动)
 * 输入 JSON:
 * {
 *   "lineId":"ln-..","recipeId":"rc-..","channelId":"<uuid>",
 *   "dcw":[{"id":"dw-..","name":"..","min":120,"max":300,"stepLimit":5,"probeValue":180,
 *           "ackMode":"transport-ack","observeDaqId":"dn-.."}],
 *   "daq":["dn-..","dn-.."],
 *   "plugins":["idd-closedloop-bridge","rag-bridge"]
 * }
 * 用法:node scripts/onboarding/verify-line.mjs <config.json|->
 */
import { api, BASE, login, ok, summary, readConfig, pollUntil, PROTECTED, assertNotProtected, assertOnboardingOwnership, assertDriverEndpointsAttested } from './lib.mjs'
import { checkedGet, readProtectedSnapshot } from './v6-protected-api.mjs'
import { evaluateProtectedFixture } from './v6-protected-fixture.mjs'

async function main() {
  const cfg = await readConfig()
  await assertOnboardingOwnership(cfg)
  if (typeof cfg.lineId !== 'string' || !cfg.lineId.trim()) throw new Error('目标产线 ID 缺失')
  assertNotProtected(cfg.lineId, '目标产线')
  if (cfg.dcw !== undefined && !Array.isArray(cfg.dcw)) throw new Error('dcw 必须是数组')
  const tok = await login()

  // Capture and validate the protected journal before any acceptance writes.
  const PROTECTED_LINE = PROTECTED[0]
  const JOURNAL_LIMIT = 500
  const snapshotOptions = { base: BASE, token: tok, lineId: PROTECTED_LINE, limit: JOURNAL_LIMIT }
  const protectedBefore = await readProtectedSnapshot(snapshotOptions)
  const preflightV6 = evaluateProtectedFixture({ before: protectedBefore, after: protectedBefore, lineId: PROTECTED_LINE, limit: JOURNAL_LIMIT })
  if (preflightV6.status === 'FAIL') {
    console.error(`V6 受保护线保留 journal 完整性 — FAIL: ${preflightV6.reason}`)
    process.exitCode = 1
    return
  }

  // Neither a line label nor loopback proves that the endpoint belongs to a simulator.
  // Even built-in driver names can be overridden by plugins at runtime.
  if (cfg.dcw?.length) {
    const targets = protectedBefore.lines.filter(line => line.id === cfg.lineId)
    if (targets.length !== 1 || targets[0].simulated !== true) {
      throw new Error(`V2/V3 写入拒绝:目标产线 ${cfg.lineId} 必须唯一且 simulated=true`)
    }
  }

  // Resolve every target before any V2/V3 write, including nodes not present in the journal.
  for (const n of cfg.dcw ?? []) {
    if (!n || typeof n.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(n.id)) throw new Error('无效的写控节点 ID')
    const { node } = await checkedGet({ base: BASE, token: tok, path: `/api/workshop/dcw/${encodeURIComponent(n.id)}` })
    if (!node || typeof node !== 'object' || Array.isArray(node) || node.id !== n.id
      || typeof node.lineId !== 'string' || node.lineId !== cfg.lineId) {
      throw new Error(`写控节点 ${n.id} 不属于目标产线 ${cfg.lineId}`)
    }
    assertNotProtected(node.lineId, '写控节点产线')
    if (typeof node.driver !== 'string' || !node.driver || !node.driverConfig
      || typeof node.driverConfig !== 'object' || Array.isArray(node.driverConfig)) {
      throw new Error(`V2/V3 写入拒绝:节点 ${n.id} 缺少驱动或端点配置`)
    }
    // 实时节点 driverConfig 的端点绑定复核(配置可能被改指他处;以实时面为准):
    // host 必须环回,端口必须落在本次归属证明的端口集内,缺端口不可证明。
    assertDriverEndpointsAttested(node.driverConfig, `节点 ${n.id}`)
  }

  // V1 数采落库(滑动窗口:每次轮询重算 now,避免 to=启动时刻冻结导致新样本落窗外)。
  // 多形态节点(向量/图像)数据在 daq_frames 不在 daq_samples:标量面 60s 内无点时回查帧面。
  for (const id of cfg.daq ?? []) {
    try {
      await pollUntil(async () => {
        const now = Date.now()
        const j = await api('GET', `/api/workshop/daq/${id}/samples?from=${now - 90000}&to=${now}&bucketMs=30000`, undefined, tok)
        if ((j.data?.points ?? []).length > 0) return true
        const f = await api('GET', `/api/workshop/daq/${id}/frames?from=${now - 120000}&to=${now}&limit=1`, undefined, tok).catch(() => null)
        return (f?.data?.frames ?? f?.data ?? []).length > 0
      }, { timeoutMs: 120000, label: `采样[${id}]` })
      ok(`V1 数采落库[${id}]`, true)
    }
    catch (e) {
      ok(`V1 数采落库[${id}]`, false, String(e).slice(0, 80))
    }
  }

  // V2/V3 量程联锁 + 合法回环
  for (const n of cfg.dcw ?? []) {
    const span = Math.max(1, (n.max - n.min) / 10)
    const bad = await api('POST', `/api/workshop/dcw/${n.id}/write`, { value: n.max + span }, tok)
    const badMsg = String(bad.message ?? '') + String(bad.code ?? '')
    // 必须命中量程/限界拒绝语义;超时/网络失败不是“量程联锁通过”
    const rejected = bad.code === 'NODE_RANGE_EXCEEDED'
      || (/RANGE|LIMIT|越界|量程|上限|下限|VALIDATION/i.test(badMsg) && !/超时|timeout|ECONN|网络/i.test(badMsg))
    ok(`V2 越界拒[${n.name}]`, rejected, `value=${n.max + span} → ${String(bad.message ?? bad.code).slice(0, 60)}`)
    // V3 探针必须在写前实时取值:开批次后引擎/配方会驱动 SP,配置期探针会过期。
    // 只写命令点(如 mqtt commandTopic)read 返 null → 回退用最近一次写锚点值当现值。
    let probe = n.probeValue
    const rd = await api('POST', `/api/workshop/dcw/${n.id}/read`, {}, tok).catch(() => null)
    let cur = rd?.data?.read?.value
    if (typeof cur !== 'number') {
      const jr = await api('GET', '/api/workshop/dcw/journal?limit=30', undefined, tok)
      const lastAnchor = (jr.data?.anchors ?? []).filter(a => a.nodeId === n.id)
        .sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0))[0]
      if (lastAnchor && typeof lastAnchor.newValue === 'number') cur = lastAnchor.newValue
    }
    // 探针必须同时落在「节点量程 ∩ 活动配方窗口」内,且尽量朝窗口内侧走:
    // 当前值可能已被冒烟步推到窗口上沿,cur+step 会越配方窗口(实测 47+2>48 被拒)。
    const rp = (cfg.recipeParams ?? []).find(p => p.nodeId === n.id)
    const upper = Math.min(n.max, rp?.max ?? n.max)
    const lower = Math.max(n.min, rp?.min ?? n.min)
    const step = Math.max(0.1, Number(n.stepLimit) || 1)
    if (typeof cur === 'number') {
      const up = Math.round((cur + step) * 10) / 10
      const down = Math.round((cur - step) * 10) / 10
      probe = up < upper && up >= lower ? up : (down >= lower && down < upper ? down : Math.min(upper, Math.max(lower, cur)))
    }
    else if (probe < lower || probe > upper) {
      probe = Math.min(upper, Math.max(lower, probe))
    }
    // V3 可能撞 60s 写间隔/保持窗(上一轮验收/冒烟刚写过)——最多等待 3 次,每次 65s
    let good = await api('POST', `/api/workshop/dcw/${n.id}/write`, { value: probe }, tok)
    for (let i = 0; i < 3 && good.code !== 0 && /间隔|60s|WRITE_INTERVAL|保持窗口|写入频繁/i.test(String(good.message ?? '')); i++) {
      await new Promise(r => setTimeout(r, 65000))
      good = await api('POST', `/api/workshop/dcw/${n.id}/write`, { value: probe }, tok)
    }
    // transport-ack 协议(MQTT commandTopic 等无读通道):按平台 ACK 口径断言 broker 受理,
    // 再用独立 DAQ 观测节点证实物理量真的跟随。不允许把“链路受理”当“设备证实”。
    if (n.ackMode === 'transport-ack') {
      const ack = good.data?.outcome?.ack
      const writeOk = (good.code === 0 || !!good.data?.outcome) && ack === 'transport-ack'
      let followed = null
      if (writeOk && n.observeDaqId) {
        const tol = Number(n.observeTolerance ?? Math.max(0.5, Math.abs(probe) * 0.02))
        try {
          followed = await pollUntil(async () => {
            const now = Date.now()
            const j = await api('GET', `/api/workshop/daq/${n.observeDaqId}/samples?from=${now - 90000}&to=${now}&bucketMs=5000`, undefined, tok)
            const pts = j.data?.points ?? []
            const last = pts[pts.length - 1]
            return last && Number.isFinite(last.avg) && Math.abs(last.avg - probe) <= tol ? last.avg : null
          }, { timeoutMs: Number(n.observeTimeoutMs ?? 45000), stepMs: 3000, label: `观测[${n.name}]` })
        }
        catch { followed = null }
      }
      const okd = writeOk && (n.observeDaqId ? followed != null : true)
      ok(`V3 合法写生效(transport-ack)[${n.name}]`, okd,
        `cur=${cur ?? '?'} probe=${probe} ack=${ack ?? '缺失'} DAQ观测=${followed ?? '未跟随'} ${okd ? '' : String(good.message ?? good.code).slice(0, 80)}`)
      continue
    }
    const rb = good.data?.outcome?.readback
    const rbOk = typeof rb === 'number' && Number.isFinite(rb) && Math.abs(rb - probe) <= Math.max(0.5, Math.abs(probe) * 0.002)
    const goodOk = (good.code === 0 || !!good.data?.outcome) && rbOk
    ok(`V3 合法写回环[${n.name}]`, goodOk,
      `cur=${cur ?? '?'} probe=${probe} readback=${rb ?? '缺失'} ${goodOk ? '一致' : String(good.message ?? good.code).slice(0, 80)}`)
  }

  // V4 配方在册 + 参数逐项映射(不能只看 id 存在)
  const agg = await api('GET', '/api/workshop/dcw', undefined, tok)
  const rec = (agg.data?.recipes ?? []).find(r => r.id === cfg.recipeId)
  const expectedParams = cfg.recipeParams ?? []
  const recParams = rec?.params ?? []
  const paramMismatch = expectedParams.filter((e) => {
    const p = recParams.find(x => x.nodeId === e.nodeId)
    if (!p) return true
    return (e.value !== undefined && p.value !== e.value)
      || (e.min !== undefined && p.min !== e.min)
      || (e.max !== undefined && p.max !== e.max)
      || (e.stepLimit !== undefined && p.stepLimit !== e.stepLimit)
  })
  ok('V4 配方在册', !!rec, rec ? `${rec.name} v${rec.version} params=${recParams.length}` : (cfg.recipeId ?? '未提供'))
  if (expectedParams.length > 0) {
    ok('V4 配方参数映射正确', paramMismatch.length === 0,
      paramMismatch.length === 0 ? `${expectedParams.length} 项逐项一致` : `不匹配:${paramMismatch.map(p => p.nodeId).join(',')}`)
  }

  // V5 频道绑定与插件(plugins 显式数组:[] 表示期望零插件启用,同样要断言隔离)
  const ch = await api('GET', `/api/workshop/channels/${cfg.channelId}`, undefined, tok)
  const c = ch.data?.channel ?? ch.data
  ok('V5 频道绑线', c?.lineId === cfg.lineId, `${c?.lineId} vs ${cfg.lineId}`)
  const members = await api('GET', `/api/workshop/channels/${cfg.channelId}/agents`, undefined, tok)
  ok('V5 频道成员≥2', (members.data ?? []).length >= 2, `members=${(members.data ?? []).length}`)
  if (Array.isArray(cfg.plugins)) {
    const pj = await api('GET', `/api/workshop/channels/${cfg.channelId}/plugins`, undefined, tok)
    const enabled = new Set((pj.data?.plugins ?? []).filter(p => p.enabled).map(p => p.name))
    for (const name of cfg.plugins) ok(`V5 插件[${name}]`, enabled.has(name), enabled.has(name) ? 'enabled' : `实际=${[...enabled].join(',')}`)
    const unexpected = [...enabled].filter(n => !cfg.plugins.includes(n))
    ok('V5 插件隔离(未配置插件不得被默认启用)', unexpected.length === 0,
      unexpected.length ? `意外启用:${unexpected.join(',')}` : `仅配置项启用(enabled=${enabled.size}, expected=${cfg.plugins.length})`)
  }

  // V6 only skips when both checked snapshots prove the fixture is absent.
  const protectedAfter = await readProtectedSnapshot(snapshotOptions)
  const v6 = evaluateProtectedFixture({ before: protectedBefore, after: protectedAfter, lineId: PROTECTED_LINE, limit: JOURNAL_LIMIT })
  if (v6.status === 'SKIP') {
    console.log(`⚠ V6 受保护线保留 journal 完整性 — SKIP: ${v6.reason}; 正式验收需在隔离测试环境预置受保护线和非空 journal 基线`)
    console.log('(V6 SKIP=1:该项不计入通过/失败)')
  }
  else {
    ok(`V6 受保护线保留 journal 完整性 — ${v6.status}`, v6.status === 'PASS', v6.reason)
  }

  summary('接入验收', { graceful: true })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
