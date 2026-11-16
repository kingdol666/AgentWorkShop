import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentInfo, AgentInterface } from '../server/services/workshop/agents/agent-interface'
import type { A2AMessage } from '../server/services/workshop/types/a2a'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-legacy-hold-'))

const { initWorkshopDb } = await import('../server/services/workshop/db/database/open')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createMessageRepo } = await import('../server/services/workshop/db/message.repo')
const { TaskEngine } = await import('../server/services/workshop/runtime/task-engine/facade')
const { AgentRuntime } = await import('../server/services/workshop/runtime/agent-runtime/facade')
const { Mailbox } = await import('../server/services/workshop/runtime/mailbox')
const { ManagerSchedules } = await import('../server/services/workshop/runtime/manager/schedules')
const { ManagerTasks } = await import('../server/services/workshop/runtime/manager/tasks')
const { isRecoveryBlockedMessage } = await import('../server/services/workshop/db/message.repo')
const { projectHasLegacyRecoveryHold } = await import('../server/services/workshop/projects/legacy-recovery')
const { LEGACY_RECOVERY_MARKER, holdLegacyActiveTasks } = await import('../server/services/workshop/runtime/task-engine/legacy-recovery')

function insertTask(db: DatabaseSync, id: string, state: string, lease: string | null, parent: string | null = null): void {
  db.prepare(`INSERT INTO tasks(id, channel_id, parent_id, root_queue_seq, assignee_id, title, state, progress, close_reason, execution_lease_id, execution_lease_agent_id, created_at, updated_at)
    VALUES (?, 'ch', ?, ?, 'worker', ?, ?, 42, 'previous reason', ?, ?, '2026-01-01', '2026-01-01')`)
    .run(id, parent, parent ? null : Number(id.replace(/\D/g, '')) || 1, id, state, lease, lease ? 'worker' : null)
}

function insertMessage(db: DatabaseSync, id: string, taskId: string | null, state: string, metadata: object): void {
  db.prepare(`INSERT INTO messages(id, channel_id, task_id, to_agent_id, role, parts_json, metadata_json, state, created_at)
    VALUES (?, 'ch', ?, 'worker', 'ROLE_USER', '[]', ?, ?, '2026-01-01')`).run(id, taskId, JSON.stringify(metadata), state)
}

test('cross-channel project hold and unrelated FIFO predecessor block project work', async () => {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  insertTask(db, 'held1', 'WORKING', null)
  insertTask(db, 'project2', 'WORKING', 'lease-2')
  insertTask(db, 'other3', 'WORKING', 'lease-3')
  insertTask(db, 'earlier4', 'WORKING', 'lease-4')
  db.prepare('UPDATE tasks SET channel_id = ?, project_id = ?, source = ? WHERE id = ?').run('project-channel', 'project', 'project', 'project2')
  db.prepare('UPDATE tasks SET project_id = ?, source = ? WHERE id = ?').run('project', 'project', 'held1')
  db.prepare('UPDATE tasks SET channel_id = ? WHERE id = ?').run('third-channel', 'other3')
  db.prepare('UPDATE tasks SET root_queue_seq = 0 WHERE id = ?').run('earlier4')
  holdLegacyActiveTasks(db)
  const tasks = createTaskRepo(db)
  const messages = createMessageRepo(db)
  const engine = new TaskEngine({ tasks, messages })
  assert.equal(projectHasLegacyRecoveryHold(db, 'project'), true)
  assert.equal(engine.isLegacyRecoveryBlocked('project2'), true)
  assert.equal(engine.isLegacyRecoveryBlocked('other3'), false)
  assert.equal(engine.isLegacyRecoveryBlocked('earlier4'), false)
  assert.equal(engine.assertAssignmentFence('project2', { generation: 0, leaseId: 'lease-2' }), false)
  assert.throws(() => engine.redeliverAssign('project2'), /requires operator investigation/)
  let redeliveries = 0
  await ManagerSchedules.prototype.restore.call({
    deps: { repos: { tasks, messages, channels: { findById: () => undefined } } },
    runGroupChatMaintenance() {}, recoverPendingChatDeliveries() {}, wakeAgent() {},
    getTaskEngine: () => ({ isLegacyRecoveryBlocked: (id: string) => engine.isLegacyRecoveryBlocked(id), redeliverAssign: () => { redeliveries++ } }),
  } as never)
  assert.equal(redeliveries, 2)
  db.prepare('UPDATE tasks SET project_id = NULL WHERE id = ?').run('held1')
  db.prepare('UPDATE tasks SET channel_id = ?, root_queue_seq = 2 WHERE id = ?').run('ch', 'project2')
  assert.equal(projectHasLegacyRecoveryHold(db, 'project'), true)
  db.prepare('UPDATE tasks SET root_queue_seq = -1 WHERE id = ?').run('project2')
  assert.equal(projectHasLegacyRecoveryHold(db, 'project'), false)
  db.close()
})

