/**
 * 上下文注入探针:验证 AgentRuntime → omp Harness 的工业上下文/工具注入全链。
 *
 * Tier A(tsx 直读,确定性):OmpRpcAgentImpl.contextPrefix 组装断言 ——
 *   场景 + 产线工况简报(产线/配方/工艺窗口/数采窗口/报警) + 调控作业环,
 *   且未绑定 Agent 的 prefix 不含任何工业段(零硬编码泄漏)。
 * Tier B(HTTP 工具面):my_industrial_nodes 语义卡(自定义模板 semantics 透出)
 *   / daq_query line_id 过滤落实 / 越窗报警状态透出。
 * Tier C(omp 实测):真实 harness 回合能否引用注入事实(任务文本零泄漏)。
 *
 * 运行:dev(3000) + modbus 模拟器(1502) 就绪后
 *   npx tsx scripts/_dbg-context-inject-audit.mjs
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
const invoke = (agentId, tool, args) => jpost('/api/workshop/agent-tools/invoke', { agentId, tool, args }).then(r => r.data?.result?.text ?? JSON.stringify(r))

// 唯一语义标记(自定义模板 semantics 的数据驱动证明:任何查表词典都不可能含它)
const SEM_MARKER = 'PROBE-SEM-7741:熔体温度决定塑化均化质量,波动超过4℃将导致制品内应力超标'
const LINE_NAME = '上下文探针线R7'
const PROD_NAME = '探针产品P9'
const RECIPE_NAME = '探针配方Q5'
const PROBE_AGENT = 'probe-ctx-agent-7741'

async function makeFixture() {
  const twin = (await jpost('/api/workshop/device-twins', { name: '探针受控设备', modelRef: 'dev-folder-extruder', kind: 'device', posX: 4200, posZ: 900 })).data.twin
  const line = (await jpost('/api/workshop/dcw/lines', { name: LINE_NAME })).data.line
  const prod = (await jpost('/api/workshop/dcw/products', { name: PROD_NAME, lineId: line.id })).data.product
  const dq = (await jpost('/api/workshop/daq', {
    templateRef: 'daq-temp-tc', name: '探针-温度采集',
    driver: 'modbus-tcp',
    driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40003, dataType: 'float32', byteOrder: 'big' },
    intervalMs: 400, lineId: line.id, deviceBindingId: twin.id,
    semantics: SEM_MARKER,
  })).data.node
  const dw = (await jpost('/api/workshop/dcw', {
    templateRef: 'dcw-temp-sp', name: '探针-温度设定',
    driver: 'modbus-tcp',
    driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big', engMin: 150, engMax: 200, rawMin: 0, rawMax: 2000 },
    lineId: line.id, deviceBindingId: twin.id,
    semantics: SEM_MARKER,
  })).data.node
  const rc = (await jpost('/api/workshop/dcw/recipes', {
    productId: prod.id, name: RECIPE_NAME,
    params: [{ nodeId: dw.id, value: 180, min: 176, max: 188 }],
    // 数采窗口故意设窄:真实温度 ~166~174 → 必然越限报警(验证报警透出)
    daqWindows: [{ nodeId: dq.id, min: 100, max: 110 }],
  })).data.recipe
  await jpost(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId: rc.id })
  return { twin, line, prod, dq, dw, rc }
}

async function cleanupFixture(f) {
  await jpost(`/api/workshop/dcw/lines/${f.line.id}/stop`, {}).catch(() => {})
  await jdel(`/api/workshop/dcw/recipes/${f.rc.id}`).catch(() => {})
  await jdel(`/api/workshop/daq/${f.dq.id}`).catch(() => {})
  await jdel(`/api/workshop/dcw/${f.dw.id}`).catch(() => {})
  await jdel(`/api/workshop/dcw/products/${f.prod.id}`).catch(() => {})
  await jdel(`/api/workshop/dcw/lines/${f.line.id}`).catch(() => {})
  await jdel(`/api/workshop/device-twins/${f.twin.id}`).catch(() => {})
}

/** 等待任务(或其子任务)完成并收集工件文本(轮询 channel 任务列表) */
async function waitTaskArtifact(channelId, taskId, maxMs = 300_000) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    await sleep(4000)
    const res = (await jget(`/api/workshop/channels/${channelId}/tasks`)).data
    const tasks = Array.isArray(res) ? res : res?.tasks ?? []
    if (tasks.length === 0) continue
    const related = tasks.filter(t => t.id === taskId || t.parentId === taskId)
    if (related.length === 0) continue
    const allDone = related.every(t => ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state))
    if (!allDone) continue
    const text = related
      .flatMap(t => (t.artifacts ?? []).map(a => (a.parts ?? []).map(p => p.text ?? '').join(' ')))
      .join('\n')
    if (related.some(t => t.state !== 'COMPLETED')) {
      fail(`omp 任务非正常收口: ${related.map(t => `${t.title}=${t.state}`).join(',')}`)
    }
    return text
  }
  fail('omp 任务等待超时')
  return ''
}

