/**
 * MCP 工具层测试(node + tsx 直跑,无浏览器)。
 *
 * 覆盖:
 *  1. tools/list 返回 §6.1 的 16 个工具(名逐字一致)
 *  2. tools/call 参数校验(zod 错误返回)
 *  3. 无 token → UNAUTHORIZED
 *  4. 无效 token → UNAUTHORIZED
 *  5. a2a.send 的 fromAgentId 由 token 决定(manager 收到 callerAgentId,而非请求体自报)
 *
 * 通过 SDK 的 Client + InMemoryTransport 协议层测试;token 经自定义 transport
 * 注入(Authorization 头 / auth 中间件两种路径)。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createWorkshopMcpServer } from '../server/mcp/workshop-server'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { AgentInfo } from '../server/services/workshop/agents/agent-interface'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) {
    failures += 1
  }
}

/** 提取工具错误文案(isError 结果的第一个文本块) */
function toolErrorText(result: unknown): string {
  const block = (result as { content?: Array<{ text?: string }> })?.content?.[0]
  return typeof block?.text === 'string' ? block.text : ''
}

/** 可注入 caller token 的客户端 transport(InMemoryTransport 只原生转发 authInfo) */
class TokenClientTransport extends InMemoryTransport {
  token: string | undefined
  /** 'auth' = 经 authInfo.token 注入;'header' = 经 Authorization: Bearer 头(requestInfo)注入 */
  mode: 'auth' | 'header' = 'auth'

  override async send(message: unknown, options?: { authInfo?: unknown }): Promise<void> {
    if (this.token === undefined) {
      return super.send(message as never, options as never)
    }
    if (this.mode === 'auth') {
      return super.send(message as never, {
        ...options,
        authInfo: { token: this.token, clientId: 'test-client', scopes: [] },
      } as never)
    }
    // header 模式:复刻 InMemoryTransport.send 但注入 requestInfo(Authorization 头)
    const self = this as unknown as { _otherTransport?: { onmessage?: (m: unknown, e: unknown) => void, _messageQueue: Array<{ message: unknown, extra: unknown }> } }
    const other = self._otherTransport
    if (!other) throw new Error('Not connected')
    const extra = { requestInfo: { headers: { authorization: `Bearer ${this.token}` } } }
    if (other.onmessage) other.onmessage(message, extra)
    else other._messageQueue.push({ message, extra })
  }
}

/** 手动链接一对 transport(client 侧为可注入 token 的 TokenClientTransport) */
function createLinkedPair(): [TokenClientTransport, InMemoryTransport] {
  const clientTransport = new TokenClientTransport()
  const serverTransport = new InMemoryTransport()
  const c = clientTransport as unknown as { _otherTransport?: InMemoryTransport }
  const s = serverTransport as unknown as { _otherTransport?: InMemoryTransport }
  c._otherTransport = serverTransport
  s._otherTransport = clientTransport
  return [clientTransport, serverTransport]
}

/** §6.1 表逐字的 16 个工具名 */
const EXPECTED_TOOLS = [
  'workshop.channel.create',
  'workshop.channel.list',
  'workshop.channel.remove',
  'workshop.agent.create',
  'workshop.agent.add',
  'workshop.agent.definitions',
  'workshop.agent.list',
  'workshop.agent.remove',
  'workshop.task.submit',
  'workshop.task.dispatch',
  'workshop.task.list',
  'workshop.task.get',
  'workshop.task.report',
  'workshop.task.complete',
  'workshop.task.cancel',
  'workshop.a2a.send',
  'workshop.a2a.poll',
  'workshop.a2a.subscribe',
  'workshop.mail.list',
  'workshop.queue.overview',
]

/** fake manager stub:记录调用 + 返回预设值(与 AgentChannelManager 相同方法签名) */
function makeFakeManager() {
  const calls: Array<{ method: string, args: unknown[] }> = []

  const agentsByToken = new Map<string, AgentInfo>()
  agentsByToken.set('token-lead-1', {
    id: 'agent-lead-1',
    channelId: 'ch-1',
    name: 'Lead',
    harness: 'mock',
    role: 'lead',
    config: {},
  })
  agentsByToken.set('token-worker-2', {
    id: 'agent-worker-2',
    channelId: 'ch-1',
    name: 'Worker2',
    harness: 'mock',
    role: 'worker',
    config: {},
  })

  const record
    = (method: string, result: unknown) =>
      (...args: unknown[]) => {
        calls.push({ method, args })
        return Promise.resolve(result)
      }

  const manager = {
    createChannel: record('createChannel', { channelId: 'ch-1' }),
    listChannels: record('listChannels', []),
    removeChannel: record('removeChannel', undefined),
    createAgent: record('createAgent', {
      id: 'agent-tpl',
      name: 'New',
      harness: 'mock',
      config: {},
      enabled: 1,
      instances: [],
    }),
    addAgentToChannel: record('addAgentToChannel', {
      id: 'agent-inst',
      channelId: 'ch-1',
      name: 'New',
      harness: 'mock',
      role: 'worker',
      config: {},
    }),
    listAgents: record('listAgents', []),
    listChannelAgents: record('listChannelAgents', []),
    submitChannelTask: record('submitChannelTask', { id: 'task-1' }),
    dispatchTask: record('dispatchTask', { id: 'task-2' }),
    reportTask: record('reportTask', { id: 'task-1' }),
    completeTask: record('completeTask', { id: 'task-1' }),
    cancelTask: record('cancelTask', { id: 'task-1' }),
    listTasks: record('listTasks', []),
    getTask: record('getTask', { id: 'task-1' }),
    sendA2A: record('sendA2A', {
      messageId: 'm-1',
      contextId: 'ch-1',
      role: 'ROLE_AGENT',
      parts: [{ text: 'hi' }],
    }),
    pollMailbox: record('pollMailbox', []),
    listChannelMail: record('listChannelMail', []),
    queueOverview: record('queueOverview', []),
    subscribe: record('subscribe', undefined),
    findByToken: (token: string) => agentsByToken.get(token),
    restore: record('restore', undefined),
  }

  return {
    manager: manager as unknown as AgentChannelManager,
    calls,
    agentsByToken,
  }
}