test('project hold is revalidated before and during supervision and after message recall', async () => {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  insertTask(db, 'held1', 'WORKING', 'held-lease')
  insertTask(db, 'project2', 'WORKING', 'lease-2')
  db.prepare('UPDATE tasks SET channel_id = ?, project_id = ? WHERE id = ?').run('project-channel', 'project', 'project2')
  db.prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run('project', 'held1')
  const tasks = createTaskRepo(db)
  const messages = createMessageRepo(db)
  const engine = new TaskEngine({ tasks, messages })
  let supervisionCalls = 0
  class Runtime extends AgentRuntime {
    override refreshStatus(): void {}
    protected override queueContext(): never { return {} as never }
    async processForTest(msg: A2AMessage, token: string): Promise<void> { await this.processMessage(msg, token) }
  }
  const snapshot = { tick: 1, now: Date.now(), activeRootId: 'project2', queuedRootIds: [], tasks: [engine.get('project2')!], members: [], pendingChildren: {}, mail: [] }
  const markHold = () => db.prepare('UPDATE tasks SET close_reason = ? WHERE id = ?').run(LEGACY_RECOVERY_MARKER, 'held1')
  const clearHold = () => db.prepare('UPDATE tasks SET close_reason = ? WHERE id = ?').run('previous reason', 'held1')
  const supervisor = new Runtime(
    { id: 'worker', channelId: 'project-channel', name: 'Lead', role: 'lead', harness: 'mock' } as AgentInfo,
    { async supervise(_snapshot: unknown, ctx: import('../server/services/workshop/agents/agent-interface').AgentRunContext) {
      supervisionCalls++
      ctx.executionScope!.assertActive()
      markHold()
      assert.throws(() => ctx.executionScope!.assertActive(), /stale/)
      return []
    } } as unknown as AgentInterface,
    { mailbox: {} as never, taskEngine: engine as never, bus: {} as never, workspace: {} as never },
  )
  assert.equal(await supervisor.supervise(snapshot), null)
  assert.equal(supervisionCalls, 1)
  assert.equal(await supervisor.supervise(snapshot), null)
  assert.equal(supervisionCalls, 1)
  clearHold()
  const blocked = (row: Parameters<typeof isRecoveryBlockedMessage>[0]) => isRecoveryBlockedMessage(row, id => engine.isLegacyRecoveryBlocked(id))
  const mailbox = new Mailbox(messages, 'project-channel', 'worker', () => {}, blocked)
  const recallStarted = Promise.withResolvers<undefined>()
  const recallResult = Promise.withResolvers<string | undefined>()
  let runs = 0
  const runtime = new Runtime(
    { id: 'worker', channelId: 'project-channel', name: 'Worker', role: 'worker', harness: 'mock' } as AgentInfo,
    { async* run() {
      runs++
      yield { kind: 'done' }
    } } as unknown as AgentInterface,
    { mailbox, taskEngine: engine as never, bus: { notifyAgent() {} } as never, workspace: {} as never,
      memory: { recall: () => {
        recallStarted.resolve(undefined)
        return recallResult.promise
      } } as never },
  )
  const msg: A2AMessage = { messageId: 'assign-project', contextId: 'project-channel', taskId: 'project2', role: 'ROLE_USER', parts: [], metadata: { 'x-aw-task-kind': 'assign', 'x-aw-task-id': 'project2', 'x-aw-assignment-generation': 0, 'x-aw-execution-lease-id': 'lease-2' } }
  mailbox.enqueue(msg)
  const delivery = (await mailbox.dequeue())!
  const token = mailbox.claimToken(delivery)!
  assert.equal(mailbox.beginProcessing(delivery.messageId, token), true)
  const processing = runtime.processForTest(delivery, token)
  await recallStarted.promise
  markHold()
  recallResult.resolve(undefined)
  await processing
  assert.equal(runs, 0)
  const retained = db.prepare('SELECT state, attempts FROM messages WHERE id = ?').get('assign-project')
  assert.equal(retained?.state, 'pending')
  assert.equal(retained?.attempts, 0)
  db.close()
})