async function main() {
  // 先建 fixture 再 import 服务模块:repo 单例在首次调用时读盘,
  // 探针进程必须晚于数据创建(否则读到陈旧快照);产线活动批次是
  // dev 进程运行时状态,探针进程永远不可见 —— 运行时相关断言全部由
  // Tier C(真实 omp 回合)活体覆盖,这里只断言持久化数据面。
  console.log('== fixture 创建(HTTP) ==')
  const f = await makeFixture()
  console.log(`[fixture] 产线 ${f.line.id} / 配方 ${f.rc.id} / 数控 ${f.dw.id} / 数采 ${f.dq.id}`)
  await jpost('/api/workshop/agent-tools/bindings', { agentId: PROBE_AGENT, nodeId: f.dw.id, kind: 'dcw', mode: 'manual' })
  await jpost('/api/workshop/agent-tools/bindings', { agentId: PROBE_AGENT, nodeId: f.dq.id, kind: 'daq', mode: 'auto' })

  console.log('== Tier A: contextPrefix 组装(tsx 直读,持久化数据面) ==')
  const [{ buildIndustrialContext, industrialLoopGuide }, { OmpRpcAgentImpl }] = await Promise.all([
    import('../server/services/workshop/agents/industrial-context.ts'),
    import('../server/services/workshop/agents/omp-agent.ts'),
  ])

  // 未绑定 Agent:任何工业段都不得出现(零硬编码)
  assert(buildIndustrialContext('no-such-agent') === '', '未绑定 Agent:工况简报为空')
  assert(industrialLoopGuide('no-such-agent') === '', '未绑定 Agent:作业环为空')
  const bare = new OmpRpcAgentImpl({ agentId: 'no-such-agent', name: 'x', role: 'worker', channelId: 'c' })
  const barePrefix = await bare.contextPrefix()
  assert(!barePrefix.includes('产线工况简报') && !barePrefix.includes('工业调控作业环'), '未绑定 Agent prefix 不含工业段')
  assert(barePrefix.includes('Scenario Brief'), '未绑定 Agent prefix 仍含场景段')

  // 绑定 Agent:工况简报 + 作业环随绑定数据出现
  const briefing = buildIndustrialContext(PROBE_AGENT)
  assert(briefing.includes('产线工况简报'), '工况简报段存在')
  assert(briefing.includes(LINE_NAME), `简报含产线名(${LINE_NAME})`)
  assert(briefing.includes('工况:'), '简报含工况行(运行态由 Tier C 活体验证)')

  const loop = industrialLoopGuide(PROBE_AGENT)
  assert(loop.includes('工业调控作业环'), '作业环段存在')
  assert(loop.includes('安全量程 ∩ 活动配方工艺窗口'), '作业环含窗口联锁纪律')
  assert(loop.includes('等待用户批准'), 'manual 绑定 → 作业环含审批纪律')
  assert(loop.includes('daq_query') && loop.includes('my_industrial_nodes') && loop.includes('dcw_control'), '作业环引用全部工业工具名')

  const bound = new OmpRpcAgentImpl({ agentId: PROBE_AGENT, name: 'x', role: 'worker', channelId: 'c' })
  const boundPrefix = await bound.contextPrefix()
  const order = [
    boundPrefix.indexOf('Scenario Brief'),
    boundPrefix.indexOf('产线工况简报'),
    boundPrefix.indexOf('工业调控作业环'),
  ]
  assert(order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2], `prefix 段序:场景→工况→作业环 [${order}]`)
  assert(boundPrefix.includes(LINE_NAME), 'prefix 携带产线事实')

  console.log('== Tier B: 工具面语义(HTTP,含实时状态) ==')
  // 报警透出:数采窗口故意收窄,线跑起来后真实温度必然越限
  await sleep(3500)
  const nodesCard = await invoke(PROBE_AGENT, 'my_industrial_nodes', {})
  assert(nodesCard.includes(SEM_MARKER), '语义卡透出自定义 semantics 原文(节点级覆盖)')
  assert(nodesCard.includes('[176, 188]') && nodesCard.includes('工艺窗口'), '语义卡含配方工艺窗口')
  assert(nodesCard.includes('手动确认模式'), '语义卡标注 manual 模式')
  assert(nodesCard.includes('状态 alarm'), '数采卡透出越窗报警状态(实时)')
  // 报警简报行的活体验证放在 Tier C(T1 问题要求报告当前报警节点) ——
  // 报警态是 dev 进程运行时状态,探针进程不可见

  // daq_query:line_id 过滤落实
  const q = await invoke(PROBE_AGENT, 'daq_query', { line_id: f.line.id, last_minutes: 5 })
  assert(q.includes('探针-温度采集'), 'daq_query(line_id) 命中本线节点')
  assert(q.includes('过滤条件') && q.includes(f.line.id), 'daq_query 结果标注 line_id 过滤')
  const qMiss = await invoke(PROBE_AGENT, 'daq_query', { line_id: 'no-such-line' })
  assert(qMiss.includes('没有归属产线'), 'daq_query(未知 line_id) 明确空集说明')
  const qConflict = await invoke(PROBE_AGENT, 'daq_query', { node_id: f.dq.id, line_id: 'other-line' })
  assert(qConflict.includes('过滤冲突'), 'daq_query(line_id 与 node_id 冲突) 显式报错')
  const qData = await invoke(PROBE_AGENT, 'daq_query', { node_id: f.dq.id, last_minutes: 5 })
  assert(qData.includes('工况判读'), 'daq_query 返回工况判读(窗口位置+同线设定联动)')

  // ===== Tier C: omp harness 实测(真实回合引用注入事实;任务文本零工业信息) =====
  let ch = null
  let team = null
  let tplWorker = null
  const taskIds = []
  console.log('== Tier C: omp harness 实测(真实回合引用注入事实) ==')
  if (fails.length > 0) {
    console.log('(Tier A/B 已有失败,跳过 omp 实测以免烧等待时间)')
  }
  else {
    ch = (await jpost('/api/workshop/channels', { name: '上下文注入探针频道' })).data
    team = (await jpost('/api/workshop/teams', { name: '上下文注入探针团队' })).data
    await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: 'tpl-default-lead', role: 'lead' })
    tplWorker = (await jpost('/api/workshop/agents', {
      name: '探针工艺员', harness: 'omp',
      config: { rpcMode: 'rpc', systemPromptPrefix: '你是产线工艺员,严格基于系统上下文与工具结果回答,不臆测。' },
    })).data
    await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: tplWorker.id, role: 'worker' })
    await jpost(`/api/workshop/teams/${team.id}/deploy`, { channelId: ch.channelId })
    const chAgents = (await jget(`/api/workshop/channels/${ch.channelId}/agents`)).data
    const workerInst = chAgents.find(a => a.role === 'worker')
    await jpost('/api/workshop/agent-tools/bindings', { agentId: workerInst.id, nodeId: f.dw.id, kind: 'dcw', mode: 'auto' })
    await jpost('/api/workshop/agent-tools/bindings', { agentId: workerInst.id, nodeId: f.dq.id, kind: 'daq', mode: 'auto' })
    console.log(`[omp] worker 实例 ${workerInst.id} 已部署并绑定`)

    // T1:禁用工具 —— 答案只能来自 prompt 注入的工况简报/作业环
    const t1 = (await jpost(`/api/workshop/channels/${ch.channelId}/tasks`, {
      title: '工况感知自检',
      parts: [{ text: '请把本题派发给绑定工业节点的团队成员作答(勿自行作答)。题目:不要调用任何工具,仅依据你系统上下文中自动注入的「产线工况简报」与「工业调控作业环」回答:1) 你所在产线名称;2) 活动配方名;3) 数控节点的配方工艺窗口数值区间;4) 逐字引用调控作业环第3步的决策纪律原文(含「安全量程」字样的整句);5) 简报是否列出了当前报警节点?若有,报告其名称与实时数值。逐项作答。' }],
    })).data
    taskIds.push(t1.task?.id ?? t1.id)
    const r1 = await waitTaskArtifact(ch.channelId, taskIds[0])
    assert(r1.includes('探针线R7'), 'omp 回合引用产线名(接受 LLM 缩写)')
    assert(r1.includes(RECIPE_NAME), 'omp 回合引用配方名')
    assert(r1.includes('176') || r1.includes('188'), 'omp 回合引用窗口数值')
    assert(r1.includes('安全量程 ∩ 活动配方工艺窗口'), 'omp 回合逐字引用作业环纪律')
    assert(r1.includes('探针-温度采集'), 'omp 回合引用当前报警节点(简报报警行活体验证)')

    // T2:工具面 —— my_industrial_nodes 语义原文(自定义 semantics 全链)
    const t2 = (await jpost(`/api/workshop/channels/${ch.channelId}/tasks`, {
      title: '节点语义自检',
      parts: [{ text: '请把本题派发给绑定工业节点的团队成员作答(勿自行作答)。题目:先调用 my_industrial_nodes 工具,然后回答:你绑定节点的「工艺语义/采集语义」原文是什么(以 PROBE-SEM 开头)?该节点的安全量程与当前活动配方窗口各是多少?' }],
    })).data
    taskIds.push(t2.task?.id ?? t2.id)
    const r2 = await waitTaskArtifact(ch.channelId, taskIds[1])
    assert(r2.includes('PROBE-SEM-7741'), 'omp 经工具引用自定义 semantics 原文')
    assert(r2.includes('176') && (r2.includes('150') || r2.includes('200')), 'omp 经工具引用量程与窗口')
  }

  // ===== 清理(尽力) =====
  if (ch) {
    for (const tid of taskIds) await jpost(`/api/workshop/channels/${ch.channelId}/tasks/${tid}/cancel`, {}).catch(() => {})
    await jdel(`/api/workshop/channels/${ch.channelId}`).catch(() => {})
  }
  if (team) await jdel(`/api/workshop/teams/${team.id}`).catch(() => {})
  if (tplWorker) await jdel(`/api/workshop/agents/${tplWorker.id}`).catch(() => {})
  const bl = (await jget(`/api/workshop/agent-tools/bindings?agentId=${PROBE_AGENT}`)).data.bindings ?? []
  for (const b of bl) await jdel(`/api/workshop/agent-tools/bindings/${b.id}`).catch(() => {})
  await cleanupFixture(f)

  console.log(`\n===== 上下文注入探针: ${pass} PASS / ${fails.length} FAIL =====`)
  if (fails.length) { fails.forEach(m => console.error(' -', m)); process.exitCode = 1 }
  process.exit(process.exitCode ?? 0)
}

main().catch((e) => { console.error('探针异常:', e); process.exit(1) })
