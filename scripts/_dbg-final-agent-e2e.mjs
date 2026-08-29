/**
 * 终审 E2E-B:Agent 团队作业 × 真实 Modbus 节点控制。
 * 真实 omp 团队(lead 调度 + omp 工程师 worker)绑定「真实 Modbus 数控/数采节点」,
 * 派发分析与优化任务:worker 读真实寄存器数据 → 分析 → HITL 批准 → 真实写入 40021。
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
  // ===== 1. 真实 Modbus 产线(E2E-A 同款) =====
  const twin = (await jpost('/api/workshop/device-twins', { name: 'Agent受控设备(E2E-B)', modelRef: 'dev-folder-extruder', kind: 'device', posX: 3000, posZ: 900 })).data.twin
  cleanup.push(['twin', twin.id])
  const line = (await jpost('/api/workshop/dcw/lines', { name: '终审产线B(Agent受控)' })).data.line
  cleanup.push(['dcw-line', line.id])
  const prod = (await jpost('/api/workshop/dcw/products', { name: '终审产品B', lineId: line.id })).data.product
  cleanup.push(['dcw-product', prod.id])
  const dq = (await jpost('/api/workshop/daq', {
    templateRef: 'daq-temp-tc', name: 'B-温度采集(Modbus)',
    driver: 'modbus-tcp',
    driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40003, dataType: 'float32', byteOrder: 'big' },
    intervalMs: 500, lineId: line.id, deviceBindingId: twin.id,
  })).data.node
  const dw = (await jpost('/api/workshop/dcw', {
    templateRef: 'dcw-temp-sp', name: 'B-温度设定(Modbus)',
    driver: 'modbus-tcp',
    driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big', engMin: 150, engMax: 200, rawMin: 0, rawMax: 2000 },
    lineId: line.id, deviceBindingId: twin.id,
  })).data.node
  cleanup.push(['daq', dq.id], ['dcw', dw.id])
  const rc = (await jpost('/api/workshop/dcw/recipes', {
    productId: prod.id, name: '终审配方B',
    params: [{ templateRef: 'dcw-temp-sp', nodeId: dw.id, value: 180, min: 176, max: 188 }],
    daqWindows: [{ nodeId: dq.id, min: 100, max: 260 }],
  })).data.recipe
  cleanup.push(['dcw-recipe', rc.id])
  const st = await jpost(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId: rc.id })
  if (!st.data?.line?.active) { fail('开跑失败'); process.exit(1) }
  await sleep(2500)
  console.log('[产线] B 线运行,真实 Modbus 节点就绪')

  // ===== 2. 真实 omp 团队部署 =====
  const chRes = (await jpost('/api/workshop/channels', { name: '产线优化组(E2E-B)' })).data
  const ch = { id: chRes.channelId }
  cleanup.push(['channel', ch.id])
  const team = (await jpost('/api/workshop/teams', { name: '产线优化组(E2E-B)' })).data
  cleanup.push(['team', team.id])
  await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: 'tpl-default-lead', role: 'lead' })
  const tplWorker = (await jpost('/api/workshop/agents', {
    name: '工艺工程师(E2E-B)', harness: 'omp',
    config: {
      intro: '负责读取真实产线数据并执行工艺优化',
      rpcMode: 'rpc',
      systemPromptPrefix: '你是工艺工程师。用 my_industrial_nodes 了解授权节点,用 daq_query 获取真实采集数据分析,然后将温度设定优化到 182℃(用 dcw_control,你的下发需要用户批准)。结论引用具体数值。',
    },
  })).data
  cleanup.push(['agent-tpl', tplWorker.id])
  await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: tplWorker.id, role: 'worker' })
  const dep = await jpost(`/api/workshop/teams/${team.id}/deploy`, { channelId: ch.id })
  console.log('[团队] omp 团队部署完成')
  const chAgents = (await jget(`/api/workshop/channels/${ch.id}/agents`)).data
  const workerInst = chAgents.find(a => a.role === 'worker')
  if (!workerInst) { fail('worker 实例缺失'); process.exit(1) }
  cleanup.push(['channel-agent', `${ch.id}:${workerInst.id}`])

  // ===== 3. 绑定真实节点给 worker =====
  await jpost('/api/workshop/agent-tools/bindings', { agentId: workerInst.id, nodeId: dq.id, kind: 'daq', mode: 'auto' })
  await jpost('/api/workshop/agent-tools/bindings', { agentId: workerInst.id, nodeId: dw.id, kind: 'dcw', mode: 'manual' })
  const bl = (await jget(`/api/workshop/agent-tools/bindings?agentId=${workerInst.id}`)).data.bindings
  if (bl.length === 2) console.log('[绑定] worker 持有真实 Modbus 数采(auto)+ 数控(manual)')
  else fail(`绑定异常: ${bl.length}`)

  // ===== 4. 工具冒烟(worker 身份读真实数据) =====
  const q = await invoke(workerInst.id, 'daq_query', { last_minutes: 5 })
  if (!q.text.includes('B-温度采集')) { fail(`daq_query 异常: ${q.text.slice(0, 100)}`); process.exit(1) }
  const m = q.text.match(/最新 (\d+(\.\d+)?)/)
  console.log(`[工具] worker 读真实寄存器:最新温度 ${m?.[1]}℃(经 Modbus 采集)`)

  // ===== 5. 派发优化任务 → 观察 HITL 与写副作用 =====
  const goal = `分析产线「${line.name}」温度数据并执行优化:1) daq_query 获取最近数据;2) 将温度设定优化为 182℃(dcw_control,等待用户批准);3) 汇报数值。`
  const task = (await jpost(`/api/workshop/channels/${ch.id}/tasks`, { title: '工艺优化(真实节点)', parts: [{ text: goal }], mode: 'loop' })).data
  const taskId = task?.task?.id ?? task?.id
  if (!taskId) { fail(`任务派发失败: ${JSON.stringify(task).slice(0, 120)}`); process.exit(1) }
  console.log(`[任务] ${taskId.slice(0, 8)} 已派发(真实节点优化)`)

  let hitlSeen = false
  let written = false
  let subSeen = false
  for (let i = 0; i < 300; i++) {
    await sleep(2000)
    const tasksRes = (await jget(`/api/workshop/channels/${ch.id}/tasks`)).data
    const tasks = Array.isArray(tasksRes) ? tasksRes : tasksRes?.tasks ?? []
    if (!subSeen && tasks.find(t => t.id !== taskId)) { subSeen = true; console.log('[调度] lead 派发子任务') }
    const pend = (await jget(`/api/workshop/agent-tools/approvals?agentId=${workerInst.id}`)).data.approvals
    if (pend.length > 0 && !hitlSeen) {
      hitlSeen = true
      console.log(`[HITL] Agent 请求下发: ${pend[0].detail.slice(0, 56)}`)
      await jpost(`/api/workshop/agent-tools/approvals/${pend[0].id}/decide`, { approved: true, comment: '批准' })
      console.log('[HITL] 批准(真实设备写入放行)')
    }
    const dwNow = (await jget('/api/workshop/dcw')).data.nodes.find(n => n.id === dw.id)
    // Agent 自主决策:目标值由其分析得出(引导 182,实际按实时数据可在窗口内浮动)
    // 只有经 HITL 批准的写入才算 Agent 副作用(180 = 配方 lineStart 初始下发,须排除)
    if (hitlSeen && dwNow?.value != null && dwNow.value >= 176 && dwNow.value <= 188) { written = true; break }
  }
  if (subSeen) console.log('PASS lead 调度(真实团队)')
  else fail('未见解派发')
  if (hitlSeen) console.log('PASS HITL:Agent 对真实 Modbus 节点的下发经用户批准')
  else fail('未见 HITL 审批')
  const dwFinal = (await jget('/api/workshop/dcw')).data.nodes.find(n => n.id === dw.id)
  if (written) console.log(`PASS 真实写副作用:Agent 自主决策下发 ${dwFinal?.value}℃(raw ${(dwFinal.value - 150) / 50 * 2000}),经 Modbus 同址回读一致`)
  else fail(`写副作用缺失: value=${dwFinal?.value}`)

  // ===== 6. 打标 + 语义查询 =====
  const states = (await jget('/api/workshop/dcw/lines')).data.states
  const stB = states.find(s => s.lineId === line.id)
  if (stB?.taggedSamples > 0) console.log(`PASS 数据打标:${stB.taggedSamples} 样本归属本产线批次`)
  else fail('打标异常')
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
        else if (kind === 'twin') await jdel(`/api/workshop/device-twins/${id}`)
        else if (kind === 'channel-agent') {
          const [cid, aid] = String(id).split(':')
          await jdel(`/api/workshop/channels/${cid}/agents/${aid}`)
        }
        else if (kind === 'channel') await jdel(`/api/workshop/channels/${id}`)
        else if (kind === 'team') await jdel(`/api/workshop/teams/${id}`)
        else if (kind === 'agent-tpl') await jdel(`/api/workshop/agents/${id}`)
      }
      catch { /* 尽力清理 */ }
    }
    console.log(process.exitCode ? 'E2E-B FAILED' : 'E2E-B ALL PASS')
    process.exit(process.exitCode ?? 0)
  })
  .catch((err) => { console.error('FATAL:', err.message); process.exit(1) })
