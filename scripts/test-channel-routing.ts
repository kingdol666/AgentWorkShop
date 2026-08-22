/**
 * ChannelRuntime 路由测试(node + tsx 直跑,无浏览器)。
 *
 * 覆盖:
 *  1. 点对点直投(x-aw-target-agent)
 *  2. 跨 channel 目标忽略
 *  3. 任务消息直投 assignee(x-aw-task-kind)
 *  4. 广播只达订阅者
 *  5. 无订阅者时广播无投递
 *  6. 订阅后广播可达
 *
 * 使用真实 ChannelRuntime + 真实 Mailbox(:memory:) + 3 个 fake AgentRuntime(仅 getState/enqueue 记录)。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import type { MessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { Mailbox } from '../server/services/workshop/runtime/mailbox'
import { ChannelRuntime } from '../server/services/workshop/runtime/channel-runtime'
import type { AgentRuntimeLike, TaskEngine } from '../server/services/workshop/runtime/agent-runtime'
import type { A2AMessage } from '../server/services/workshop/types/a2a'
import type { AgentStatusView, AgentTaskQueueView } from '../server/services/workshop/types/task'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) {
    failures += 1
  }
}

/** 落库一个 channel(messages.channel_id / agents.channel_id 外键依赖) */
function seedChannel(db: DatabaseSync, id: string): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO channels (id, name, description, lead_agent_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, id, '', null, 1, now, now)
}

/** 落库一个 Agent 实例(subscriptions.agent_id 外键依赖 channel_agents.id) */
function seedAgent(db: DatabaseSync, id: string, channelId: string, role: 'lead' | 'worker'): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO channel_agents (id, channel_id, template_id, name, harness, config_json, role, token, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, channelId, null, id, 'mock', '{}', role, randomUUID(), 1, now, now)
}

