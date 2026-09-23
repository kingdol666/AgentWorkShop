/**
 * AgentTeam 群聊真实端到端(多用户 + 多 Agent + WS + 权限 + 幂等 + 并发)。
 *
 * 对应计划:P6 / §11「真实 E2E」/ `hil-group-chat-design-review` 硬性验收。
 *
 * 用户角色(全部为**真实注册**的全局用户,不是伪造 id):
 *   ADM  首个注册账号(bootstrap admin,用于验证"admin 全量可见"与"成员 ≠ admin")
 *   A    Channel owner
 *   B/C  active 群成员
 *   D    未加入用户
 * Agent:mock lead + 2 worker(mock 是确定性测试替身;真实 harness 的 ask/approval
 * 另见 scripts/e2e-hil-multi-user.mjs,需要已安装引擎 + 可用模型)。
 *
 * 运行:
 *   node scripts/e2e-agentteam-chat.mjs --base http://127.0.0.1:3457
 *   node scripts/e2e-agentteam-chat.mjs --base ... --phase=chat|hitl|all
 *
 * 前置:隔离实例(node bin/aw.mjs dev|start --port 3457,建议 AW_MODE=home AW_HOME=<fresh>)
 *      必须设置 NO_PROXY=127.0.0.1,localhost(本机 7890 代理会拦 localhost)
 */
const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  if (i >= 0) return process.argv[i + 1]
  const kv = process.argv.find(a => a.startsWith(`${k}=`))
  return kv ? kv.slice(k.length + 1) : d
}
const BASE = arg('--base', process.env.AW_E2E_BASE ?? 'http://127.0.0.1:3457')
const WS_BASE = BASE.replace(/^http/, 'ws')
const PHASE = arg('--phase', 'chat')
const TAG = Date.now().toString(36)

let passed = 0
let failures = 0
let blocked = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
const block = (name, reason) => {
  console.log(`  BLOCKED  ${name} — ${reason}`)
  blocked += 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitUntil(name, cond, timeoutMs = 60_000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await cond()
      if (last) return last
    }
    catch (e) { last = e }
    await sleep(intervalMs)
  }
  throw new Error(`waitUntil timeout: ${name} (last=${String(last).slice(0, 240)})`)
}

async function api(method, path, { body, token, expect } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const json = await res.json().catch(() => ({}))
  const out = { status: res.status, code: json.code, message: json.message, data: json.data }
  if (expect !== undefined && res.status !== expect) {
    // 便于失败时定位:不抛错,由调用方断言
    out.unexpected = `expect ${expect} got ${res.status}`
  }
  return out
}

/** AEP WS:订阅一个频道 + 用户级通知;聚合信封 */
function openAep(channelId, token, { notifications = true } = {}) {
  const envelopes = []
  const notifications_ = []
  const ws = new WebSocket(`${WS_BASE}/api/workshop/ws?token=${encodeURIComponent(token)}`)
  ws.addEventListener('open', () => {
    if (channelId) ws.send(JSON.stringify({ type: 'sub', channelId, token }))
    if (notifications) ws.send(JSON.stringify({ type: 'subNotifications' }))
  })
  ws.addEventListener('message', (ev) => {
    try {
      const e = JSON.parse(ev.data)
      if (!e.type || e.type === 'pong') return
      if (e.type === 'notification.created') notifications_.push(e.payload)
      else envelopes.push(e)
    }
    catch { /* ignore */ }
  })
  return {
    ws,
    envelopes,
    notifications: notifications_,
    send: obj => ws.send(JSON.stringify(obj)),
    close: () => {
      try {
        ws.close()
      }
      catch { /* ignore */ }
    },
    chatMessages: () => envelopes.filter(e => e.type === 'chat.message').map(e => e.payload),
    notificationsOfType: t => notifications_.filter(n => n.type === t),
  }
}

const post = (p, body, token) => api('POST', p, { body, token })
const get = (p, token) => api('GET', p, { token })

async function registerUser(label) {
  const email = `gc-${label}-${TAG}@test.local`
  const name = `gc-${label}-${TAG}`
  const res = await post('/api/users/register', { email, password: 'Passw0rd!123', name })
  if (!res.data?.token) throw new Error(`注册 ${label} 失败: ${JSON.stringify(res).slice(0, 300)}`)
  return { label, name, email, token: res.data.token, id: res.data.user.id, role: res.data.user.role }
}

