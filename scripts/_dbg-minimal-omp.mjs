/**
 * 最小复现:omp worker 任务失败根因定位(不清理,便于事后查库)。
 */
const ROOT = 'http://127.0.0.1:3000'
let TOKEN = ''
const H = () => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const jpost = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H(), body: JSON.stringify(b ?? {}) }).then(r => r.json())
const jget = (u) => fetch(ROOT + u, { headers: H() }).then(r => r.json())

async function main() {
  const reg = await jpost('/api/workshop/users/register', { name: 'ompdbg-' + Math.random().toString(36).slice(2, 8) })
  TOKEN = reg.data?.token
  if (!TOKEN) { console.error('register failed'); process.exit(1) }
  console.log('[ok] registered')

  // 产线:1 数采 + 1 数控 + 开跑(Agent 有数据可读)
  const lineRes = await jpost('/api/workshop/dcw/lines', { name: 'OMPDBG-线' })
  console.log('[line-res]', JSON.stringify(lineRes).slice(0, 150))
  const line = lineRes.data.line
  const dq = (await jpost('/api/workshop/daq', { templateRef: 'daq-temp-tc', name: 'OMPDBG-温度', lineId: line.id, intervalMs: 500 })).data.node
  const dw = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: 'OMPDBG-设定', lineId: line.id })).data.node
  const prod = (await jpost('/api/workshop/dcw/products', { name: 'OMPDBG-产品', lineId: line.id })).data.product
  console.log('[prod]', prod?.id)
  const rcRes = await jpost('/api/workshop/dcw/recipes', {
    productId: prod.id, name: 'OMPDBG-配方', params: [{ templateRef: 'dcw-temp-sp', nodeId: dw.id, value: 180, min: 176, max: 188 }],
    daqWindows: [{ nodeId: dq.id, min: 100, max: 260 }],
  })
  console.log('[rc-res]', JSON.stringify(rcRes).slice(0, 200))
  const rc = rcRes.data.recipe
  const st = await jpost(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId: rc.id })
  console.log('[line]', st.data?.line?.active ? 'running' : 'FAILED')

  // channel + omp worker(直派,无 lead 调度)
  const ch = (await jpost('/api/workshop/channels', { name: 'OMPDBG-channel', leadAgent: { name: 'OMPDBG-lead', harness: 'mock', config: { delayMs: 60 } } })).data
  console.log('[channel]', JSON.stringify(ch).slice(0, 120))
  const tpl = (await jpost('/api/workshop/agents', {
    name: 'OMPDBG-worker', harness: 'omp',
    config: { systemPromptPrefix: '你是测试工程师。收到任务后用 daq_query 读数并汇报均值,不要做其他事。' },
  })).data
  await jpost(`/api/workshop/channels/${ch.channelId}/agents`, { agentId: tpl.id, role: 'worker' })
  const agents = (await jget(`/api/workshop/channels/${ch.channelId}/agents`)).data
  const worker = agents.find(a => a.role === 'worker')
  console.log('[worker]', worker?.id?.slice(0, 8), 'harness=' + worker?.harness)
  await jpost('/api/workshop/agent-tools/bindings', { agentId: worker.id, nodeId: dq.id, kind: 'daq', mode: 'auto' })

  // 直派任务到 worker(assigneeId 直投,不经过 lead)
  const taskRes = await jpost(`/api/workshop/channels/${ch.channelId}/tasks`, {
    title: 'OMPDBG-读数任务',
    parts: [{ text: '用 daq_query 获取 OMPDBG-温度 最近 2 分钟数据,汇报均值。完成后用 complete_task 提交结论。' }],
    assigneeId: worker.id,
  })
  console.log('[task-res]', JSON.stringify(taskRes).slice(0, 260))
  const task = taskRes.data
  const taskId = task?.task?.id ?? task?.id
  console.log('[task]', taskId?.slice(0, 8))

  // 观察任务状态 + 工具审批
  for (let i = 0; i < 60; i++) {
    await sleep(3000)
    const t = (await jget(`/api/workshop/channels/${ch.channelId}/tasks`)).data
    const arr = Array.isArray(t) ? t : t?.tasks ?? []
    const me = arr.find(x => x.id === taskId)
    const proc = await jget('/api/workshop/runtime')
    if (i % 4 === 0) {
      console.log(`[t+${i * 3}s] task=${me?.state} progress=${me?.progress} wired=${proc.data?.wiredAgents?.length}`)
    }
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(me?.state)) {
      console.log('[final]', me?.state)
      const detail = (await jget(`/api/workshop/tasks/${taskId}`)).data
      console.log('[history]', JSON.stringify(detail?.history ?? detail?.task?.history ?? []).slice(0, 1500))
      break
    }
  }
  console.log('[cleanup-hint] channel=' + ch.channelId + ' line=' + line.id)
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1) })
