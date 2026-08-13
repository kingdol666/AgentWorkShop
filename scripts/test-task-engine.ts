/**
 * TaskEngine 测试(node + tsx 直跑,无浏览器)
 *
 * 覆盖:
 *  1. create/dispatch 父子关系(assignee/creator/state/parent)
 *  2. dispatch 投递 assign 消息(parts + metadata 断言)
 *  3. 状态机全合法迁移
 *  4. 非法迁移(COMPLETED→WORKING、终态再迁等)抛 INVALID_TRANSITION
 *  5. applyEvent artifact 分块 append + progress 折算 / totalChunks 折算
 *  6. complete 置终态 + 进度 100
 *  7. reassign retryCount+1 + 投递 assign 消息
 *  8. cancel 置 CANCELED + 投递 cancel 消息
 *  9. onChildCompleted 最后一个子任务完成 → 父恢复 WORKING + child-completed 消息
 */
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { TaskEngine } from '../server/services/workshop/runtime/task-engine'
import type { Part, A2AArtifact } from '../server/services/workshop/types/a2a'
import type { WorkspaceTask } from '../server/services/workshop/types/task'
import { AppError } from '../server/utils/errors'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** 全新内存库 + engine + 一个 channel + lead/worker 两个 agent */
function setup() {
  const db = openWorkshopDb(':memory:')
  const channels = createChannelRepo(db)
  const agents = createAgentRepo(db)
  const tasks = createTaskRepo(db)
  const messages = createMessageRepo(db)
  const engine = new TaskEngine({ tasks, messages })
  const channel = channels.create({ name: 'test-channel' })
  const lead = agents.create({ channelId: channel.id, name: 'lead', harness: 'mock', role: 'lead' })
  const worker = agents.create({ channelId: channel.id, name: 'worker', harness: 'mock', role: 'worker' })
  return { db, engine, messages, channel, lead, worker, agents }
}

/** 拉取某 agent 未消费消息并解析 parts/metadata */
function pendingMessages(messages: ReturnType<typeof createMessageRepo>, agentId: string) {
  return messages.listPendingByAgent(agentId).map(row => ({
    row,
    parts: JSON.parse(row.partsJson) as Part[],
    metadata: JSON.parse(row.metadataJson) as Record<string, unknown>,
  }))
}

/** 断言抛 INVALID_TRANSITION(400) */
function expectInvalidTransition(name: string, fn: () => unknown): void {
  try {
    fn()
    check(name, false, '未抛出异常')
  }
  catch (e) {
    const err = e as AppError
    check(
      name,
      err instanceof AppError && err.code === 'INVALID_TRANSITION' && err.status === 400,
      `code=${err?.code} status=${err?.status}`,
    )
  }
}

function testCreateDispatch(): void {
  const { engine, lead, worker, channel } = setup()
  const parent = engine.create({
    channelId: channel.id,
    creatorId: lead.id,
    assigneeId: lead.id,
    title: '主任务',
    description: '统筹交付',
  })
  check('create 初始 SUBMITTED', parent.state === 'SUBMITTED', `state=${parent.state}`)
  check('create 落库可查', engine.get(parent.id)?.id === parent.id)

  const working = engine.transition(parent.id, 'WORKING', lead.id)
  check('create 后 WORKING 迁移', working.state === 'WORKING')

  const child = engine.dispatch(parent, {
    assigneeId: worker.id,
    title: '子任务1',
    description: '实现功能 A',
  })
  check('dispatch 子任务 ASSIGNED', child.state === 'ASSIGNED', `state=${child.state}`)
  check('dispatch 子任务 parentId', child.parentId === parent.id)
  check('dispatch 子任务 assignee', child.assigneeId === worker.id)
  check('dispatch 子任务 creator=父 assignee', child.creatorId === parent.assigneeId)
  check('dispatch 后父转 WAITING', engine.get(parent.id)?.state === 'WAITING')
}

