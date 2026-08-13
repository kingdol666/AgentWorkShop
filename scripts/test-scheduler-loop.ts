/**
 * SchedulerLoop 调度循环测试(node + tsx 直跑,无浏览器)。
 *
 * 覆盖:
 *  1. 定时 tick:SUBMITTED 任务自动 dispatch 给 worker → worker 自动接取完成 → child-completed → 父任务完成(端到端)
 *  2. wake() 立即触发一轮(大 tickMs 下无定时 tick 仍能 dispatch)
 *  3. supervise 抛错 → 内置规则引擎兜底 dispatch
 *  4. stop() 后不再调度
 *  5. createAgentImpl 工厂(mock/claude/omp/未知 harness)
 *
 * 装配:真实 :memory: repo + 真实 TaskEngine + 真实 ChannelRuntime + 真实 Mailbox
 *      + 真实 AgentRuntime(MockAgentImpl lead/worker)+ 真实 SchedulerLoop。
 */
import { randomUUID } from 'node:crypto'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import type { AgentRow } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import type { TaskPatch } from '../server/services/workshop/db/task.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { TaskEngine } from '../server/services/workshop/runtime/task-engine'
import { ChannelRuntime } from '../server/services/workshop/runtime/channel-runtime'
import { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime'
import type { ChannelBus } from '../server/services/workshop/runtime/agent-runtime'
import { Mailbox, rowToMessage } from '../server/services/workshop/runtime/mailbox'
import { SchedulerLoop } from '../server/services/workshop/runtime/scheduler-loop'
import { MockAgentImpl } from '../server/services/workshop/agents/mock-agent'
import { createAgentImpl } from '../server/services/workshop/agents/factory'
import type {
  AgentEvent,
  AgentInfo,
  AgentInterface,
  AgentWorkspace,
  SupervisionDecision,
} from '../server/services/workshop/agents/agent-interface'
import type { A2AMessage } from '../server/services/workshop/types/a2a'
import { AppError } from '../server/utils/errors'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function waitUntil(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    if (cond()) return true
    if (Date.now() - start >= timeoutMs) return cond()
    await sleep(10)
  }
}

function rowToAgentInfo(row: AgentRow): AgentInfo {
  return {
    id: row.id,
    channelId: row.channelId,
    name: row.name,
    harness: row.harness,
    role: row.role as 'lead' | 'worker',
    config: JSON.parse(row.configJson) as Record<string, unknown>,
    token: row.token,
  }
}

interface WorkspaceDeps {
  engine: TaskEngine
  cr: ChannelRuntime
  tasks: ReturnType<typeof createTaskRepo>
  messages: ReturnType<typeof createMessageRepo>
}

/** 进程内 AgentWorkspace(委托真实 TaskEngine/ChannelRuntime/repo,模拟 manager 的最小能力面) */
function buildWorkspace(agent: AgentInfo, deps: WorkspaceDeps): AgentWorkspace {
  const { engine, cr, tasks, messages } = deps
  return {
    listAgents: async () => [],
    dispatchTask: async () => {
      throw new AppError(400, 'BAD_REQUEST', '测试 workspace 不使用 dispatchTask')
    },
    listTasks: async () => engine.list(agent.channelId),
    getTask: async (taskId) => {
      const task = engine.get(taskId)
      if (!task) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
      return task
    },
    reportTask: async ({ taskId, progress, artifact, message }) => {
      const task = engine.get(taskId)
      if (!task) throw new AppError(404, 'NOT_FOUND', `任务不存在: ${taskId}`)
      const patch: TaskPatch = {}
      if (progress !== undefined) patch.progress = progress
      if (artifact) patch.artifacts = [...task.artifacts, artifact]
      if (message) {
        patch.history = [
          ...task.history,
          { messageId: randomUUID(), contextId: task.channelId, role: 'ROLE_AGENT' as const, parts: [{ text: message }] },
        ]
      }
      tasks.update(taskId, patch)
      return engine.get(taskId)!
    },
    completeTask: async (taskId, artifacts) => {
      const completed = engine.complete(taskId, artifacts)
      if (completed.parentId) {
        engine.onChildCompleted(completed)
        const parent = engine.get(completed.parentId)
        if (parent) cr.getAgents().find(a => a.agentId === parent.assigneeId)?.wakeMailbox()
      }
      return completed
    },
    cancelTask: async taskId => engine.cancel(taskId, agent.id),
    sendMessage: async ({ toAgentId, parts, metadata }) => {
      const message: A2AMessage = {
        messageId: randomUUID(),
        contextId: agent.channelId,
        role: 'ROLE_AGENT',
        parts,
        metadata: { ...(metadata ?? {}), 'x-aw-target-agent': toAgentId, 'x-aw-from-agent': agent.id },
      }
      cr.route(message)
      return message
    },
    pollMailbox: async (limit = 100) =>
      messages.listPendingByAgent(agent.id).slice(0, limit).map(rowToMessage),
    subscribe: async () => {},
  }
}