test('FIFO-blocked updates, completions and reports retain task and message evidence', async () => {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  insertTask(db, 'held1', 'WORKING', null)
  insertTask(db, 'queued2', 'ASSIGNED', 'lease-2')
  insertTask(db, 'working3', 'WORKING', 'lease-3')
  insertMessage(db, 'evidence', 'queued2', 'pending', { 'x-aw-task-kind': 'assign' })
  db.prepare('UPDATE tasks SET close_reason = ? WHERE id = ?').run(LEGACY_RECOVERY_MARKER, 'held1')
  const tasks = createTaskRepo(db)
  const engine = new TaskEngine({ tasks, messages: createMessageRepo(db) })
  const beforeTasks = db.prepare('SELECT * FROM tasks ORDER BY id').all()
  const beforeMessages = db.prepare('SELECT * FROM messages ORDER BY id').all()
  assert.throws(() => engine.updateTask('queued2', { title: 'changed' }, 'worker'), /requires operator investigation/)
  assert.throws(() => engine.complete('working3', [{ artifactId: 'a', name: 'output', parts: [{ text: 'result' }] }]), /requires operator investigation/)
  const manager = { requireTaskInScope: (_channel: string, _agent: string, id: string) => engine.get(id), getTaskEngine: () => engine, deps: { repos: { tasks } }, notifyTask() {} }
  await assert.rejects(ManagerTasks.prototype.reportTask.call(manager as never, 'ch', 'worker', { taskId: 'working3', progress: 100, message: 'late' }), /requires operator investigation/)
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), beforeTasks)
  assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY id').all(), beforeMessages)
  db.close()
})

test('ambiguous linked metadata stays pending without retries while explicit chat passes', () => {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  insertTask(db, 'held1', 'WORKING', null)
  insertTask(db, 'queued2', 'WORKING', 'lease-2')
  db.prepare('UPDATE tasks SET close_reason = ? WHERE id = ?').run(LEGACY_RECOVERY_MARKER, 'held1')
  const engine = new TaskEngine({ tasks: createTaskRepo(db), messages: createMessageRepo(db) })
  const messages = createMessageRepo(db)
  for (const [id, metadata] of [['broken', '{'], ['null', 'null'], ['array', '[]'], ['string', '"chat"'], ['chat', '{"x-aw-from-label":"user"}']] as const) {
    insertMessage(db, id, 'queued2', 'pending', {})
    db.prepare('UPDATE messages SET metadata_json = ?, attempts = 2 WHERE id = ?').run(metadata, id)
  }
  const blocked = (row: Parameters<typeof isRecoveryBlockedMessage>[0]) => isRecoveryBlockedMessage(row, id => engine.isLegacyRecoveryBlocked(id))
  assert.deepEqual(messages.listPendingByChannelAgent('ch', 'worker', undefined, blocked).map(row => row.id), ['chat'])
  for (const id of ['broken', 'null', 'array', 'string']) assert.equal(messages.claim(id, blocked), null)
  assert.deepEqual(db.prepare('SELECT id, state, attempts FROM messages WHERE id <> ? ORDER BY id').all('chat').map(row => [row.id, row.state, row.attempts]), [
    ['array', 'pending', 2], ['broken', 'pending', 2], ['null', 'pending', 2], ['string', 'pending', 2],
  ])
  db.close()
})

