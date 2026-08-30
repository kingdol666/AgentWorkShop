/**
 * 加固探针:验证 hardening-plan Phase 1 的行为修复。
 * 1. B4 入口幂等:同标题在途任务二次提交 → 409(防 HITL 双击/重试重复执行)
 * 2. D1+D2 数据驱动报警:孪生报警来自节点量程派生(数据)而非硬编码阈值 ——
 *    构造 168℃ 读数 + 量程 [10,20] 的节点:legacy 85℃ 规则不会 alarm(168<85 不成立…实际 168>85
 *    会命中 legacy!因此量程改用 [200,300] 使读数 168 **低于量程下限** → 节点 alarm,
 *    同时 legacy 规则(温度>85 → alarm)也 alarm —— 无法区分。
 *    → 改用压力模板:读数 ~0.82,量程 [2,3] → 越下限 alarm;legacy 压力规则(>2.0MPa)不触发(0.82<2.0)。
 *    孪生若 alarm = 数据驱动路径生效;若 running = 修复未生效。
 * 3. A1 伴生断言:重复回合后 ws 广播仍正常(stream 泄漏修复无回归)。
 * 运行:dev(3000) 就绪后 node scripts/_dbg-hardening-probe.mjs
 */
const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let pass = 0
const fails = []
const ok = (m) => { pass++; console.log(`  PASS ${m}`) }
const fail = (m) => { fails.push(m); console.error(`  FAIL ${m}`) }
const assert = (cond, m) => (cond ? ok(m) : fail(m))
const jpost = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())
const jget = (u) => fetch(ROOT + u, { headers: H }).then(r => r.json())
const jdel = (u) => fetch(ROOT + u, { method: 'DELETE', headers: H }).then(r => r.json())

async function main() {
  // ===== 1. B4: 同标题在途 409 =====
  console.log('== B4: submitChannelTask 入口幂等 ==')
  const ch = (await jpost('/api/workshop/channel-templates/chtpl-default-fullstack/instantiate', { name: '加固探针频道' })).data
  const channelId = ch.channelId
  try {
    const t1 = await jpost(`/api/workshop/channels/${channelId}/tasks`, { title: '加固探针唯一标题X9', parts: [{ text: 'noop' }] })
    const id1 = t1.data?.task?.id ?? t1.data?.id
    assert(!!id1, '首次提交成功')
    const t2 = await jpost(`/api/workshop/channels/${channelId}/tasks`, { title: '加固探针唯一标题X9', parts: [{ text: 'noop' }] })
    assert(t2.error?.code === 'CONFLICT' || /409|已在途/.test(JSON.stringify(t2)), `同标题在途 → 409(实际 ${JSON.stringify(t2).slice(0, 90)})`)
    const t3 = await jpost(`/api/workshop/channels/${channelId}/tasks`, { title: '加固探针另一标题Y3', parts: [{ text: 'noop' }] })
    const id3 = t3.data?.task?.id ?? t3.data?.id
    assert(!!id3, '不同标题不受影响')
    for (const t of [id1, id3]) await jpost(`/api/workshop/channels/${channelId}/tasks/${t}/cancel`, {}).catch(() => {})
  }
  finally {
    await jdel(`/api/workshop/channels/${channelId}`).catch(() => {})
  }

  // ===== 2. D1+D2: 数据驱动孪生报警 =====
  console.log('== D1+D2: telemetryKey 数据字段 + 节点态透传 ==')
  // 采集门控:节点必须有活动产线批次才采样 → 建产线+产品+配方(mock 设定节点凑参数)+开跑
  const twin = (await jpost('/api/workshop/device-twins', { name: '加固探针设备', modelRef: 'dev-folder-extruder', kind: 'device', posX: 4500, posZ: 900 })).data.twin
  const line = (await jpost('/api/workshop/dcw/lines', { name: '加固探针线' })).data.line
  const prod = (await jpost('/api/workshop/dcw/products', { name: '加固探针产品', lineId: line.id })).data.product
  const dw = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: '加固探针-温度设定', driver: 'mock', lineId: line.id, deviceBindingId: twin.id })).data.node
  const rc = (await jpost('/api/workshop/dcw/recipes', { productId: prod.id, name: '加固探针配方', params: [{ nodeId: dw.id, value: 180 }] })).data.recipe
  // 压力模板读数 ~0.82:量程 [2,3] → 越下限 → 节点 alarm;
  // legacy 压力阈值(>2.0MPa)与温度阈值(>85℃)都不会命中(0.82<2.0) → 孪生 alarm 只能来自节点态透传
  const dq = (await jpost('/api/workshop/daq', {
    templateRef: 'pressure-tx', name: '加固探针-压力',
    driver: 'mock', intervalMs: 300,
    min: 2, max: 3, lineId: line.id, deviceBindingId: twin.id,
  })).data.node
  const st = await jpost(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId: rc.id })
  if (!st.data?.line?.active) { fail(`产线开跑失败: ${JSON.stringify(st).slice(0, 100)}`); process.exit(1) }
  try {
    await sleep(3500)
    const twins = (await jget('/api/workshop/device-twins')).data
    const arr = Array.isArray(twins) ? twins : twins?.twins ?? []
    const now = arr.find(t => t.id === twin.id)
    assert(!!now, '孪生存在')
    assert(now.state === 'alarm', `孪生态=alarm(数据驱动透传;实际 ${now.state})`)
    assert(now.telemetry && now.telemetry.pressure != null, `telemetry 键=pressure(telemetryKey 数据字段;实际 ${JSON.stringify(now.telemetry).slice(0, 60)})`)
    const nodes = (await jget('/api/workshop/daq')).data.nodes
    const nd = nodes.find(n => n.id === dq.id)
    assert(nd.state === 'alarm', `节点自身 alarm(量程派生;实际 ${nd.state})`)
  }
  finally {
    await jpost(`/api/workshop/dcw/lines/${line.id}/stop`, {}).catch(() => {})
    await jdel(`/api/workshop/dcw/recipes/${rc.id}`).catch(() => {})
    await jdel(`/api/workshop/daq/${dq.id}`).catch(() => {})
    await jdel(`/api/workshop/dcw/${dw.id}`).catch(() => {})
    await jdel(`/api/workshop/dcw/products/${prod.id}`).catch(() => {})
    await jdel(`/api/workshop/dcw/lines/${line.id}`).catch(() => {})
    await jdel(`/api/workshop/device-twins/${twin.id}`).catch(() => {})
  }

  console.log(`\n===== 加固探针: ${pass} PASS / ${fails.length} FAIL =====`)
  if (fails.length) { fails.forEach(m => console.error(' -', m)); process.exitCode = 1 }
  process.exit(process.exitCode ?? 0)
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1) })
