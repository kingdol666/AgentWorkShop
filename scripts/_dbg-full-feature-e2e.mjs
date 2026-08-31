/**
 * 全功能端到端验证(针对运行中的 dev 环境,默认 http://127.0.0.1:3000)。
 * 覆盖:产线搭建与开跑 → 数采实时 → 产线控制联锁(配方窗口)→ AgentTeam 部署
 *   → Agent 绑定工业节点 → 工具桥冒烟 → goal 任务派发 → lead 调度 → 真实 omp
 *   worker 执行(my_industrial_nodes/daq_query/dcw_control)→ HITL 审批 →
 *   写副作用(设定值变化)→ 任务完成 → 打标抽查 → 清理。
 * 运行: node scripts/_dbg-full-feature-e2e.mjs
 */
const ROOT = process.env.AW_BASE ?? 'http://127.0.0.1:3000'
let TOKEN = process.env.AW_E2E_TOKEN ?? ''
const H = () => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const fail = (m) => { console.error('FATAL:', m); process.exit(1) }

async function api(method, path, body) {
  const res = await fetch(ROOT + path, { method, headers: H(), body: body !== undefined ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, ...json }
}
const jpost = (u, b) => api('POST', u, b ?? {})
const jget = (u) => api('GET', u)
const jdel = (u) => api('DELETE', u)
const invoke = async (agentId, tool, args) => {
  const r = await jpost('/api/workshop/agent-tools/invoke', { agentId, tool, args })
  return r.data?.result ?? { text: JSON.stringify(r).slice(0, 200), isError: true }
}

const cleanup = []
const tag = Math.random().toString(36).slice(2, 8)

async function main() {
  // ===== 0. 用户注册 =====
  console.log('━━━ 0. 用户注册 ━━━')
  const reg = await jpost('/api/workshop/users/register', { name: 'ffx-' + tag })
  TOKEN = reg.data?.token
  if (!TOKEN) fail('用户注册失败: ' + JSON.stringify(reg).slice(0, 120))
  check('用户注册并取得 token', !!TOKEN)

  // ===== 1. 产线搭建:1 线 1 产品 2 数采 1 数控 + 配方 + 开跑 =====
  console.log('\n━━━ 1. 产线搭建与开跑 ━━━')
  const line = (await jpost('/api/workshop/dcw/lines', { name: '全功能验证线-' + tag })).data.line
  cleanup.push(['dcw-line', line.id])
  const prod = (await jpost('/api/workshop/dcw/products', { name: '全功能产品-' + tag, lineId: line.id })).data.product
  cleanup.push(['dcw-product', prod.id])
  const dq = (await jpost('/api/workshop/daq', { templateRef: 'daq-temp-tc', name: 'FFX-温度采集', lineId: line.id, intervalMs: 500 })).data.node
  const dq2 = (await jpost('/api/workshop/daq', { templateRef: 'daq-pressure-tx', name: 'FFX-压力采集', lineId: line.id, intervalMs: 500 })).data.node
  cleanup.push(['daq', dq.id], ['daq', dq2.id])
  const dw = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: 'FFX-温度设定', lineId: line.id })).data.node
  cleanup.push(['dcw', dw.id])
  check('产线实体创建(2 数采 + 1 数控)', !!dq?.id && !!dq2?.id && !!dw?.id)
  const rc = (await jpost('/api/workshop/dcw/recipes', {
    productId: prod.id, name: '全功能配方-' + tag,
    params: [{ templateRef: 'dcw-temp-sp', nodeId: dw.id, value: 180, min: 176, max: 188 }],
    daqWindows: [{ nodeId: dq.id, min: 100, max: 260 }],
  })).data.recipe
  cleanup.push(['dcw-recipe', rc.id])
  check('配方创建(temp-sp@180,窗口 176~188;daq 窗口 100~260)', !!rc?.id)
  const st = await jpost(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId: rc.id })
  check('产线开跑(active)', !!st.data?.line?.active, `active=${st.data?.line?.active}`)
  await sleep(3000)
  const daqNodes = (await jget('/api/workshop/daq')).data.nodes
  const dqLive = daqNodes.find(n => n.id === dq.id)
  check('数采实时值流动', dqLive?.value != null, `temp=${dqLive?.value}${dqLive?.unit ?? ''} state=${dqLive?.state}`)
  const dwLive = (await jget('/api/workshop/dcw')).data.nodes.find(n => n.id === dw.id)
  check('数控设定值已由配方下发(180)', Math.abs((dwLive?.value ?? 0) - 180) < 0.01, `value=${dwLive?.value}`)

  // ===== 2. 产线控制联锁(REST 直写;配方窗口替代全局量程) =====
  console.log('\n━━━ 2. 产线控制联锁(配方窗口)━━━')
  const wOk = await jpost(`/api/workshop/dcw/${dw.id}/write`, { value: 182 })
  check('窗口内写入 182 成功', wOk.status === 200 && wOk.data?.outcome?.ok === true, `readback=${wOk.data?.outcome?.readback}`)
  const wLow = await jpost(`/api/workshop/dcw/${dw.id}/write`, { value: 170 })
  check('低于工艺下限 176 被拒(400)', wLow.status === 400, `status=${wLow.status} msg=${String(wLow.message ?? '').slice(0, 60)}`)
  const wHigh = await jpost(`/api/workshop/dcw/${dw.id}/write`, { value: 200 })
  check('高于工艺上限 188 被拒(400)', wHigh.status === 400, `status=${wHigh.status}`)
  await jpost(`/api/workshop/dcw/${dw.id}/write`, { value: 180 }) // 复位

  // ===== 3. AgentTeam:分析团队(lead mock + worker omp)部署 =====
  console.log('\n━━━ 3. AgentTeam 部署 ━━━')
  const chRes = (await jpost('/api/workshop/channels', { name: '全功能团队-' + tag, description: '产线数据分析与工艺优化' })).data
  const ch = { id: chRes.channelId }
  cleanup.push(['channel', ch.id])
  check('channel 创建', !!ch.id)
  const team = (await jpost('/api/workshop/teams', { name: '全功能分析组-' + tag, description: '数据分析 + 工艺优化' })).data
  cleanup.push(['team', team.id])
  check('团队创建', !!team?.id)
  await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: 'tpl-default-lead', role: 'lead' })
  const tplWorker = (await jpost('/api/workshop/agents', {
    name: '数据分析工程师-' + tag, harness: 'omp',
    config: {
      intro: '负责从数采时序库获取产线数据、分析趋势,并按分析结论对数控设定下发工艺优化',
      systemPromptPrefix: '你是产线数据分析工程师。先用 my_industrial_nodes 查看你的授权节点,再用 daq_query 获取最近 5 分钟数据并给出均值。若温度均值与 182℃ 偏差超过 1℃,用 dcw_control 把温度设定调整为 182(你的温度设定节点是手动确认模式,发起后等待用户批准)。结论必须引用具体数值。',
    },
  })).data
  cleanup.push(['agent-tpl', tplWorker.id])
  await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: tplWorker.id, role: 'worker' })
  const dep = await jpost(`/api/workshop/teams/${team.id}/deploy`, { channelId: ch.id })
  const chAgents = (await jget(`/api/workshop/channels/${ch.id}/agents`)).data
  const leadInst = chAgents.find(a => a.role === 'lead')
  const workerInst = chAgents.find(a => a.role === 'worker')
  cleanup.push(['channel-agent', `${ch.id}:${leadInst?.id}`], ['channel-agent', `${ch.id}:${workerInst?.id}`])
  check('部署 lead+worker 实例进入 channel', !!leadInst && !!workerInst, `harness(lead)=${leadInst?.harness} harness(worker)=${workerInst?.harness}`)

  // ===== 4. Agent 绑定工业节点 =====
  console.log('\n━━━ 4. Agent 绑定工业节点 ━━━')
  await jpost('/api/workshop/agent-tools/bindings', { agentId: workerInst.id, nodeId: dq.id, kind: 'daq', mode: 'auto' })
  await jpost('/api/workshop/agent-tools/bindings', { agentId: workerInst.id, nodeId: dq2.id, kind: 'daq', mode: 'auto' })
  await jpost('/api/workshop/agent-tools/bindings', { agentId: workerInst.id, nodeId: dw.id, kind: 'dcw', mode: 'manual' })
  const bl = (await jget(`/api/workshop/agent-tools/bindings?agentId=${workerInst.id}`)).data.bindings
  check('worker 绑定 2 数采(auto)+ 1 数控(manual)', bl.length === 3, `n=${bl.length}`)

  // ===== 5. 工具桥冒烟(与 omp host tools 同一服务层) =====
  console.log('\n━━━ 5. 工具桥冒烟 ━━━')
  const mine = await invoke(workerInst.id, 'my_industrial_nodes', {})
  check('my_industrial_nodes:3 节点物理语义齐备', mine.text?.includes('FFX-温度采集') && mine.text?.includes('FFX-温度设定'), mine.text?.slice(0, 80))
  const q = await invoke(workerInst.id, 'daq_query', { last_minutes: 5 })
  check('daq_query:双节点数据 + 统计语义', q.text?.includes('FFX-温度采集'), q.text?.slice(0, 80))
  const qDenied = await invoke('nonexistent-agent', 'daq_query', {})
  check('未绑定 Agent 调用被拒', qDenied.isError === true)

  // ===== 6. goal 任务派发:数据分析 → 判断偏差 → 下发修正 =====
  console.log('\n━━━ 6. goal 任务派发(真实 omp worker 执行)━━━')
  const goal = `请分析产线当前运行状态:1) 用你的数采工具获取最近 5 分钟温度数据并给出均值;2) 判断温度均值与 182℃ 目标的偏差;3) 偏差超过 1℃ 时,用数控工具把温度设定调整为 182(手动确认模式,发起后等待批准)。完成后汇报数值结论。`
  const task = (await jpost(`/api/workshop/channels/${ch.id}/tasks`, {
    title: '产线数据分析与工艺优化-' + tag,
    parts: [{ text: goal }],
    mode: 'goal',
    modeConfig: { goalCriteria: '已产出含具体数值的数据分析结论,且温度设定值已调整为 182℃ 附近(或明确说明未需调整)' },
  })).data
  const taskId = task?.task?.id ?? task?.id
  check('goal 任务已提交', !!taskId, `id=${taskId?.slice(0, 8)}`)
  cleanup.push(['task', taskId])

  // ===== 7. 观察调度 → 执行 → HITL → 写副作用 → 完成 =====
  console.log('\n━━━ 7. 观察:调度 → omp 执行 → HITL → 副作用 ━━━')
  let subTaskSeen = false, hitlSeen = false, workerValueSeen = false, approved = false
  let subState = '', lastLog = 0
  const t0 = Date.now()
  for (let i = 0; i < 200; i++) {
    await sleep(3000)
    const tasksRes = (await jget(`/api/workshop/channels/${ch.id}/tasks`)).data
    const tasks = Array.isArray(tasksRes) ? tasksRes : tasksRes?.tasks ?? []
    const sub = tasks.find(t => t.id !== taskId)
    if (sub && !subTaskSeen) {
      subTaskSeen = true
      console.log(`[t+${Math.round((Date.now() - t0) / 1000)}s] [调度] lead 已派发子任务 ${sub.id.slice(0, 8)} → ${sub.assigneeId?.slice(0, 8)}`)
    }
    if (sub) subState = sub.state
    // HITL:worker 发起 dcw_control → 审批面板出现 → 批准
    if (!approved) {
      const pend = (await jget(`/api/workshop/agent-tools/approvals?agentId=${workerInst.id}`)).data.approvals
      if (pend.length > 0 && !hitlSeen) {
        hitlSeen = true
        console.log(`[t+${Math.round((Date.now() - t0) / 1000)}s] [HITL] Agent 发起下发审批: ${String(pend[0].detail).slice(0, 70)}`)
        await jpost(`/api/workshop/agent-tools/approvals/${pend[0].id}/decide`, { approved: true, comment: '分析结论合理,批准执行' })
        approved = true
        console.log(`[t+${Math.round((Date.now() - t0) / 1000)}s] [HITL] 用户已批准`)
      }
    }
    // 写副作用:温度设定被 Agent 更新为 182±3
    const dwNow = (await jget('/api/workshop/dcw')).data.nodes.find(n => n.id === dw.id)
    if (dwNow?.value != null && Math.abs(dwNow.value - 182) <= 3 && dwNow.value !== 180) workerValueSeen = true
    if (i % 10 === 0 && i > 0) {
      const mem = (await jget(`/api/workshop/channels/${ch.id}/queue`)).data
      const arr = Array.isArray(mem) ? mem : []
      console.log(`  [t+${i * 3}s] tasks: ${tasks.map(t => t.state).join(',')} | agents: ${arr.map(m => `${m.role}:${m.state}`).join(',')}`)
    }
    const parentDone = tasks.find(t => t.id === taskId)?.state === 'COMPLETED'
    if (workerValueSeen && (parentDone || subState === 'COMPLETED' || i > 90)) break
  }
  check('lead 调度:主任务拆解并派发子任务', subTaskSeen)
  check('HITL:Agent 经工具发起数控下发,用户批准后执行', hitlSeen)
  const dwFinal = (await jget('/api/workshop/dcw')).data.nodes.find(n => n.id === dw.id)
  check('写副作用:温度设定被 Agent 更新为 182 附近', workerValueSeen, `value=${dwFinal?.value}℃(目标 182)`)
  const parentState = (await jget(`/api/workshop/channels/${ch.id}/tasks`)).data
  const parent = (Array.isArray(parentState) ? parentState : parentState?.tasks ?? []).find(t => t.id === taskId)
  check('goal 任务最终完成', parent?.state === 'COMPLETED', `state=${parent?.state} sub=${subState}`)

  // ===== 8. 打标/孪生抽查 =====
  console.log('\n━━━ 8. 打标与数据链路抽查 ━━━')
  const states = (await jget('/api/workshop/dcw/lines')).data.states
  const stLine = states.find(s => s.lineId === line.id)
  check('数据打标:产线窗口内样本带产线标识', stLine?.active && stLine.taggedSamples > 0, `tagged=${stLine?.taggedSamples}`)
  const qAfter = await invoke(workerInst.id, 'daq_query', { last_minutes: 5 })
  check('Agent 可持续获取打标数据的物理语义视图', qAfter.text?.includes('均值') || qAfter.text?.includes('FFX-温度采集'))
}