async function main(): Promise<void> {
  const [clientTransport, serverTransport] = createLinkedPair()
  const fake = makeFakeManager()
  const server = createWorkshopMcpServer(fake.manager)

  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)

  // ===== 1. tools/list:20 个工具,名逐字一致 =====
  const { tools } = await client.listTools()
  const actualNames = tools.map(t => t.name).sort()
  const expectedNames = [...EXPECTED_TOOLS].sort()
  check('tools/list 返回 20 个工具', tools.length === 20, `got ${tools.length}`)
  check(
    '工具名与 §6.1 逐字一致',
    JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    JSON.stringify(actualNames),
  )

  // ===== 2. 参数校验:zod 错误返回 =====
  const missingName = await client.callTool({ name: 'workshop.channel.create', arguments: {} })
  check(
    '参数校验:channel.create 缺 name → 工具错误',
    (missingName as { isError?: boolean }).isError === true,
    toolErrorText(missingName),
  )
  check(
    '参数校验:错误文案含 Input validation error',
    toolErrorText(missingName).includes('Input validation error'),
    toolErrorText(missingName),
  )

  const badRole = await client.callTool({
    name: 'workshop.agent.add',
    arguments: { channelId: 'ch-1', agentId: 'agent-tpl', role: 'admin' },
  })
  check(
    '参数校验:agent.add role 非法枚举 → 工具错误',
    (badRole as { isError?: boolean }).isError === true,
    toolErrorText(badRole),
  )

  // ===== 3. 无 token → UNAUTHORIZED =====
  clientTransport.token = undefined
  const noToken = await client.callTool({ name: 'workshop.agent.list', arguments: {} })
  check(
    '无 token → UNAUTHORIZED',
    (noToken as { isError?: boolean }).isError === true && toolErrorText(noToken) === 'UNAUTHORIZED',
    toolErrorText(noToken),
  )

  // ===== 4. 无效 token → UNAUTHORIZED =====
  clientTransport.token = 'bad-token'
  const badToken = await client.callTool({ name: 'workshop.agent.list', arguments: {} })
  check(
    '无效 token → UNAUTHORIZED',
    (badToken as { isError?: boolean }).isError === true && toolErrorText(badToken) === 'UNAUTHORIZED',
    toolErrorText(badToken),
  )

  // ===== 5. a2a.send 的 fromAgentId 由 token 决定 =====
  clientTransport.token = 'token-lead-1'
  // 请求体故意自报 fromAgentId,应被忽略;caller 由 token 解析为 agent-lead-1
  const sendResult = await client.callTool({
    name: 'workshop.a2a.send',
    arguments: { toAgentId: 'agent-worker-2', parts: [{ text: 'hello' }], fromAgentId: 'evil-agent' },
  })
  check('a2a.send(有效 token)→ 成功', (sendResult as { isError?: boolean }).isError !== true, toolErrorText(sendResult))

  const sendCall = fake.calls.find(c => c.method === 'sendA2A')
  const callerAgentId = sendCall?.args[1]
  const sendInput = sendCall?.args[2] as { toAgentId?: string, fromAgentId?: string } | undefined
  check(
    'a2a.send callerAgentId 由 token 决定(agent-lead-1)',
    callerAgentId === 'agent-lead-1',
    `got ${String(callerAgentId)}`,
  )
  check(
    'a2a.send 忽略请求体自报的 fromAgentId',
    sendInput?.fromAgentId === undefined && sendInput?.toAgentId === 'agent-worker-2',
    JSON.stringify(sendInput),
  )

  // ===== 6. Authorization 头路径同样解析 token =====
  clientTransport.mode = 'header'
  clientTransport.token = 'token-worker-2'
  const headerResult = await client.callTool({ name: 'workshop.a2a.send', arguments: { toAgentId: 'agent-lead-1', parts: [{ text: 'hi' }] } })
  check('Authorization 头解析 token → 成功', (headerResult as { isError?: boolean }).isError !== true, toolErrorText(headerResult))
  const headerCall = fake.calls.filter(c => c.method === 'sendA2A').at(-1)
  check(
    'Authorization 头路径 callerAgentId = agent-worker-2',
    headerCall?.args[1] === 'agent-worker-2',
    `got ${String(headerCall?.args[1])}`,
  )

  await client.close()
  await server.close()

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