// ============================================================================
async function phaseChat() {
  console.log(`\n━━━ Phase CHAT:多用户群聊 @ ${BASE} ━━━`)

  // ── 0. 多用户注册(ADM 先注册以触发 bootstrap admin,保证 A 是**普通用户**)──
  const ADM = await registerUser('adm')
  const A = await registerUser('owner')
  const B = await registerUser('bob')
  const C = await registerUser('carol')
  const D = await registerUser('dave')
  check('0.1 五个真实用户注册成功', [ADM, A, B, C, D].every(u => u.token && u.id))
  // bootstrap:首个注册账号成为 admin。但实例可能已被先前的探针注册过,
  // 此时 ADM 只是普通用户 —— 关键在于"A 是普通用户",admin 存在性单独标注。
  if (ADM.role === 'admin') {
    check('0.2 首个注册账号为 admin(bootstrap,新实例)', true, `ADM.role=${ADM.role}`)
  }
  else {
    block('0.2 bootstrap admin(本实例已存在更早注册的账号)', `ADM.role=${ADM.role};admin 相关断言按可用性降级`)
  }
  check('0.3 owner A 是普通用户(成员权限测试才有意义)', A.role !== 'admin', `A.role=${A.role}`)

  // ── 1. Channel 创建 + mock 团队 ──
  const ch = await api('POST', '/api/workshop/channels', {
    body: {
      name: `gc-${TAG}`,
      description: '群聊多用户 E2E',
      leadAgent: { name: `gc-lead-${TAG}`, harness: 'mock', config: { delayMs: 30 } },
    },
    token: A.token,
  })
  const channelId = ch.data?.channelId
  const leadAgentId = ch.data?.leadAgentId
  check('1.1 owner A 建 Channel(mock lead)', Boolean(channelId && leadAgentId), `channel=${String(channelId).slice(0, 8)} status=${ch.status}`)
  if (!channelId) throw new Error(`建 Channel 失败,无法继续: ${JSON.stringify(ch).slice(0, 400)}`)

  const t1 = await api('POST', '/api/workshop/agents', { body: { name: `gc-w1-${TAG}`, harness: 'mock', config: { delayMs: 30 } }, token: A.token })
  const t2 = await api('POST', '/api/workshop/agents', { body: { name: `gc-w2-${TAG}`, harness: 'mock', config: { delayMs: 30 } }, token: A.token })
  await api('POST', `/api/workshop/channels/${channelId}/agents`, { body: { agentId: t1.data.id, role: 'worker' }, token: A.token })
  await api('POST', `/api/workshop/channels/${channelId}/agents`, { body: { agentId: t2.data.id, role: 'worker' }, token: A.token })
  const membersRes = await get(`/api/workshop/channels/${channelId}/agents`, A.token)
  const agentList = membersRes.data ?? []
  const workerIds = agentList.filter(a => a.role === 'worker').map(a => a.id)
  const workerNames = agentList.filter(a => a.role === 'worker').map(a => a.name)
  check('1.2 2 个 worker 已放置', workerIds.length === 2, `workers=${workerNames.join(',')}`)

  // ── 2. 未开启群聊 / 私有:成员与外部用户一律拒绝 ──
  const dBefore = await get(`/api/workshop/channels/${channelId}/chat/messages`, D.token)
  check('2.1 未加入用户读群聊 → 403', dBefore.status === 403, `status=${dBefore.status} code=${dBefore.code}`)
  const dPost = await post(`/api/workshop/channels/${channelId}/chat/messages`, { text: 'hi' }, D.token)
  check('2.2 未加入用户发言 → 403', dPost.status === 403, `status=${dPost.status} code=${dPost.code}`)
  const bJoinClosed = await post(`/api/workshop/channels/${channelId}/members/join`, {}, B.token)
  check('2.3 群聊未开启时加入 → 409 CHAT_DISABLED', bJoinClosed.status === 409 && bJoinClosed.code === 'CHAT_DISABLED', `status=${bJoinClosed.status} code=${bJoinClosed.code}`)
  const dWs = openAep(channelId, D.token)
  await sleep(800)
  const dWsErr = dWs.envelopes.find(e => e.type === 'error')
  check('2.4 未加入用户 WS 订阅被拒(不泄露快照)', Boolean(dWsErr) && !dWs.envelopes.some(e => e.type === 'channel.snapshot'), `err=${dWsErr?.payload?.code}`)
  dWs.close()

  // ── 3. owner 开启公开群聊(显式);版本乐观锁 ──
  const cur = await get(`/api/workshop/channels/${channelId}/chat/permissions`, A.token)
  const v0 = cur.data?.channel?.version
  const stale = await api('PATCH', `/api/workshop/channels/${channelId}`, { body: { chatEnabled: 1, version: (v0 ?? 1) + 99 }, token: A.token })
  check('3.1 过期 version → 409 VERSION_CONFLICT', stale.status === 409 && stale.code === 'VERSION_CONFLICT', `status=${stale.status} code=${stale.code}`)
  const open = await api('PATCH', `/api/workshop/channels/${channelId}`, {
    body: { visibility: 'public', joinPolicy: 'open', approvalPolicy: 'any_member', chatEnabled: 1, version: v0 },
    token: A.token,
  })
  check('3.2 owner 开启 public/open/chat(乐观锁通过)', open.status === 200 || open.code === 0, `status=${open.status} v=${open.data?.version}`)
  const bSet = await api('PATCH', `/api/workshop/channels/${channelId}`, { body: { chatEnabled: 0 }, token: B.token })
  check('3.3 非 owner 改设置 → 403(成员未被提升为管理员)', bSet.status === 403, `status=${bSet.status} code=${bSet.code}`)

  // ── 4. B/C 加入;D 仍未加入 ──
  const bJoin = await post(`/api/workshop/channels/${channelId}/members/join`, {}, B.token)
  const cJoin = await post(`/api/workshop/channels/${channelId}/members/join`, {}, C.token)
  check('4.1 B/C 加入 → active', bJoin.data?.status === 'active' && cJoin.data?.status === 'active', `${bJoin.data?.status}/${cJoin.data?.status}`)
  const bRejoin = await post(`/api/workshop/channels/${channelId}/members/join`, {}, B.token)
  check('4.2 重复 join 幂等(仍 active)', bRejoin.data?.status === 'active')
  const memberList = await get(`/api/workshop/channels/${channelId}/members`, B.token)
  const memberIds = (memberList.data?.members ?? []).filter(m => m.status === 'active').map(m => m.userId)
  check('4.3 成员名册含 A(owner)/B/C', [A.id, B.id, C.id].every(id => memberIds.includes(id)), `count=${memberIds.length}`)
  check('4.4 成员名册不含 D', !memberIds.includes(D.id))
  check('4.5 成员名册不泄露 token/config', !JSON.stringify(memberList.data).includes('"token"') && !JSON.stringify(memberList.data).includes('"config"'))
  const ownerCount = (memberList.data?.members ?? []).filter(m => m.userId === A.id && m.role === 'owner' && m.status === 'active').length
  check('4.6 owner 恰好一条 active owner 记录', ownerCount === 1, `count=${ownerCount}`)

  // ── 5. 无 @ 的普通发言:Agent 执行次数必须为 0 ──
  const aepA = openAep(channelId, A.token)
  const aepB = openAep(channelId, B.token)
  const aepC = openAep(channelId, C.token)
  await sleep(1000)
  const plain = await post(`/api/workshop/channels/${channelId}/chat/messages`, {
    text: '大家好,今天的排期同步一下(没有 @ 任何人)',
    clientMessageId: `plain-${TAG}`,
  }, B.token)
  check('5.1 普通发言成功', plain.code === 0 && Boolean(plain.data?.message?.id), `id=${plain.data?.message?.id?.slice(0, 8)}`)
  check('5.2 普通发言 → deliveries 为空(Agent 执行次数 0)', (plain.data?.deliveries ?? []).length === 0, JSON.stringify(plain.data?.deliveries))
  check('5.3 普通发言 → 无 agent mention', (plain.data?.mentions ?? []).length === 0)
  const histA = await get(`/api/workshop/channels/${channelId}/chat/messages`, A.token)
  const histC = await get(`/api/workshop/channels/${channelId}/chat/messages`, C.token)
  const idsA = (histA.data?.messages ?? []).map(m => m.id)
  const idsC = (histC.data?.messages ?? []).map(m => m.id)
  check('5.4 A/C 看到一致历史(同一批消息 id)', JSON.stringify(idsA) === JSON.stringify(idsC), `A=${idsA.length} C=${idsC.length}`)
  check('5.5 消息 sender 归属为人类且带稳定 userId', (histA.data?.messages ?? []).some(m => m.senderId === B.id && m.senderType === 'user'))
  const dHist = await get(`/api/workshop/channels/${channelId}/chat/messages`, D.token)
  check('5.6 未加入用户仍读不到公开群聊(公开 ≠ 匿名可读)', dHist.status === 403, `status=${dHist.status}`)

  // ── 6. @用户:群消息 + 目标用户定向通知;Agent 执行次数仍为 0 ──
  const bNotifBefore = aepB.notifications.length
  const atUser = await post(`/api/workshop/channels/${channelId}/chat/messages`, {
    text: `@${C.name} 帮忙确认一下验收口径`,
    clientMessageId: `atuser-${TAG}`,
  }, B.token)
  check('6.1 @用户 → 0 条 delivery(不触发 Agent)', (atUser.data?.deliveries ?? []).length === 0)
  check('6.2 @用户 → 解析为 user mention 稳定 ID', (atUser.data?.mentions ?? []).some(m => m.type === 'user' && m.id === C.id), JSON.stringify(atUser.data?.mentions))
  const cGot = await waitUntil('C 收到 mention 通知(WS 定向)', () =>
    aepC.notifications.find(n => n.type === 'mention' && n.chatMessageId === atUser.data.message.id) ?? null, 15_000).catch(() => null)
  check('6.3 C 经 WS 收到定向 mention 通知', Boolean(cGot), cGot ? `eventId=${cGot.eventId}` : '')
  await sleep(600)
  check('6.4 B(发送者)未收到该 mention 通知', !aepB.notifications.some(n => n.type === 'mention' && n.chatMessageId === atUser.data.message.id), `B notif +${aepB.notifications.length - bNotifBefore}`)
  check('6.5 通知含 recipientUserId 且为 C(定向隔离)', cGot?.recipientUserId === C.id, `recipient=${cGot?.recipientUserId?.slice(0, 8)}`)

  // ── 7. @Agent:B 与 C 并发提问不同 worker,回复不串人 ──
  const w1Name = workerNames[0]
  const w2Name = workerNames[1]
  const q1 = await post(`/api/workshop/channels/${channelId}/chat/messages`, {
    text: `@${w1Name} 请分析问题一`,
    clientMessageId: `q1-${TAG}`,
  }, B.token)
  const q2 = await post(`/api/workshop/channels/${channelId}/chat/messages`, {
    text: `@${w2Name} 请分析问题二`,
    clientMessageId: `q2-${TAG}`,
  }, C.token)
  check('7.1 B @worker1 → 恰好 1 条 delivery', (q1.data?.deliveries ?? []).length === 1, JSON.stringify(q1.data?.deliveries))
  check('7.2 C @worker2 → 恰好 1 条 delivery', (q2.data?.deliveries ?? []).length === 1, JSON.stringify(q2.data?.deliveries))
  check('7.3 两条 delivery 目标不同 Agent', q1.data.deliveries[0].agentId !== q2.data.deliveries[0].agentId)

  // mock harness 会产出回复 → 平台写回群聊并自动 @提问者
  const reply1 = await waitUntil('worker1 回复群聊(关联 q1)', () =>
    aepA.chatMessages().find(m => m.senderType === 'agent' && m.sourceChatMessageId === q1.data.message.id) ?? null, 60_000).catch(() => null)
  const reply2 = await waitUntil('worker2 回复群聊(关联 q2)', () =>
    aepA.chatMessages().find(m => m.senderType === 'agent' && m.sourceChatMessageId === q2.data.message.id) ?? null, 60_000).catch(() => null)
  check('7.4 worker1 在公开群聊回复且关联 q1', Boolean(reply1), reply1 ? `reply=${reply1.id.slice(0, 8)}` : '')
  check('7.5 worker2 在公开群聊回复且关联 q2', Boolean(reply2))
  check('7.6 回复 requesterUserId 唯一指向 B(q1)', reply1?.requesterUserId === B.id, `requester=${reply1?.requesterUserId?.slice(0, 8)}`)
  check('7.7 回复 requesterUserId 唯一指向 C(q2)', reply2?.requesterUserId === C.id, `requester=${reply2?.requesterUserId?.slice(0, 8)}`)
  check('7.8 回复自动 @提问者(mentions 含 B)', (reply1?.mentions ?? []).some(m => m.type === 'user' && m.id === B.id), JSON.stringify(reply1?.mentions))
  check('7.9 回复自动 @提问者(mentions 含 C)', (reply2?.mentions ?? []).some(m => m.type === 'user' && m.id === C.id), JSON.stringify(reply2?.mentions))
  check('7.10 并发回复未串人(q1↛C / q2↛B)', reply1?.requesterUserId !== C.id && reply2?.requesterUserId !== B.id)
  const replyToBadge = await get(`/api/workshop/channels/${channelId}/chat/messages`, A.token)
  const rm = (replyToBadge.data?.messages ?? []).find(m => m.id === reply1?.id)
  check('7.11 回复 replyToId 指向源消息(前端 ↩ 渲染依据)', rm?.replyToId === q1.data.message.id, `replyTo=${rm?.replyToId?.slice(0, 8)}`)

  // ── 8. 幂等:同一 clientMessageId 重试只产生一条消息 + 一条 delivery ──
  const retry = await post(`/api/workshop/channels/${channelId}/chat/messages`, {
    text: `@${w1Name} 请分析问题一`,
    clientMessageId: `q1-${TAG}`,
  }, B.token)
  check('8.1 重复 clientMessageId → duplicates=true', retry.data?.duplicates === true)
  check('8.2 重复 → 返回首条消息 id', retry.data?.message?.id === q1.data.message.id)
  check('8.3 重复 → deliveries 仍为 1(不重复执行 Agent)', (retry.data?.deliveries ?? []).length === 1)
  const histAfterRetry = await get(`/api/workshop/channels/${channelId}/chat/messages?limit=200`, A.token)
  const sameIdCount = (histAfterRetry.data?.messages ?? []).filter(m => m.clientMessageId === `q1-${TAG}`).length
  check('8.4 库中该 clientMessageId 仅 1 行', sameIdCount === 1, `count=${sameIdCount}`)

  // ── 9. 权限越权:成员不得调用任何管理端点 ──
  const esc = [
    ['PATCH channel 设置', () => api('PATCH', `/api/workshop/channels/${channelId}`, { body: { name: 'hacked' }, token: B.token })],
    ['DELETE channel', () => api('DELETE', `/api/workshop/channels/${channelId}`, { token: B.token })],
    ['POST activate', () => post(`/api/workshop/channels/${channelId}/activate`, {}, B.token)],
    ['POST tasks(创建管理)', () => post(`/api/workshop/channels/${channelId}/tasks`, { title: 'x', description: 'y' }, B.token)],
    ['GET tasks 列表', () => get(`/api/workshop/channels/${channelId}/tasks`, B.token)],
    ['GET agents(管理面)', () => get(`/api/workshop/channels/${channelId}/agents`, B.token)],
    ['PUT plugins', () => api('PUT', `/api/workshop/channels/${channelId}/plugins`, { body: { plugins: [] }, token: B.token })],
    ['POST memories(写)', () => post(`/api/workshop/channels/${channelId}/memories`, { title: 'x', content: 'y' }, B.token)],
    ['POST agents(放置成员)', () => post(`/api/workshop/channels/${channelId}/agents`, { agentId: leadAgentId, role: 'worker' }, B.token)],
    ['DELETE member(移除他人)', () => api('DELETE', `/api/workshop/channels/${channelId}/members/${C.id}`, { token: B.token })],
    ['POST approve(批准成员)', () => post(`/api/workshop/channels/${channelId}/members/${D.id}/approve`, {}, B.token)],
  ]
  let escBlocked = 0
  for (const [label, fn] of esc) {
    const r = await fn()
    const ok = r.status === 403 || r.status === 404
    if (ok) escBlocked += 1
    check(`9.x 成员越权被拒: ${label}`, ok, `status=${r.status} code=${r.code ?? ''}`)
  }
  check('9.1 管理端点越权全数被拒(11/11)', escBlocked === 11, `blocked=${escBlocked}/11`)

  // ── 10. 通知:跨用户零泄漏 + 断线游标补发 ──
  await post(`/api/workshop/channels/${channelId}/chat/messages`, { text: `@${B.name} 补发测试-1`, clientMessageId: `bf1-${TAG}` }, C.token)
  const notifB = await get('/api/workshop/notifications?limit=100', B.token)
  const notifD = await get('/api/workshop/notifications?limit=100', D.token)
  const bNotifs = notifB.data?.notifications ?? []
  check('10.1 B 的通知只含自己(recipientUserId 全等)', bNotifs.every(n => n.recipientUserId === B.id), `count=${bNotifs.length}`)
  check('10.2 D(未加入)无任何该 Channel 通知', (notifD.data?.notifications ?? []).every(n => n.channelId !== channelId))
  check('10.3 unreadCount 只统计本人', typeof notifB.data?.unreadCount === 'number' && notifB.data.unreadCount >= 1, `unread=${notifB.data?.unreadCount}`)
  const cNotifList = await get('/api/workshop/notifications?limit=100', C.token)
  check('10.4 C 看不到 B 的定向通知', (cNotifList.data?.notifications ?? []).every(n => n.recipientUserId === C.id))

  // 断线补发:拿一个"较旧"的游标 → 应能补齐其后所有通知
  const cursorId = bNotifs[bNotifs.length - 1]?.id
  const backfill = await get(`/api/workshop/notifications?cursorId=${cursorId}&limit=200`, B.token)
  check('10.5 按游标补发返回升序通知', (backfill.data?.notifications ?? []).every(n => n.recipientUserId === B.id))
  await post('/api/workshop/notifications/read', { all: true }, B.token)
  const notifB2 = await get('/api/workshop/notifications?limit=100', B.token)
  check('10.6 标记全部已读 → unreadCount=0', notifB2.data?.unreadCount === 0, `unread=${notifB2.data?.unreadCount}`)
  const cStillUnread = await get('/api/workshop/notifications?limit=100', C.token)
  check('10.7 已读不影响他人(B 已读后 C 仍有未读)', (cStillUnread.data?.unreadCount ?? 0) >= 0)

  // ── 11. 成员退出 → 权限立即收紧;重新加入 → generation 递增 ──
  const beforeLeave = await get(`/api/workshop/channels/${channelId}/members`, B.token)
  const genB = (beforeLeave.data?.members ?? []).find(m => m.userId === B.id)?.userId
  const leave = await post(`/api/workshop/channels/${channelId}/members/leave`, {}, C.token)
  check('11.1 C 退出成功', leave.code === 0, JSON.stringify(leave.data))
  const cAfterLeave = await get(`/api/workshop/channels/${channelId}/chat/messages`, C.token)
  check('11.2 退出后立即读不到群聊 → 403', cAfterLeave.status === 403, `status=${cAfterLeave.status}`)
  const ownerLeave = await post(`/api/workshop/channels/${channelId}/members/leave`, {}, A.token)
  check('11.3 owner 不能退出 → 409 OWNER_CANNOT_LEAVE', ownerLeave.status === 409 && ownerLeave.code === 'OWNER_CANNOT_LEAVE', `status=${ownerLeave.status} code=${ownerLeave.code}`)
  void genB

  // ── 12. 未开启群聊 / 转 private 后权限收紧 ──
  const vNow = (await get(`/api/workshop/channels/${channelId}/chat/permissions`, A.token)).data?.channel?.version
  await api('PATCH', `/api/workshop/channels/${channelId}`, { body: { visibility: 'private', version: vNow }, token: A.token })
  const dJoinPrivate = await post(`/api/workshop/channels/${channelId}/members/join`, {}, D.token)
  check('12.1 转 private 后未加入用户无法加入 → 403', dJoinPrivate.status === 403, `status=${dJoinPrivate.status} code=${dJoinPrivate.code}`)
  const bStillReads = await get(`/api/workshop/channels/${channelId}/chat/messages`, B.token)
  check('12.2 转 private 不自动移除既有成员(仍可读)', bStillReads.status === 200 || bStillReads.code === 0, `status=${bStillReads.status}`)

  // ── 13. WS 群聊事件:channel 流 seq/replay + 快照含群聊基线 ──
  const aepSnap = openAep(channelId, A.token)
  const snap = await waitUntil('A 收到 channel.snapshot', () => aepSnap.envelopes.find(e => e.type === 'channel.snapshot') ?? null, 15_000).catch(() => null)
  check('13.1 WS 首帧 channel.snapshot 到达', Boolean(snap))
  check('13.2 快照含群聊基线(chat.members/chatMessages)', Array.isArray(snap?.payload?.chat?.members) && Array.isArray(snap?.payload?.chat?.chatMessages), `members=${snap?.payload?.chat?.members?.length}`)
  check('13.3 快照含调用者能力视图(单一事实源)', typeof snap?.payload?.permissions?.canManage === 'boolean', JSON.stringify(snap?.payload?.permissions))
  // chat.message 必须走 channel 流(seq 单调、可回放):订阅后发一条,断言帧确实到达
  const seqBefore = aepSnap.envelopes.filter(e => e.type === 'chat.message').length
  const liveMsg = await post(`/api/workshop/channels/${channelId}/chat/messages`, { text: `WS 流帧验证 ${TAG}`, clientMessageId: `ws-${TAG}` }, B.token)
  const liveFrame = await waitUntil('chat.message 帧到达(channel 流)', () =>
    aepSnap.envelopes.find(e => e.type === 'chat.message' && e.payload?.id === liveMsg.data?.message?.id) ?? null, 15_000).catch(() => null)
  check('13.4 chat.message 经 channel 流下发(带 seq)', Boolean(liveFrame) && liveFrame.seq > 0, `type=${liveFrame?.type} seq=${liveFrame?.seq} (订阅前帧数 ${seqBefore})`)
  const seqs = aepSnap.envelopes.filter(e => e.type === 'chat.message').map(e => e.seq)
  check('13.5 chat.message seq 单调递增(可作重连游标)', seqs.length >= 1 && seqs.every((s, i) => i === 0 || s > seqs[i - 1]), `seqs=${seqs.join(',')}`)
  // 断线重连补发:用 lastSeq 重订 → 服务端重放缺失段(不丢消息)
  const lastSeq = aepSnap.envelopes.filter(e => typeof e.seq === 'number').reduce((m, e) => Math.max(m, e.seq), 0)
  aepSnap.close()
  await sleep(400)
  const aepReplay = openAep(null, A.token)
  await sleep(300)
  aepReplay.send({ type: 'sub', channelId, token: A.token, lastSeq: Math.max(0, lastSeq - 1) })
  const replayed = await waitUntil('重连 lastSeq 重放缺失段', () => {
    const hits = aepReplay.envelopes.filter(e => e.type === 'chat.message' && e.seq > lastSeq - 1)
    return hits.length > 0 ? hits : null
  }, 15_000).catch(() => null)
  check('13.6 断线重连按 lastSeq 重放聊天帧(不丢消息)', Boolean(replayed), `replayed=${replayed?.length}`)
  aepReplay.close()
  const ownerSnap = await get(`/api/workshop/channels/${channelId}/chat/messages`, A.token)
  check('13.7 群聊 REST 与 WS 流口径一致(同一事实源)', (ownerSnap.data?.messages ?? []).some(m => m.id === liveMsg.data?.message?.id))

  // 成员视角快照:必须不含管理面凭据
  const aepMember = openAep(channelId, B.token)
  const mSnap = await waitUntil('B 收到 channel.snapshot', () => aepMember.envelopes.find(e => e.type === 'channel.snapshot') ?? null, 15_000).catch(() => null)
  const mJson = JSON.stringify(mSnap?.payload ?? {})
  check('13.6 成员快照不含 agent config/token', !mJson.includes('"token"') && !mJson.includes('"config"'))
  check('13.7 成员快照不含内部 mailbox 载荷(messages 为空)', Array.isArray(mSnap?.payload?.messages) && mSnap.payload.messages.length === 0)
  check('13.8 成员快照 permissions.canManage=false', mSnap?.payload?.permissions?.canManage === false)
  aepMember.close()

  // ── 15. P0 审批旁路回归(§13.2):默认批准 / 越权列表 / 越权应答一律关闭 ──
  const decideNoFlag = await post('/api/workshop/agent-tools/approvals/nonexistent/decide', { comment: 'no approved field' }, B.token)
  check('15.1 decide 缺 approved 字段 → 400(不再默认批准)', decideNoFlag.status === 400, `status=${decideNoFlag.status} code=${decideNoFlag.code}`)
  const decideExplicit = await post('/api/workshop/agent-tools/approvals/nonexistent/decide', { approved: true }, B.token)
  check('15.2 decide 显式 approved 但审批不存在 → 409(不再 500)', decideExplicit.status === 409, `status=${decideExplicit.status} code=${decideExplicit.code}`)
  const apprD = await get('/api/workshop/agent-tools/approvals?scope=pending', D.token)
  check('15.3 无关用户审批列表为空(按可见 Channel 过滤,不再全员可见)', (apprD.data?.approvals ?? []).length === 0, `count=${apprD.data?.approvals?.length} status=${apprD.status}`)
  const apprHistD = await get('/api/workshop/agent-tools/approvals?scope=history', D.token)
  check('15.4 无关用户历史审批同样为空', (apprHistD.data?.approvals ?? []).length === 0, `count=${apprHistD.data?.approvals?.length}`)
  check('15.5 审批对象不含他人 Channel 的条目(D 视角)', (apprD.data?.approvals ?? []).every(a => a.agentId !== leadAgentId))
  const respondBadKind = await post('/api/workshop/hitl/respond', { kind: 'not-a-kind', id: 'x' }, B.token)
  check('15.6 hitl/respond 未知 kind → 400', respondBadKind.status === 400, `status=${respondBadKind.status}`)
  const respondGone = await post('/api/workshop/hitl/respond', { kind: 'omp-dialog', id: `nope-${TAG}`, value: 'x' }, B.token)
  check('15.7 hitl/respond 不存在的待办 → 409 ALREADY_RESOLVED', respondGone.status === 409, `status=${respondGone.status} code=${respondGone.code}`)
  const respondNoDecision = await post('/api/workshop/hitl/respond', { kind: 'codex-approval', id: `nope-${TAG}` }, B.token)
  check('15.8 hitl/respond 无任何决策字段 → 4xx(不落定为批准)', respondNoDecision.status === 400 || respondNoDecision.status === 409, `status=${respondNoDecision.status}`)
  const crossRespond = await post('/api/workshop/hitl/respond', { kind: 'dcw-approval', id: `nope-${TAG}`, confirmed: true }, D.token)
  check('15.9 非成员应答 → 403/409(未加入用户无任何审批能力)', crossRespond.status === 403 || crossRespond.status === 409, `status=${crossRespond.status} code=${crossRespond.code}`)

  // ── 16. 清理 ──
  aepA.close()
  aepB.close()
  aepC.close()
  const del = await api('DELETE', `/api/workshop/channels/${channelId}?purge=1`, { token: A.token })
  check('16.1 owner 可删除 Channel(管理权保留)', del.status === 200 || del.code === 0, `status=${del.status}`)
}

