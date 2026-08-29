/**
 * 全链条端到端审计:真实 omp Harness Agent 团队 × mock 产线。
 * 链路:建 channel/团队 → 部署 lead+worker(omp)→ 搭产线(数采/数控/配方/开跑)
 *   → Agent 绑定工业节点 → 派发分析任务 → lead 调度派发 → worker 用
 *   my_industrial_nodes/daq_query 读数 → dcw_control 下发 → HITL 批准
 *   → 任务完成/告警/孪生同步 → 清理。
 */
const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
const jpost = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())
const jget = (u) => fetch(ROOT + u, { headers: H }).then(r => r.json())
const jdel = (u) => fetch(ROOT + u, { method: 'DELETE', headers: H }).then(r => r.json())
const invoke = (agentId, tool, args) => jpost('/api/workshop/agent-tools/invoke', { agentId, tool, args }).then(r => r.data.result)

const cleanup = []
async function main() {
  // ===== 1. mock 产线:1 线 2 数采 2 数控 + 配方 + 开跑 =====
  const line = (await jpost('/api/workshop/dcw/lines', { name: '全链路审计线' })).data.line
  cleanup.push(['dcw-line', line.id])
  const prod = (await jpost('/api/workshop/dcw/products', { name: '全链路审计产品', lineId: line.id })).data.product
  cleanup.push(['dcw-product', prod.id])
  const dq = (await jpost('/api/workshop/daq', { templateRef: 'daq-temp-tc', name: 'E2E-温度采集', lineId: line.id, intervalMs: 500 })).data.node
  const dq2 = (await jpost('/api/workshop/daq', { templateRef: 'daq-pressure-tx', name: 'E2E-压力采集', lineId: line.id, intervalMs: 500 })).data.node
  const dw = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: 'E2E-温度设定', lineId: line.id })).data.node
  cleanup.push(['daq', dq.id], ['daq', dq2.id], ['dcw', dw.id])
  const rc = (await jpost('/api/workshop/dcw/recipes', {
    productId: prod.id, name: '全链路审计配方',
    params: [{ templateRef: 'dcw-temp-sp', nodeId: dw.id, value: 180, min: 176, max: 188 }],
    daqWindows: [{ nodeId: dq.id, min: 100, max: 260 }],
  })).data.recipe
  cleanup.push(['dcw-recipe', rc.id])
  const st = await jpost(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId: rc.id })
  if (!st.data?.line?.active) { fail('产线开跑失败'); process.exit(1) }
  await sleep(2500)
  const daqLive = (await jget('/api/workshop/daq')).data.nodes.find(n => n.id === dq.id)
  console.log(`[产线] ${line.name} 运行中,数采实时 ${daqLive?.value}${daqLive?.unit}(${daqLive?.state})`)

  // ===== 2. AgentTeam:分析团队(lead + 数据工程师,omp harness) =====
  const chRes = (await jpost('/api/workshop/channels', { name: '产线优化团队(E2E)', description: '全链路审计' })).data
  const ch = { id: chRes.channelId }
  cleanup.push(['channel', ch.id])
  const team = (await jpost('/api/workshop/teams', { name: '产线分析组(E2E)', description: '数据获取分析与工艺优化' })).data
  if (!team) { fail('团队创建失败'); process.exit(1) }
  cleanup.push(['team', team.id])
  console.log(`[团队] ${team.name}(${team.id.slice(0, 8)})`)

  // lead:产线优化主管(omp);worker:数据分析工程师(omp,提示词驱动用工业工具)
  await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: 'tpl-default-lead', role: 'lead' })
  const tplWorkerResp = await jpost('/api/workshop/agents', {
    name: '数据分析工程师(E2E)', harness: 'omp',
    config: {
      intro: '负责从数采时序库获取产线数据、分析趋势,并按分析结论对数控设定下发工艺优化',
      systemPromptPrefix: '你是产线数据分析工程师。用 my_industrial_nodes 查看授权节点,用 daq_query 获取最新数据并分析均值/趋势,如需调整工艺用 dcw_control 下发(目标:温度均值向 182 靠拢)。结论需引用具体数值。',
    },
  })
  const tplWorker = tplWorkerResp.data
  cleanup.push(['agent-tpl', tplWorker.id])
  const worker = await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: tplWorker.id, role: 'worker' })
  console.log(`[团队] lead + worker 成员就绪(${team.members?.length ?? '?'} 人)`)

  // 部署到 channel
  const dep = await jpost(`/api/workshop/teams/${team.id}/deploy`, { channelId: ch.id })
  const members = Array.isArray(dep.data) ? dep.data : dep.data?.deployed ?? dep.data?.members ?? []
  console.log(`[部署] ${members.length} 个 Agent 实例进入 channel(${JSON.stringify(dep).slice(0, 80)}...)`)

  // 部署后的实例 id(worker/lead)
  const chAgents = (await jget(`/api/workshop/channels/${ch.id}/agents`)).data
  const leadInst = chAgents.find(a => a.role === 'lead')
  const workerInst = chAgents.find(a => a.role === 'worker')
  if (!leadInst || !workerInst) { fail(`部署实例缺失: ${chAgents.length}`); process.exit(1) }
  for (const a of [leadInst, workerInst]) cleanup.push(['channel-agent', `${ch.id}:${a.id}`])
  console.log(`[实例] lead ${leadInst.id.slice(0, 8)} / worker ${workerInst.id.slice(0, 8)}(harness=${workerInst.harness})`)

  // ===== 3. 绑定工业节点给 worker 实例 =====
  await jpost('/api/workshop/agent-tools/bindings', { agentId: workerInst.id, nodeId: dq.id, kind: 'daq', mode: 'auto' })
  await jpost('/api/workshop/agent-tools/bindings', { agentId: workerInst.id, nodeId: dq2.id, kind: 'daq', mode: 'auto' })
  await jpost('/api/workshop/agent-tools/bindings', { agentId: workerInst.id, nodeId: dw.id, kind: 'dcw', mode: 'manual' })
  const bl = (await jget(`/api/workshop/agent-tools/bindings?agentId=${workerInst.id}`)).data.bindings
  if (bl.length === 3) console.log('[绑定] worker 持有 2 数采(auto)+ 1 数控(manual)')
  else fail(`绑定异常: ${bl.length}`)

  // ===== 4. 工具链路冒烟(worker 实例身份,经 HTTP 桥 = omp 同路径) =====
  const mine = await invoke(workerInst.id, 'my_industrial_nodes', {})
  if (!mine.text.includes('E2E-温度采集') || !mine.text.includes('E2E-温度设定')) fail(`节点清单异常: ${mine.text.slice(0, 120)}`)
  else console.log('[工具] my_industrial_nodes:3 节点物理语义齐备')
  const q = await invoke(workerInst.id, 'daq_query', { last_minutes: 5 })
  if (!q.text.includes('E2E-温度采集') || !q.text.includes('最新')) fail(`daq_query 异常: ${q.text.slice(0, 120)}`)
  else console.log('[工具] daq_query:双节点数据 + 统计语义齐备')

  // ===== 5. 派发真实分析任务(lead 调度 → worker 执行) =====
  const goal = `请分析产线「${line.name}」当前运行状态:1) 用你的数采工具获取最近 5 分钟温度/压力数据并给出均值与趋势;2) 判断温度均值与目标 182℃ 的偏差;3) 若偏差超过 1℃,用数控工具下发修正(注意你的温度设定为手动确认模式,等待用户批准)。完成后汇报数值结论。`
  const task = (await jpost(`/api/workshop/channels/${ch.id}/tasks`, {
    title: '产线数据分析与工艺优化',
    parts: [{ text: goal }],
    mode: 'loop',
  })).data
  const taskId = task?.task?.id ?? task?.id
  if (!taskId) { fail(`任务派发失败: ${JSON.stringify(task).slice(0, 150)}`); process.exit(1) }
  cleanup.push(['task', taskId])
  console.log(`[任务] 已派发 ${taskId.slice(0, 8)}(loop 模式)`)

  // ===== 6. 观察调度与执行:轮询任务树 + 工具副作用 =====
  let subTaskSeen = false
  let workerValueSeen = false
  let hitlSeen = false
  for (let i = 0; i < 150; i++) {
    await sleep(2000)
    const tasksRes = (await jget(`/api/workshop/channels/${ch.id}/tasks`)).data
    const tasks = Array.isArray(tasksRes) ? tasksRes : tasksRes?.tasks ?? []
    const sub = tasks.find(t => t.id !== taskId)
    if (sub && !subTaskSeen) { subTaskSeen = true; console.log(`[调度] lead 已派发子任务 ${sub.id.slice(0, 8)} → ${sub.assigneeId?.slice(0, 8)}`) }
    if (i > 0 && i % 10 === 0) {
      const mem = (await jget(`/api/workshop/channels/${ch.id}/queue`)).data
      const arr = Array.isArray(mem) ? mem : []
      console.log(`  [t+${i * 2}s] tasks: ${tasks.map(t => t.state).join(',')} | agents: ${arr.map(m => `${m.role}:${m.state}:${m.currentTaskId?.slice(0, 6) ?? '-'}`).join(',')}`)
    }
    // worker 数值写副作用:dcw_control 需 HITL → 审批面板出现
    const pend = (await jget(`/api/workshop/agent-tools/approvals?agentId=${workerInst.id}`)).data.approvals
    if (pend.length > 0 && !hitlSeen) {
      hitlSeen = true
      console.log(`[HITL] Agent 发起下发审批: ${pend[0].detail.slice(0, 60)}`)
      await jpost(`/api/workshop/agent-tools/approvals/${pend[0].id}/decide`, { approved: true, comment: '分析结论合理,批准' })
      console.log('[HITL] 用户批准(备注:分析结论合理,批准)')
    }
    // 写副作用:节点 value 被改为 182±(Agent 的优化目标)
    const dwNow = (await jget('/api/workshop/dcw')).data.nodes.find(n => n.id === dw.id)
    if (dwNow?.value != null && dwNow.value !== 180 && Math.abs(dwNow.value - 182) <= 3) workerValueSeen = true
    const subDone = sub && (sub.state === 'COMPLETED')
    if (workerValueSeen && (subDone || i > 60)) break
  }
  if (subTaskSeen) console.log('PASS lead 调度:主任务拆解并派发子任务')
  else fail('未见 lead 派发子任务')
  if (hitlSeen) console.log('PASS HITL:Agent 经工具发起数控下发,用户批准后执行')
  else fail('未见 Agent 的 HITL 审批请求')
  const dwFinal = (await jget('/api/workshop/dcw')).data.nodes.find(n => n.id === dw.id)
  if (workerValueSeen) console.log(`PASS 写副作用:温度设定被 Agent 更新为 ${dwFinal?.value}℃(目标 182)`)
  else fail(`设定值未变: ${dwFinal?.value}`)

  // ===== 7. 孪生/告警/打标链路抽查 =====
  const states = (await jget('/api/workshop/dcw/lines')).data.states
  const stLine = states.find(s => s.lineId === line.id)
  if (stLine?.active && stLine.taggedSamples > 0) console.log(`PASS 数据打标:产线窗口内 ${stLine.taggedSamples} 样本带产线标识`)
  else fail(`打标异常: ${JSON.stringify(stLine)}`)
  const qAfter = await invoke(workerInst.id, 'daq_query', { last_minutes: 5 })
  if (qAfter.text.includes('均值')) console.log('PASS Agent 可持续获取打标数据的物理语义视图')
  else fail(`查询异常: ${qAfter.text.slice(0, 100)}`)
}

main()
  .then(async () => {
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
    console.log(process.exitCode ? 'E2E FAILED' : 'E2E ALL PASS')
    process.exit(process.exitCode ?? 0)
  })
  .catch((err) => {
    console.error('FATAL:', err.message)
    process.exit(1)
  })