test('malformed linked claim is retained when a FIFO hold appears after processing begins', async () => {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  insertTask(db, 'held1', 'WORKING', 'held-lease')
  insertTask(db, 'queued2', 'WORKING', 'lease-2')
  insertMessage(db, 'malformed-claim', 'queued2', 'pending', {})
  db.prepare('UPDATE messages SET metadata_json = ?, attempts = 2 WHERE id = ?').run('{', 'malformed-claim')
  const messages = createMessageRepo(db)
  const engine = new TaskEngine({ tasks: createTaskRepo(db), messages })
  const mailbox = new Mailbox(messages, 'ch', 'worker', () => {}, row => isRecoveryBlockedMessage(row, id => engine.isLegacyRecoveryBlocked(id)))
  class Runtime extends AgentRuntime {
    async processForTest(msg: A2AMessage, token: string): Promise<void> { await this.processMessage(msg, token) }
  }
  let runs = 0
  const runtime = new Runtime(
    { id: 'worker', channelId: 'ch', name: 'Worker', role: 'worker', harness: 'mock' } as AgentInfo,
    { async* run() {
      runs++
      yield { kind: 'done' }
    } } as unknown as AgentInterface,
    { mailbox, taskEngine: engine as never, bus: {} as never, workspace: {} as never },
  )
  const delivery = (await mailbox.dequeue())!
  const token = mailbox.claimToken(delivery)!
  assert.equal(mailbox.beginProcessing(delivery.messageId, token), true)
  db.prepare('UPDATE tasks SET close_reason = ? WHERE id = ?').run(LEGACY_RECOVERY_MARKER, 'held1')
  await runtime.processForTest(delivery, token)
  const row = db.prepare('SELECT state, attempts, metadata_json FROM messages WHERE id = ?').get('malformed-claim')
  assert.equal(runs, 0)
  assert.equal(row?.state, 'pending')
  assert.equal(row?.attempts, 2)
  assert.equal(row?.metadata_json, '{')
  db.close()
})

test('restore does not redeliver an assignment claimed while activating a channel', async () => {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  insertTask(db, 'task1', 'WORKING', 'lease')
  insertMessage(db, 'assignment', 'task1', 'pending', { 'x-aw-task-kind': 'assign', 'x-aw-task-id': 'task1', 'x-aw-assignment-generation': 0, 'x-aw-execution-lease-id': 'lease' })
  const tasks = createTaskRepo(db)
  const messages = createMessageRepo(db)
  const engine = new TaskEngine({ tasks, messages })
  let token: string | null = null
  await ManagerSchedules.prototype.restore.call({
    deps: { repos: { tasks, messages, channels: { findById: () => ({ enabled: 1, leadAgentId: 'worker' }) } } },
    runGroupChatMaintenance() {}, recoverPendingChatDeliveries() {}, wakeAgent() {}, runtimeOf: () => null,
    ensureChannelActive: () => { token = messages.claim('assignment') }, getTaskEngine: () => engine,
  } as never)
  assert.ok(token)
  assert.equal(messages.ownsClaim('assignment', token!), true)
  assert.deepEqual(db.prepare('SELECT id, state, attempts FROM messages').all().map(row => [row.id, row.state, row.attempts]), [['assignment', 'consuming', 0]])
  db.close()
})

test('old database active tasks are durably held without replay; leased and terminal tasks are unchanged', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'aw-legacy-db-')), 'workshop.sqlite')
  let db = new DatabaseSync(path)
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  insertTask(db, 't1', 'SUBMITTED', null)
  insertTask(db, 't2', 'ASSIGNED', null)
  insertTask(db, 't3', 'WORKING', null)
  insertTask(db, 't4', 'WAITING', null)
  insertTask(db, 't5', 'COMPLETED', null)
  insertMessage(db, 'pending', 't2', 'pending', { 'x-aw-task-kind': 'assign' })
  insertMessage(db, 'claimed', 't3', 'consuming', { 'x-aw-task-kind': 'assign' })
  insertMessage(db, 'metadata', null, 'pending', { 'x-aw-task-id': 't4', 'x-aw-task-kind': 'child-completed' })
  db.exec('ALTER TABLE tasks DROP COLUMN execution_lease_id; ALTER TABLE tasks DROP COLUMN execution_lease_agent_id; ALTER TABLE tasks DROP COLUMN execution_lease_started_at; ALTER TABLE tasks DROP COLUMN execution_lease_revoked_at; ALTER TABLE tasks DROP COLUMN assignment_generation')
  db.close()

  db = new DatabaseSync(path)
  initWorkshopDb(db)
  const tasks = createTaskRepo(db)
  const engine = new TaskEngine({ tasks, messages: createMessageRepo(db) })
  for (const [id, state] of [['t1', 'SUBMITTED'], ['t2', 'ASSIGNED'], ['t3', 'WORKING'], ['t4', 'WAITING']] as const) {
    const task = engine.get(id)!
    assert.equal(task.state, state)
    assert.equal(task.progress, 42)
    assert.equal(task.closeReason, `previous reason ${LEGACY_RECOVERY_MARKER}`)
    assert.equal(task.executionLeaseId, undefined)
    assert.equal(engine.assertAssignmentFence(id), false)
  }
  assert.equal(engine.get('t5')!.closeReason, 'previous reason')
  assert.deepEqual(db.prepare('SELECT state FROM messages ORDER BY id').all().map(row => row.state), ['dead', 'dead', 'dead'])
  const before = db.prepare('SELECT id, state, close_reason, updated_at FROM tasks ORDER BY id').all()
  initWorkshopDb(db)
  assert.deepEqual(db.prepare('SELECT id, state, close_reason, updated_at FROM tasks ORDER BY id').all(), before)
  db.exec('PRAGMA foreign_keys = OFF')
  insertTask(db, 't6', 'WORKING', 'valid-lease')
  insertMessage(db, 'leased', 't6', 'pending', { 'x-aw-task-kind': 'assign', 'x-aw-task-id': 't6', 'x-aw-assignment-generation': 0, 'x-aw-execution-lease-id': 'valid-lease' })
  holdLegacyActiveTasks(db)
  assert.equal(engine.get('t6')!.closeReason, 'previous reason')
  assert.equal(engine.get('t6')!.executionLeaseId, 'valid-lease')
  assert.equal(db.prepare('SELECT state FROM messages WHERE id = ?').get('leased')?.state, 'pending')
  assert.equal(engine.assertAssignmentFence('t6', { generation: 0, leaseId: 'valid-lease' }), false)
  db.close()
})

