/**
 * 真实场景串测(轻量,零 LLM token,~2 分钟):记忆系统 + Channel 内/间通信 + HITL。
 * 场景:东线团队沉淀「淬火工艺结论」→ 西线 worker 跨团队检索命中 → 西线 lead 跨 Channel
 *       发信给东线 lead(自动回执)→ 西线把 182℃ 用于本线生产 → agent 发起数控下发触发
 *       HITL → 用户批准 → 写入生效 → 西线沉淀作业结论。
 * 运行: AW_BASE=http://127.0.0.1:3001 node scripts/_dbg-collab-scenario-e2e.mjs
 */
const ROOT = process.env.AW_BASE ?? 'http://127.0.0.1:3000'
let TOKEN = ''
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
const invoke = async (agentId, tool, args = {}) => {
  const r = await jpost('/api/workshop/agent-tools/invoke', { agentId, tool, args })
  const result = r.data?.result
  return { status: r.status, text: String(result?.text ?? JSON.stringify(r).slice(0, 160)), isError: result?.isError === true }
}
const cleanup = []
const tag = Math.random().toString(36).slice(2, 8)

async function main() {
  console.log('━━━ 0. 注册 + 双团队部署 ━━━')
  const reg = await jpost('/api/workshop/users/register', { name: 'scen-' + tag })
  TOKEN = reg.data?.token
  if (!TOKEN) fail('注册失败: ' + JSON.stringify(reg).slice(0, 120))
  check('注册并取得 token', !!TOKEN)

  const deploy = async (name, withWorker) => {
    const ch = (await jpost('/api/workshop/channels', { name, description: '协同场景验证' })).data.channelId
    cleanup.push(['channel', ch])
    const team = (await jpost('/api/workshop/teams', { name: name + '-组' })).data
    cleanup.push(['team', team.id])
    await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: 'tpl-default-lead', role: 'lead' })
    let worker = null
    if (withWorker) {
      const tpl = (await jpost('/api/workshop/agents', { name: name + '-worker', harness: 'mock', config: {} })).data
      cleanup.push(['agent-tpl', tpl.id])
      await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: tpl.id, role: 'worker' })
    }
    await jpost(`/api/workshop/teams/${team.id}/deploy`, { channelId: ch })
    const agents = (await jget(`/api/workshop/channels/${ch}/agents`)).data
    const lead = agents.find(a => a.role === 'lead')
    worker = agents.find(a => a.role === 'worker') ?? null
    if (lead) cleanup.push(['channel-agent', `${ch}:${lead.id}`])
    if (worker) cleanup.push(['channel-agent', `${ch}:${worker.id}`])
    return { channelId: ch, lead, worker }
  }
  const east = await deploy('东线团队-' + tag, false)
  const west = await deploy('西线团队-' + tag, true)
  check('东西两线团队就绪(lead/worker 到位)',
    !!east.lead?.id && !!west.lead?.id && !!west.worker?.id,
    `E:${east.lead.id.slice(0, 6)} W:${west.lead.id.slice(0, 6)}/${west.worker.id.slice(0, 6)}`)

  // ===== 1. 记忆系统:东线把作业结论沉淀到团队共享域 =====
  console.log('\n━━━ 1. 记忆系统(东线沉淀 → 西线检索)━━━')
  const mem = await jpost(`/api/workshop/channels/${east.channelId}/memories`, {
    title: '淬火工艺结论-' + tag,
    content: '淬火温度 182℃ 保温 30 分钟,硬度 HRC58 达标;超过 190℃ 过回火软化。西线同类工件可直接采用该参数。',
    importance: 0.9,
  })
  check('东线共享记忆写入', mem.status === 200, `status=${mem.status}`)
  const hit = await invoke(west.worker.id, 'search_other_teams_memory', { query: '淬火 温度 硬度' })
  check('西线 worker 跨团队检索命中(带归属)', hit.status === 200
    && String(hit.text).includes('淬火工艺结论-' + tag) && String(hit.text).includes('东线团队-' + tag),
    String(hit.text).slice(0, 70))

  // ===== 2. Channel 间:西线 lead → 东线 lead 请求协作 =====
  console.log('\n━━━ 2. 跨 Channel 通信(lead → lead)━━━')
  const ask = await jpost(`/api/workshop/channels/${west.channelId}/messages`, {
    toChannelId: east.channelId,
    fromAgentId: west.lead.id,
    text: '我已检索到你们团队的淬火结论(182℃/HRC58)。请确认参数有效性,并知会贵队成员配合我线复检。',
    requireReply: true,
  })
  const askId = ask.data?.messageId
  cleanup.push(['cross-message', askId])
  check('西线 lead → 东线 lead 发信成功', ask.status === 200 && !!askId, `id=${String(askId ?? '').slice(0, 8)}`)
  const denied = await jpost(`/api/workshop/channels/${west.channelId}/messages`, {
    toChannelId: east.channelId, fromAgentId: west.worker.id, text: 'worker 越权(应拒)',
  })
  check('worker 跨 Channel 被拒(403)', denied.status === 403)
  let reply = null
  for (let i = 0; i < 15; i++) {
    await sleep(1500)
    const msgs = (await jget(`/api/workshop/channels/${west.channelId}/messages?limit=20`)).data
    const list = Array.isArray(msgs) ? msgs : msgs?.messages ?? []
    reply = list.find(m => m.metadata?.['x-aw-in-reply-to'] === askId && m.fromAgentId === east.lead.id)
    if (reply) break
  }
  check('东线 lead 自动回执到达西线(闭环)', !!reply,
    reply ? String(reply.parts?.[0]?.text ?? '').slice(0, 50) + '…' : '22s 未收到')

  // ===== 3. 西线生产: Hitl 下发 182℃(基于东线结论)=====
  console.log('\n━━━ 3. 西线产线 + HITL(手动确认下发 182℃)━━━')
  const line = (await jpost('/api/workshop/dcw/lines', { name: '西线产线-' + tag })).data.line
  cleanup.push(['dcw-line', line.id])
  const prod = (await jpost('/api/workshop/dcw/products', { name: '西线产品-' + tag, lineId: line.id })).data.product
  cleanup.push(['dcw-product', prod.id])
  const dq = (await jpost('/api/workshop/daq', { templateRef: 'daq-temp-tc', name: 'SC-温度采集', lineId: line.id, intervalMs: 500 })).data.node
  cleanup.push(['daq', dq.id])
  const dw = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: 'SC-温度设定', lineId: line.id })).data.node
  cleanup.push(['dcw', dw.id])
  const rc = (await jpost('/api/workshop/dcw/recipes', {
    productId: prod.id, name: '西线配方-' + tag,
    params: [{ templateRef: 'dcw-temp-sp', nodeId: dw.id, value: 175, min: 170, max: 190 }],
    daqWindows: [{ nodeId: dq.id, min: 100, max: 260 }],
  })).data.recipe
  cleanup.push(['dcw-recipe', rc.id])
  await jpost(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId: rc.id })
  await sleep(2500)
  const st = (await jget('/api/workshop/dcw/lines')).data.states.find(s => s.lineId === line.id)
  check('西线产线开跑(active)', !!st?.active, `runId=${String(st?.runId ?? '').slice(0, 8)}`)

  // worker 绑定数控节点(手动确认)→ agent 工具桥发起下发 → HITL(桥阻塞等审批,异步发起)
  await jpost('/api/workshop/agent-tools/bindings', { agentId: west.worker.id, nodeId: dw.id, kind: 'dcw', mode: 'manual' })
  const bl = (await jget(`/api/workshop/agent-tools/bindings?agentId=${west.worker.id}`)).data.bindings
  check('worker 绑定数控节点(manual)', bl.length > 0, `n=${bl.length}`)
  const pendingInv = invoke(west.worker.id, 'dcw_control', { node_id: dw.id, value: 182, hypothesis: '按东线淬火工艺结论调整设定值' })
  let approvals = []
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    approvals = (await jget(`/api/workshop/agent-tools/approvals?agentId=${west.worker.id}`)).data.approvals
    if (approvals.length > 0) break
  }
  check('agent 发起下发 → HITL 待审批', approvals.length > 0, `pending=${approvals.length}`)
  if (approvals.length > 0) {
    const appr = await jpost(`/api/workshop/agent-tools/approvals/${approvals[0].id}/decide`, { approved: true, comment: '同意,采用东线结论 182℃' })
    check('用户批准 HITL', appr.status === 200)
  }
  const inv = await pendingInv
  check('HITL 批准后下发执行(回执非错误)', !inv.isError, String(inv.text).slice(0, 80))
  await sleep(1500)
  const dwNow = (await jget('/api/workshop/dcw')).data.nodes.find(n => n.id === dw.id)
  check('写入生效 + 回读校验(182℃)', Math.abs((dwNow?.value ?? 0) - 182) < 0.01, `value=${dwNow?.value}℃`)

  // ===== 4. 西线沉淀作业结论(闭环收尾)=====
  const out = await jpost(`/api/workshop/channels/${west.channelId}/memories`, {
    title: '西线复检结论-' + tag,
    content: '采用东线淬火结论(182℃/HRC58),经 HITL 批准下发并回读校验通过。后续西线同类工件沿用该参数。',
    importance: 0.85,
  })
  check('西线沉淀作业结论到共享记忆', out.status === 200)
  const memList = (await jget(`/api/workshop/channels/${west.channelId}/memories`)).data
  const memListArr = Array.isArray(memList) ? memList : memList?.memories ?? memList?.items ?? []
  check('团队记忆列表可见(可审计)', memListArr.length >= 1, `n=${memListArr.length}`)

  // ===== 清理 =====
  console.log('\n━━━ 清理 ━━━')
  await jpost(`/api/workshop/dcw/lines/${line.id}/stop`, {})
  for (const [kind, id] of [...cleanup].reverse()) {
    try {
      if (kind === 'channel') await api('DELETE', `/api/workshop/channels/${id}`)
      else if (kind === 'team') await api('DELETE', `/api/workshop/teams/${id}`)
      else if (kind === 'agent-tpl') await api('DELETE', `/api/workshop/agents/${id}`)
      else if (kind === 'channel-agent') {
        const [cid, aid] = String(id).split(':')
        if (cid && aid) await api('DELETE', `/api/workshop/channels/${cid}/agents/${aid}`)
      }
      else if (kind === 'daq') await api('DELETE', `/api/workshop/daq/${id}`)
      else if (kind === 'dcw') await api('DELETE', `/api/workshop/dcw/${id}`)
      else if (kind === 'dcw-line') await api('DELETE', `/api/workshop/dcw/lines/${id}`)
      else if (kind === 'dcw-product') await api('DELETE', `/api/workshop/dcw/products/${id}`)
    }
    catch { /* 清理失败不阻断 */ }
  }
  console.log('清理完成')

  console.log(failures === 0 ? '\nSCENARIO ALL PASS' : `\nSCENARIO ${failures} FAILED`)
  if (failures > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
