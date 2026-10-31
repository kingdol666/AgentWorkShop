/**
 * TaskEngine Goal 生命周期回归(整改计划阶段0/1 安全网,docs/plans 2026-10-30 v2):
 *   - Goal 无真实交付不得 COMPLETED(此前平台合成 goal-summary 自证过闸)
 *   - goal-summary(含平台合成)不作为唯一证据
 *   - completionPolicy=no-deliverable 显式声明时允许无交付收口
 *   - FAILED/CANCELED 子任务经 supersede(显式替代关系)后父 Goal 可收口
 *   - 无替代的失败/取消分支不可收口;superseded 关系落库可查
 * 直测 TaskEngineLifecycle(in-memory 库),覆盖 REST/MCP/Agent 工具/调度器五路完成汇合点。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { TaskEngine } from '../server/services/workshop/runtime/task-engine'
import { synthesizeGoalSummary } from '../server/services/workshop/runtime/execution-mode'
import type { A2AArtifact } from '../server/services/workshop/types/a2a'

function harness() {
  const db = openWorkshopDb(':memory:')
  const now = new Date().toISOString()
  db.prepare('INSERT INTO channels (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('ch-1', 'goal 生命周期测试频道', now, now)
  const repos = { tasks: createTaskRepo(db), messages: createMessageRepo(db) }
  const engine = new TaskEngine(repos, { onTaskChange: () => {} })
  return { engine, repos }
}

const evidence = (text: string): A2AArtifact[] => [{ artifactId: randomUUID(), name: 'report', parts: [{ text }] }]

function makeGoal(engine: InstanceType<typeof TaskEngine>, opts: { policy?: string } = {}) {
  const policy = opts.policy ? ` [policy:${opts.policy}]` : ''
  return engine.create({
    channelId: 'ch-1',
    creatorId: 'user-1',
    assigneeId: 'lead-1',
    title: `目标 ${randomUUID().slice(0, 6)}`,
    description: `[mode:goal] 多步目标 [criteria:全部完成]${policy}`,
  })
}

function makeChild(engine: InstanceType<typeof TaskEngine>, parent: { id: string }, title: string) {
  engine.transition(parent.id, 'WORKING', 'user-1')
  return engine.create({
    channelId: 'ch-1',
    creatorId: 'lead-1',
    assigneeId: 'worker-1',
    parentId: parent.id,
    title,
  })
}

const childDone = (engine: InstanceType<typeof TaskEngine>, parent: { id: string }, title: string, text = '子任务交付:结论与数据') => {
  const c = makeChild(engine, parent, title)
  engine.complete(c.id, evidence(text))
  return c
}

const childFailed = (engine: InstanceType<typeof TaskEngine>, parent: { id: string }, title: string) => {
  const c = makeChild(engine, parent, title)
  engine.transition(c.id, 'WORKING', 'system')
  engine.transition(c.id, 'FAILED', 'system')
  return c
}

const childCanceled = (engine: InstanceType<typeof TaskEngine>, parent: { id: string }, title: string) => {
  const c = makeChild(engine, parent, title)
  engine.cancel(c.id, 'lead-1', 'LEAD_CANCEL')
  return c
}

test('goal 无任何交付不得完成(假完成回归闸)', () => {
  const { engine } = harness()
  const g = makeGoal(engine)
  assert.throws(() => engine.complete(g.id), (err: { code?: string, message?: string }) =>
    err?.code === 'TASK_DELIVERABLE_REQUIRED' || /证据|deliverable/i.test(err?.message ?? ''))
})

test('平台合成的 goal-summary 不能作为唯一交付过闸(自证防堵)', () => {
  const { engine } = harness()
  const g = makeGoal(engine)
  const synthetic = synthesizeGoalSummary(g, [], '全部完成')
  assert.throws(() => engine.complete(g.id, [synthetic]), (err: { code?: string, message?: string }) =>
    err?.code === 'TASK_DELIVERABLE_REQUIRED' || /证据|deliverable/i.test(err?.message ?? ''))
})

test('goal 显式声明 no-deliverable 策略时可无交付收口', () => {
  const { engine } = harness()
  const g = makeGoal(engine, { policy: 'no-deliverable' })
  const done = engine.complete(g.id)
  assert.equal(done.state, 'COMPLETED')
})

test('有真实交付的 goal 正常完成(防过度收紧)', () => {
  const { engine } = harness()
  const g = makeGoal(engine)
  const done = engine.complete(g.id, evidence('真实成果:目标达成,附数据'))
  assert.equal(done.state, 'COMPLETED')
})

test('FAILED 子任务被 supersede 后父 Goal 可收口', () => {
  const { engine } = harness()
  const g = makeGoal(engine)
  childDone(engine, g, '成功子任务 A')
  const bad = childFailed(engine, g, '失败子任务 B')
  const replacement = childDone(engine, g, '替代子任务 B2')
  engine.supersede(bad.id, replacement.id, 'lead-1', 'B 失败,B2 已重新完成同一工作')
  const done = engine.complete(g.id, evidence('Lead 验收:A 与 B2 交付满足判定标准'))
  assert.equal(done.state, 'COMPLETED')
})

test('FAILED 子任务无替代时父 Goal 不可收口', () => {
  const { engine } = harness()
  const g = makeGoal(engine)
  const bad = childFailed(engine, g, '失败子任务')
  assert.throws(() => engine.complete(g.id, evidence('试图收口')), (err: { code?: string, message?: string }) =>
    err?.code === 'INVALID_STATE' || /未.*处置|替代|失败/.test(err?.message ?? ''))
  // 补上替代后同一父任务可收口(错误可恢复,不是死局)
  const replacement = childDone(engine, g, '替代子任务')
  engine.supersede(bad.id, replacement.id, 'lead-1')
  const done = engine.complete(g.id, evidence('验收通过'))
  assert.equal(done.state, 'COMPLETED')
})

test('CANCELED 子任务经 supersede 后父 Goal 可收口(取消分支出口)', () => {
  const { engine } = harness()
  const g = makeGoal(engine)
  childDone(engine, g, '成功子任务')
  const canceled = childCanceled(engine, g, '取消子任务')
  const replacement = childDone(engine, g, '替代子任务')
  engine.supersede(canceled.id, replacement.id, 'lead-1')
  const done = engine.complete(g.id, evidence('验收通过'))
  assert.equal(done.state, 'COMPLETED')
})

test('superseded 关系落库可查且指向替代任务', () => {
  const { engine, repos } = harness()
  const g = makeGoal(engine)
  const bad = childFailed(engine, g, '失败子任务')
  const replacement = childDone(engine, g, '替代子任务')
  engine.supersede(bad.id, replacement.id, 'lead-1')
  const row = repos.tasks.findById(bad.id)
  assert.equal(row?.supersededByTaskId, replacement.id)
})

test('supersede 校验:替代任务必须存在且同属一个父任务', () => {
  const { engine } = harness()
  const g1 = makeGoal(engine)
  const g2 = makeGoal(engine)
  const bad = childFailed(engine, g1, '失败子任务')
  const other = childDone(engine, g2, '别的父任务的子任务')
  assert.throws(() => engine.supersede(bad.id, randomUUID(), 'lead-1'))
  assert.throws(() => engine.supersede(bad.id, other.id, 'lead-1'))
})
