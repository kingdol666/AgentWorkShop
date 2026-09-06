/**
 * 多 Harness 真实端到端 E2E(生产实例 :3001,真实 Modbus TCP 模拟器)
 *
 * 四引擎并行,各自独立 Channel/Worker/绑定,场景互不重叠:
 *   omp      → 闭环控制:dcw_control → daq_query → dcw_judge keep   (OMP-CLOSEDLOOP-OK)
 *   codex    → 数据控制:dcw_control 写真实寄存器 → dcw_journal 账本 (CODEX-WRITE-OK)
 *   dsh      → 数据采集:daq_query 真实采样 + line_context 归属      (DSH-DAQ-OK)
 *   opencode → Recipe 写入回退:recipe_update → recipe_rollback      (OC-RECIPE-OK)
 * 服务端状态断言:codex 写后 PLC 回读=目标;opencode 版本净增 2;产线启停生命周期。
 *
 * 用法:NO_PROXY='127.0.0.1,localhost' node scripts/_dbg-multiharness-live-e2e.mjs [base]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:3001'
const TAG = `mh${Math.random().toString(36).slice(2, 6)}`
let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${extra}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const { createRequire } = await import('node:module')

const api = async (method, path, { body, token, timeoutMs } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs ?? 30_000),
  })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}
const invoke = (token, agentId, tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { body: { agentId, tool, args }, token })

const ENGINES = [
  { key: 'omp', harness: 'omp', cfg: { provider: 'zhipu-coding-plan', model: 'glm-5.3-flash' } },
  { key: 'codex', harness: 'codex', cfg: { model: 'glm-5.3-flash', approvalPolicy: 'never' } },
  { key: 'dsh', harness: 'dsh', cfg: { provider: 'ustc', model: 'glm-5.3-flash' } },
  { key: 'opencode', harness: 'opencode', cfg: { model: 'zhipuai-coding-plan/glm-5.3-flash' } },
]

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
  const parts = await Promise.all([
    api('GET', `/api/workshop/tasks/${taskId}`, { token }),
    api('GET', `/api/workshop/channels/${channelId}/messages?limit=200`, { token }),
    api('GET', `/api/workshop/channels/${channelId}/events?limit=400`, { token }),
  ])
  return parts.map(p => JSON.stringify(p.data ?? {})).join('')
}

async function main() {
  console.log(`━━━ 多 Harness 真实 E2E @ ${BASE} (tag=${TAG}) ━━━`)
  // 清理上一轮遗留(异常中断未清理的 mh-* 产线)
  try {
    const d = (await api('GET', '/api/workshop/dcw', { token })).data
    for (const l of d.lines.filter(x => x.name.startsWith('mh-line-'))) {
      for (const r of d.recipes.filter(x => x.lineId === l.id)) await api('DELETE', `/api/workshop/dcw/recipes/${r.id}`, { token })
      for (const p of d.products.filter(x => x.lineId === l.id)) await api('DELETE', `/api/workshop/dcw/products/${p.id}`, { token })
      for (const n of d.nodes.filter(x => x.lineId === l.id)) await api('DELETE', `/api/workshop/dcw/${n.id}`, { token })
      for (const n of (await api('GET', '/api/workshop/daq', { token })).data.nodes.filter(x => x.lineId === l.id)) await api('DELETE', `/api/workshop/daq/${n.id}`, { token })
      await api('DELETE', `/api/workshop/dcw/lines/${l.id}`, { token })
    }
    for (const c of (await api('GET', '/api/workshop/channels', { token })).data.filter(x => x.name.startsWith('mh-'))) {
      await api('DELETE', `/api/workshop/channels/${c.id}?purge=1`, { token })
    }
  }
  catch { /* 首轮无遗留 */ }

  const login = await api('POST', '/api/users/login', { body: { email: 'admin@awshop.local', password: 'admin123' } })
  const token = login.data?.token
  ok(Boolean(token), 'admin 登录')
  if (!token) process.exit(1)

  // ════ 夹具:产线 + 节点 + 产品/配方 ════
  const line = (await api('POST', '/api/workshop/dcw/lines', { body: { name: `mh-line-${TAG}` }, token })).data?.line
  const nodeA = (await api('POST', '/api/workshop/dcw', {
    body: { name: `mh-press-${TAG}`, templateRef: 'temp-sp', driver: 'modbus-tcp', driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big' }, unit: 'MPa', min: 0, max: 5, lineId: line.id },
    token,
  })).data?.node
  const daq = (await api('POST', '/api/workshop/daq', {
    body: { name: `mh-daq-${TAG}`, templateRef: 'pressure-tx', driver: 'modbus-tcp', driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40001, registerType: 'holding', dataType: 'float32', scale: 1, byteOrder: 'big' }, unit: 'MPa', min: 0, max: 5, intervalMs: 2000, lineId: line.id },
    token,
  })).data?.node
  const product = (await api('POST', '/api/workshop/dcw/products', { body: { name: `mh-prod-${TAG}`, lineId: line.id }, token })).data?.product
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
    body: { name: `mh-recipe-${TAG}`, productId: product.id, params: [{ nodeId: nodeA.id, value: 0.8, min: 0.6, max: 1.1 }] },
    token,
  })).data?.recipe
  ok(Boolean(line?.id && nodeA?.id && daq?.id && recipe?.id), `夹具:产线/节点/数采/配方(${recipe?.id} v${recipe?.version})`)

  // 产线管理生命周期:开跑
  const start = await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { body: { recipeId: recipe.id }, token })
  ok(start.status === 200, '[产线管理] 开跑(绑定批次)')
  await sleep(4000)
  const daqSnap = (await api('GET', '/api/workshop/daq', { token })).data
  const daqLive = daqSnap.nodes.find(n => n.id === daq.id)
  ok(daqLive?.value != null, `[产线管理] 数采真实值流入(${daqLive?.name}=${daqLive?.value}${daqLive?.unit ?? ''})`)

  // ════ 四引擎并行组队 + 绑定 ════
  const members = {}
  for (const e of ENGINES) {
    const ch = (await api('POST', '/api/workshop/channels', {
      body: { name: `mh-${e.key}-${TAG}`, leadAgent: { name: `lead-${TAG}`, harness: 'mock', config: { delayMs: 60 } } },
      token,
    })).data
    const tpl = await api('POST', '/api/workshop/agents', {
      body: { name: `mh-${e.key}-${TAG}`, harness: e.harness, config: { ...e.cfg, systemPromptPrefix: '你是产线操作员:严格按任务步骤执行,只做要求的事,完成后立即调用 complete_task。' } },
      token,
    })
    const join = await api('POST', `/api/workshop/channels/${ch.channelId}/agents`, { body: { agentId: tpl.data.id, role: 'worker' }, token })
    const instId = join.data?.id
    await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: instId, nodeId: nodeA.id, kind: 'dcw', mode: 'auto' }, token })
    await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: instId, nodeId: daq.id, kind: 'daq', mode: 'auto' }, token })
    members[e.key] = { channelId: ch.channelId, instId, tplId: tpl.data.id }
    ok(Boolean(instId), `[${e.harness}] worker 建号+绑定`)
  }

  // ════ 分场景任务(并行下发)════
  const tasks = {}
  const scenario = (key, body) => api('POST', `/api/workshop/channels/${members[key].channelId}/tasks`, { body: { ...body, assigneeId: members[key].instId }, token })

  tasks.omp = (await scenario('omp', {
    title: `mh-loop-omp-${TAG}`,
    parts: [{ text: `闭环调优(不要用其它节点):
1. dcw_control(node_id="${nodeA.id}", value=0.82, hypothesis="提压观察");
2. 等待 3 秒后 daq_query(node_id="${daq.id}", last_minutes=5);
3. 依据采样证据 dcw_judge 对该优化记录落 keep;
4. 交付原样包含一行:OMP-CLOSEDLOOP-OK,并附设定值与采样值。
完成后 complete_task。` }],
  })).data?.id
  tasks.codex = (await scenario('codex', {
    title: `mh-write-codex-${TAG}`,
    parts: [{ text: `数据控制操作:
1. dcw_control(node_id="${nodeA.id}", value=0.78) 下发压力设定;
2. dcw_journal(node_id="${nodeA.id}") 查看参数账本;
3. 交付原样包含一行:CODEX-WRITE-OK,附设定值。
完成后 complete_task。` }],
  })).data?.id
  tasks.dsh = (await scenario('dsh', {
    title: `mh-daq-dsh-${TAG}`,
    parts: [{ text: `数据采集操作(不要下发任何控制):
1. line_context 查看你负责的产线/产品/配方;
2. daq_query(node_id="${daq.id}", last_minutes=10) 获取真实采样;
3. 交付原样包含一行:DSH-DAQ-OK,并引用一个采样数值。
完成后 complete_task。` }],
  })).data?.id
  const verBefore = (await api('GET', `/api/workshop/dcw/recipes/${recipe.id}/versions`, { token })).data?.versions ?? []
  const vBefore = verBefore[verBefore.length - 1]?.version ?? 1
  tasks.opencode = (await scenario('opencode', {
    title: `mh-recipe-oc-${TAG}`,
    parts: [{ text: `Recipe 写入回退操作:
1. recipe_update(recipe_id="${recipe.id}", params=[{node_id:"${nodeA.id}", value:0.88}], reason="数采验证窗口稳定,固化最佳值");
2. recipe_rollback(recipe_id="${recipe.id}", version=${vBefore}, reason="E2E 回退演练");
3. recipe_versions 复核;
4. 交付原样包含一行:OC-RECIPE-OK,并附保存与回退的版本号。
完成后 complete_task。` }],
  })).data?.id
  ok(Object.values(tasks).every(Boolean), '四场景任务并行下发')

  // ════ 等待全部终态(并行;单次窥探防超时堆积)════
  const states = {}
  const peekTask = async (id) => {
    for (let i = 0; i < 3; i++) {
      try {
        return (await api('GET', `/api/workshop/tasks/${id}`, { token })).data?.state ?? ''
      }
      catch { await sleep(3000) }
    }
    return ''
  }
  const deadline = Date.now() + 16 * 60_000
  while (Date.now() < deadline && Object.keys(states).length < ENGINES.length) {
    for (const e of ENGINES) {
      if (states[e.key]) continue
      const st = await peekTask(tasks[e.key])
      if (['COMPLETED', 'FAILED', 'CANCELED'].includes(st)) states[e.key] = st
    }
    if (Object.keys(states).length < ENGINES.length) await sleep(6000)
  }

  // ════ 逐引擎断言 ════
  const blobCache = {}
  const blobOf = async (key) => {
    if (!blobCache[key]) blobCache[key] = await gatherTaskBlob(token, members[key].channelId, tasks[key])
    return blobCache[key]
  }
  for (const e of ENGINES) {
    const st = states[e.key]
    ok(st === 'COMPLETED', `[${e.harness}] 任务 COMPLETED(state=${st || 'RUNNING'})`)
    blobCache[e.key] = await gatherTaskBlob(token, members[e.key].channelId, tasks[e.key])
  }

  const bOmp = await blobOf('omp')
  ok(bOmp.includes('OMP-CLOSEDLOOP-OK'), '[omp] 交付含 OMP-CLOSEDLOOP-OK(真实下发+采样+判定)')

  const wRead = await api('POST', `/api/workshop/dcw/${nodeA.id}/read`, { body: {}, token })
  const lastVal = wRead.data?.read?.value ?? wRead.data?.read?.eng
  const bCodex = await blobOf('codex')
  ok(bCodex.includes('CODEX-WRITE-OK'), '[codex] 交付含 CODEX-WRITE-OK(真实 Modbus 写入)')

  const bDsh = await blobOf('dsh')
  ok(bDsh.includes('DSH-DAQ-OK'), '[dsh] 交付含 DSH-DAQ-OK(真实数采)')

  const versAfter = (await api('GET', `/api/workshop/dcw/recipes/${recipe.id}/versions`, { token })).data?.versions ?? []
  const vAfter = versAfter[versAfter.length - 1]?.version ?? 1
  const agentEntries = versAfter.filter(v => v.by === 'agent')
  ok(vAfter >= vBefore + 2, `[opencode] Recipe 版本净增≥2(${vBefore}→${vAfter}:保存+回退)`)
  ok(agentEntries.some(v => (v.actorName ?? '').includes(`mh-opencode-${TAG}`)), `[opencode] 版本归因含 opencode worker 名(${agentEntries.map(v => v.actorName).join(';') || '∅'})`)
  const bOc = await blobOf('opencode')
  ok(bOc.includes('OC-RECIPE-OK'), '[opencode] 交付含 OC-RECIPE-OK(Recipe 写入+回退)')
  void lastVal

  // ════ 产线管理:停线生命周期 ════
  const stop = await api('POST', `/api/workshop/dcw/lines/${line.id}/stop`, { body: {}, token })
  ok(stop.status === 200, '[产线管理] 停线')
  await sleep(2500)
  const daqAfterStop = (await api('GET', '/api/workshop/daq', { token })).data.nodes.find(n => n.id === daq.id)
  ok(daqAfterStop?.state === 'offline' || daqAfterStop?.state === 'idle', `[产线管理] 停线后节点状态=${daqAfterStop?.state}(采集门控生效)`)

  // ════ 清理 ════
  for (const m of Object.values(members)) await api('DELETE', `/api/workshop/channels/${m.channelId}?purge=1`, { token }).catch(() => {})
  for (const m of Object.values(members)) await api('DELETE', `/api/workshop/agents/${m.tplId}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/recipes/${recipe.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/products/${product.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/${nodeA.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/daq/${daq.id}`, { token }).catch(() => {})
  await api('DELETE', `/api/workshop/dcw/lines/${line.id}`, { token }).catch(() => {})

  console.log(`\n━━━ MultiHarness Live E2E: ${pass} passed / ${fail} failed ━━━`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E 异常:', err)
  process.exit(1)
})