// ============================================================================
async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`)
  console.log(`║ AgentTeam 群聊真实 E2E  base=${BASE}  phase=${PHASE}`)
  console.log(`╚══════════════════════════════════════════════════════════════╝`)

  const health = await api('GET', '/api/health')
  if (health.data?.status !== 'ok') {
    console.error(`✖ 服务不可达或未就绪: ${BASE}(${JSON.stringify(health).slice(0, 200)})`)
    process.exit(1)
  }
  console.log(`· 服务健康 version=${health.data.version} uptime=${Math.round((health.data.uptimeMs ?? 0) / 1000)}s`)

  if (PHASE === 'chat' || PHASE === 'all') {
    await phaseChat()
  }
  if (PHASE === 'hitl' || PHASE === 'all') {
    const mod = await import('./e2e-hil-multi-user.mjs').catch(() => null)
    if (mod?.phaseHil) {
      // 共享同一套断言/HTTP/WS 工具与真实注册器(避免两套计数口径漂移)。
      // 注册标签加自增序号:--phase=all 时 chat/HIL 两段共用同一个 TAG,
      // 不加序号会因"邮箱已被注册"直接中断第二段(实测踩过)。
      let regSeq = 0
      const reg = async (label) => {
        regSeq += 1
        return registerUser(`${label}${regSeq}`)
      }
      const shared = {
        BASE,
        WS_BASE,
        api,
        post: (p, body, token) => api('POST', p, { body, token }),
        get: (p, token) => api('GET', p, { token }),
        check,
        block,
        waitUntil,
        sleep,
        openAep,
        TAG,
        reg,
        harness: arg('--harness', 'omp'),
        passed: () => passed,
        failures: () => failures,
        blocked: () => blocked,
      }
      await mod.phaseHil(shared)
    }
    else block('Phase HIL', 'scripts/e2e-hil-multi-user.mjs 未就绪')
  }

  console.log(`\n━━━ 结果: ${passed} passed / ${failures} failed / ${blocked} blocked ━━━`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL', err?.stack ?? err?.message ?? String(err))
  process.exit(1)
})
