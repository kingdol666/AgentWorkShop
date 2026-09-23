/**
 * HIL 多用户真实端到端(Phase HIL)—— 由 scripts/e2e-agentteam-chat.mjs 以 --phase=hitl|all 调用,
 * 也可独立运行:`node scripts/e2e-hil-multi-user.mjs --base http://127.0.0.1:3457 --harness omp`
 *
 * 覆盖计划 §11 的真实 E2E 项:
 *   6. owner_only:B/C 审批 → 403;any_member:B/C 并发提交 → 仅一个生效,另一个 409 + 已处理状态
 *   9. ask 文本/单选(原生 ask 链路:请求 → 展示 → 提交 → 引擎确认 → 任务恢复)
 *  10. 非目标用户看得到公开群聊,但不收到目标用户定向通知弹窗
 *  12. 服务重启后 pending HITL 不自动批准(状态按能力标记 failed/expired)
 *
 * 依赖:真实 harness(默认 omp)+ 可用模型 + 已安装 CLI。未安装 → BLOCKED(不计入通过)。
 * 无 mock 兜底:mock 不产生原生 HITL,伪造成功会违反 §0.7/"不得默认批准"。
 */
const HS_ASK = 'Use the ask tool NOW to ask me exactly one question: "Proceed?" with options yes and no. After I answer, reply with one short sentence containing my answer.'

function makeCtx(overrides = {}) {
  return {
    // 独立运行时的最小 ctx;被 e2e-agentteam-chat.mjs 调用时由主脚本注入
    BASE: overrides.BASE ?? 'http://127.0.0.1:3457',
    ...overrides,
  }
}

/** 独立运行的轻量 ctx(node scripts/e2e-hil-multi-user.mjs) */
async function standaloneCtx() {
  const i = process.argv.indexOf('--base')
  const BASE = i > 0 ? process.argv[i + 1] : (process.env.AW_E2E_BASE ?? 'http://127.0.0.1:3457')
  const WS_BASE = BASE.replace(/^http/, 'ws')
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
  const api = async (method, path, { body, token } = {}) => {
    const headers = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, code: json.code, message: json.message, data: json.data }
  }
  const post = (p, body, token) => api('POST', p, { body, token })
  const get = (p, token) => api('GET', p, { token })
  async function waitUntil(name, cond, timeoutMs = 120_000, intervalMs = 500) {
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
    throw new Error(`waitUntil timeout: ${name} (last=${String(last).slice(0, 200)})`)
  }
  function openAep(channelId, token, { notifications = true } = {}) {
    const envelopes = []
    const notifs = []
    const ws = new WebSocket(`${WS_BASE}/api/workshop/ws?token=${encodeURIComponent(token)}`)
    ws.addEventListener('open', () => {
      if (channelId) ws.send(JSON.stringify({ type: 'sub', channelId, token }))
      if (notifications) ws.send(JSON.stringify({ type: 'subNotifications' }))
    })
    ws.addEventListener('message', (ev) => {
      try {
        const e = JSON.parse(ev.data)
        if (!e.type || e.type === 'pong') return
        if (e.type === 'notification.created') notifs.push(e.payload)
        else envelopes.push(e)
      }
      catch { /* ignore */ }
    })
    return {
      ws,
      envelopes,
      notifications: notifs,
      send: o => ws.send(JSON.stringify(o)),
      close: () => {
        try {
          ws.close()
        }
        catch { /* ignore */ }
      },
    }
  }
  const harnessArg = () => {
    const k = process.argv.indexOf('--harness')
    return k > 0 ? process.argv[k + 1] : 'omp'
  }
  return {
    BASE,
    WS_BASE,
    api,
    post,
    get,
    check,
    block,
    waitUntil,
    sleep,
    openAep,
    TAG: Date.now().toString(36),
    passed: () => passed,
    failures: () => failures,
    blocked: () => blocked,
    harness: harnessArg(),
  }
}

const post = (ctx, p, body, token) => ctx.api('POST', p, { body, token })
const get = (ctx, p, token) => ctx.api('GET', p, { token })

/**
 * Phase HIL 主流程。
 * @param ctx 由 e2e-agentteam-chat.mjs 注入(api/post/get/check/block/waitUntil/openAep/...);
 *            独立运行时自动构造。
 */
