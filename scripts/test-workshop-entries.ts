/**
 * 入口层测试(REST + A2A + plugin 装配;WS 留集成)(node + tsx 直跑,无浏览器)。
 *
 * 装配:真实 :memory: db + 真实 Manager(mock harness,delayMs=0)+ 真实 SchedulerLoop
 *      (经 REST 入口创建 channel/lead 时由 handler 自动装配;无真实 HTTP 服务器,
 *      用 h3 的 H3 实例挂载各 handler,app.request 直调,等价 Nitro 测试客户端)。
 *
 * 覆盖:
 *  1. REST:创建 channel(带 lead)/创建 2 worker/发任务 → 任务流转到 COMPLETED(轮询等待)
 *  2. REST:任务列表含进度;任务详情含成果
 *  3. REST 错误码:NO_LEAD_AGENT(400)/LEAD_EXISTS(409)/NOT_FOUND(404)/INVALID_TRANSITION(400)
 *  4. REST:取消任务(慢速 lead 确定性场景)→ CANCELED
 *  5. A2A card:结构(supportedInterfaces.protocolBinding=JSONRPC / capabilities.streaming / modes / skills)
 *  6. A2A rpc:tasks/get 返回任务;tasks/list;tasks/send 同步阻塞至终态;tasks/sendSubscribe(SSE);
 *     tasks/cancel;message/send(带 token);agent/getCard;JSON-RPC 错误码(-32601/-32602/-32005/-32700)
 */
import { H3 } from 'h3'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createAgentImpl } from '../server/services/workshop/agents/factory'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { AllRepos, AgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { ChannelRuntime } from '../server/services/workshop/runtime/channel-runtime'
import type { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime'
import createChannelHandler from '../server/api/workshop/channels.post'
import listChannelsHandler from '../server/api/workshop/channels.get'
import deleteChannelHandler from '../server/api/workshop/channels/[id].delete'
import createAgentHandler from '../server/api/workshop/channels/[id]/agents/index.post'
import listAgentsHandler from '../server/api/workshop/channels/[id]/agents/index.get'
import deleteAgentHandler from '../server/api/workshop/agents/[id].delete'
import submitTaskHandler from '../server/api/workshop/channels/[id]/tasks/index.post'
import listTasksHandler from '../server/api/workshop/channels/[id]/tasks/index.get'
import getTaskHandler from '../server/api/workshop/tasks/[id].get'
import cancelTaskHandler from '../server/api/workshop/tasks/[id]/cancel/index.post'
import cardHandler from '../server/api/workshop/a2a/[agentId]/card/index.get'
import rpcHandler from '../server/api/workshop/a2a/[agentId]/rpc/index.post'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>()
  setTimeout(resolve, ms)
  return promise
}

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    if (await cond()) return true
    if (Date.now() - start >= timeoutMs) return await cond()
    await sleep(20)
  }
}

// ===== 装配:真实 Manager + H3 测试客户端 =====

const db = openWorkshopDb(':memory:')
const repos: AllRepos = {
  channels: createChannelRepo(db),
  agents: createAgentRepo(db),
  messages: createMessageRepo(db),
  subscriptions: createSubscriptionRepo(db),
  tasks: createTaskRepo(db),
}
const manager: AgentChannelManager = createAgentChannelManager({ repos, implFactory: createAgentImpl, db })
// plugin 的 getWorkshopManager() 从该全局单例读取(plugin 未在测试中执行)
globalThis.__workshopManager = manager

const app = new H3()
app.on('post', '/api/workshop/channels', createChannelHandler)
app.on('get', '/api/workshop/channels', listChannelsHandler)
app.on('delete', '/api/workshop/channels/:id', deleteChannelHandler)
app.on('post', '/api/workshop/channels/:id/agents', createAgentHandler)
app.on('get', '/api/workshop/channels/:id/agents', listAgentsHandler)
app.on('delete', '/api/workshop/agents/:id', deleteAgentHandler)
app.on('post', '/api/workshop/channels/:id/tasks', submitTaskHandler)
app.on('get', '/api/workshop/channels/:id/tasks', listTasksHandler)
app.on('get', '/api/workshop/tasks/:id', getTaskHandler)
app.on('post', '/api/workshop/tasks/:id/cancel', cancelTaskHandler)
app.on('get', '/api/workshop/a2a/:agentId.card', cardHandler)
app.on('post', '/api/workshop/a2a/:agentId.rpc', rpcHandler)

