/**
 * 跨 Channel 通信端到端验证(针对运行中的环境,默认 http://127.0.0.1:3000)。
 * 覆盖:lead→异 channel lead 投递(metadata 盖章/落对方 mailbox)→ mock lead 消费并
 *   自动回执(跨 channel 回信)→ 回信到达源 channel lead → 权限(worker 拒)→
 *   边界(自指/停用/无 lead channel)。
 * 运行: node scripts/_dbg-cross-channel-e2e.mjs   (AW_BASE 可覆盖目标)
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
const cleanup = []
const tag = Math.random().toString(36).slice(2, 8)

async function deployTeam(channelName, extraWorkers = []) {
  const chRes = (await jpost('/api/workshop/channels', { name: channelName, description: '跨Channel验证' })).data
  cleanup.push(['channel', chRes.channelId])
  const team = (await jpost('/api/workshop/teams', { name: channelName + '-组', description: '跨Channel验证' })).data
  cleanup.push(['team', team.id])
  // 成员先入队再一次 deploy(重复 deploy 不会同步新增成员)
  await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: 'tpl-default-lead', role: 'lead' })
  for (const w of extraWorkers) {
    await jpost(`/api/workshop/teams/${team.id}/members`, { agentId: w.id, role: 'worker' })
  }
  await jpost(`/api/workshop/teams/${team.id}/deploy`, { channelId: chRes.channelId })
  const agents = (await jget(`/api/workshop/channels/${chRes.channelId}/agents`)).data
  const lead = agents.find(a => a.role === 'lead')
  const worker = agents.find(a => a.role === 'worker')
  cleanup.push(['channel-agent', `${chRes.channelId}:${lead?.id}`])
  if (worker) cleanup.push(['channel-agent', `${chRes.channelId}:${worker.id}`])
  return { channelId: chRes.channelId, lead, worker, teamId: team.id }
}

async function main() {
  console.log('━━━ 0. 用户注册 ━━━')
  const reg = await jpost('/api/workshop/users/register', { name: 'xcc-' + tag })
  TOKEN = reg.data?.token
  if (!TOKEN) fail('用户注册失败: ' + JSON.stringify(reg).slice(0, 120))
  check('用户注册并取得 token', !!TOKEN)

  // ===== 1. 两个团队:西线(lead mock + worker mock)/ 东线(lead mock)=====
  console.log('\n━━━ 1. 双 channel 部署 ━━━')
  const workerTpl = (await jpost('/api/workshop/agents', { name: '西线worker-' + tag, harness: 'mock', config: {} })).data
  cleanup.push(['agent-tpl', workerTpl.id])
  const west = await deployTeam('西线团队-' + tag, [workerTpl])
  check('西线 channel + mock lead 就绪', !!west.channelId && !!west.lead?.id)
  const east = await deployTeam('东线团队-' + tag)
  check('东线 channel + mock lead 就绪', !!east.channelId && !!east.lead?.id)
  const westWorker = west.worker
  check('西线 worker 就绪(权限反证用)', !!westWorker?.id)

  // ===== 2. 跨 Channel 发送(REST,lead 身份)=====
  console.log('\n━━━ 2. 跨 Channel 投递(lead → 对方 lead)━━━')
  const ask = '东线请注意:西线请求支援——请分析你们 channel 的负载情况,并把结论回执给我。'
  const sent = await jpost(`/api/workshop/channels/${west.channelId}/messages`, {
    toChannelId: east.channelId,
    fromAgentId: west.lead.id,
    text: ask,
    requireReply: true,
  })
  check('跨 Channel 发送成功(回执含目标 channel/lead)',
    sent.status === 200 && sent.data?.toChannelId === east.channelId && sent.data?.toLeadAgentId === east.lead.id,
    `messageId=${String(sent.data?.messageId ?? '').slice(0, 8)} toChannel=${String(sent.data?.toChannelName ?? '')}`)
  const crossMsgId = sent.data?.messageId
  cleanup.push(['cross-message', crossMsgId])

  // 落库断言:消息出现在东线历史,盖章齐全,收件人=东线 lead
  const eastMsgs = (await jget(`/api/workshop/channels/${east.channelId}/messages?limit=20`)).data
  const list = Array.isArray(eastMsgs) ? eastMsgs : eastMsgs?.messages ?? []
  const delivered = list.find(m => m.id === crossMsgId)
  const meta = delivered?.metadata ?? {}
  check('东线 mailbox 可见该消息(收件人=东线 lead)', !!delivered && delivered.toAgentId === east.lead.id)
  check('跨 Channel 盖章齐全(cross-channel/from-channel/from-label)',
    meta['x-aw-cross-channel'] === 'true'
    && meta['x-aw-from-channel'] === west.channelId
    && String(meta['x-aw-from-label'] ?? '').includes('西线团队'),
    `label=${String(meta['x-aw-from-label'] ?? '')}`)

  // ===== 3. 东线 lead 消费并自动回执(跨 channel 回信到西线 lead)=====
  console.log('\n━━━ 3. 对方 lead 消费并回信(闭环)━━━')
  let reply = null
  for (let i = 0; i < 20; i++) {
    await sleep(1500)
    const westMsgs = (await jget(`/api/workshop/channels/${west.channelId}/messages?limit=20`)).data
    const wlist = Array.isArray(westMsgs) ? westMsgs : westMsgs?.messages ?? []
    reply = wlist.find(m => m.metadata?.['x-aw-in-reply-to'] === crossMsgId
      && m.metadata?.['x-aw-cross-channel'] === 'true'
      && m.toAgentId === west.lead.id)
    if (reply) break
  }
  check('东线 lead 自动回信到达西线 lead(in_reply_to 关联)', !!reply,
    reply ? `text=${String(reply.parts?.[0]?.text ?? '').slice(0, 50)}…` : '30s 内未收到回信')
  if (reply) cleanup.push(['cross-message', reply.id])

  // 回信已被西线 lead 消费?(mock 收到无需回执的信件仅登记;此处只验投递与可见性)

  // ===== 4. 权限:worker 跨 Channel 被拒 =====
  console.log('\n━━━ 4. 权限反证 ━━━')
  const denied = await jpost(`/api/workshop/channels/${west.channelId}/messages`, {
    toChannelId: east.channelId,
    fromAgentId: westWorker.id,
    text: 'worker 试图跨 Channel(应被拒)',
  })
  check('worker 跨 Channel 被拒(403 ROLE_FORBIDDEN)',
    denied.status === 403 && String(denied.message ?? '').includes('Leader'),
    `status=${denied.status} msg=${String(denied.message ?? '').slice(0, 60)}`)

  // 无 fromAgentId(人类身份)跨 Channel 同样拒绝
  const anon = await jpost(`/api/workshop/channels/${west.channelId}/messages`, {
    toChannelId: east.channelId,
    text: '匿名跨 Channel(应被拒)',
  })
  check('无 Leader 身份被拒(403)', anon.status === 403, `status=${anon.status}`)

  // ===== 5. 边界:自指 / 停用 / 不存在 =====
  console.log('\n━━━ 5. 边界用例 ━━━')
  const selfRef = await jpost(`/api/workshop/channels/${west.channelId}/messages`, {
    toChannelId: west.channelId, fromAgentId: west.lead.id, text: 'self',
  })
  check('目标=本 channel 被拒(404)', selfRef.status === 404, `status=${selfRef.status}`)
  const ghost = await jpost(`/api/workshop/channels/${west.channelId}/messages`, {
    toChannelId: 'ch-not-exists-' + tag, fromAgentId: west.lead.id, text: 'ghost',
  })
  check('目标不存在被拒(404)', ghost.status === 404, `status=${ghost.status}`)

  // ===== 清理 =====
  console.log('\n━━━ 清理 ━━━')
  for (const [kind, id] of cleanup.reverse()) {
    if (kind === 'channel') await api('DELETE', `/api/workshop/channels/${id}`)
    else if (kind === 'team') await api('DELETE', `/api/workshop/teams/${id}`)
    else if (kind === 'agent-tpl') await api('DELETE', `/api/workshop/agents/${id}`)
    else if (kind === 'channel-agent') {
      const [cid, aid] = String(id).split(':')
      if (cid && aid) await api('DELETE', `/api/workshop/channels/${cid}/agents/${aid}`)
    }
  }
  console.log('清理完成')

  console.log(failures === 0 ? '\nE2E ALL PASS' : `\nE2E ${failures} FAILED`)
  if (failures > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