function testDispatchAssignMessage(): void {
  const { engine, lead, worker, messages, channel } = setup()
  const parent = engine.create({
    channelId: channel.id,
    creatorId: lead.id,
    assigneeId: lead.id,
    title: '主任务',
  })
  engine.transition(parent.id, 'WORKING', lead.id)
  const child = engine.dispatch(parent, {
    assigneeId: worker.id,
    title: '子任务1',
    description: '实现功能 A',
  })

  const msgs = pendingMessages(messages, worker.id)
  check('dispatch 投递 1 条 assign 消息', msgs.length === 1, `count=${msgs.length}`)
  const m = msgs[0]
  check('assign 消息 title part', m.parts[0]?.text === '子任务1', JSON.stringify(m.parts))
  check('assign 消息 description part', m.parts[1]?.text === '实现功能 A')
  check('assign 消息 kind', m.metadata['x-aw-task-kind'] === 'assign')
  check('assign 消息 task-id = 子任务 id', m.metadata['x-aw-task-id'] === child.id)
  check('assign 消息投递对象', m.row.toAgentId === worker.id)
}

function testAllLegalTransitions(): void {
  const { engine, lead, worker, channel } = setup()
  // 每个迁移用独立任务,避免状态污染
  const cases: Array<{ from: WorkspaceTask['state'], to: WorkspaceTask['state'] }> = [
    { from: 'SUBMITTED', to: 'WORKING' },
    { from: 'SUBMITTED', to: 'ASSIGNED' },
    { from: 'SUBMITTED', to: 'CANCELED' },
    { from: 'ASSIGNED', to: 'WORKING' },
    { from: 'ASSIGNED', to: 'CANCELED' },
    { from: 'WORKING', to: 'WAITING' },
    { from: 'WORKING', to: 'COMPLETED' },
    { from: 'WORKING', to: 'FAILED' },
    { from: 'WORKING', to: 'CANCELED' },
    { from: 'WAITING', to: 'WORKING' },
    { from: 'WAITING', to: 'CANCELED' },
    { from: 'FAILED', to: 'ASSIGNED' },
  ]
  for (const { from, to } of cases) {
    const t = engine.create({
      channelId: channel.id,
      creatorId: lead.id,
      assigneeId: worker.id,
      title: `t-${from}-${to}`,
    })
    if (from === 'ASSIGNED') {
      engine.transition(t.id, 'ASSIGNED', lead.id)
    }
    else if (from === 'WORKING') {
      engine.transition(t.id, 'WORKING', worker.id)
    }
    else if (from === 'WAITING') {
      engine.transition(t.id, 'WORKING', worker.id)
      engine.transition(t.id, 'WAITING', lead.id)
    }
    else if (from === 'FAILED') {
      engine.transition(t.id, 'WORKING', worker.id)
      engine.transition(t.id, 'FAILED', worker.id)
    }
    const r = engine.transition(t.id, to, lead.id)
    check(`合法迁移 ${from}→${to}`, r.state === to, `got=${r.state}`)
  }
}

function testIllegalTransitions(): void {
  const { engine, lead, worker, channel } = setup()
  // COMPLETED → WORKING
  {
    const t = engine.create({ channelId: channel.id, creatorId: lead.id, assigneeId: worker.id, title: 'x' })
    engine.transition(t.id, 'WORKING', worker.id)
    engine.transition(t.id, 'COMPLETED', worker.id)
    expectInvalidTransition('COMPLETED→WORKING 拒绝', () => engine.transition(t.id, 'WORKING', lead.id))
  }
  // WORKING→COMPLETED 后再次 WORKING(终态不可迁)
  {
    const t = engine.create({ channelId: channel.id, creatorId: lead.id, assigneeId: worker.id, title: 'y' })
    engine.transition(t.id, 'WORKING', worker.id)
    engine.transition(t.id, 'COMPLETED', worker.id)
    expectInvalidTransition('COMPLETED(终态)→WORKING 拒绝', () => engine.transition(t.id, 'WORKING', lead.id))
  }
  // 终态 COMPLETED → FAILED / CANCELED
  {
    const t = engine.create({ channelId: channel.id, creatorId: lead.id, assigneeId: worker.id, title: 'z' })
    engine.transition(t.id, 'WORKING', worker.id)
    engine.transition(t.id, 'COMPLETED', worker.id)
    expectInvalidTransition('COMPLETED→FAILED 拒绝', () => engine.transition(t.id, 'FAILED', lead.id))
    expectInvalidTransition('COMPLETED→CANCELED 拒绝', () => engine.transition(t.id, 'CANCELED', lead.id))
  }
  // 非法: SUBMITTED → WAITING / FAILED
  {
    const t = engine.create({ channelId: channel.id, creatorId: lead.id, assigneeId: worker.id, title: 'w' })
    expectInvalidTransition('SUBMITTED→WAITING 拒绝', () => engine.transition(t.id, 'WAITING', lead.id))
    expectInvalidTransition('SUBMITTED→FAILED 拒绝', () => engine.transition(t.id, 'FAILED', lead.id))
  }
  // 非法: WORKING → ASSIGNED
  {
    const t = engine.create({ channelId: channel.id, creatorId: lead.id, assigneeId: worker.id, title: 'v' })
    engine.transition(t.id, 'WORKING', worker.id)
    expectInvalidTransition('WORKING→ASSIGNED 拒绝', () => engine.transition(t.id, 'ASSIGNED', lead.id))
  }
  // 非法: FAILED → WORKING(只能 FAILED→ASSIGNED)
  {
    const t = engine.create({ channelId: channel.id, creatorId: lead.id, assigneeId: worker.id, title: 'u' })
    engine.transition(t.id, 'WORKING', worker.id)
    engine.transition(t.id, 'FAILED', worker.id)
    expectInvalidTransition('FAILED→WORKING 拒绝', () => engine.transition(t.id, 'WORKING', lead.id))
  }
}