function mkTask(channelId: string, assigneeId: string, title: string): WorkspaceTask {
  return {
    id: randomUUID(),
    channelId,
    assigneeId,
    creatorId: '',
    title,
    state: 'ASSIGNED',
    progress: 0,
    retryCount: 0,
    artifacts: [],
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/** fake AgentRuntime:仅记录 enqueue,并透过真实 Mailbox 落库 */
class FakeAgentRuntime implements AgentRuntimeLike {
  readonly agentId: string
  readonly role: 'lead' | 'worker'
  readonly channelId: string
  received: A2AMessage[] = []
  readonly mailbox: Mailbox

  constructor(agentId: string, role: 'lead' | 'worker', channelId: string, messages: MessageRepo) {
    this.agentId = agentId
    this.role = role
    this.channelId = channelId
    this.mailbox = new Mailbox(messages, channelId, agentId, () => {})
  }

  enqueue(message: A2AMessage): void {
    this.received.push(message)
    this.mailbox.enqueue(message)
  }

  getState(): 'idle' | 'busy' | 'stopped' {
    return 'idle'
  }

  wakeMailbox(): void {}

  injectSteer(message: A2AMessage): void {
    this.enqueue(message)
  }

  getStatus(): AgentStatusView {
    return {
      agentId: this.agentId,
      channelId: this.channelId,
      role: this.role,
      name: this.agentId,
      state: 'idle',
      currentTaskId: null,
      queuedCount: 0,
      completedCount: 0,
    }
  }

  getQueueView(): AgentTaskQueueView {
    return { agentId: this.agentId, channelId: this.channelId, queued: [], completed: [] }
  }

  async stop(): Promise<void> {}

  emitExternal(): void {}
}

function main(): void {
  const db = openWorkshopDb(':memory:')
  seedChannel(db, 'ch1')
  seedAgent(db, 'agentA', 'ch1', 'lead')
  seedAgent(db, 'agentB', 'ch1', 'worker')
  seedAgent(db, 'agentC', 'ch1', 'worker')
  const messages = createMessageRepo(db)
  const subscriptions = createSubscriptionRepo(db)

  // fake TaskEngine:route 仅调用 get
  const tasks = new Map<string, WorkspaceTask>()
  const engine = {
    get: (taskId: string) => tasks.get(taskId),
    create: () => {
      throw new Error('未使用')
    },
    dispatch: () => {
      throw new Error('未使用')
    },
    transition: () => {
      throw new Error('未使用')
    },
    applyEvent: () => {},
    list: () => [] as WorkspaceTask[],
    complete: () => {
      throw new Error('未使用')
    },
    reassign: () => {
      throw new Error('未使用')
    },
    cancel: () => {
      throw new Error('未使用')
    },
    onChildCompleted: () => {},
    queueViewOf: () => ({ queued: [], completed: [] }),
  } as TaskEngine

  const channelId = 'ch1'
  const cr = new ChannelRuntime(channelId, { taskEngine: engine, subscriptionRepo: subscriptions, channelAgents: createChannelAgentRepo(db) })
  const a = new FakeAgentRuntime('agentA', 'lead', channelId, messages)
  const b = new FakeAgentRuntime('agentB', 'worker', channelId, messages)
  const c = new FakeAgentRuntime('agentC', 'worker', channelId, messages)
  cr.addAgent(a)
  cr.addAgent(b)
  cr.addAgent(c)

  function routeMsg(metadata: Record<string, unknown>): A2AMessage {
    const msg: A2AMessage = { messageId: randomUUID(), contextId: channelId, role: 'ROLE_USER', parts: [], metadata }
    cr.route(msg)
    return msg
  }

  function clearReceived(): void {
    a.received = []
    b.received = []
    c.received = []
  }

  console.log('\n--- 基础 ---')
  check('getAgents 返回 3 个 agent', cr.getAgents().length === 3)
  check('lead getter 返回 lead agent', cr.lead?.agentId === 'agentA')

  console.log('\n--- 1. 点对点直投 ---')
  clearReceived()
  const p2p = routeMsg({ 'x-aw-target-agent': 'agentB', 'x-aw-from-agent': 'agentA' })
  check('点对点直投:目标收到', b.received.includes(p2p))
  check('点对点直投:非目标未收到', !a.received.includes(p2p) && !c.received.includes(p2p))

  console.log('\n--- 2. 跨 channel 目标忽略 ---')
  clearReceived()
  routeMsg({ 'x-aw-target-agent': 'agentX', 'x-aw-from-agent': 'agentA' })
  check('跨 channel 目标忽略:无投递', a.received.length === 0 && b.received.length === 0 && c.received.length === 0)

  console.log('\n--- 3. 任务消息直投 assignee ---')
  const task = mkTask(channelId, 'agentC', '任务C')
  tasks.set(task.id, task)
  clearReceived()
  const assignMsg = routeMsg({ 'x-aw-task-kind': 'assign', 'x-aw-task-id': task.id })
  check('任务消息直投 assignee', c.received.includes(assignMsg))
  console.log('\n--- 4. 广播只达订阅者 ---')
  subscriptions.add(channelId, 'agentA', 'agentB') // A 订阅 B
  clearReceived()
  const bcastB = routeMsg({ 'x-aw-from-agent': 'agentB' })
  check('广播只达订阅者:A 收到', a.received.includes(bcastB))
  check('广播只达订阅者:B/C 未收到', !b.received.includes(bcastB) && !c.received.includes(bcastB))

  console.log('\n--- 5. 无订阅者时广播无投递 ---')
  clearReceived()
  routeMsg({ 'x-aw-from-agent': 'agentC' }) // C 无订阅者
  console.log('\n--- 6. 订阅后广播可达 ---')
  subscriptions.add(channelId, 'agentA', 'agentC') // A 订阅 C
  clearReceived()
  const bcastC = routeMsg({ 'x-aw-from-agent': 'agentC' })
  check('订阅后广播可达:A 收到 C 的广播', a.received.includes(bcastC))
  check('订阅后广播:C 自身未收到', !c.received.includes(bcastC))

  console.log('\n--- 7. 垃圾拦截(无发送人/伪造发送人/无效任务) ---')
  clearReceived()
  const noSender = routeMsg({ 'x-aw-target-agent': 'agentB' })
  check('无发送人消息被拦截', !b.received.includes(noSender))
  const fakeSender = routeMsg({ 'x-aw-target-agent': 'agentB', 'x-aw-from-agent': 'agentZ' })
  check('伪造发送人(非成员)消息被拦截', !b.received.includes(fakeSender))
  routeMsg({ 'x-aw-task-kind': 'assign', 'x-aw-task-id': 'task-not-exist' })
  check('无效任务消息被拦截', a.received.length === 0 && b.received.length === 0 && c.received.length === 0)
  const humanMsg = routeMsg({ 'x-aw-target-agent': 'agentB', 'x-aw-from-label': 'tester' })
  check('人类消息(from-label)放行', b.received.includes(humanMsg))

  console.log('\n--- 真实 Mailbox 持久化 ---')
  void b.mailbox.peek(10).then(async (peeked) => {
    const persisted = peeked.find(m => m.metadata?.['x-aw-target-agent'] === 'agentB')
    check('点对点直投:Mailbox 落库 pending', persisted !== undefined, `peeked ${peeked.length} 条`)

    // ===== 恰好一次认领(steer 注入 / poll_messages 读即取 / 消费循环 dequeue 三方竞争) =====
    console.log('\n--- 恰好一次认领(原子 claim) ---')
    // 清空 B 信箱残留(FIFO 顺序干扰):全部认领并消费
    for (const old of await b.mailbox.peek(50)) {
      if (b.mailbox.claim(old.messageId)) b.mailbox.markConsumed(old.messageId)
    }
    const raceMsg: A2AMessage = {
      messageId: randomUUID(),
      contextId: channelId,
      role: 'ROLE_AGENT',
      parts: [{ text: 'race' }],
      metadata: { 'x-aw-target-agent': 'agentB', 'x-aw-from-agent': 'agentA', 'x-aw-msg-priority': 'immediate' },
    }
    b.mailbox.enqueue(raceMsg)
    // 三个竞争方依次认领:只有第一个成功(唯一所有权 → 消息绝不双投)
    const steerGot = b.mailbox.claim(raceMsg.messageId)
    const pollGot = b.mailbox.claim(raceMsg.messageId)
    const dqGot = b.mailbox.claim(raceMsg.messageId)
    check('首竞争者(steer)认领成功', steerGot === true)
    check('后到竞争者(poll/dequeue)认领失败', pollGot === false && dqGot === false)
    // 认领期间消息对 peek 不可见(poll_messages 不会重复取走)
    const visible = await b.mailbox.peek(10)
    check('认领期间 peek 不可见', !visible.some(x => x.messageId === raceMsg.messageId))
    // steer 放弃(deferred)→ requeue 释放回 pending → dequeue 接管
    check('requeue 释放认领', b.mailbox.requeue(raceMsg.messageId) === true)
    const taken = await Promise.race([
      b.mailbox.dequeue(),
      new Promise<A2AMessage | null>(r => setTimeout(() => r(null), 1000)),
    ])
    check('释放后 dequeue 取到消息', taken?.messageId === raceMsg.messageId)
    // 终态:markConsumed 后 claim 不复活消息
    b.mailbox.markConsumed(raceMsg.messageId)
    check('consumed 后 claim 不复活', b.mailbox.claim(raceMsg.messageId) === false)

    // ===== 同毫秒突发 FIFO(rowid 决胜回归) =====
    // 紧密循环同步入队:大概率全部落在同一毫秒内 → dequeue 顺序必须 === 入队顺序
    console.log('\n--- 同毫秒突发 FIFO(rowid 决胜) ---')
    const burst: A2AMessage[] = []
    for (let i = 0; i < 30; i++) {
      const m: A2AMessage = {
        messageId: randomUUID(),
        contextId: channelId,
        role: 'ROLE_AGENT',
        parts: [{ text: `burst-${i}` }],
        metadata: { 'x-aw-target-agent': 'agentB', 'x-aw-from-agent': 'agentA' },
      }
      b.mailbox.enqueue(m)
      burst.push(m)
    }
    const textOf = (m: A2AMessage): string =>
      (m.parts[0] && 'text' in m.parts[0] ? m.parts[0].text : '') as string
    const takenOrder: string[] = []
    for (let i = 0; i < burst.length; i++) {
      const got = await Promise.race([
        b.mailbox.dequeue(),
        new Promise<A2AMessage | null>(r => setTimeout(() => r(null), 1000)),
      ])
      if (!got) break
      takenOrder.push(textOf(got))
    }
    const expectOrder = burst.map(textOf)
    check('30 条同毫秒突发按入队顺序逐条出队(FIFO)', takenOrder.join(',') === expectOrder.join(','),
      `${takenOrder.length} 条`)

    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
    process.exit(failures === 0 ? 0 : 1)
  })
}

main()
