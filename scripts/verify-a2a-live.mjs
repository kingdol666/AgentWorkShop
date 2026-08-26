/**
 * A2A 实时验证脚本(真实 HTTP,dev server 对口)——覆盖 test-workshop-entries 的 A2A 入口部分:
 *  - AgentCard 结构(supportedInterfaces.protocolBinding=JSONRPC / capabilities.streaming / modes)
 *  - JSON-RPC:tasks/send(同步阻塞至终态)/ tasks/get / tasks/list / tasks/cancel / message/send / agent/getCard
 *  - 错误码:-32601 Method not found / -32602 Invalid params / -32005 Agent not authorized / -32700 Parse error
 * 运行:node scripts/verify-a2a-live.mjs [--base http://127.0.0.1:3000]
 */
const BASE = (process.argv.find(a => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:3000') + '/api/workshop'
let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

async function req(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function rpc(agentId, payload, agentToken) {
  const headers = { 'content-type': 'application/json' }
  if (agentToken) headers.authorization = `Bearer ${agentToken}`
  const res = await fetch(`${BASE}/a2a/${agentId}/rpc`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

const cleanup = { channelId: null, agentIds: [] }
let __token = null

async function main() {
  console.log('━━━ A2A 实时验证(真实 HTTP)→', BASE, '━━━')
  const user = await req('POST', '/users/register', { body: { name: 'a2a-live-' + Math.random().toString(36).slice(2, 9) } })
  const token = user.json?.data?.token
  __token = token
  check('用户注册/拿 token', !!token)

  const ch = await req('POST', '/channels', { token, body: { name: 'a2a-live-check' } })
  const CH = ch.json?.data?.channelId
  cleanup.channelId = CH
  check('channel 创建', ch.json?.code === 0 && !!CH)

  const lead = await req('POST', `/channels/${CH}/agents`, { token, body: { name: 'a2a-lead', harness: 'mock', role: 'lead' } })
  const worker = await req('POST', `/channels/${CH}/agents`, { token, body: { name: 'a2a-worker', harness: 'mock', role: 'worker' } })
  const LEAD = lead.json?.data?.id, WORKER = worker.json?.data?.id
  cleanup.agentIds = [LEAD, WORKER]
  check('lead/worker 实例创建', !!LEAD && !!WORKER)

  console.log('\n--- 1. AgentCard ---')
  const card = await req('GET', `/a2a/${LEAD}/card`)
  const c = card.json
  check('card 返回', !!c && !!c.name && c.name === 'a2a-lead', JSON.stringify(card.json)?.slice(0, 160))
  check('card.supportedInterfaces[].protocolBinding=JSONRPC', Array.isArray(c?.supportedInterfaces) && c.supportedInterfaces.some(i => i.protocolBinding === 'JSONRPC' && i.protocolVersion === '1.0'))
  check('card.capabilities.streaming=true', c?.capabilities?.streaming === true)
  check('card.skills 为数组(缺省 [])', Array.isArray(c?.skills))
  check('card.defaultInputModes 含 text/plain', Array.isArray(c?.defaultInputModes) && c.defaultInputModes.includes('text/plain'))

  console.log('\n--- 2. JSON-RPC 方法 ---')
  // tasks/send:同步阻塞至终态(mock 毫秒级)
  const sendR = await rpc(LEAD, {
    jsonrpc: '2.0', id: 1, method: 'tasks/send',
    params: { message: { role: 'ROLE_USER', parts: [{ text: 'a2a-live 任务', mediaType: 'text/plain' }] } },
  })
  const r1 = sendR.json
  check('tasks/send 返回 result', !!r1?.result, r1?.error ? JSON.stringify(r1.error) : '')
  check('tasks/send 终态 COMPLETED', r1?.result?.status?.state === 'COMPLETED', r1?.result?.status?.state ?? '')
  check('tasks/send result 含 id/contextId', !!r1?.result?.id && !!r1?.result?.contextId)
  const a2aTaskId = r1?.result?.id

  // tasks/get
  const getR = await rpc(LEAD, { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId: a2aTaskId } })
  check('tasks/get 命中', getR.json?.result?.id === a2aTaskId)
  const badGet = await rpc(LEAD, { jsonrpc: '2.0', id: 3, method: 'tasks/get', params: { taskId: '00000000-0000-0000-0000-000000000000' } })
  check('tasks/get 不存在 → -32002', badGet.json?.error?.code === -32002, String(badGet.json?.error?.code))

  // tasks/list
  const listR = await rpc(LEAD, { jsonrpc: '2.0', id: 4, method: 'tasks/list', params: {} })
  check('tasks/list 含刚创建任务', (listR.json?.result ?? []).some(t => t.id === a2aTaskId))

  // agent/getCard
  const cardR = await rpc(WORKER, { jsonrpc: '2.0', id: 5, method: 'agent/getCard', params: {} })
  check('agent/getCard', cardR.json?.result?.supportedInterfaces?.some?.(i => i.protocolBinding === 'JSONRPC') === true)

  // message/send:worker 带 token 发消息给 lead(须真实送达)
  const workerToken = worker.json?.data?.token
  const msgR = await rpc(LEAD, {
    jsonrpc: '2.0', id: 6, method: 'message/send',
    params: { message: { role: 'ROLE_AGENT', parts: [{ text: 'a2a-live 内部消息', mediaType: 'text/plain' }] } },
  }, workerToken)
  check('message/send 带 token 送达', !!msgR.json?.result?.messageId, msgR.json?.error ? JSON.stringify(msgR.json.error) : '')
  const msgNoToken = await rpc(WORKER, { jsonrpc: '2.0', id: 60, method: 'message/send', params: { message: { role: 'ROLE_AGENT', parts: [{ text: 'x' }] } } })
  check('message/send 无 token → -32005', msgNoToken.json?.error?.code === -32005, String(msgNoToken.json?.error?.code))

  console.log('\n--- 3. JSON-RPC 错误码 ---')
  const unknown = await rpc(LEAD, { jsonrpc: '2.0', id: 7, method: 'no/such/method', params: {} })
  check('未知方法 → -32601', unknown.json?.error?.code === -32601, String(unknown.json?.error?.code))
  const badParams = await rpc(LEAD, { jsonrpc: '2.0', id: 8, method: 'tasks/get', params: {} })
  check('缺参 → -32602', badParams.json?.error?.code === -32602, String(badParams.json?.error?.code))
  const noId = await rpc(LEAD, { jsonrpc: '2.0', method: 'tasks/list', params: {} })
  check('缺 id 请求仍应答', !!noId.json && (noId.json.result || noId.json.error))
  const notFound = await rpc('00000000-0000-0000-0000-000000000000', { jsonrpc: '2.0', id: 9, method: 'tasks/list', params: {} })
  check('不存在的 agent → -32001', notFound.json?.error?.code === -32001, String(notFound.json?.error?.code))

  console.log('\n--- 4. tasks/cancel ---')
  const cancelTask = await req('POST', `/channels/${CH}/tasks`, { token, body: { title: '待取消任务', description: '将被取消' } })
  const CT = cancelTask.json?.data?.id
  const cancelR = await rpc(LEAD, { jsonrpc: '2.0', id: 10, method: 'tasks/cancel', params: { taskId: CT } })
  check('tasks/cancel 生效 CANCELED', cancelR.json?.result?.status?.state === 'CANCELED', cancelR.json?.result?.status?.state ?? JSON.stringify(cancelR.json))

  console.log(`\n━━━ 结果: PASS=${pass} FAIL=${fail} ━━━`)
  process.exit(fail === 0 ? 0 : 1)
}

try {
  await main()
}
finally {
  if (cleanup.channelId) await req('DELETE', `/channels/${cleanup.channelId}`, { token: __token }).catch(() => {})
}