test('held tasks cannot be redelivered, reassigned, dispatched, completed, or altered by events', () => {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  insertTask(db, 't1', 'WORKING', null)
  holdLegacyActiveTasks(db)
  const engine = new TaskEngine({ tasks: createTaskRepo(db), messages: createMessageRepo(db) })
  const before = engine.get('t1')!
  for (const action of [
    () => engine.redeliverAssign('t1'),
    () => engine.reassignRunning('t1', 'other', 'lead'),
    () => engine.complete('t1', [{ artifactId: 'fake', name: 'output', parts: [{ text: 'fake' }] }]),
    () => engine.dispatch(before, { assigneeId: 'other', title: 'child' }),
    () => engine.transition('t1', 'FAILED', 'lead'),
    () => engine.cancel('t1', 'lead'),
    () => engine.refreshDeadline('t1', '2030-01-01'),
    () => engine.create({ channelId: 'ch', creatorId: 'lead', assigneeId: 'worker', title: 'child', parentId: 't1' }),
  ]) assert.throws(action, /requires operator investigation/)
  engine.applyEvent('t1', { kind: 'artifact', artifact: { artifactId: 'late', name: 'output', parts: [{ text: 'late' }] } })
  assert.deepEqual(engine.timeoutTree('t1', 'lead'), [])
  assert.deepEqual(engine.get('t1'), before)
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get()?.n, 0)
  db.close()
})

test('root creation rejects a held channel before side effects while other channels retain idempotency', () => {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  const tasks = createTaskRepo(db)
  let changes = 0
  const engine = new TaskEngine({ tasks, messages: createMessageRepo(db) }, { onTaskChange: () => {
    changes++
  } })
  const input = { channelId: 'ch', creatorId: 'lead', assigneeId: 'worker', title: 'root', sourceChatMessageId: 'source' }
  const earlier = engine.createOrGetRoot(input)
  assert.equal(earlier.created, true)
  assert.equal(engine.createOrGetRoot(input).task.id, earlier.task.id)
  insertTask(db, 'held2', 'WORKING', null)
  holdLegacyActiveTasks(db)
  const before = db.prepare('SELECT * FROM tasks ORDER BY id').all()
  const messageCount = db.prepare('SELECT count(*) AS n FROM messages').get()?.n
  const changeCount = changes
  for (const action of [
    () => engine.create({ ...input, title: 'new root' }),
    () => engine.createOrGetRoot({ ...input, sourceChatMessageId: 'new-source' }),
    () => engine.createOrGetRoot(input),
  ]) {
    assert.throws(action, (error: unknown) => (error as { status?: number, code?: string }).status === 409
      && (error as { code?: string }).code === 'LEGACY_EXECUTION_RECOVERY_REQUIRED')
  }
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), before)
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get()?.n, messageCount)
  assert.equal(changes, changeCount)
  assert.equal(engine.isLegacyRecoveryBlocked(earlier.task.id), false)
  const other = { ...input, channelId: 'other-channel' }
  const created = engine.createOrGetRoot(other)
  const repeated = engine.createOrGetRoot(other)
  assert.equal(created.created, true)
  assert.equal(repeated.created, false)
  assert.equal(repeated.task.id, created.task.id)
  assert.equal(engine.create({ ...other, title: 'another root', sourceChatMessageId: 'another-source' }).channelId, 'other-channel')
  db.close()
})