interface Setup {
  engine: TaskEngine
  cr: ChannelRuntime
  lead: AgentRuntime
  worker: AgentRuntime
  channelId: string
  loop: SchedulerLoop
}

interface SetupOptions {
  tickMs?: number
  leadImpl?: AgentInterface
}

function setup(opts: SetupOptions = {}): Setup {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createAgentRepo(db)
  const tasks = createTaskRepo(db)
  const messages = createMessageRepo(db)
  const subscriptions = createSubscriptionRepo(db)
  const engine = new TaskEngine({ tasks, messages })
  const channel = channels.create({ name: 'test-channel' })

  const leadRow = agents.create({
    channelId: channel.id,
    name: 'lead',
    harness: 'mock',
    role: 'lead',
    config: { delayMs: 0 },
  })
  const workerRow = agents.create({
    channelId: channel.id,
    name: 'worker',
    harness: 'mock',
    role: 'worker',
    config: { delayMs: 0 },
  })
  const leadInfo = rowToAgentInfo(leadRow)
  const workerInfo = rowToAgentInfo(workerRow)

  const cr = new ChannelRuntime(channel.id, { taskEngine: engine, subscriptionRepo: subscriptions })
  const bus: ChannelBus = { emit: () => {}, onEvent: () => () => {}, notifyTask: () => {}, notifyAgent: () => {}, onAgentStatus: () => {}, onTaskEvent: () => {}, wakeScheduler: () => {} }

  const lead = new AgentRuntime(leadInfo, opts.leadImpl ?? new MockAgentImpl(leadInfo.config), {
    mailbox: new Mailbox(messages, leadInfo.id, () => cr.wakeScheduler()),
    taskEngine: engine,
    bus,
    workspace: buildWorkspace(leadInfo, { engine, cr, tasks, messages }),
  })
  const worker = new AgentRuntime(workerInfo, new MockAgentImpl(workerInfo.config), {
    mailbox: new Mailbox(messages, workerInfo.id, () => cr.wakeScheduler()),
    taskEngine: engine,
    bus,
    workspace: buildWorkspace(workerInfo, { engine, cr, tasks, messages }),
  })

  cr.addAgent(lead)
  cr.addAgent(worker)
  lead.start()
  worker.start()

  const loop = new SchedulerLoop(cr, lead, { tickMs: opts.tickMs ?? 10 })
  cr.scheduler = loop

  return { engine, cr, lead, worker, channelId: channel.id, loop }
}

async function teardown(s: Setup): Promise<void> {
  s.loop.stop()
  await Promise.all([s.lead.stop(), s.worker.stop()])
}

function submitTask(s: Setup, title: string) {
  return s.engine.create({
    channelId: s.channelId,
    creatorId: '',
    assigneeId: s.lead.agentId,
    title,
    description: '统筹交付',
  })
}

// ===== 场景 =====

async function testAutoDispatchAndComplete(): Promise<void> {
  console.log('\n--- 1. 定时 tick 自动 dispatch + worker 完成 + 父完成 ---')
  const s = setup({ tickMs: 10 })
  s.loop.start()
  const parent = submitTask(s, '主任务')

  const dispatched = await waitUntil(() =>
    s.engine.list(s.channelId).some(t => t.parentId === parent.id && t.assigneeId === s.worker.agentId),
  )
  check('定时 tick dispatch 子任务给 worker', dispatched)

  const completed = await waitUntil(() => s.engine.get(parent.id)?.state === 'COMPLETED')
  check('worker 完成子任务 → child-completed → 父任务完成', completed, `state=${s.engine.get(parent.id)?.state}`)

  const child = s.engine.list(s.channelId).find(t => t.parentId === parent.id)
  check('子任务 COMPLETED 且进度 100', child?.state === 'COMPLETED' && child?.progress === 100, `state=${child?.state} progress=${child?.progress}`)

  await teardown(s)
}

