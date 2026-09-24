/**
 * 路由决策留痕 + 能力画像数据基础(koda 后端设计借鉴)确定性测试:
 *  - lead 经 agents 端点创建(响应含实例 token)→ MCP tools/call 携带 Bearer
 *  - workshop.task.dispatch 带 route_reason → 落库 → 任务列表返回
 *  - task.status 事件载荷携带 routeReason/createdAt(前端"事件即实体" + 能力画像数据基础)
 * 运行:node scripts/test-route-reason.mjs
 */
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3101'
const sleep = ms => new Promise(r => setTimeout(r, ms))

let passed = 0, failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}

const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

const mcp = async (sid, id, method, params, agentToken) => {
  const headers = { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' }
  if (sid) headers['mcp-session-id'] = sid
  if (agentToken) headers.authorization = `Bearer ${agentToken}`
  const res = await fetch(`${BASE}/api/mcp/workshop`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  return { sid: res.headers.get('mcp-session-id'), text: await res.text() }
}

async function main() {
  const REASON = 'specialty: mock worker; queue empty; deterministic test'

  // ── 组队(mock;lead 经 agents 端点创建拿 token)──
  const user = await api('POST', '/api/workshop/users/register', { body: { name: `route-${Date.now().toString(36)}` } })
  const token = user.data?.token
  const ch = await api('POST', '/api/workshop/channels', { body: { name: 'route-reason-check' }, token })
  if (ch.code !== 0) throw new Error('channel 创建失败')
  const channelId = ch.data.channelId
  const lead = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    body: { name: 'lead', harness: 'mock', role: 'lead' },
    token,
  })
  const worker = await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    // 慢 worker:lead 会把父任务分解给 worker,子任务在测试窗口内保持 WORKING,
    // 父任务因此停在非终态 —— MCP 手工 dispatch 才有合法前置状态。
    body: { name: 'worker', harness: 'mock', role: 'worker', config: { delayMs: 60_000 } },
    token,
  })
  const leadToken = lead.data?.token
  const workerId = worker.data?.id
  check('lead 实例 token 下发(MCP caller)', Boolean(leadToken) && Boolean(workerId))

  // ── 父任务 + MCP dispatch 带 route_reason ──
  // lead 用长 delay:父任务在 MCP 手工派发前必须保持非终态 —— 简单任务会被 mock lead
  // 在首个监督回合直接收口,那时再 dispatch 只会拿到 TASK_TERMINAL。
  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: {
      title: '[mock:complex] route-parent',
      description: '父任务必须分解为子任务并派发给 worker 执行(本条同时是 route_reason 检查的前置)。',
    },
    token,
  })
  const parentId = task.data?.id
  check('父任务提交', Boolean(parentId), parentId?.slice(0, 8))

  const init = await mcp(null, 1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'route-e2e', version: '1.0.0' },
  }, leadToken)
  const sid = init.sid
  check('MCP 会话建立(agent caller)', Boolean(sid))

  const call = await mcp(sid, 2, 'tools/call', {
    name: 'workshop.task.dispatch',
    arguments: {
      parentTaskId: parentId,
      assigneeId: workerId,
      title: 'routed-child',
      description: 'child with auditable routing decision',
      routeReason: REASON,
    },
  }, leadToken)
  const okCall = !/"isError":\s*true/.test(call.text) && !call.text.includes('SCOPE_VIOLATION')
  check('MCP dispatch(route_reason)执行', okCall, okCall ? '' : call.text.slice(0, 140))
  if (sid) await fetch(`${BASE}/api/mcp/workshop?sessionId=${sid}`, { method: 'DELETE' }).catch(() => {})

  // ── 断言:任务行带 routeReason + 画像数据基础 ──
  await sleep(1200)
  const tasks = (await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })).data ?? []
  const child = tasks.find(t => t.title === 'routed-child')
  check('任务列表返回 routeReason', child?.routeReason === REASON, child?.routeReason ?? '(missing)')
  check('DTO 含 createdAt/updatedAt(能力画像数据基础)', Boolean(child?.createdAt) && Boolean(child?.updatedAt), '')

  // ── 断言:task.status 事件载荷携带 routeReason/createdAt ──
  const evs = (await api('GET', `/api/workshop/channels/${channelId}/events?limit=200`, { token })).data?.items ?? []
  const evReason = evs.find(e => e.type === 'task.status' && (e.payload ?? {}).routeReason !== undefined)
  const evCreated = evs.find(e => e.type === 'task.status' && (e.payload ?? {}).createdAt !== undefined)
  check('task.status 事件携带 routeReason(事件即实体)', Boolean(evReason))
  check('task.status 事件携带 createdAt', Boolean(evCreated))

  // 清理
  await api('DELETE', `/api/workshop/channels/${channelId}`, { token }).catch(() => {})
  console.log(`\n★ 结果: ${passed} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('e2e 异常:', err.message)
  process.exit(1)
})