test('mixed leases hold entire trees, quarantine task messages only, and block later roots', () => {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  insertTask(db, 'root1', 'WORKING', 'root-lease')
  insertTask(db, 'child1', 'ASSIGNED', 'child-lease', 'root1')
  insertTask(db, 'child2', 'COMPLETED', null, 'root1')
  insertTask(db, 'root2', 'WORKING', 'other-lease')
  insertTask(db, 'root3', 'WORKING', 'safe-lease')
  insertTask(db, 'root9', 'WORKING', 'earlier-lease')
  insertTask(db, 'independent4', 'WORKING', 'independent-lease')
  db.prepare('UPDATE tasks SET channel_id = ? WHERE id = ?').run('other-channel', 'independent4')
  db.prepare('UPDATE tasks SET root_queue_seq = ? WHERE id = ?').run(0, 'root9')
  db.prepare('UPDATE tasks SET root_queue_seq = ? WHERE id = ?').run(1, 'root1')
  db.prepare('UPDATE tasks SET root_queue_seq = ? WHERE id = ?').run(2, 'root2')
  db.prepare('UPDATE tasks SET root_queue_seq = ? WHERE id = ?').run(3, 'root3')
  insertMessage(db, 'bad-assign', 'child1', 'consuming', { 'x-aw-task-kind': 'assign' })
  insertMessage(db, 'tree-guide', 'child2', 'pending', { 'x-aw-task-kind': 'guide' })
  insertMessage(db, 'child-notice', null, 'pending', { 'x-aw-task-kind': 'child-completed', 'x-aw-task-id': 'root2', 'x-aw-child-task-id': 'child1' })
  insertMessage(db, 'chat', 'child1', 'pending', { 'x-aw-from-label': 'user' })
  insertMessage(db, 'other', 'root3', 'pending', { 'x-aw-task-kind': 'assign', 'x-aw-task-id': 'root3', 'x-aw-assignment-generation': 0, 'x-aw-execution-lease-id': 'safe-lease' })
  holdLegacyActiveTasks(db)
  const engine = new TaskEngine({ tasks: createTaskRepo(db), messages: createMessageRepo(db) })
  for (const id of ['root1', 'child1', 'child2']) assert.match(engine.get(id)!.closeReason!, /LEGACY_EXECUTION_RECOVERY_REQUIRED/)
  for (const id of ['root9', 'root2', 'root3', 'independent4']) assert.equal(engine.get(id)!.closeReason, 'previous reason')
  assert.equal(engine.assertAssignmentFence('root9', { generation: 0, leaseId: 'earlier-lease' }), true)
  assert.equal(engine.assertAssignmentFence('independent4', { generation: 0, leaseId: 'independent-lease' }), true)
  assert.equal(engine.hasLegacyRecoveryHold('other-channel'), false)
  assert.equal(engine.hasLegacyRecoveryHold('ch'), true)
  assert.equal(engine.isLegacyRecoveryBlocked('child2'), true)
  assert.equal(engine.isLegacyRecoveryBlocked('root2'), true)
  assert.equal(engine.isLegacyRecoveryBlocked('root3'), true)
  assert.throws(() => engine.redeliverAssign('root2'), /requires operator investigation/)
  assert.throws(() => engine.transition('root2', 'WORKING', 'worker'), /requires operator investigation/)
  assert.throws(() => engine.reassignRunning('root2', 'other', 'lead'), /requires operator investigation/)
  assert.deepEqual(engine.timeoutTree('root2', 'lead'), [])
  engine.applyEvent('root2', { kind: 'artifact', artifact: { artifactId: 'late', name: 'late', parts: [{ text: 'late' }] } })
  assert.deepEqual(engine.get('root2')!.artifacts, [])
  assert.deepEqual(Object.fromEntries(db.prepare('SELECT id, state FROM messages').all().map(row => [row.id, row.state])), {
    'bad-assign': 'dead', 'tree-guide': 'dead', 'child-notice': 'dead', 'chat': 'pending', 'other': 'pending',
  })
  const before = db.prepare('SELECT * FROM tasks ORDER BY id').all()
  holdLegacyActiveTasks(db)
  assert.deepEqual(db.prepare('SELECT * FROM tasks ORDER BY id').all(), before)
  db.close()
})