main()
  .then(async () => {
    console.log('\n━━━ 清理 ━━━')
    for (const [kind, id] of [...cleanup].reverse()) {
      try {
        if (kind === 'dcw-line') await jpost(`/api/workshop/dcw/lines/${id}/stop`, {})
        else if (kind === 'daq') await jdel(`/api/workshop/daq/${id}`)
        else if (kind === 'dcw') await jdel(`/api/workshop/dcw/${id}`)
        else if (kind === 'dcw-recipe') await jdel(`/api/workshop/dcw/recipes/${id}`)
        else if (kind === 'dcw-product') await jdel(`/api/workshop/dcw/products/${id}`)
        else if (kind === 'task') await jpost(`/api/workshop/channels/unknown/tasks/${id}/cancel`, {}).catch(() => {})
        else if (kind === 'channel-agent') {
          const [cid, aid] = String(id).split(':')
          await jdel(`/api/workshop/channels/${cid}/agents/${aid}`)
        }
        else if (kind === 'channel') await jdel(`/api/workshop/channels/${id}`)
        else if (kind === 'team') await jdel(`/api/workshop/teams/${id}`)
        else if (kind === 'agent-tpl') await jdel(`/api/workshop/agents/${id}`)
      }
      catch { /* 清理尽力而为 */ }
    }
    console.log(failures === 0 ? '\nE2E ALL PASS' : `\nE2E ${failures} FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('FATAL:', err.message)
    process.exit(1)
  })
