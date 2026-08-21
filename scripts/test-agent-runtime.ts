/**
 * AgentRuntime 运行时核心测试(node + tsx 直跑,无浏览器)。
 *
 * 覆盖:
 *  1. idle 自动消费
 *  2. busy 时 enqueue 不打断(排队)
 *  3. 结束后续消费积压
 *  4. assign 消息触发 transition('WORKING')
 *  5. 单条 run 抛错不阻塞下一条
 *  6. abort 终止事件流
 *  7. stop 优雅(等当前事件流结束)
 *
 * 注入 fake TaskEngine(与契约相同签名),真实引擎装配留到集成阶段。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import type { MessageRepo } from '../server/services/workshop/db/message.repo'
import { Mailbox } from '../server/services/workshop/runtime/mailbox'
import { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime'
import type { ChannelBus, TaskEngine } from '../server/services/workshop/runtime/agent-runtime'
import type { A2AMessage, Part } from '../server/services/workshop/types/a2a'
import type { AgentTaskQueueView, TaskState, WorkspaceTask } from '../server/services/workshop/types/task'
import type {
  AgentEvent,
  AgentInfo,
  AgentInterface,
  AgentRunContext,
  AgentRunRequest,
  AgentWorkspace,
} from '../server/services/workshop/agents/agent-interface'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) {
    failures += 1
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function waitUntil(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await sleep(5)
  }
}

/** 落库一个 channel(messages.channel_id 外键依赖) */
function seedChannel(db: DatabaseSync, id: string): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO channels (id, name, description, lead_agent_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, id, '', null, 1, now, now)
}

function mkAgent(id: string, role: 'lead' | 'worker', channelId: string): AgentInfo {
  return { id, channelId, name: id, harness: 'mock', role, config: {} }
}

function mkMessage(channelId: string, parts: Part[], metadata?: Record<string, unknown>): A2AMessage {
  return { messageId: randomUUID(), contextId: channelId, role: 'ROLE_USER', parts, metadata }
}