test('assignment mismatches hold active leased tasks while matching assignments remain untouched', () => {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  for (const [index, id] of ['missing', 'generation', 'lease', 'recipient', 'matching'].entries()) {
    insertTask(db, `${id}${index + 1}`, 'ASSIGNED', `${id}-lease`)
  }
  const meta = (id: string, lease: string) => ({ 'x-aw-task-kind': 'assign', 'x-aw-task-id': id, 'x-aw-assignment-generation': 0, 'x-aw-execution-lease-id': lease })
  insertMessage(db, 'missing-msg', 'missing1', 'pending', { 'x-aw-task-kind': 'assign' })
  insertMessage(db, 'generation-msg', 'generation2', 'pending', { ...meta('generation2', 'generation-lease'), 'x-aw-assignment-generation': 1 })
  insertMessage(db, 'lease-msg', 'lease3', 'consuming', { ...meta('lease3', 'lease-lease'), 'x-aw-execution-lease-id': 'old' })
  insertMessage(db, 'recipient-msg', 'recipient4', 'pending', meta('recipient4', 'recipient-lease'))
  db.prepare('UPDATE messages SET to_agent_id = ? WHERE id = ?').run('other', 'recipient-msg')
  insertMessage(db, 'matching-msg', 'matching5', 'pending', meta('matching5', 'matching-lease'))
  holdLegacyActiveTasks(db)
  const rows = db.prepare('SELECT id, close_reason FROM tasks ORDER BY id').all()
  for (const row of rows) assert.equal(String(row.close_reason).includes(LEGACY_RECOVERY_MARKER), row.id !== 'matching5')
  assert.equal(db.prepare('SELECT state FROM messages WHERE id = ?').get('matching-msg')?.state, 'pending')
  db.close()
})

test('a stale assignment and a fresh assignment still require investigation', () => {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  insertTask(db, 'task1', 'WORKING', 'fresh')
  insertMessage(db, 'stale', 'task1', 'consuming', { 'x-aw-task-kind': 'assign', 'x-aw-task-id': 'task1', 'x-aw-assignment-generation': 0, 'x-aw-execution-lease-id': 'old' })
  insertMessage(db, 'fresh', 'task1', 'pending', { 'x-aw-task-kind': 'assign', 'x-aw-task-id': 'task1', 'x-aw-assignment-generation': 0, 'x-aw-execution-lease-id': 'fresh' })
  holdLegacyActiveTasks(db)
  assert.match(String(db.prepare('SELECT close_reason FROM tasks WHERE id = ?').get('task1')?.close_reason), /LEGACY_EXECUTION_RECOVERY_REQUIRED/)
  assert.deepEqual(db.prepare('SELECT state FROM messages ORDER BY id').all().map(row => row.state), ['dead', 'dead'])
  db.close()
})

