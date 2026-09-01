/** HITL 超时默认拒绝 E2E(需 HITL_TIMEOUT_MS=5000 的 server):挂起→到期→自动拒绝→Agent 收到保持原值语义。 */
const ROOT = 'http://127.0.0.1:3100'
const H = { authorization: 'Bearer ut-ffc1dfbbc0c1444c87c1ec69a9e8208c', 'content-type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const fail = m => { console.error('FAIL:', m); process.exitCode = 1 }
const jget = u => fetch(ROOT + u, { headers: H }).then(r => r.json())
const jpost = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())
const jdel = u => fetch(ROOT + u, { method: 'DELETE', headers: H }).then(r => r.json())

const cleanup = []
async function main() {
  // 1. 产线 + 数采/数控 + 配方 + 开跑(dcw_control 需要产线运行窗口)
  const line = (await jpost('/api/workshop/dcw/lines', { name: 'HITL超时验证线' })).data.line
  cleanup.push(['line', line.id])
  const dq = (await jpost('/api/workshop/daq', { templateRef: 'daq-temp-tc', name: 'HITL温度采集', lineId: line.id, intervalMs: 500 })).data.node
  const dw = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: 'HITL温度设定', lineId: line.id })).data.node
  cleanup.push(['daq', dq.id], ['dcw', dw.id])
  const prod = (await jpost('/api/workshop/dcw/products', { name: 'HITL验证产品', lineId: line.id })).data.product
  cleanup.push(['product', prod.id])
  const rc = (await jpost('/api/workshop/dcw/recipes', {
    productId: prod.id, name: 'HITL验证配方',
    params: [{ templateRef: 'dcw-temp-sp', nodeId: dw.id, value: 180, min: 170, max: 190 }],
    daqWindows: [],
  })).data.recipe
  cleanup.push(['recipe', rc.id])
  const st = await jpost(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId: rc?.id })
  if (!st.data?.line?.active) { fail('产线开跑失败: ' + JSON.stringify(st).slice(0, 120)); return }
  console.log('[产线] 已开跑,设定节点目标 180')

  // 2. 团队 + 部署 + manual 绑定
  const ch = (await jpost('/api/workshop/channels', { name: 'HITL超时验证' })).data
  cleanup.push(['channel', ch.channelId])
  const team = (await jpost('/api/workshop/teams', { name: 'HITL超时验证组' })).data
  cleanup.push(['team', team.id])
  await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: 'tpl-default-lead', role: 'lead' })
  const w = (await jpost('/api/workshop/agents', {
    name: 'HITL验证worker', harness: 'omp',
    config: { intro: '验证用', systemPromptPrefix: '验证 HITL 超时默认拒绝。' },
  })).data
  cleanup.push(['agent', w.id])
  await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: w.id, role: 'worker' })
  await jpost(`/api/workshop/teams/${team.id}/deploy`, { channelId: ch.channelId })
  const inst = (await jget(`/api/workshop/channels/${ch.channelId}/agents`)).data.find(a => a.role === 'worker')
  cleanup.push(['cagent', `${ch.channelId}:${inst.id}`])
  await jpost('/api/workshop/agent-tools/bindings', { agentId: inst.id, nodeId: dw.id, kind: 'dcw', mode: 'manual' })
  console.log('[部署] worker 实例就绪,manual 绑定智控节点')

  // 3. 发起 dcw_control(不 await 完成态)→ 审批应挂起且带 expiresAt
  const invokeP = jpost('/api/workshop/agent-tools/invoke', { agentId: inst.id, tool: 'dcw_control', args: { node_id: dw.id, value: 185 } })
  await sleep(1500)
  const pend = (await jget(`/api/workshop/agent-tools/approvals?agentId=${inst.id}`)).data.approvals
  const ap = pend.find(a => a.nodeId === dw.id)
  if (!ap) { fail('审批未挂起'); return }
  const ttl = Math.round((Date.parse(ap.expiresAt) - Date.now()) / 1000)
  console.log(`[审批] 挂起成功 expiresAt 剩余 ${ttl}s`, ttl > 0 && ttl <= 6 ? 'PASS(短超时窗生效)' : `FAIL(期望 ≤6s)`)
  if (!(ttl > 0 && ttl <= 6)) fail('expiresAt/超时窗不符')

  // 4. 等超时(5s 窗 + 余量)→ invoke 应以「默认拒绝」收敛
  const res = await Promise.race([invokeP, sleep(15000).then(() => null)])
  const text = res?.data?.result?.text ?? JSON.stringify(res).slice(0, 200)
  const rejected = !res ? 'TIMEOUT' : ((text.includes('超时') || text.includes('拒绝')) && text.includes('指令未执行'))
  console.log('[超时] 工具结果:', text.slice(0, 140))
  console.log('[超时] 默认拒绝语义:', rejected === true ? 'PASS(超时→拒绝→指令未执行)' : 'FAIL')
  if (rejected !== true) fail('超时未按默认拒绝收敛')

  // 5. 历史留痕:expired 状态可查(scope=history)
  const hist = (await jget('/api/workshop/agent-tools/approvals?scope=history&limit=10')).data?.approvals ?? []
  const exp = Array.isArray(hist) ? hist.find(x => x.id === ap.id && x.status === 'expired') : null
  console.log('[留痕] expired 历史记录:', exp ? 'PASS' : `WARN(未查到: ${JSON.stringify(hist).slice(0, 100)})`)

  // 6. 节点值未被改动(默认拒绝 = 指令不执行)
  const dwNow = (await jget('/api/workshop/dcw')).data.nodes.find(n => n.id === dw.id)
  console.log(`[语义] 设定值保持 ${dwNow.value}(应 ≈180 配方目标)`, Math.abs(dwNow.value - 180) < 0.01 ? 'PASS' : 'FAIL')
  if (Math.abs(dwNow.value - 180) >= 0.01) fail('超时拒绝后设定值被意外改动')
}

main().then(async () => {
  for (const [kind, id] of [...cleanup].reverse()) {
    try {
      if (kind === 'line') await jpost(`/api/workshop/dcw/lines/${id}/stop`, {})
      else if (kind === 'daq') await jdel(`/api/workshop/daq/${id}`)
      else if (kind === 'dcw') await jdel(`/api/workshop/dcw/${id}`)
      else if (kind === 'recipe') await jdel(`/api/workshop/dcw/recipes/${id}`)
      else if (kind === 'product') await jdel(`/api/workshop/dcw/products/${id}`)
      else if (kind === 'cagent') { const [c, a] = String(id).split(':'); await jdel(`/api/workshop/channels/${c}/agents/${a}`) }
      else if (kind === 'channel') await jdel(`/api/workshop/channels/${id}`)
      else if (kind === 'team') await jdel(`/api/workshop/teams/${id}`)
      else if (kind === 'agent') await jdel(`/api/workshop/agents/${id}`)
    } catch { /* 尽力清理 */ }
  }
  console.log(process.exitCode ? 'HITL E2E FAILED' : 'HITL E2E ALL PASS')
  process.exit(process.exitCode ?? 0)
})