function mkTask(channelId: string, assigneeId: string, title: string): WorkspaceTask {
  return {
    id: randomUUID(),
    channelId,
    assigneeId,
    creatorId: '',
    title,
    state: 'SUBMITTED',
    progress: 0,
    retryCount: 0,
    artifacts: [],
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

/** fake TaskEngine:记录 transition/applyEvent,提供 get/create 等(与契约相同签名) */
function makeFakeEngine() {
  const transitions: { taskId: string, state: TaskState, by: string }[] = []
  const applied: { taskId: string, event: AgentEvent }[] = []
  const tasks = new Map<string, WorkspaceTask>()
  const engine = {
    create(input: {
      channelId: string
      creatorId: string
      assigneeId: string
      title: string
      description?: string
      parentId?: string
      parts?: Part[]
    }): WorkspaceTask {
      const t = mkTask(input.channelId, input.assigneeId, input.title)
      tasks.set(t.id, t)
      return t
    },
    dispatch(): WorkspaceTask {
      throw new Error('dispatch 未在测试中使用')
    },
    transition(taskId: string, state: TaskState, by: string): WorkspaceTask {
      transitions.push({ taskId, state, by })
      const t = tasks.get(taskId)
      if (t) t.state = state
      return t ?? mkTask('', '', '')
    },
    applyEvent(taskId: string, event: AgentEvent): void {
      applied.push({ taskId, event })
    },
    list(): WorkspaceTask[] {
      return [...tasks.values()]
    },
    get(taskId: string): WorkspaceTask | undefined {
      return tasks.get(taskId)
    },
    complete(): WorkspaceTask {
      throw new Error('complete 未在测试中使用')
    },
    reassign(): WorkspaceTask {
      throw new Error('reassign 未在测试中使用')
    },
    cancel(): WorkspaceTask {
      throw new Error('cancel 未在测试中使用')
    },
    onChildCompleted(): void {},
    queueViewOf(channelId: string, agentId: string): AgentTaskQueueView {
      const mine = [...tasks.values()].filter(t => t.channelId === channelId && t.assigneeId === agentId)
      return {
        agentId,
        channelId,
        queued: mine.filter(t => t.state === 'SUBMITTED' || t.state === 'ASSIGNED'),
        current: mine.find(t => t.state === 'WORKING'),
        completed: mine.filter(t => t.state === 'COMPLETED'),
      }
    },
  }
  return { engine: engine as TaskEngine, transitions, applied, tasks }
}

/** 可配置 fake impl:记录 run 调用,按注入的生成器产出事件流 */
class FakeImpl implements AgentInterface {
  calls: AgentRunRequest[] = []
  constructor(
    private behavior: (req: AgentRunRequest, ctx: AgentRunContext) => AsyncGenerator<AgentEvent, void, unknown>,
  ) {}

  run(req: AgentRunRequest, ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    this.calls.push(req)
    return this.behavior(req, ctx)
  }
}

interface Setup {
  messages: MessageRepo
  busEvents: { event: AgentEvent, source: A2AMessage }[]
  bus: ChannelBus
  engine: ReturnType<typeof makeFakeEngine>
}

function setup(): Setup {
  const db = openWorkshopDb(':memory:')
  seedChannel(db, 'ch1')
  const messages = createMessageRepo(db)
  const busEvents: { event: AgentEvent, source: A2AMessage }[] = []
  const bus: ChannelBus = {
    emit: (event, source) => busEvents.push({ event, source }),
    onEvent: () => () => {},
    notifyTask: () => {},
    notifyAgent: () => {},
    onAgentStatus: () => {},
    onTaskEvent: () => {},
    wakeScheduler: () => {},
  }
  return { messages, busEvents, bus, engine: makeFakeEngine() }
}

function makeRuntime(s: Setup, agent: AgentInfo, impl: AgentInterface): AgentRuntime {
  const mailbox = new Mailbox(s.messages, agent.channelId, agent.id, () => {})
  const workspace = {} as AgentWorkspace
  return new AgentRuntime(agent, impl, { mailbox, taskEngine: s.engine.engine, bus: s.bus, workspace })
}

async function testAutoConsume(): Promise<void> {
  console.log('\n--- 1. idle 自动消费 ---')
  const s = setup()
  const impl = new FakeImpl(async function* () {
    yield { kind: 'status', status: { state: 'working', timestamp: new Date().toISOString() } }
    yield { kind: 'done' }
  })
  const rt = makeRuntime(s, mkAgent('a1', 'worker', 'ch1'), impl)
  rt.start()
  const msg = mkMessage('ch1', [])
  rt.enqueue(msg)
  await waitUntil(() => impl.calls.length === 1)
  await waitUntil(() => rt.getState() === 'idle')
  check('enqueue 后自动消费:run 被调用', impl.calls.length === 1)
  check('自动消费:事件逐条广播', s.busEvents.length === 2, `收到 ${s.busEvents.length} 个事件`)
  check('自动消费:消息标记已消费', s.messages.listPendingByChannelAgent('ch1', 'a1').length === 0)
  await rt.stop()
}

async function testBusyQueue(): Promise<void> {
  console.log('\n--- 2/3. busy 不打断 + 积压消费 ---')
  const s = setup()
  let release!: () => void
  const hold = new Promise<void>((r) => {
    release = r
  })
  const impl = new FakeImpl(async function* () {
    yield { kind: 'status', status: { state: 'started', timestamp: new Date().toISOString() } }
    await hold
    yield { kind: 'done' }
  })
  const rt = makeRuntime(s, mkAgent('a1', 'worker', 'ch1'), impl)
  rt.start()
  const msgA = mkMessage('ch1', [])
  const msgB = mkMessage('ch1', [])
  rt.enqueue(msgA)
  await waitUntil(() => impl.calls.length === 1)
  check('busy 时不打断:state=busy', rt.getState() === 'busy')
  rt.enqueue(msgB)
  await sleep(30)
  check('busy 时不打断:B 排队未处理', impl.calls.length === 1)
  release()
  await waitUntil(() => impl.calls.length === 2)
  await waitUntil(() => rt.getState() === 'idle')
  check('结束后续消费积压:B 被消费', impl.calls.length === 2)
  check('积压消费:两条消息均已消费', s.messages.listPendingByChannelAgent('ch1', 'a1').length === 0)
  await rt.stop()
}

async function testAssignTransition(): Promise<void> {
  console.log('\n--- 4. assign 消息触发 transition WORKING ---')
  const s = setup()
  const impl = new FakeImpl(async function* () {
    yield { kind: 'done' }
  })
  const rt = makeRuntime(s, mkAgent('a1', 'worker', 'ch1'), impl)
  rt.start()
  const task = mkTask('ch1', 'a1', '任务A')
  s.engine.tasks.set(task.id, task)
  const msg = mkMessage('ch1', [], { 'x-aw-task-kind': 'assign', 'x-aw-task-id': task.id })
  msg.taskId = task.id
  rt.enqueue(msg)
  await waitUntil(() => impl.calls.length === 1)
  await waitUntil(() => rt.getState() === 'idle')
  check(
    'assign 消息触发 transition("WORKING", agentId)',
    s.engine.transitions.some(t => t.taskId === task.id && t.state === 'WORKING' && t.by === 'a1'),
  )
  await rt.stop()
}

async function testErrorDoesNotBlock(): Promise<void> {
  console.log('\n--- 5. 单条 run 抛错不阻塞下一条 ---')
  const s = setup()
  let callCount = 0
  const impl = new FakeImpl(async function* () {
    callCount += 1
    if (callCount === 1) {
      yield { kind: 'status', status: { state: 'boom', timestamp: new Date().toISOString() } }
      throw new Error('boom')
    }
    yield { kind: 'done' }
  })
  const rt = makeRuntime(s, mkAgent('a1', 'worker', 'ch1'), impl)
  rt.start()
  rt.enqueue(mkMessage('ch1', []))
  rt.enqueue(mkMessage('ch1', []))
  await waitUntil(() => impl.calls.length >= 3 && rt.getState() === 'idle')
  check('单条抛错重投重试:失败消息重试成功且不阻塞下一条', impl.calls.length === 3)
  check('重试后消息仍标记消费', s.messages.listPendingByChannelAgent('ch1', 'a1').length === 0)
  await rt.stop()
}

async function testAbort(): Promise<void> {
  console.log('\n--- 6. abort 终止事件流 ---')
  const s = setup()
  let events = 0
  const impl = new FakeImpl(async function* (_req, ctx) {
    for (let i = 0; i < 300; i++) {
      if (ctx.signal.aborted) break
      events += 1
      yield { kind: 'status', status: { state: `step${i}`, timestamp: new Date().toISOString() } }
      await sleep(2)
    }
    yield { kind: 'done' }
  })
  const rt = makeRuntime(s, mkAgent('a1', 'worker', 'ch1'), impl)
  rt.start()
  rt.enqueue(mkMessage('ch1', []))
  await waitUntil(() => events >= 3)
  rt.abortCurrent()
  await waitUntil(() => rt.getState() === 'idle')
  check('abort 后事件流终止', events < 300, `终止于第 ${events} 个事件`)
  await rt.stop()
}

async function testStop(): Promise<void> {
  console.log('\n--- 7. stop 优雅 ---')
  const s = setup()
  let release!: () => void
  const hold = new Promise<void>((r) => {
    release = r
  })
  const impl = new FakeImpl(async function* () {
    yield { kind: 'status', status: { state: 'working', timestamp: new Date().toISOString() } }
    await hold
    yield { kind: 'done' }
  })
  const rt = makeRuntime(s, mkAgent('a1', 'worker', 'ch1'), impl)
  rt.start()
  rt.enqueue(mkMessage('ch1', []))
  await waitUntil(() => impl.calls.length === 1)
  let stopResolved = false
  const _stopPromise = rt.stop().then(() => {
    stopResolved = true
  })
  await sleep(30)
  check('stop 等当前事件流结束(未提前返回)', !stopResolved)
  release()
  await waitUntil(() => stopResolved)
  check('stop 优雅:state=stopped', rt.getState() === 'stopped')
}

async function main(): Promise<void> {
  await testAutoConsume()
  await testBusyQueue()
  await testAssignTransition()
  await testErrorDoesNotBlock()
  await testAbort()
  await testStop()
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