test('restart quarantines ambiguous metadata and restore does not redeliver held trees', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'aw-ambiguous-db-')), 'workshop.sqlite')
  let db = new DatabaseSync(path)
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  for (const id of ['task1', 'task2', 'task3', 'task4', 'task5']) insertTask(db, id, 'WORKING', `${id}-lease`)
  insertMessage(db, 'malformed', 'task1', 'consuming', {})
  insertMessage(db, 'null', 'task2', 'pending', {})
  insertMessage(db, 'array', 'task3', 'pending', {})
  insertMessage(db, 'conflict', 'task4', 'pending', { 'x-aw-task-kind': 'assign', 'x-aw-task-id': 'task5', 'x-aw-assignment-generation': 0, 'x-aw-execution-lease-id': 'task4-lease' })
  insertMessage(db, 'chat', 'task1', 'pending', { 'x-aw-from-label': 'user' })
  insertMessage(db, 'session-chat', 'task2', 'pending', { 'x-aw-session-id': 'session' })
  insertMessage(db, 'unlinked-invalid', null, 'pending', {})
  const setMetadata = db.prepare('UPDATE messages SET metadata_json = ?, claim_token = ? WHERE id = ?')
  setMetadata.run('{"x-aw-task-kind":', 'old-claim', 'malformed')
  setMetadata.run('null', null, 'null')
  setMetadata.run('[]', null, 'array')
  setMetadata.run('{', null, 'unlinked-invalid')
  db.close()

  db = new DatabaseSync(path)
  initWorkshopDb(db)
  const tasks = createTaskRepo(db)
  const messages = createMessageRepo(db)
  const engine = new TaskEngine({ tasks, messages })
  for (const id of ['task1', 'task2', 'task3', 'task4', 'task5']) {
    assert.match(engine.get(id)!.closeReason!, /LEGACY_EXECUTION_RECOVERY_REQUIRED/)
  }
  const before = db.prepare('SELECT id, state, metadata_json, claim_token FROM messages ORDER BY id').all()
  const byId = Object.fromEntries(before.map(row => [String(row.id), row]))
  for (const id of ['malformed', 'null', 'array', 'conflict']) {
    assert.equal(byId[id]?.state, 'dead')
    assert.equal(byId[id]?.claim_token, null)
  }
  assert.equal(byId.malformed?.metadata_json, '{"x-aw-task-kind":')
  for (const id of ['chat', 'session-chat', 'unlinked-invalid']) assert.equal(byId[id]?.state, 'pending')

  let redeliveries = 0
  const manager = {
    deps: { repos: { tasks, messages, channels: { findById: () => undefined } } },
    runGroupChatMaintenance() {},
    recoverPendingChatDeliveries() {},
    getTaskEngine: () => ({
      isLegacyRecoveryBlocked: (id: string) => engine.isLegacyRecoveryBlocked(id),
      redeliverAssign: () => { redeliveries++ },
    }),
    wakeAgent() {},
  }
  await ManagerSchedules.prototype.restore.call(manager as never)
  assert.equal(redeliveries, 0)
  assert.deepEqual(db.prepare('SELECT id, state, metadata_json, claim_token FROM messages ORDER BY id').all(), before)
  initWorkshopDb(db)
  assert.deepEqual(db.prepare('SELECT id, state, metadata_json, claim_token FROM messages ORDER BY id').all(), before)
  db.close()
})

test('startup recovery preserves a large unrelated pending mailbox', () => {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  insertTask(db, 'task1', 'WORKING', null)
  db.exec('BEGIN')
  const insert = db.prepare(`INSERT INTO messages(id, channel_id, task_id, to_agent_id, role, parts_json, metadata_json, state, created_at)
    VALUES (?, 'ch', 'task1', 'worker', 'ROLE_USER', '[]', '{"x-aw-from-label":"user"}', 'pending', '2026-01-01')`)
  for (let i = 0; i < 10000; i++) insert.run(`chat-${i}`)
  db.exec('COMMIT')
  holdLegacyActiveTasks(db)
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE state = ?').get('pending')?.n, 10000)
  db.close()
})

test('late lease-less assign and child completion cannot execute a held task', async () => {
  const db = new DatabaseSync(':memory:')
  initWorkshopDb(db)
  db.exec('PRAGMA foreign_keys = OFF')
  insertTask(db, 't1', 'WORKING', null)
  holdLegacyActiveTasks(db)
  const engine = new TaskEngine({ tasks: createTaskRepo(db), messages: createMessageRepo(db) })
  const mailbox = new Mailbox(createMessageRepo(db), 'ch', 'worker', () => {})
  let runs = 0
  let physicalWrites = 0
  class Runtime extends AgentRuntime {
    async processForTest(msg: A2AMessage, token: string): Promise<void> { await this.processMessage(msg, token) }
  }
  const runtime = new Runtime(
    { id: 'worker', channelId: 'ch', name: 'Worker', role: 'worker', harness: 'mock', config: {} } as AgentInfo,
    { async* run() {
      runs++
      physicalWrites++
      yield { kind: 'done' }
    } } as unknown as AgentInterface,
    { mailbox, taskEngine: engine as never, bus: {} as never, workspace: {} as never },
  )
  for (const kind of ['assign', 'child-completed']) {
    const msg: A2AMessage = { messageId: kind, contextId: 'ch', taskId: 't1', role: 'ROLE_USER', parts: [], metadata: { 'x-aw-task-kind': kind } }
    assert.equal(mailbox.enqueue(msg), true)
    const delivery = await mailbox.dequeue()
    assert.ok(delivery)
    const token = mailbox.claimToken(delivery)!
    assert.equal(mailbox.beginProcessing(delivery.messageId, token), true)
    await runtime.processForTest(delivery, token)
  }
  assert.equal(runs, 0)
  assert.equal(physicalWrites, 0)
  assert.equal(engine.get('t1')!.state, 'WORKING')
  assert.equal(engine.get('t1')!.closeReason, `previous reason ${LEGACY_RECOVERY_MARKER}`)
  db.close()
})