function testApplyEventArtifactChunking(): void {
  const { engine, lead, worker, channel } = setup()
  const t = engine.create({ channelId: channel.id, creatorId: lead.id, assigneeId: worker.id, title: '分块任务' })
  engine.transition(t.id, 'WORKING', worker.id)

  const mkArtifact = (text: string): A2AArtifact => ({
    artifactId: 'art-1',
    name: 'report',
    parts: [{ text }],
  })

  engine.applyEvent(t.id, { kind: 'artifact', artifact: mkArtifact('chunk-1'), append: true, totalChunks: 4 })
  let task = engine.get(t.id)!
  check('第 1 块 append 后 parts=1', task.artifacts[0].parts.length === 1)
  check('第 1 块 progress=25', task.progress === 25, `progress=${task.progress}`)

  engine.applyEvent(t.id, { kind: 'artifact', artifact: mkArtifact('chunk-2'), append: true, totalChunks: 4 })
  task = engine.get(t.id)!
  check('第 2 块 append 后 parts=2(同名合并)', task.artifacts[0].parts.length === 2)
  check('第 2 块 progress=50', task.progress === 50, `progress=${task.progress}`)
  check('同名 append 不新增 artifact', task.artifacts.length === 1)

  engine.applyEvent(t.id, { kind: 'artifact', artifact: mkArtifact('chunk-3'), append: true, totalChunks: 4 })
  engine.applyEvent(t.id, { kind: 'artifact', artifact: mkArtifact('chunk-4'), append: true, totalChunks: 4 })
  task = engine.get(t.id)!
  check('4 块收齐 parts=4', task.artifacts[0].parts.length === 4)
  check('4 块 progress=100', task.progress === 100, `progress=${task.progress}`)

  // 非 append 直接 push 新 artifact
  const other: A2AArtifact = { artifactId: 'art-2', name: 'notes', parts: [{ text: '总结' }] }
  engine.applyEvent(t.id, { kind: 'artifact', artifact: other })
  task = engine.get(t.id)!
  check('非 append 新增 artifact', task.artifacts.length === 2)
  check('非 append 不影响 progress', task.progress === 100, `progress=${task.progress}`)
}

function testComplete(): void {
  const { engine, lead, worker, channel } = setup()
  const t = engine.create({ channelId: channel.id, creatorId: lead.id, assigneeId: worker.id, title: '完成任务' })
  engine.transition(t.id, 'WORKING', worker.id)
  const done = engine.complete(t.id)
  check('complete 置 COMPLETED', done.state === 'COMPLETED', `state=${done.state}`)
  check('complete 进度 100', done.progress === 100, `progress=${done.progress}`)
}

