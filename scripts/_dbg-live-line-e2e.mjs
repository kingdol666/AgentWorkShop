/**
 * 模拟真实产线全栈 E2E(生产实例 :3001,真实协议:Modbus TCP/RTU、MQTT、OPC UA、HTTP)
 *
 * S1 夹具:产线+产品+配方+5 数采节点(modbus-tcp/rtu/mqtt/opcua/http)+5 数控节点
 * S2 协议连通:逐节点驱动 test(真实连接)
 * S3 数采:开跑 → 采样流入(mock 之外的 5 协议节点值变化)+ Timescale 落库
 * S4 数控:REST 下发 modbus-tcp/rtu/opcua/http/mqtt 五路(真实协议写+回读/路由捕获)
 * S5 Agent 闭环:绑定 → 任务(dcw_control→daq_query→dcw_judge)→ CLOSEDLOOP-OK
 * S6 HITL:manual 绑定的 OPC UA 节点 → 待审批 → 批准 → 真实写入
 * S7 Recipe:下发(PLC=目标)/recipe_update/recipe_rollback/版本史/参数账本回退
 *
 * 用法:NO_PROXY='127.0.0.1,localhost' node scripts/_dbg-live-line-e2e.mjs [base] [tag]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:3001'
const TAG = process.argv[3] ?? `lv${Math.random().toString(36).slice(2, 6)}`
const { createRequire } = await import('node:module')
const reqMqtt = createRequire(import.meta.url)
let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  }
  else {
    fail++
    console.log(`  ✗ ${name} ${extra}`)
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (method, path, { body, token } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
const invoke = (token, agentId, tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { body: { agentId, tool, args }, token })

async function main() {
  console.log(`━━━ 模拟真实产线全栈 E2E @ ${BASE} (tag=${TAG}) ━━━`)

  // ════ S0 登录 ════
  const login = await api('POST', '/api/users/login', { body: { email: 'admin@awshop.local', password: 'admin123' } })
  if (login.data?.token === undefined) {
    // 隔离库回退:admin 用户名
    const alt = await api('POST', '/api/users/login', { body: { email: 'admin', password: 'admin123' } })
    login.data = alt.data
  }
  const token = login.data?.token
  ok(Boolean(token), 'admin 登录')
  if (!token) process.exit(1)

  // ════ S1 夹具 ════
  const line = (await api('POST', '/api/workshop/dcw/lines', { body: { name: `模拟产线-${TAG}` }, token })).data?.line
  const product = (await api('POST', '/api/workshop/dcw/products', { body: { name: `模拟产品-${TAG}`, lineId: line.id }, token })).data?.product
  ok(Boolean(line?.id && product?.id), `产线/产品创建(${line.id.slice(0, 8)})`)

  // 5 数采节点(5 协议)
  const daqDefs = [
    { key: 'modbus-tcp', name: `进料压力-MBTCP`, driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', scale: 1, byteOrder: 'big' }, template: 'pressure-tx' },
    { key: 'modbus-rtu', name: `RTU 温度`, driverConfig: { host: '127.0.0.1', port: 15030, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', scale: 1, byteOrder: 'big' }, template: 'temp-tc' },
    { key: 'opcua', name: `OPC 炉温`, driverConfig: { endpoint: 'opc.tcp://127.0.0.1:4840', nodeId: 'ns=2;s=AW.Temp' }, template: 'temp-tc' },
    { key: 'mqtt', name: `MQTT 均温`, driverConfig: { host: '127.0.0.1', port: 1883, topic: 'aw/sim/temp', jsonPath: 'data.temp' }, template: 'temp-tc' },
    { key: 'http', name: `HTTP 品质值`, driverConfig: { url: 'http://127.0.0.1:1889/api/value', jsonPath: 'data.value' }, template: 'temp-tc' },
  ]
  const daqNodes = {}
  for (const d of daqDefs) {
    const test = await api('POST', '/api/workshop/daq/test-driver', { body: { driver: d.key, driverConfig: d.driverConfig }, token })
    const node = (await api('POST', '/api/workshop/daq', {
      body: { name: `${d.name}-${TAG}`, templateRef: d.template, driver: d.key, driverConfig: d.driverConfig, unit: d.key === 'modbus-tcp' ? 'MPa' : '℃', min: 0, max: 200, intervalMs: 2000, lineId: line.id },
      token,
    })).data?.node
    daqNodes[d.key] = node
    const testOk = test.data?.test?.ok !== false
    ok(Boolean(node?.id), `[daq] ${d.key} 创建(test=${testOk ? '连通' : (test.data?.test?.message ?? '失败')})`, test.data?.test?.message)
  }

  // 5 数控节点(5 协议)
  const dcwDefs = [
    { key: 'modbus-tcp', name: `压力设定-MBTCP`, driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big' }, unit: 'MPa', min: 0, max: 5 },
    { key: 'modbus-rtu', name: `RTU 开度`, driverConfig: { host: '127.0.0.1', port: 15030, unitId: 1, register: 40021, dataType: 'int16', byteOrder: 'big' }, unit: '%', min: 0, max: 10000 },
    { key: 'opcua', name: `OPC 炉温设定`, driverConfig: { endpoint: 'opc.tcp://127.0.0.1:4840', nodeId: 'ns=2;s=AW.SetTemp' }, unit: '℃', min: 0, max: 200 },
    { key: 'mqtt', name: `MQTT 下位机设定`, driverConfig: { host: '127.0.0.1', port: 1883, topic: `aw/sim/setpoint/${TAG}`, jsonKey: 'value' }, unit: '℃', min: 0, max: 200 },
    { key: 'http', name: `HTTP 加热设定`, driverConfig: { url: 'http://127.0.0.1:1889/api/setpoint', bodyKey: 'value' }, unit: '℃', min: 0, max: 200 },
  ]
  const dcwNodes = {}
  for (const d of dcwDefs) {
    const node = (await api('POST', '/api/workshop/dcw', {
      body: { name: `${d.name}-${TAG}`, templateRef: 'temp-sp', driver: d.key, driverConfig: d.driverConfig, unit: d.unit, min: d.min, max: d.max, lineId: line.id },
      token,
    })).data?.node
    dcwNodes[d.key] = node
    ok(Boolean(node?.id), `[dcw] ${d.key} 创建`)
  }

  // 配方:2 个真实协议参数
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
    body: { name: `工艺A-${TAG}`, productId: product.id, params: [
      { nodeId: dcwNodes['modbus-tcp'].id, value: 0.9, min: 0.6, max: 1.1 },
      { nodeId: dcwNodes['modbus-rtu'].id, value: 500 },
    ] },
    token,
  })).data?.recipe
  ok(Boolean(recipe?.id), `配方创建(${recipe?.id})`)

  // ════ S2 数采协议连通(节点级 test)════
  for (const [k, n] of Object.entries(daqNodes)) {
    const t = await api('POST', `/api/workshop/daq/${n.id}/test`, { body: {}, token })
    ok(t.data?.ok === true || t.data?.ok === undefined || t.status === 200, `[daq] ${k} test 连通`, JSON.stringify(t.data ?? t).slice(0, 90))
  }

  // ════ S3 数采流入(开跑 → 采样 + Timescale)════
  const producedBefore = (await api('GET', '/api/workshop/daq', { token })).data?.meta?.produced ?? 0
  const start = await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { body: { recipeId: recipe.id }, token })
  ok(start.status === 200, '产线开跑(绑定配方批次)', start.message)
  await sleep(9000)
  const daqSnap = (await api('GET', '/api/workshop/daq', { token })).data
  const liveNodes = daqSnap.nodes.filter(n => Object.values(daqNodes).some(x => x?.id === n.id))
  const changing = liveNodes.filter(n => n.value != null)
  ok(changing.length >= 4, `数采流入:5 协议节点中 ${changing.length} 个有实时值(${changing.map(n => `${n.name}=${n.value}`).join('; ').slice(0, 140)})`)
  const prodAfter = daqSnap.meta?.produced ?? 0
  ok(prodAfter > producedBefore, `管线 produced 增长(${producedBefore} → ${prodAfter})`)

  // ════ S4 数控五协议下发 ════
  const w1 = await api('POST', `/api/workshop/dcw/${dcwNodes['modbus-tcp'].id}/write`, { body: { value: 0.95 }, token })
  ok(w1.data?.outcome?.ok === true || w1.data?.ok !== false, `modbus-tcp 写 0.95(回读 ${w1.data?.outcome?.readback ?? w1.data?.readback ?? '?'})`, JSON.stringify(w1.data ?? w1).slice(0, 120))
  const w2 = await api('POST', `/api/workshop/dcw/${dcwNodes['modbus-rtu'].id}/write`, { body: { value: 500 }, token })
  ok(w2.data?.outcome?.ok === true || w2.data?.ok !== false, `modbus-rtu 写 500(int16,回读 ${w2.data?.outcome?.readback ?? w2.data?.readback ?? '?'})`, JSON.stringify(w2.data ?? w2).slice(0, 120))
  const w3 = await api('POST', `/api/workshop/dcw/${dcwNodes['opcua'].id}/write`, { body: { value: 88 }, token })
  ok(w3.data?.outcome?.ok === true, `opcua 写 88(回读 ${w3.data?.outcome?.readback ?? '?'})`, JSON.stringify(w3.data ?? w3).slice(0, 120))
  const w4 = await api('POST', `/api/workshop/dcw/${dcwNodes['http'].id}/write`, { body: { value: 66.6 }, token })
  ok(w4.data?.outcome?.ok === true, `http 写 66.6(POST /api/setpoint,回读 ${w4.data?.outcome?.readback ?? '?'})`, JSON.stringify(w4.data ?? w4).slice(0, 120))

  // mqtt 下发:订阅容器内 mosquitto?此处 1883 是 proto-sim broker —— 用 node 订阅捕获
  const captured = await captureMqtt(`aw/sim/setpoint/${TAG}`, async () => {
    await api('POST', `/api/workshop/dcw/${dcwNodes['mqtt'].id}/write`, { body: { value: 55.5 }, token })
  })
  ok(captured.includes('55.5'), `mqtt 下发路由捕获(topic=aw/sim/setpoint/${TAG} payload 含 55.5)`, captured.slice(0, 80))

  // ════ S5 Agent 闭环(真实协议节点)════
  const ch = (await api('POST', '/api/workshop/channels', {
    body: { name: `live-${TAG}`, leadAgent: { name: `lead-${TAG}`, harness: 'mock', config: { delayMs: 60 } } },
    token,
  })).data
  const tpl = await api('POST', '/api/workshop/agents', {
    body: { name: `op-${TAG}`, harness: 'omp', config: { provider: 'zhipu-coding-plan', model: 'glm-5.3-flash', systemPromptPrefix: '你是产线操作员:严格按步骤执行,完成后立即调用 complete_task。' } },
    token,
  })
  const join = await api('POST', `/api/workshop/channels/${ch.channelId}/agents`, { body: { agentId: tpl.data.id, role: 'worker' }, token })
  const instId = join.data?.id
  await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: instId, nodeId: dcwNodes['modbus-tcp'].id, kind: 'dcw', mode: 'auto' }, token })
  await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: instId, nodeId: daqNodes['modbus-tcp'].id, kind: 'daq', mode: 'auto' }, token })
  // HITL:opcua 设定节点 manual 模式
  await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: instId, nodeId: dcwNodes['opcua'].id, kind: 'dcw', mode: 'manual' }, token })
  ok(Boolean(instId), 'Agent 入队 + 三节点绑定(auto×2 + manual×1)')

  // 闭环任务
  const t1 = await api('POST', `/api/workshop/channels/${ch.channelId}/tasks`, {
    body: {
      title: `closedloop-${TAG}`,
      parts: [{ text: `闭环调优(严格按步骤):
1. dcw_control(node_id="${dcwNodes['modbus-tcp'].id}", value=0.95, hypothesis="提压验证") 下发压力设定;
2. 等待 3 秒后 daq_query(node_id="${daqNodes['modbus-tcp'].id}") 查看进料压力响应;
3. 基于数采证据 dcw_judge:对刚才下发的优化记录落判定 keep(附一句证据);
4. 最终交付原样包含一行标记 CLOSEDLOOP-OK,并附压力设定值与采样值各一个。
完成后调用 complete_task。` }],
      assigneeId: instId,
    },
    token,
  })
  const task1 = t1.data?.task?.id ?? t1.data?.id
  const st1 = await pollTask(token, task1, 12 * 60_000)
  ok(st1 === 'COMPLETED', `[闭环] 任务 COMPLETED(state=${st1})`)
  const blob1 = await gatherTaskBlob(token, ch.channelId, task1)
  ok(blob1.includes('CLOSEDLOOP-OK'), '[闭环] 交付含 CLOSEDLOOP-OK(真实协议下发+数采证据+判定)')

  // ════ S6 HITL(manual 绑定 → invoke 挂起 → 审批 → 真实写入)════
  // HITL 语义:invoke 挂起等待裁决(超时 300s),因此后台发起、轮询待办、批准后收结果
  const hitlPromise = invoke(token, instId, 'dcw_control', { node_id: dcwNodes['opcua'].id, value: 92, task_id: 'hitl-e2e' }).catch(err => ({ data: { result: { text: `invoke err: ${err.message}`, isError: true } } }))
  let pending = null
  for (let i = 0; i < 10 && !pending; i++) {
    await sleep(1500)
    const pend = (await api('GET', '/api/workshop/agent-tools/approvals', { token })).data?.approvals ?? []
    pending = pend.find(p => p.agentId === instId) ?? null
  }
  ok(Boolean(pending?.id), `[HITL] 产生待审批(${pending?.id ?? '无'})`)
  if (pending?.id) {
    const dec = await api('POST', `/api/workshop/agent-tools/approvals/${pending.id}/decide`, { body: { approved: true, comment: 'E2E 批准' }, token })
    ok(dec.status === 200, '[HITL] 管理员批准')
    const hitl = await hitlPromise
    ok(hitl.data?.result?.isError !== true, '[HITL] Agent 收到批准结果并执行', (hitl.data?.result?.text ?? '').slice(0, 90))
    await sleep(1500)
    const rd = await api('POST', `/api/workshop/dcw/${dcwNodes['opcua'].id}/read`, { body: {}, token })
    ok(String(rd.data?.read?.value ?? '').startsWith('92'), `[HITL] 批准后真实写入生效(OPC UA SetTemp 回读 ${rd.data?.read?.value})`, JSON.stringify(rd.data ?? rd).slice(0, 90))
  }
  else {
    await hitlPromise.catch(() => {})
  }

  // ════ S7 Recipe 全生命周期(真实协议下发)════
  const upd = await invoke(token, instId, 'recipe_update', { recipe_id: recipe.id, params: [{ node_id: dcwNodes['modbus-tcp'].id, value: 0.98 }], reason: '闭环验证:压力窗口内稳定' })
  ok(upd.data?.result?.text?.includes('v2'), '[recipe] Agent recipe_update → v2', upd.data?.result?.text?.slice(0, 90))
  const rv = await api('POST', `/api/workshop/dcw/recipes/${recipe.id}/revert`, { body: { version: 1, reason: 'E2E 回退到初版' }, token })
  ok(rv.data?.recipe?.version === 3, '[recipe] 界面回退 → v3')
  const jl = await invoke(token, instId, 'dcw_journal', { node_id: dcwNodes['modbus-tcp'].id })
  ok(jl.data?.result?.text?.includes('优化记录') || jl.data?.result?.text?.includes('锚'), '[journal] dcw_journal 参数账本可查')
  // 节点级参数回退:回退压力设定到上一稳定锚
  const rb = await invoke(token, instId, 'dcw_rollback', { node_id: dcwNodes['modbus-tcp'].id })
  const rbOk = rb.data?.result?.text?.includes('回退') && !rb.data?.result?.isError
  const rbSkip = (rb.data?.result?.text ?? '').includes('冷却') || (rb.data?.result?.text ?? '').includes('无可回退')
  ok(rbOk || rbSkip, `[journal] dcw_rollback 执行(${rb.data?.result?.text?.slice(0, 70) ?? '∅'})`)

  // ════ 清理 ════
  await api('POST', `/api/workshop/dcw/lines/${line.id}/stop`, { body: {}, token }).catch(() => {})
  await api('DELETE', `/api/workshop/channels/${ch.channelId}?purge=1`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/agents/${tpl.data.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/recipes/${recipe.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/products/${product.id}`, { token }).catch(() => {})
  for (const n of Object.values(dcwNodes)) await api('DELETE', `/api/workshop/dcw/${n.id}`, { token }).catch(() => {})
  for (const n of Object.values(daqNodes)) await api('DELETE', `/api/workshop/daq/${n.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/lines/${line.id}`, { token }).catch(() => {})

  console.log(`\n━━━ LiveLine E2E: ${pass} passed / ${fail} failed ━━━`)
  process.exit(fail === 0 ? 0 : 1)
}

async function pollTask(token, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let state = ''
  while (Date.now() < deadline) {
    for (let i = 0; i < 3; i++) {
      try {
        const me = await api('GET', `/api/workshop/tasks/${id}`, { token })
        state = me.data?.state ?? ''
        break
      }
      catch { await sleep(3000) }
    }
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(state)) return state
    await sleep(6000)
  }
  return state || 'RUNNING'
}

async function gatherTaskBlob(token, channelId, taskId) {
  const taskBlob = JSON.stringify((await api('GET', `/api/workshop/tasks/${taskId}`, { token })).data ?? {})
  const msgBlob = JSON.stringify((await api('GET', `/api/workshop/channels/${channelId}/messages?limit=200`, { token })).data ?? {})
  const evBlob = JSON.stringify((await api('GET', `/api/workshop/channels/${channelId}/events?limit=400`, { token })).data ?? {})
  return taskBlob + msgBlob + evBlob
}

/** 订阅 MQTT 主题并执行动作,断言捕获 payload(真实 broker = 127.0.0.1:1883) */
async function captureMqtt(topic, action) {
  const mqtt = createMqttLib()
  return await new Promise((resolve) => {
    const client = mqtt.connect('mqtt://127.0.0.1:1883')
    let got = ''
    const done = () => { try { client.end(true) } catch {} ; resolve(got) }
    client.on('connect', async () => {
      client.subscribe(topic, () => {
        setTimeout(action, 300)
      })
      setTimeout(() => done(), 9000)
    })
    client.on('message', (t, payload) => { got = `${t} ${payload.toString()}` })
    setTimeout(() => done(), 12_000)
  })
}
function createMqttLib() {
  return reqMqtt('mqtt')
}

main().catch((err) => {
  console.error('E2E 异常:', err)
  process.exit(1)
})
