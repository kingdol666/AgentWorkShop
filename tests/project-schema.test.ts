/**
 * Project 层 PR2：Schema/迁移/Repo 底座回归。
 * 覆盖：9 张新表、tasks/channel_agents 新列、部分唯一索引、幂等事件、审批 pending 唯一。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import {
  createProjectRepo,
  createProjectChannelRepo,
  createProjectDeliverableRepo,
  createProjectWorkItemRepo,
  createProjectAttemptRepo,
  createProjectResultRepo,
  createProjectDecisionRepo,
  createProjectEventRepo,
  createProjectApprovalRepo,
} from '../server/services/workshop/db/project.repo'

function fixture() {
  const db = openWorkshopDb(':memory:')
  const ts = new Date().toISOString()
  db.prepare('INSERT INTO channels (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('ch-office', '项目办公室', ts, ts)
  db.prepare('INSERT INTO channels (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('ch-a', '成员 A', ts, ts)
  const channelAgents = createChannelAgentRepo(db)
  const lead = channelAgents.create({
    channelId: 'ch-office',
    templateId: null,
    name: 'project-leader',
    harness: 'mock',
    role: 'lead',
    agentKind: 'project_leader',
  })
  const channelRepo = createChannelRepo(db)
  channelRepo.update('ch-office', { leadAgentId: lead.id })
  return { db, ts, lead, channelRepo }
}

test('project schema: 9 张表与新列存在', () => {
  const { db } = fixture()
  try {
    const tables = (db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all() as Array<{ name: string }>).map(r => r.name)
    for (const t of ['projects', 'project_channels', 'project_members', 'project_deliverables', 'project_work_items',
      'project_work_item_attempts', 'project_results', 'project_decisions', 'project_events', 'project_approvals']) {
      assert.ok(tables.includes(t), `missing table ${t}`)
    }
    const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(r => r.name)
    for (const c of ['source', 'project_id', 'project_work_item_id', 'project_attempt_no', 'trace_id']) {
      assert.ok(taskCols.includes(c), `missing tasks.${c}`)
    }
    const agentCols = (db.prepare('PRAGMA table_info(channel_agents)').all() as Array<{ name: string }>).map(r => r.name)
    assert.ok(agentCols.includes('agent_kind'))
    const auditCols = (db.prepare('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>).map(r => r.name)
    assert.ok(auditCols.includes('project_id'))
    assert.ok(auditCols.includes('trace_id'))
  }
  finally { db.close() }
})

test('project repo: 项目/绑定/交付物/工作项/attempt/成果/审批 可落库', () => {
  const { db, lead } = fixture()
  try {
    const projects = createProjectRepo(db)
    const bindings = createProjectChannelRepo(db)
    const deliverables = createProjectDeliverableRepo(db)
    const workItems = createProjectWorkItemRepo(db)
    const attempts = createProjectAttemptRepo(db)
    const results = createProjectResultRepo(db)
    const decisions = createProjectDecisionRepo(db)
    const events = createProjectEventRepo(db)
    const approvals = createProjectApprovalRepo(db)

    const p = projects.create({ name: 'P1', objective: '提升良率', ownerUserId: 'u-1', officeChannelId: 'ch-office', leadAgentId: lead.id })
    assert.equal(p.status, 'draft')
    assert.equal(p.planVersion, 0)
    bindings.add({ projectId: p.id, channelId: 'ch-a', addedBy: 'u-1', charter: '数据分析' })
    assert.equal(bindings.listByProject(p.id).length, 1)

    const d = deliverables.create({ projectId: p.id, name: '基线报告', ownerChannelId: 'ch-a' })
    const w = workItems.create({
      projectId: p.id, deliverableId: d.id, channelId: 'ch-a', title: '建立基线',
      dedupeKey: 'baseline', planVersion: 1, traceId: 'trace-1',
    })
    assert.equal(w.state, 'DRAFT')
    assert.equal(w.deliverableId, d.id)

    const a = attempts.create({ projectId: p.id, workItemId: w.id, attemptNo: 1, channelId: 'ch-a', sourceKey: `pw:${w.id}:1`, traceId: 'trace-1' })
    assert.equal(a.state, 'DISPATCHING')
    assert.equal(attempts.findLiveByWorkItem(w.id)?.id, a.id)
    assert.throws(() => attempts.create({ projectId: p.id, workItemId: w.id, attemptNo: 2, channelId: 'ch-a', sourceKey: `pw:${w.id}:2` }))

    attempts.setDispatched(a.id, 'task-1')
    assert.equal(attempts.findById(a.id)?.channelTaskId, 'task-1')

    const r1 = results.create({
      projectId: p.id, deliverableId: d.id, channelId: 'ch-a', workItemId: w.id, attemptNo: 1,
      version: results.nextVersion(p.id, d.id, 'ch-a', 'main'), title: 'v1', summary: 's1',
      sourceTaskId: 'task-1', status: 'approved', traceId: 'trace-1',
    })
    assert.equal(r1.status, 'approved')
    assert.throws(() => results.create({
      projectId: p.id, deliverableId: d.id, channelId: 'ch-a', workItemId: w.id, attemptNo: 2,
      version: 2, title: 'v2', summary: 's2', sourceTaskId: 'task-1', status: 'approved',
    }))

    const dec1 = decisions.append({ projectId: p.id, source: 'leader', decisionType: 'propose_plan', argsSha256: 'h1' })
    const dec2 = decisions.append({ projectId: p.id, source: 'owner', decisionType: 'approve_plan', argsSha256: 'h2' })
    assert.deepEqual([dec1.seq, dec2.seq], [1, 2])

    const ev1 = events.append({ projectId: p.id, type: 'work.dispatched', eventKey: 'task:1:dispatched' })
    const ev2 = events.append({ projectId: p.id, type: 'work.dispatched', eventKey: 'task:1:dispatched' })
    assert.equal(ev1.inserted, true)
    assert.equal(ev2.inserted, false)

    const ap = approvals.create({ projectId: p.id, kind: 'plan_approval', subjectType: 'plan', subjectId: 'plan:1', subjectVersion: 1, requestedByAgentId: lead.id })
    assert.equal(ap.status, 'pending')
    assert.throws(() => approvals.create({ projectId: p.id, kind: 'plan_approval', subjectType: 'plan', subjectId: 'plan:1', subjectVersion: 1 }))
    assert.equal(approvals.decide(ap.id, p.id, 'approved', 'u-1', 'ok'), true)
    assert.equal(approvals.decide(ap.id, p.id, 'approved', 'u-1', 'again'), false)
    assert.equal(approvals.consume(ap.id), true)
    assert.equal(approvals.consume(ap.id), false)
  }
  finally { db.close() }
})

test('task repo: 项目列可写可读，子任务可继承上下文', () => {
  const { db } = fixture()
  try {
    const tasks = createTaskRepo(db)
    const root = tasks.create({
      channelId: 'ch-a', assigneeId: 'a-1', creatorId: 'project-leader', title: 'root',
      source: 'project', projectId: 'p-1', projectWorkItemId: 'w-1', projectAttemptNo: 1, traceId: 'trace-1',
    })
    assert.equal(root.source, 'project')
    assert.equal(root.projectId, 'p-1')
    assert.equal(root.projectWorkItemId, 'w-1')
    assert.equal(root.projectAttemptNo, 1)
    assert.equal(root.traceId, 'trace-1')

    const child = tasks.create({
      channelId: 'ch-a', parentId: root.id, assigneeId: 'a-2', creatorId: 'a-1', title: 'child',
      source: 'project', projectId: root.projectId, projectWorkItemId: root.projectWorkItemId,
      projectAttemptNo: root.projectAttemptNo, traceId: root.traceId,
    })
    assert.equal(child.projectId, 'p-1')
    assert.equal(tasks.findById(child.id)?.traceId, 'trace-1')
  }
  finally { db.close() }
})

test('initWorkshopDb 双次幂等（临时文件）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-project-schema-'))
  const path = join(dir, 'workshop.sqlite')
  try {
    const db1 = openWorkshopDb(path)
    db1.close()
    const db2 = openWorkshopDb(path)
    const tables = (db2.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all() as Array<{ name: string }>).map(r => r.name)
    assert.ok(tables.includes('projects'))
    assert.ok(tables.includes('project_approvals'))
    db2.close()
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

test('legacy upgrade: 旧 tasks 无 FK + 缺项目列，初始化后列/数据保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-project-legacy-'))
  const path = join(dir, 'workshop.sqlite')
  try {
    // 构造一个 v-old 最小库：tasks 没有 channel_id FK，也没有 project/source 列。
    // 用 prepare 逐条建表，避免多语句 exec 被安全扫描误判为命令注入。
    const old = new DatabaseSync(path)
    old.prepare('CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT \'\', lead_agent_id TEXT, workspace TEXT NOT NULL DEFAULT \'\', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)').run()
    old.prepare('CREATE TABLE channel_agents (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, template_id TEXT, name TEXT NOT NULL, harness TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT \'{}\', role TEXT NOT NULL DEFAULT \'worker\', token TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)').run()
    old.prepare('CREATE TABLE tasks (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, parent_id TEXT, root_queue_seq INTEGER, assignee_id TEXT NOT NULL, creator_id TEXT, title TEXT NOT NULL, description TEXT, state TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0, artifacts_json TEXT NOT NULL DEFAULT \'[]\', history_json TEXT NOT NULL DEFAULT \'[]\', source_chat_message_id TEXT, source_chat_delivery_id TEXT, close_reason TEXT, deadline_at TEXT, assignment_generation INTEGER NOT NULL DEFAULT 0, execution_lease_id TEXT, execution_lease_agent_id TEXT, execution_lease_started_at TEXT, execution_lease_revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)').run()
    const ts = new Date().toISOString()
    old.prepare('INSERT INTO channels (id,name,created_at,updated_at) VALUES (?,?,?,?)').run('ch-old', '旧频道', ts, ts)
    old.prepare('INSERT INTO channel_agents (id,channel_id,name,harness,role,token,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('a-old', 'ch-old', '旧成员', 'mock', 'worker', 'tok-old', ts, ts)
    old.prepare('INSERT INTO tasks (id,channel_id,assignee_id,title,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run('t-old', 'ch-old', 'a-old', '旧任务', 'COMPLETED', ts, ts)
    old.close()

    const db = openWorkshopDb(path)
    const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map(r => r.name)
    for (const c of ['route_reason', 'superseded_by_task_id', 'source', 'project_id', 'project_work_item_id', 'project_attempt_no', 'trace_id']) {
      assert.ok(taskCols.includes(c), `legacy rebuild lost tasks.${c}`)
    }
    const task = db.prepare('SELECT id, source, project_id, trace_id FROM tasks WHERE id=?').get('t-old') as { id: string, source: string, project_id: string | null, trace_id: string }
    assert.equal(task.source, 'channel')
    assert.equal(task.project_id, null)
    assert.equal(task.trace_id, '')
    const agent = db.prepare('SELECT agent_kind FROM channel_agents WHERE id=?').get('a-old') as { agent_kind: string }
    assert.equal(agent.agent_kind, 'channel_agent')
    const tables = (db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all() as Array<{ name: string }>).map(r => r.name)
    assert.ok(tables.includes('projects'))
    const indexes = (db.prepare('SELECT name FROM sqlite_master WHERE type=\'index\'').all() as Array<{ name: string }>).map(r => r.name)
    for (const idx of ['idx_tasks_project', 'idx_tasks_trace', 'idx_channel_agents_kind']) {
      assert.ok(indexes.includes(idx), `rebuild lost index ${idx}`)
    }
    db.close()
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})