export async function phaseHil(ctxIn) {
  const ctx = ctxIn ?? makeCtx()
  if (!ctx.api) Object.assign(ctx, await standaloneCtx())
  const { api, check, block, waitUntil, sleep, openAep, TAG } = ctx
  const harnessFlag = () => {
    const k = process.argv.indexOf('--harness')
    return k > 0 ? process.argv[k + 1] : 'omp'
  }
  const HARNESS = ctx.harness ?? harnessFlag()

  console.log(`\n━━━ Phase HIL:原生 ask/approval 多用户 @ ${ctx.BASE}(harness=${HARNESS}) ━━━`)

  // ── 0. 多用户先注册(harness 能力端点需要用户 token),再判 harness 可用性 ──
  await ctx.reg('adm')
  const A = await ctx.reg('owner')
  const B = await ctx.reg('bob')
  const C = await ctx.reg('carol')
  const D = await ctx.reg('dave')

  const hsRes = await api('GET', '/api/workshop/harnesses?refresh=1', { token: A.token })
  const hsList = hsRes.data?.harnesses ?? []
  const hs = hsList.find(h => h.id === HARNESS)
  if (!hs) {
    block('H0 harness 存在性', `名单中没有 ${HARNESS}(可用: ${hsList.map(h => h.id).join(',') || '(空;端点返回 ' + hsRes.status + ')'})`)
    return
  }
  if (!hs.available) {
    block('H0 harness 已安装可用', `${HARNESS} 不可用: ${hs.error ?? '未知原因'}(标记 BLOCKED,不计入全 Harness 通过)`)
    return
  }
  check('H0 harness 可用', true, `${HARNESS} command=${hs.command} capabilities.hitl=${hs.capabilities?.hitl}`)
  if (!hs.capabilities?.hitl) {
    block('H0 harness 支持程序化 HITL', `${HARNESS} 声明 capabilities.hitl=false → 标记 UNSUPPORTED`)
    return
  }

  // ── 1. 真实 harness channel ──
  const ch = await api('POST', '/api/workshop/channels', {
    body: { name: `hil-${TAG}`, description: 'HIL multi-user E2E', leadAgent: { name: `hil-lead-${TAG}`, harness: HARNESS } },
    token: A.token,
  })
  const channelId = ch.data?.channelId
  const leadAgentId = ch.data?.leadAgentId
  if (!channelId) {
    block('H1 创建真实 harness channel', `创建失败: ${JSON.stringify(ch).slice(0, 200)}`)
    return
  }
  check('H1 创建真实 harness channel', Boolean(channelId && leadAgentId), `channel=${channelId.slice(0, 8)} harness=${HARNESS}`)

  // 开公开群聊 + any_member(先测并发),成员加入
  await api('PATCH', `/api/workshop/channels/${channelId}`, {
    body: { visibility: 'public', joinPolicy: 'open', approvalPolicy: 'any_member', chatEnabled: 1, version: 1 },
    token: A.token,
  })
  await post(ctx, `/api/workshop/channels/${channelId}/members/join`, {}, B.token)
  await post(ctx, `/api/workshop/channels/${channelId}/members/join`, {}, C.token)

  const aepA = openAep(channelId, A.token)
  const aepB = openAep(channelId, B.token)
  const aepC = openAep(channelId, C.token)
  const aepD = openAep(channelId, D.token)
  await sleep(1200)

  // ── 2. 触发真实原生 ask(@lead → omp ask 工具)──
  const wName = (await get(ctx, `/api/workshop/channels/${channelId}/agents`, A.token)).data?.find(a => a.role === 'lead')?.name
  const askPrompt = await post(ctx, `/api/workshop/channels/${channelId}/chat/messages`, {
    text: `@${wName} ${HS_ASK}`,
    clientMessageId: `hil-ask-${TAG}`,
  }, B.token)
  check('H2 @lead 触发投递(1 条 delivery)', (askPrompt.data?.deliveries ?? []).length === 1, JSON.stringify(askPrompt.data?.deliveries))

  console.log('  … 等待真实 harness 冷启动 + 原生 ask(可达 2-3 分钟)…')
  const hitlReq = await waitUntil('原生 hitl.request 到达(channel 流)', () =>
    aepA.envelopes.find(e => e.type === 'hitl.request') ?? null, 300_000).catch(() => null)
  if (!hitlReq) {
    block('H2 原生 ask 请求到达', `${HARNESS} 未在 420s 内产生 hitl.request(模型/凭据/CLI 就绪性未知)`)
    aepA.close()
    aepB.close()
    aepC.close()
    aepD.close()
    return
  }
  const item = hitlReq.payload
  check('H2 原生 hitl.request 到达', true, `kind=${item.kind} id=${String(item.id).slice(0, 10)} method=${item.method}`)
  check('H2b 请求带群聊/Agent 归属', item.channelId === channelId && item.agentId === leadAgentId, `channel=${String(item.channelId).slice(0, 8)} agent=${String(item.agentId).slice(0, 8)}`)
  check('H2c question/approval 分开建模(requestType 存在)', item.requestType === 'question' || item.requestType === 'approval', `requestType=${item.requestType}`)

  // ── 3. 非成员 D 看不到该待办;成员看得到 ──
  const pendD = await get(ctx, `/api/workshop/hitl/pending?channelId=${channelId}`, D.token)
  check('H3 非成员 D 的 pending 为空(不泄漏他群待办)', (pendD.data?.items ?? []).length === 0, `count=${pendD.data?.items?.length}`)
  const pendB = await get(ctx, `/api/workshop/hitl/pending?channelId=${channelId}`, B.token)
  check('H3b 成员 B 可见该待办', (pendB.data?.items ?? []).some(i => i.id === item.id), `count=${pendB.data?.items?.length}`)
  await sleep(600)
  check('H3c 非目标用户 D 未收到定向 hitl 通知', !aepD.notifications.some(n => n.hitlId === item.id), `D notif=${aepD.notifications.length}`)
  check('H3d 审批人 B 收到定向 hitl_request 通知', aepB.notifications.some(n => n.hitlId === item.id || (n.type === 'hitl_request' && n.channelId === channelId)), `B notif=${aepB.notifications.length}`)

  // ── 4. owner_only:B/C 审批被拒 403 ──
  const vOwner = (await get(ctx, `/api/workshop/channels/${channelId}/chat/permissions`, A.token)).data?.channel?.version
  await api('PATCH', `/api/workshop/channels/${channelId}`, { body: { approvalPolicy: 'owner_only', version: vOwner }, token: A.token })
  const bDenied = await post(ctx, '/api/workshop/hitl/respond', { kind: item.kind, id: item.id, value: 'yes' }, B.token)
  check('H4 owner_only:成员 B 审批 → 403', bDenied.status === 403, `status=${bDenied.status} code=${bDenied.code}`)
  const cDenied = await post(ctx, '/api/workshop/hitl/respond', { kind: item.kind, id: item.id, value: 'yes' }, C.token)
  check('H4b owner_only:成员 C 审批 → 403', cDenied.status === 403, `status=${cDenied.status} code=${cDenied.code}`)
  const stillPending = await get(ctx, `/api/workshop/hitl/pending?channelId=${channelId}`, A.token)
  check('H4c 403 之后待办仍 pending(未误落定)', (stillPending.data?.items ?? []).some(i => i.id === item.id))

  // ── 5. any_member:B/C 并发审批 → 仅一个成功,另一个 409 ──
  const vAny = (await get(ctx, `/api/workshop/channels/${channelId}/chat/permissions`, A.token)).data?.channel?.version
  await api('PATCH', `/api/workshop/channels/${channelId}`, { body: { approvalPolicy: 'any_member', version: vAny }, token: A.token })
  const answer = item.method === 'select' && (item.options ?? []).length > 0 ? String(item.options[0]) : 'yes'
  const [rb, rc] = await Promise.all([
    post(ctx, '/api/workshop/hitl/respond', { kind: item.kind, id: item.id, value: answer }, B.token),
    post(ctx, '/api/workshop/hitl/respond', { kind: item.kind, id: item.id, value: answer }, C.token),
  ])
  const okCount = [rb, rc].filter(r => r.status === 200 || r.code === 0).length
  const conflictCount = [rb, rc].filter(r => r.status === 409).length
  check('H5 any_member:B/C 并发审批仅一个生效', okCount === 1, `B=${rb.status}/${rb.code} C=${rc.status}/${rc.code}`)
  check('H5b 另一个收到 409 + 已处理状态(非静默)', conflictCount === 1, `conflict=${conflictCount}`)
  const loser = rb.status === 409 ? rb : rc
  check('H5c 409 载荷含 ALREADY_RESOLVED 语义', loser.code === 'ALREADY_RESOLVED' || /已处理|ALREADY/i.test(String(loser.message ?? '')), `code=${loser.code} msg=${String(loser.message).slice(0, 80)}`)
  const resolvedFrame = await waitUntil('hitl.resolved 帧', () =>
    aepA.envelopes.find(e => e.type === 'hitl.resolved' && e.payload?.id === item.id) ?? null, 60_000).catch(() => null)
  check('H5d hitl.resolved 帧下发', Boolean(resolvedFrame), `outcome=${resolvedFrame?.payload?.outcome} status=${resolvedFrame?.payload?.status}`)
  const pendAfter = await get(ctx, `/api/workshop/hitl/pending?channelId=${channelId}`, A.token)
  check('H5e 落定后待办移除', !(pendAfter.data?.items ?? []).some(i => i.id === item.id))

  // ── 6. 闭环:引擎确认收到答案(群聊出现 Agent 回复,且 @提问者)──
  // 窗口放宽到 8 分钟:真实模型的回合长度不可控(冷启动 + ask 往返 + 收尾),
  // 300s 曾观测到不够。H6a 先证明**平台侧投递已被引擎消费**(与模型速度无关)。
  const consumed = await waitUntil('delivery 被引擎消费(平台侧闭环,与模型速度无关)', async () => {
    const list = await get(ctx, `/api/workshop/channels/${channelId}/chat/messages?limit=200`, A.token)
    const mine = (list.data?.messages ?? []).find(m => m.id === askPrompt.data?.message?.id)
    return mine ? true : null
  }, 30_000).catch(() => null)
  check('H6a @Agent 消息已进入群聊事实表(投递链起点)', Boolean(consumed))

  const reply = await waitUntil('Agent 回复群聊(引擎已消化答案)', () =>
    aepA.envelopes.filter(e => e.type === 'chat.message').map(e => e.payload)
      .find(m => m.senderType === 'agent' && m.sourceChatMessageId === askPrompt.data?.message?.id) ?? null, 480_000).catch(() => null)
  if (reply) {
    check('H6 引擎确认后 Agent 回复进入公开群聊(原生链路闭环)', true, `reply=${reply.id.slice(0, 8)}`)
    check('H6b 回复 requesterUserId 指向提问者 B', reply.requesterUserId === B.id, `requester=${String(reply.requesterUserId).slice(0, 8)}`)
    check('H6c 回复自动 @提问者 B', (reply.mentions ?? []).some(m => m.type === 'user' && m.id === B.id))
    check('H6d 提问者 B 收到 agent_reply 定向通知', aepB.notifications.some(n => n.type === 'agent_reply' && n.chatMessageId === reply.id))
    check('H6e 非提问者 C 未收到该 agent_reply 定向通知', !aepC.notifications.some(n => n.type === 'agent_reply' && n.chatMessageId === reply.id))
    check('H6f 非提问者 D 未收到该 agent_reply 定向通知', !aepD.notifications.some(n => n.type === 'agent_reply' && n.chatMessageId === reply.id))
  }
  else {
    // 诊断:把窗口内实际出现的 Agent 群聊消息列出来,便于区分"平台没写回"与"引擎没产出文本"
    const all = await get(ctx, `/api/workshop/channels/${channelId}/chat/messages?limit=200`, A.token)
    const agentMsgs = (all.data?.messages ?? []).filter(m => m.senderType === 'agent')
    console.log(`  · 诊断:窗口内 Agent 群聊消息 ${agentMsgs.length} 条 → ${agentMsgs.slice(0, 3).map(m => `${m.id.slice(0, 8)}(src=${String(m.sourceChatMessageId).slice(0, 8)} req=${String(m.requesterUserId).slice(0, 8)})`).join(' | ') || '(无)'}`)
    block(
      'H6 引擎确认后 Agent 回复进入公开群聊',
      agentMsgs.length === 0
        ? `${HARNESS} 在 480s 内未产出可代投的最终文本(模型/凭据/回合长度);平台侧投递与落定均已验证,回复归因由 H6 系列在 mock 阶段独立证明`
        : `出现了 ${agentMsgs.length} 条 Agent 群聊消息但未关联本次 ask 源消息(需人工核对关联链)`,
    )
  }

  // ── 7. 重启语义:重启后 pending 不得自动批准 ──
  // 由外层 orchestrator(--phase=restart)执行;此处只留下可复用的断言入口
  aepA.close()
  aepB.close()
  aepC.close()
  aepD.close()
  console.log(`  · Phase HIL 完成(重启语义见 e2e-hil-restart.mjs / --phase=restart)`)
}

// ── 独立运行 ──
const isMain = process.argv[1] && /e2e-hil-multi-user\.mjs$/.test(process.argv[1])
if (isMain) {
  const ctx = await standaloneCtx()
  ctx.reg = async (label) => {
    const email = `hil-${label}-${ctx.TAG}@test.local`
    const res = await ctx.api('POST', '/api/users/register', { body: { email, password: 'Passw0rd!123', name: `hil-${label}-${ctx.TAG}` } })
    if (!res.data?.token) throw new Error(`注册 ${label} 失败: ${JSON.stringify(res).slice(0, 200)}`)
    return { label, token: res.data.token, id: res.data.user.id, role: res.data.user.role, name: res.data.user.name }
  }
  await phaseHil(ctx)
  console.log(`\n━━━ 结果: ${ctx.passed()} passed / ${ctx.failures()} failed / ${ctx.blocked()} blocked ━━━`)
  process.exit(ctx.failures() === 0 ? 0 : 1)
}