function testReassign(): void {
  const { engine, lead, worker, messages, agents, channel } = setup()
  const other = agents.create({ channelId: channel.id, name: 'worker2', harness: 'mock', role: 'worker' })
  const t = engine.create({ channelId: channel.id, creatorId: lead.id, assigneeId: worker.id, title: '失败任务' })
  engine.transition(t.id, 'WORKING', worker.id)
  engine.transition(t.id, 'FAILED', worker.id)

  const r = engine.reassign(t.id, other.id)
  check('reassign 置 ASSIGNED', r.state === 'ASSIGNED', `state=${r.state}`)
  check('reassign 换 assignee', r.assigneeId === other.id)
  check('reassign retryCount+1', r.retryCount === 1, `retry=${r.retryCount}`)

  const msgs = pendingMessages(messages, other.id)
  check('reassign 投递 assign 消息', msgs.length === 1, `count=${msgs.length}`)
  check('reassign 消息 kind=assign', msgs[0]?.metadata['x-aw-task-kind'] === 'assign')
  check('reassign 消息 task-id', msgs[0]?.metadata['x-aw-task-id'] === t.id)
}

function testCancel(): void {
  const { engine, lead, worker, messages, channel } = setup()
  const t = engine.create({ channelId: channel.id, creatorId: lead.id, assigneeId: worker.id, title: '取消任务' })
  engine.transition(t.id, 'WORKING', worker.id)

  const c = engine.cancel(t.id, lead.id)
  check('cancel 置 CANCELED', c.state === 'CANCELED', `state=${c.state}`)

  const msgs = pendingMessages(messages, worker.id)
  check('cancel 投递 cancel 消息', msgs.length === 1, `count=${msgs.length}`)
  check('cancel 消息 kind=cancel', msgs[0]?.metadata['x-aw-task-kind'] === 'cancel')
  check('cancel 消息 task-id', msgs[0]?.metadata['x-aw-task-id'] === t.id)
}

function testOnChildCompleted(): void {
  const { engine, lead, worker, messages, channel } = setup()
  const parent = engine.create({ channelId: channel.id, creatorId: lead.id, assigneeId: lead.id, title: '主任务' })
  engine.transition(parent.id, 'WORKING', lead.id)

  const child1 = engine.dispatch(parent, { assigneeId: worker.id, title: '子任务1' })
  const child2 = engine.dispatch(parent, { assigneeId: worker.id, title: '子任务2' })
  check('两个子任务后父保持 WAITING', engine.get(parent.id)?.state === 'WAITING')

  // 完成子任务 1(ASSIGNED → WORKING → COMPLETED)
  engine.transition(child1.id, 'WORKING', worker.id)
  const done1 = engine.complete(child1.id)
  engine.onChildCompleted(done1)
  check('子任务 1 完成后父仍 WAITING', engine.get(parent.id)?.state === 'WAITING')

  // 完成子任务 2(最后一个)
  engine.transition(child2.id, 'WORKING', worker.id)
  const done2 = engine.complete(child2.id)
  engine.onChildCompleted(done2)
  check('最后一个子任务完成后父恢复 WORKING', engine.get(parent.id)?.state === 'WORKING')

  // child-completed 消息:metadata 断言(x-aw-task-id=父 id,x-aw-child-task-id=子 id)
  const leadMsgs = pendingMessages(messages, lead.id)
  check('投递 2 条 child-completed 消息', leadMsgs.length === 2, `count=${leadMsgs.length}`)
  const last = leadMsgs[leadMsgs.length - 1]
  check('child-completed kind', last?.metadata['x-aw-task-kind'] === 'child-completed')
  check('child-completed x-aw-task-id=父 id', last?.metadata['x-aw-task-id'] === parent.id)
  check('child-completed x-aw-child-task-id=子2 id', last?.metadata['x-aw-child-task-id'] === child2.id)
}

function main(): void {
  testCreateDispatch()
  testDispatchAssignMessage()
  testAllLegalTransitions()
  testIllegalTransitions()
  testApplyEventArtifactChunking()
  testComplete()
  testReassign()
  testCancel()
  testOnChildCompleted()

  console.log('')
  if (failures === 0) {
    console.log('ALL PASS')
    process.exit(0)
  }
  else {
    console.log(`${failures} FAILED`)
    process.exit(1)
  }
}

main()
