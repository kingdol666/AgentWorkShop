/**
 * 团队场景复现:mock lead + omp worker + goal 任务,保留现场不清理。
 */
const ROOT = 'http://127.0.0.1:3000'
let TOKEN = ''
const H = () => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const jpost = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H(), body: JSON.stringify(b ?? {}) }).then(r => r.json())
const jget = (u) => fetch(ROOT + u, { headers: H() }).then(r => r.json())

async function main() {
  const reg = await jpost('/api/workshop/users/register', { name: 'teamdbg-' + Math.random().toString(36).slice(2, 8) })
  TOKEN = reg.data?.token
  if (!TOKEN) { console.error('register failed'); process.exit(1) }

  const line = (await jpost('/api/workshop/dcw/lines', { name: 'TEAMDBG-线' })).data.line
  const dq = (await jpost('/api/workshop/daq', { templateRef: 'daq-temp-tc', name: 'TEAMDBG-温度', lineId: line.id, intervalMs: 500 })).data.node
  const dw = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: 'TEAMDBG-设定', lineId: line.id })).data.node
  const prod = (await jpost('/api/workshop/dcw/products', { name: 'TEAMDBG-产品', lineId: line.id })).data.product
  const rc = (await jpost('/api/workshop/dcw/recipes', {
    productId: prod.id, name: 'TEAMDBG-配方',
    params: [{ templateRef: 'dcw-temp-sp', nodeId: dw.id, value: 180, min: 176, max: 188 }],
    daqWindows: [{ nodeId: dq.id, min: 100, max: 260 }],
  })).data.recipe
  await jpost(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId: rc.id })
  console.log('[line] started')

  const ch = (await jpost('/api/workshop/channels', { name: 'TEAMDBG-channel' })).data
  const team = (await jpost('/api/workshop/teams', { name: 'TEAMDBG-组' })).data
  await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: 'tpl-default-lead', role: 'lead' })
  const tplWorker = (await jpost('/api/workshop/agents', {
    name: 'TEAMDBG-worker', harness: 'omp',
    config: { systemPromptPrefix: '你是产线数据分析工程师。先用 my_industrial_nodes 查看授权节点,再用 daq_query 获取最近 2 分钟数据给出均值。若温度均值与 182℃ 偏差超过 1℃,用 dcw_control 把温度设定调整为 182(手动确认模式,发起后等待批准)。结论引用具体数值。' },
  })).data
  await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: tplWorker.id, role: 'worker' })
  const depRes = await jpost(`/api/workshop/teams/${team.id}/deploy`, { channelId: ch.channelId })
  console.log('[deploy-res]', JSON.stringify(depRes).slice(0, 300))
  const chAgentsRes = (await jget(`/api/workshop/channels/${ch.channelId}/agents`)).data
  const chAgents = Array.isArray(chAgentsRes) ? chAgentsRes : chAgentsRes?.agents ?? []
  const worker = chAgents.find(a => a.role === 'worker')
  if (!worker) { console.error('[deploy] worker missing, agents=' + JSON.stringify(chAgents).slice(0, 200)); process.exit(1) }
  console.log('[deployed] worker=' + worker.id.slice(0, 8) + ' harness=' + worker.harness)
  await jpost('/api/workshop/agent-tools/bindings', { agentId: worker.id, nodeId: dq.id, kind: 'daq', mode: 'auto' })
  await jpost('/api/workshop/agent-tools/bindings', { agentId: worker.id, nodeId: dw.id, kind: 'dcw', mode: 'manual' })

  const task = await jpost(`/api/workshop/channels/${ch.channelId}/tasks`, {
    title: 'TEAMDBG-分析任务',
    parts: [{ text: '分析产线温度:1) 用 daq_query 获取最近 2 分钟温度均值;2) 与 182℃ 目标比较偏差;3) 偏差超过 1℃ 时用 dcw_control 下发修正(等待批准)。完成后汇报数值结论。' }],
    mode: 'goal',
    modeConfig: { goalCriteria: '已产出含具体数值的数据分析结论,且温度设定值已调整为 182℃ 附近(或明确说明未需调整)' },
  })
  const taskId = task.data?.task?.id ?? task.data?.id
  console.log('[task]', taskId?.slice(0, 8), 'code=' + task.code)

  for (let i = 0; i < 70; i++) {
    await sleep(3000)
    const t = (await jget(`/api/workshop/channels/${ch.channelId}/tasks`)).data
    const arr = Array.isArray(t) ? t : t?.tasks ?? []
    const parent = arr.find(x => x.id === taskId)
    const sub = arr.find(x => x.id !== taskId)
    if (i % 4 === 0 || (parent?.state !== 'WORKING' && parent?.state !== 'WAITING')) {
      console.log(`[t+${i * 3}s] parent=${parent?.state} sub=${sub ? sub.state + '/' + (sub.progress ?? 0) : 'none'} retry=${sub?.retryCount}`)
    }
    const pend = (await jget(`/api/workshop/agent-tools/approvals?agentId=${worker.id}`)).data.approvals
    if (pend.length > 0) {
      console.log('[HITL] approval:', String(pend[0].detail).slice(0, 60))
      await jpost(`/api/workshop/agent-tools/approvals/${pend[0].id}/decide`, { approved: true, comment: '批准' })
    }
    if (['COMPLETED', 'CANCELED', 'FAILED'].includes(parent?.state)) {
      console.log('[final] parent=' + parent.state)
      break
    }
  }
  console.log('[keep] channel=' + ch.channelId)
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1) })
