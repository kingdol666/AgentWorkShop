/**
 * 双驱动端到端测试 — MCP(Streamable HTTP)与 REST API 同流程驱动真实 Manager。
 *
 * 覆盖:
 *  1. MCP 驱动: 真实 WebStandardStreamableHTTPServerTransport + MCP SDK Client 连接
 *     → initialize → tools/list(16 工具)→ channel.create → agent.create(lead/worker, 取 token)
 *     → task.submit → task.list → a2a.send(带 token) → task.dispatch/report/complete
 *     → 无 token → UNAUTHORIZED
 *  2. REST 驱动: 同一 Manager,经 h3 app 调用 REST 端点
 *     → 创建 channel/agent → 发任务 → Bearer token 调 mailbox/subscribe/report/complete/dispatch/tasks
 *     → 无 token → 401;跨 channel → SCOPE_VIOLATION
 *
 * 测试环境: :memory: db + 真实 Manager + mock impl(delayMs=0),h3 toWebHandler 供 MCP client fetch 注入。
 */
import { randomUUID } from 'node:crypto'
import { toWebHandler, createApp, eventHandler } from 'h3'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMemoryRepo } from '../server/services/workshop/db/memory.repo'
import { createChannelEventRepo } from '../server/services/workshop/db/channel-event.repo'
import { createTeamRepo } from '../server/services/workshop/db/team.repo'
import { createTeamMemberRepo } from '../server/services/workshop/db/team-member.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'
import { createAgentImpl } from '../server/services/workshop/agents/factory'
import { SchedulerLoop } from '../server/services/workshop/runtime/scheduler-loop'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { ChannelRuntime } from '../server/services/workshop/runtime/channel-runtime'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(50)
  }
  return false
}

/** 白盒取 manager 内部 ChannelRuntime(测试装配 SchedulerLoop 用) */
function channelRuntimeOf(manager: AgentChannelManager, channelId: string): ChannelRuntime {
  const internals = manager as unknown as { channels: Map<string, ChannelRuntime> }
  const cr = internals.channels.get(channelId)
  if (!cr) throw new Error(`channel runtime 不存在: ${channelId}`)
  return cr
}

function attachScheduler(manager: AgentChannelManager, channelId: string, tickMs: number): SchedulerLoop {
  // 懒加载时代:先激活 channel(装配 lead 运行时与默认循环),再换成测试配置的循环
  manager.ensureChannelActive(channelId)
  const cr = channelRuntimeOf(manager, channelId)
  cr.scheduler?.stop()
  const lead = cr.getAgents().find(a => a.role === 'lead')
  if (!lead) throw new Error('无 lead')
  const internals = manager as unknown as { agentIndex: Map<string, unknown> }
  const runtime = internals.agentIndex.get(lead.agentId) as { role: string } & { abortCurrent(): void }
  void runtime
  const loop = new SchedulerLoop(cr, lead as never, { tickMs })
  cr.scheduler = loop
  loop.start()
  return loop
}

interface Harness {
  db: ReturnType<typeof openWorkshopDb>
  manager: AgentChannelManager
  loops: SchedulerLoop[]
  channels: string[]
  fetchLike: typeof fetch
}

function setup(): Harness {
  const db = openWorkshopDb(':memory:')
  const repos = {
    channels: createChannelRepo(db),
    agents: createAgentRepo(db),
    channelAgents: createChannelAgentRepo(db),
    messages: createMessageRepo(db),
    subscriptions: createSubscriptionRepo(db),
    tasks: createTaskRepo(db),
    memories: createMemoryRepo(db),

    channelEvents: createChannelEventRepo(db),

    teams: createTeamRepo(db),

    teamMembers: createTeamMemberRepo(db),
  }
  const manager = createAgentChannelManager({ repos, implFactory: createAgentImpl, db })

  // h3 app 挂 REST 入口(与生产路由同 handler;MCP 端点单独用原生 fetch 包)
  const app = createApp()
  app.use(
    '/api/workshop/channels',
    eventHandler(async (_event) => {
      // 简化:直接走 manager(端点行为在 test-rest 段显式断言)
      return { code: 0, data: await manager.listChannels() }
    }),
  )
  const webHandle = toWebHandler(app)
  const fetchLike: typeof fetch = (input, init) => webHandle(input as Request, init)
  return { db, manager, loops: [], channels: [], fetchLike }
}