interface ReqInit {
  method?: string
  body?: unknown
  headers?: Record<string, string>
}
/** h3 H3 测试客户端:直调 handler,等价 Nitro 客户端(无真实 HTTP 服务器) */
async function req(path: string, init: ReqInit = {}): Promise<{ status: number, json: () => Promise<Record<string, unknown>>, text: () => Promise<string> }> {
  const res = await app.request(path, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  return { status: res.status, json: () => res.json() as Promise<Record<string, unknown>>, text: () => res.text() }
}

/** manager 内部结构(停止调度循环与 Agent 用) */
function internalsOf(m: AgentChannelManager): { channels: Map<string, ChannelRuntime>, agentIndex: Map<string, AgentRuntime> } {
  return m as unknown as { channels: Map<string, ChannelRuntime>, agentIndex: Map<string, AgentRuntime> }
}

/** 停止全部 SchedulerLoop 与 Agent(慢速 lead 的 run 不等待,进程将 exit) */
function teardown(): void {
  const internal = internalsOf(manager)
  for (const cr of internal.channels.values()) cr.scheduler?.stop()
  for (const agent of internal.agentIndex.values()) {
    void agent.stop().catch(() => {})
  }
  try {
    db.close()
  }
  catch {
    // 已有语句打开时忽略
  }
}

// ===== 场景 =====

async function testRestE2E(): Promise<{ channelA: string, leadA: string, workerTokens: string[], completedTaskId: string }> {
  console.log('\n--- 1. REST:创建 channel/lead + 2 worker + 发任务 → COMPLETED ---')

  // 创建 channel(带 leadAgent)→ handler 自动装配 SchedulerLoop
  const created = await req('/api/workshop/channels', {
    method: 'POST',
    body: { name: '团队A', description: '端到端', leadAgent: { name: 'Lead', harness: 'mock', config: { delayMs: 0 } } },
  })
  const createdJson = await created.json()
  const channelA: string = createdJson.data?.channelId
  const leadA: string = createdJson.data?.leadAgentId
  check('创建 channel 返回 channelId + leadAgentId', typeof channelA === 'string' && typeof leadA === 'string', JSON.stringify(createdJson.data))

  // 创建 2 个 worker
  const workerTokens: string[] = []
  for (const name of ['Worker1', 'Worker2']) {
    const res = await req(`/api/workshop/channels/${channelA}/agents`, {
      method: 'POST',
      body: { name, harness: 'mock', role: 'worker', config: { delayMs: 0 } },
    })
    const json = await res.json()
    check(`创建 worker ${name} 成功`, json.data?.id != null && json.data?.role === 'worker', JSON.stringify(json.data))
    if (typeof json.data?.token === 'string') workerTokens.push(json.data.token)
  }
  check('worker token 可见(供 A2A message/send 使用)', workerTokens.length === 2)

  const agentsRes = await req(`/api/workshop/channels/${channelA}/agents`)
  const agentsJson = await agentsRes.json()
  check('列 Agent:3 个(1 lead + 2 worker)', Array.isArray(agentsJson.data) && agentsJson.data.length === 3, `count=${agentsJson.data?.length}`)

  // 发任务(带 parts → 初始 input artifact,保证"成果"恒可见)
  const taskRes = await req(`/api/workshop/channels/${channelA}/tasks`, {
    method: 'POST',
    body: { title: '端到端任务', description: '集成验证', parts: [{ text: '集成验证载荷' }] },
  })
  const taskJson = await taskRes.json()
  const taskId: string = taskJson.data?.id
  check('发任务成功且状态 SUBMITTED', taskJson.data?.state === 'SUBMITTED', JSON.stringify(taskJson.data))

  // 轮询等待任务流转到 COMPLETED(mock harness delayMs=0,毫秒级完成)
  const completed = await waitUntil(async () => {
    const res = await req(`/api/workshop/tasks/${taskId}`)
    const json = await res.json()
    return json.data?.state === 'COMPLETED'
  })
  check('任务流转到 COMPLETED(轮询等待)', completed)

  const detail = await (await req(`/api/workshop/tasks/${taskId}`)).json()
  check('任务详情含成果(artifacts 非空)且进度 100', Array.isArray(detail.data?.artifacts) && detail.data.artifacts.length >= 1 && detail.data.progress === 100,
    `progress=${detail.data?.progress} artifacts=${detail.data?.artifacts?.length}`)

  const listRes = await (await req(`/api/workshop/channels/${channelA}/tasks`)).json()
  const listed = (listRes.data ?? []).find((t: { id: string }) => t.id === taskId)
  check('任务列表含进度(state=COMPLETED, progress=100)', listed?.state === 'COMPLETED' && listed?.progress === 100, JSON.stringify(listed))

  return { channelA, leadA, workerTokens, completedTaskId: taskId }
}

async function testRestErrors(ctx: { channelA: string, completedTaskId: string }): Promise<string> {
  console.log('\n--- 2. REST 错误码:NO_LEAD_AGENT / LEAD_EXISTS / NOT_FOUND / INVALID_TRANSITION ---')

  // 无 lead 的 channel → 发任务 NO_LEAD_AGENT(400)
  const noLead = await req('/api/workshop/channels', { method: 'POST', body: { name: '空团队' } })
  const noLeadJson = await noLead.json()
  const emptyChannel: string = noLeadJson.data?.channelId
  const taskOnEmpty = await (await req(`/api/workshop/channels/${emptyChannel}/tasks`, { method: 'POST', body: { title: 'x' } })).json()
  check('channel 无 lead → 400 NO_LEAD_AGENT', taskOnEmpty.code === 'NO_LEAD_AGENT' && taskOnEmpty.data === null, JSON.stringify(taskOnEmpty))

  // 重复创建 lead → 409 LEAD_EXISTS
  const dupLead = await (await req(`/api/workshop/channels/${ctx.channelA}/agents`, { method: 'POST', body: { name: 'Lead2', harness: 'mock', role: 'lead' } })).json()
  check('重复创建 lead → 409 LEAD_EXISTS', dupLead.code === 'LEAD_EXISTS', JSON.stringify(dupLead))

  // 任务不存在 → 404 NOT_FOUND
  const missing = await (await req('/api/workshop/tasks/not-exist')).json()
  check('任务不存在 → 404 NOT_FOUND', missing.code === 'NOT_FOUND', JSON.stringify(missing))

  // 终态任务取消 → 400 INVALID_TRANSITION
  const cancelDone = await (await req(`/api/workshop/tasks/${ctx.completedTaskId}/cancel`, { method: 'POST' })).json()
  check('取消已终态任务 → 400 INVALID_TRANSITION', cancelDone.code === 'INVALID_TRANSITION', JSON.stringify(cancelDone))

  // Agent 不存在删除 → 404 NOT_FOUND
  const missingAgent = await (await req('/api/workshop/agents/not-exist', { method: 'DELETE' })).json()
  check('删除不存在 Agent → 404 NOT_FOUND', missingAgent.code === 'NOT_FOUND', JSON.stringify(missingAgent))

  return emptyChannel
}

async function testCancel(emptyChannel: string): Promise<string> {
  console.log('\n--- 3. REST:取消任务(慢速 lead 确定性场景)→ CANCELED ---')

  // channel B:仅 lead + delayMs=5000(任务长时间停留 WORKING,取消窗口确定)
  const created = await (await req('/api/workshop/channels', {
    method: 'POST',
    body: { name: '团队B', leadAgent: { name: 'SlowLead', harness: 'mock', config: { delayMs: 5000 } } },
  })).json()
  const channelB: string = created.data?.channelId

  const submit = await (await req(`/api/workshop/channels/${channelB}/tasks`, { method: 'POST', body: { title: '将被取消' } })).json()
  const taskId: string = submit.data?.id
  const canceled = await (await req(`/api/workshop/tasks/${taskId}/cancel`, { method: 'POST' })).json()
  check('取消任务 → CANCELED(系统身份=lead)', canceled.data?.state === 'CANCELED', JSON.stringify(canceled.data))

  const after = await (await req(`/api/workshop/tasks/${taskId}`)).json()
  check('取消后任务详情 CANCELED', after.data?.state === 'CANCELED')

  // 删除 channel 后发任务 → 404
  const del = await (await req(`/api/workshop/channels/${emptyChannel}`, { method: 'DELETE' })).json()
  check('删除 channel → ok', del.data?.ok === true)
  const afterDel = await (await req(`/api/workshop/channels/${emptyChannel}/tasks`, { method: 'POST', body: { title: 'x' } })).json()
  check('删除后发任务 → 404 NOT_FOUND', afterDel.code === 'NOT_FOUND', JSON.stringify(afterDel))

  return channelB
}

async function testA2ACard(leadA: string): Promise<void> {
  console.log('\n--- 4. A2A card:结构校验 ---')
  const card = await (await req(`/api/workshop/a2a/${leadA}.card`)).json()
  check('card.name 存在', typeof card.name === 'string' && card.name.length > 0, JSON.stringify(card.name))
  check('card.description 存在', typeof card.description === 'string' && card.description.length > 0)
  check(
    'supportedInterfaces(数组, protocolBinding=JSONRPC, protocolVersion=1.0)',
    Array.isArray(card.supportedInterfaces)
    && card.supportedInterfaces.length > 0
    && card.supportedInterfaces[0].protocolBinding === 'JSONRPC'
    && card.supportedInterfaces[0].protocolVersion === '1.0'
    && typeof card.supportedInterfaces[0].url === 'string',
    JSON.stringify(card.supportedInterfaces),
  )
  check('capabilities{streaming:true, pushNotifications:false}', card.capabilities?.streaming === true && card.capabilities?.pushNotifications === false)
  check('defaultInputModes/OutputModes 含 text/plain', Array.isArray(card.defaultInputModes) && card.defaultInputModes.includes('text/plain') && Array.isArray(card.defaultOutputModes))
  check('skills 为数组', Array.isArray(card.skills))

  const missing = await req(`/api/workshop/a2a/not-exist.card`)
  const missingJson = await missing.json()
  check('card 不存在 Agent → 404', missing.status === 404 && missingJson.error?.code === 'NOT_FOUND', JSON.stringify(missingJson))
}

async function rpc(agentId: string, body: unknown, headers?: Record<string, string>) {
  return req(`/api/workshop/a2a/${agentId}.rpc`, { method: 'POST', body, headers })
}

async function testA2ARpc(ctx: { channelA: string, leadA: string, workerTokens: string[], completedTaskId: string }, channelB: string): Promise<void> {
  console.log('\n--- 5. A2A rpc:JSON-RPC 2.0 ---')

  // tasks/get:返回任务(jsonrpc 2.0 信封 + result)
  const got = await (await rpc(ctx.leadA, { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId: ctx.completedTaskId } })).json()
  check('tasks/get 返回任务', got.jsonrpc === '2.0' && got.id === 1 && got.result?.id === ctx.completedTaskId, JSON.stringify(got))

  // tasks/list
  const listed = await (await rpc(ctx.leadA, { jsonrpc: '2.0', id: 2, method: 'tasks/list', params: {} })).json()
  check('tasks/list 返回任务数组(含已完成任务)', Array.isArray(listed.result) && listed.result.some((t: { id: string }) => t.id === ctx.completedTaskId), `count=${listed.result?.length}`)

  // tasks/send:同步阻塞至终态
  const sent = await (await rpc(ctx.leadA, {
    jsonrpc: '2.0', id: 3, method: 'tasks/send',
    params: { message: { role: 'ROLE_USER', parts: [{ text: 'A2A 发任务' }] } },
  })).json()
  check('tasks/send 阻塞返回终态任务(COMPLETED)', sent.result?.status?.state === 'COMPLETED' && Array.isArray(sent.result?.artifacts), JSON.stringify(sent.result))

  // tasks/sendSubscribe:SSE 事件流(task/status-update …直到终态)
  const sseText = await Promise.race([
    rpc(ctx.leadA, { jsonrpc: '2.0', id: 4, method: 'tasks/sendSubscribe', params: { message: { role: 'ROLE_USER', parts: [{ text: 'SSE 任务' }] } } }).then(r => r.text()),
    sleep(10_000).then(() => 'TIMEOUT'),
  ])
  check('sendSubscribe 输出 SSE 事件(task + status-update)', typeof sseText === 'string' && sseText.includes('event: task') && sseText.includes('event: status-update'),
    typeof sseText === 'string' ? sseText.slice(0, 200) : sseText)

  // tasks/cancel:无 token → 系统身份(lead)取消 channelB 的第二个任务
  const submit2 = await (await req(`/api/workshop/channels/${channelB}/tasks`, { method: 'POST', body: { title: '将被 rpc 取消' } })).json()
  const taskB2: string = submit2.data?.id
  const canceled = await (await rpc(ctx.leadA, { jsonrpc: '2.0', id: 5, method: 'tasks/cancel', params: { taskId: taskB2 } })).json()
  check('tasks/cancel → CANCELED', canceled.result?.status?.state === 'CANCELED', JSON.stringify(canceled.result))

  // message/send:带 worker token → 点对点投递
  const msg = await (await rpc(ctx.leadA, {
    jsonrpc: '2.0', id: 6, method: 'message/send',
    params: { message: { role: 'ROLE_AGENT', parts: [{ text: 'hi lead' }] } },
  }, { authorization: `Bearer ${ctx.workerTokens[0]}` })).json()
  check('message/send(带 token)返回 messageId', typeof msg.result?.messageId === 'string' && msg.result?.contextId === ctx.channelA, JSON.stringify(msg.result))

  // message/send 无 token → -32005 Agent not authorized
  const noToken = await (await rpc(ctx.leadA, { jsonrpc: '2.0', id: 7, method: 'message/send', params: { message: { role: 'ROLE_AGENT', parts: [{ text: 'x' }] } } })).json()
  check('message/send 无 token → -32005', noToken.error?.code === -32005, JSON.stringify(noToken.error))

  // agent/getCard
  const card = await (await rpc(ctx.leadA, { jsonrpc: '2.0', id: 8, method: 'agent/getCard', params: {} })).json()
  check('agent/getCard 返回 card', card.result?.name != null && card.result?.capabilities?.streaming === true, JSON.stringify(card.result?.name))

  // 未知方法 → -32601;非法参数 → -32602
  const unknown = await (await rpc(ctx.leadA, { jsonrpc: '2.0', id: 9, method: 'foo.bar', params: {} })).json()
  check('未知方法 → -32601 Method not found', unknown.error?.code === -32601, JSON.stringify(unknown.error))
  const badParams = await (await rpc(ctx.leadA, { jsonrpc: '2.0', id: 10, method: 'tasks/get', params: {} })).json()
  check('非法参数 → -32602 Invalid params', badParams.error?.code === -32602, JSON.stringify(badParams.error))

  // 跨 channel 任务 → -32005(作用域隔离)
  const scoped = await (await rpc(ctx.leadA, { jsonrpc: '2.0', id: 11, method: 'tasks/get', params: { taskId: taskB2 } })).json()
  check('跨 channel 访问任务 → -32005', scoped.error?.code === -32005, JSON.stringify(scoped.error))

  // 坏 JSON → -32700 Parse error
  const badJson = await (await app.request(`/api/workshop/a2a/${ctx.leadA}.rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })).json()
  check('坏 JSON → -32700 Parse error', badJson.error?.code === -32700, JSON.stringify(badJson.error))

  // 非 JSON-RPC 请求 → -32600 Invalid Request
  const badRpc = await (await rpc(ctx.leadA, { hello: 'world' })).json()
  check('非 JSON-RPC 请求 → -32600 Invalid Request', badRpc.error?.code === -32600, JSON.stringify(badRpc.error))
}

async function main(): Promise<void> {
  const e2e = await testRestE2E()
  const emptyChannel = await testRestErrors(e2e)
  const channelB = await testCancel(emptyChannel)
  await testA2ACard(e2e.leadA)
  await testA2ARpc(e2e, channelB)

  console.log('\n--- 6. WS handler 不适合单测,留集成(server/api/workshop/ws.ts 已按 §6.4 实现) ---')

  teardown()

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