async function testWakeTriggersRound(): Promise<void> {
  console.log('\n--- 2. wake 立即触发一轮(大 tickMs,无定时 tick) ---')
  const s = setup({ tickMs: 100000 })
  s.loop.start()
  const parent = submitTask(s, '主任务')
  s.loop.wake()

  const dispatched = await waitUntil(
    () => s.engine.list(s.channelId).some(t => t.parentId === parent.id && t.assigneeId === s.worker.agentId),
    2000,
  )
  check('wake 立即触发 dispatch(无定时 tick)', dispatched)

  await teardown(s)
}

class ThrowingSuperviseImpl implements AgentInterface {
  async* run(): AsyncIterable<AgentEvent> {
    // 无消息处理(lead 仅测试 supervise 抛错)
  }

  async supervise(): Promise<SupervisionDecision[]> {
    throw new Error('supervise boom')
  }
}

async function testSuperviseThrowFallsBackToRules(): Promise<void> {
  console.log('\n--- 3. supervise 抛错 → 规则引擎兜底 dispatch ---')
  const s = setup({ tickMs: 10, leadImpl: new ThrowingSuperviseImpl() })
  s.loop.start()
  const parent = submitTask(s, '主任务')

  const dispatched = await waitUntil(() =>
    s.engine.list(s.channelId).some(t => t.parentId === parent.id && t.assigneeId === s.worker.agentId),
  )
  check('supervise 抛错后规则引擎兜底 dispatch', dispatched)

  await teardown(s)
}

async function testStopStopsScheduling(): Promise<void> {
  console.log('\n--- 4. stop 后不再调度 ---')
  const s = setup({ tickMs: 10 })
  s.loop.start()
  const first = submitTask(s, '任务一')
  const firstDone = await waitUntil(() => s.engine.get(first.id)?.state === 'COMPLETED')
  check('stop 前任务完整完成', firstDone)

  s.loop.stop()

  const second = submitTask(s, '任务二')
  await sleep(200)
  const state = s.engine.get(second.id)?.state
  const hasChild = s.engine.list(s.channelId).some(t => t.parentId === second.id)
  check('stop 后新任务不再被 dispatch', state === 'SUBMITTED' && !hasChild, `state=${state} hasChild=${hasChild}`)

  await teardown(s)
}

function testFactory(): void {
  console.log('\n--- 5. createAgentImpl 工厂 ---')
  const mk = (harness: string): AgentInfo => ({
    id: randomUUID(),
    channelId: 'ch',
    name: 'a',
    harness,
    role: 'worker',
    config: {},
  })

  check('mock → MockAgentImpl 实例', createAgentImpl(mk('mock')) instanceof MockAgentImpl)

  try {
    createAgentImpl(mk('claude'))
    check('claude 抛 HARNESS_NOT_IMPLEMENTED', false, '未抛异常')
  }
  catch (e) {
    const err = e as AppError
    check(
      'claude 抛 HARNESS_NOT_IMPLEMENTED',
      err instanceof AppError && err.code === 'HARNESS_NOT_IMPLEMENTED' && err.status === 501,
      `code=${err?.code} status=${err?.status}`,
    )
  }

  try {
    createAgentImpl(mk('unknown'))
    check('未知 harness 抛 UNKNOWN_HARNESS', false, '未抛异常')
  }
  catch (e) {
    const err = e as AppError
    check(
      '未知 harness 抛 UNKNOWN_HARNESS',
      err instanceof AppError && err.code === 'UNKNOWN_HARNESS' && err.status === 400,
      `code=${err?.code} status=${err?.status}`,
    )
  }
}

async function main(): Promise<void> {
  await testAutoDispatchAndComplete()
  await testWakeTriggersRound()
  await testSuperviseThrowFallsBackToRules()
  await testStopStopsScheduling()
  testFactory()

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('测试异常:', e)
  process.exit(1)
})