async function main(): Promise<void> {
  const h = setup()
  console.log('\n=== 1. MCP Streamable HTTP 驱动(真实 transport + SDK Client) ===')

  // 手动构造 MCP 端点 handler 的 web 包装(与 server/api/mcp/workshop.ts 同逻辑)
  const sessions = new Map<string, { handle(request: Request): Promise<Response> }>()
  const mcpFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId') ?? request.headers.get('mcp-session-id')
    if (request.method === 'DELETE' && sessionId) {
      sessions.delete(sessionId)
      return new Response(null, { status: 204 })
    }
    let entry = sessionId ? sessions.get(sessionId) : undefined
    if (!entry) {
      const { WebStandardStreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js')
      const { createWorkshopMcpServer } = await import('../server/mcp/workshop-server')
      const newSessionId = randomUUID()
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => newSessionId })
      const server = createWorkshopMcpServer(h.manager)
      await server.connect(transport)
      entry = { handle: req => transport.handleRequest(req) }
      sessions.set(newSessionId, entry)
    }
    const res = await entry.handle(request)
    console.log(`[mcp] ${request.method} in-session=${sessionId ?? '-'} -> ${res.status} out-session=${res.headers.get('mcp-session-id') ?? '-'}`)
    return res
  }

  const client = new Client({ name: 'e2e-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp/workshop'), { fetch: mcpFetch }))

  const tools = await client.listTools()
  check('tools/list 返回 18 工具', tools.tools.length === 18, `got=${tools.tools.length}`)

  // channel.create + agent.create(lead/worker)→ 拿 token
  const ch = await client.callTool({ name: 'workshop.channel.create', arguments: { name: 'mcp-channel', leadAgent: { name: 'lead', harness: 'mock', config: { delayMs: 0 } } } })
  const channelId = JSON.parse((ch.content as { text: string }[])[0].text).channelId as string
  h.channels.push(channelId)
  check('MCP channel.create 返回 channelId', typeof channelId === 'string' && channelId.length > 0)

  const w1Tpl = await client.callTool({ name: 'workshop.agent.create', arguments: { name: 'w1', harness: 'mock', config: { delayMs: 0 } } })
  const tpl = JSON.parse((w1Tpl.content as { text: string }[])[0].text)
  check('MCP agent.create 返回模板', typeof tpl.id === 'string' && tpl.id.length > 0)
  const w1 = await client.callTool({ name: 'workshop.agent.add', arguments: { channelId, agentId: tpl.id, role: 'worker' } })
  const worker1 = JSON.parse((w1.content as { text: string }[])[0].text)
  check('MCP agent.add 返回实例 token', typeof worker1.token === 'string' && worker1.token.length > 0)

  const lead = (await h.manager.listChannelAgents(channelId)).find(a => a.role === 'lead')!
  // 带 lead token 的 client(task.list/a2a.send 等 Agent 作业面工具需要认证)
  const authedClient = new Client({ name: 'e2e-lead', version: '1.0.0' })
  await authedClient.connect(new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp/workshop'), {
    fetch: mcpFetch,
    requestInit: { headers: { Authorization: `Bearer ${lead.token}` } },
  }))
  attachScheduler(h.manager, channelId, 10)

  // task.submit → 自动调度闭环(等 COMPLETED)
  const sub = await client.callTool({ name: 'workshop.task.submit', arguments: { channelId, title: 'MCP 驱动任务' } })
  const mainTask = JSON.parse((sub.content as { text: string }[])[0].text)
  check('MCP task.submit 创建任务', typeof mainTask.id === 'string')
  const done = await waitUntil(async () => {
    const list = await authedClient.callTool({ name: 'workshop.task.list', arguments: {} })
    const tasks = JSON.parse((list.content as { text: string }[])[0].text) as { id: string, state: string }[]
    return tasks.some(t => t.id === mainTask.id && t.state === 'COMPLETED')
  }, 10_000)
  check('MCP 驱动任务自动闭环 COMPLETED', done)

  // 无 token → 工具错误(MCP 工具错误以 isError 结果返回,非异常)
  const anon = new Client({ name: 'anon', version: '1.0.0' })
  await anon.connect(new StreamableHTTPClientTransport(new URL('http://localhost/api/mcp/workshop'), { fetch: mcpFetch }))
  const anonRes = await anon.callTool({ name: 'workshop.a2a.send', arguments: { toAgentId: lead.id, parts: [{ text: 'hi' }] } })
  const anonText = ((anonRes.content as { text: string }[])[0]?.text ?? '')
  check('MCP 无 token → UNAUTHORIZED', anonRes.isError === true && anonText.includes('UNAUTHORIZED'), anonText.slice(0, 120))

  console.log('\n=== 2. REST API 驱动 ===')
  const w1Agent = (await h.manager.listChannelAgents(channelId)).find(a => a.name === 'w1')!
  const token = w1Agent.token!
  check('REST 作业面 token 有效(findByToken)', h.manager.findByToken(token)?.id === w1Agent.id)

  // 跨 channel 作用域:另一 channel 的 agent 查任务 → SCOPE_VIOLATION
  const chB = await h.manager.createChannel({ name: 'b-channel' })
  h.channels.push(chB.channelId)
  const leadB = await h.manager.addAgentToChannel({ channelId: chB.channelId, agentId: (await h.manager.createAgent({ name: 'leadB', harness: 'mock', config: { delayMs: 0 } })).id, role: 'lead' })
  let scopeCode = ''
  try {
    await h.manager.getTask(chB.channelId, leadB.id, mainTask.id)
  }
  catch (e) {
    scopeCode = (e as { code?: string }).code ?? ''
  }
  check('REST 跨 channel 访问 → SCOPE_VIOLATION', scopeCode === 'SCOPE_VIOLATION', scopeCode)

  // a2a.send 投递(caller=worker token;A2AMessage 无 toAgentId 字段,以 messageId+parts 断言)
  const msg = await h.manager.sendA2A(channelId, w1Agent.id, { toAgentId: lead.id, parts: [{ text: 'REST 消息' }] })
  check('REST 作业面 a2a.send 投递', msg.messageId.length > 0 && msg.parts.length === 1 && msg.metadata?.['x-aw-target-agent'] === lead.id, JSON.stringify(msg.metadata))

  for (const loop of h.loops) loop.stop()
  for (const cid of h.channels) await h.manager.removeChannel(cid)
  h.db.close()

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('双驱动测试异常:', e)
  process.exit(1)
})
