/**
 * Project 层 V1 数据访问（9 张表）。
 *
 * 约定：
 *  - 工厂接收 DatabaseSync（与现有 repo 一致），不持单例；
 *  - JSON 列以 TEXT 原样存取，解析在 service 层；
 *  - 时间列为 ISO 字符串（与现有 channels/tasks 一致）；
 *  - 唯一约束/部分索引是幂等与并发的第一道闸门，service 层仍需二次校验。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export interface ProjectRow {
  id: string
  name: string
  description: string
  objective: string
  successCriteriaJson: string
  status: string
  mode: string
  ownerUserId: string
  officeChannelId: string | null
  leadAgentId: string | null
  planVersion: number
  planJson: string
  planApprovalRequired: number
  configJson: string
  deadlineAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ProjectChannelRow {
  projectId: string
  channelId: string
  bindingType: string
  charter: string
  status: string
  addedBy: string
  addedAt: string
  detachedAt: string | null
}

export interface ProjectDeliverableRow {
  id: string
  projectId: string
  name: string
  description: string
  ownerChannelId: string | null
  required: number
  acceptanceCriteriaJson: string
  dueAt: string | null
  dependsOnJson: string
  status: string
  waiverReason: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface ProjectWorkItemRow {
  id: string
  projectId: string
  deliverableId: string
  channelId: string
  title: string
  brief: string
  state: string
  stateReason: string | null
  priority: number
  weight: number
  dependsOnJson: string
  acceptanceJson: string
  resultKey: string
  currentAttemptId: string | null
  planVersion: number
  contractJson: string
  execBudgetMinutes: number
  traceId: string
  dedupeKey: string
  deadlineAt: string | null
  reworkCount: number
  createdBy: string
  createdAt: string
  updatedAt: string
  closedAt: string | null
  closeReason: string | null
}

export interface ProjectAttemptRow {
  id: string
  projectId: string
  workItemId: string
  attemptNo: number
  channelId: string
  channelTaskId: string | null
  sourceKey: string
  state: string
  blockedReason: string | null
  approvalId: string | null
  argsDigest: string
  traceId: string
  createdAt: string
  closedAt: string | null
}

export interface ProjectResultRow {
  id: string
  projectId: string
  deliverableId: string
  channelId: string
  lineId: string
  workItemId: string
  attemptNo: number
  resultKey: string
  version: number
  title: string
  summary: string
  method: string
  dataWindowJson: string
  sampleCount: number | null
  confidence: number | null
  validityScope: string
  payloadJson: string
  evidenceJson: string
  changeSummary: string
  openQuestions: string
  status: string
  sourceTaskId: string
  supersedesId: string | null
  authorAgentId: string | null
  authorUserId: string | null
  reviewedBy: string | null
  reviewedAt: string | null
  approvedBy: string | null
  approvedAt: string | null
  rejectReason: string | null
  traceId: string
  createdAt: string
}

export interface ProjectDecisionRow {
  id: string
  projectId: string
  seq: number
  source: string
  decisionType: string
  actorAgentId: string | null
  actorUserId: string | null
  argsJson: string
  argsSha256: string
  snapshotSha256: string
  state: string
  outcome: string
  reason: string
  approvalId: string | null
  traceId: string
  createdAt: string
}

export interface ProjectEventRow {
  id: string
  projectId: string
  seq: number
  type: string
  eventKey: string
  channelId: string | null
  workItemId: string | null
  deliverableId: string | null
  agentId: string | null
  payloadJson: string
  traceId: string
  consumedAt: string | null
  createdAt: string
}

export interface ProjectApprovalRow {
  id: string
  projectId: string
  kind: string
  subjectType: string
  subjectId: string
  subjectVersion: number | null
  status: string
  requestedByAgentId: string | null
  requestedByUserId: string | null
  payloadJson: string
  argsDigest: string
  reason: string
  decisionReason: string
  decidedByUserId: string | null
  consumedAt: string | null
  traceId: string
  expiresAt: string | null
  createdAt: string
  decidedAt: string | null
}

const PROJECT_COLS = 'id, name, description, objective, success_criteria_json AS successCriteriaJson, status, mode, owner_user_id AS ownerUserId, office_channel_id AS officeChannelId, lead_agent_id AS leadAgentId, plan_version AS planVersion, plan_json AS planJson, plan_approval_required AS planApprovalRequired, config_json AS configJson, deadline_at AS deadlineAt, created_at AS createdAt, updated_at AS updatedAt'
const PROJECT_CHANNEL_COLS = 'project_id AS projectId, channel_id AS channelId, binding_type AS bindingType, charter, status, added_by AS addedBy, added_at AS addedAt, detached_at AS detachedAt'
const DELIVERABLE_COLS = 'id, project_id AS projectId, name, description, owner_channel_id AS ownerChannelId, required, acceptance_criteria_json AS acceptanceCriteriaJson, due_at AS dueAt, depends_on_json AS dependsOnJson, status, waiver_reason AS waiverReason, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt'
const WORK_ITEM_COLS = 'id, project_id AS projectId, deliverable_id AS deliverableId, channel_id AS channelId, title, brief, state, state_reason AS stateReason, priority, weight, depends_on_json AS dependsOnJson, acceptance_json AS acceptanceJson, result_key AS resultKey, current_attempt_id AS currentAttemptId, plan_version AS planVersion, contract_json AS contractJson, exec_budget_minutes AS execBudgetMinutes, trace_id AS traceId, dedupe_key AS dedupeKey, deadline_at AS deadlineAt, rework_count AS reworkCount, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt, closed_at AS closedAt, close_reason AS closeReason'
const ATTEMPT_COLS = 'id, project_id AS projectId, work_item_id AS workItemId, attempt_no AS attemptNo, channel_id AS channelId, channel_task_id AS channelTaskId, source_key AS sourceKey, state, blocked_reason AS blockedReason, approval_id AS approvalId, args_digest AS argsDigest, trace_id AS traceId, created_at AS createdAt, closed_at AS closedAt'
const RESULT_COLS = 'id, project_id AS projectId, deliverable_id AS deliverableId, channel_id AS channelId, line_id AS lineId, work_item_id AS workItemId, attempt_no AS attemptNo, result_key AS resultKey, version, title, summary, method, data_window_json AS dataWindowJson, sample_count AS sampleCount, confidence, validity_scope AS validityScope, payload_json AS payloadJson, evidence_json AS evidenceJson, change_summary AS changeSummary, open_questions AS openQuestions, status, source_task_id AS sourceTaskId, supersedes_id AS supersedesId, author_agent_id AS authorAgentId, author_user_id AS authorUserId, reviewed_by AS reviewedBy, reviewed_at AS reviewedAt, approved_by AS approvedBy, approved_at AS approvedAt, reject_reason AS rejectReason, trace_id AS traceId, created_at AS createdAt'
const DECISION_COLS = 'id, project_id AS projectId, seq, source, decision_type AS decisionType, actor_agent_id AS actorAgentId, actor_user_id AS actorUserId, args_json AS argsJson, args_sha256 AS argsSha256, snapshot_sha256 AS snapshotSha256, state, outcome, reason, approval_id AS approvalId, trace_id AS traceId, created_at AS createdAt'
const EVENT_COLS = 'id, project_id AS projectId, seq, type, event_key AS eventKey, channel_id AS channelId, work_item_id AS workItemId, deliverable_id AS deliverableId, agent_id AS agentId, payload_json AS payloadJson, trace_id AS traceId, consumed_at AS consumedAt, created_at AS createdAt'
const APPROVAL_COLS = 'id, project_id AS projectId, kind, subject_type AS subjectType, subject_id AS subjectId, subject_version AS subjectVersion, status, requested_by_agent_id AS requestedByAgentId, requested_by_user_id AS requestedByUserId, payload_json AS payloadJson, args_digest AS argsDigest, reason, decision_reason AS decisionReason, decided_by_user_id AS decidedByUserId, consumed_at AS consumedAt, trace_id AS traceId, expires_at AS expiresAt, created_at AS createdAt, decided_at AS decidedAt'

const now = () => new Date().toISOString()

export type ProjectRepo = ReturnType<typeof createProjectRepo>
export function createProjectRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO projects (id, name, description, objective, success_criteria_json, status, mode, owner_user_id, office_channel_id, lead_agent_id, plan_version, plan_json, plan_approval_required, config_json, deadline_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectById = db.prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`)
  const selectByOwner = db.prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE owner_user_id = ? ORDER BY created_at DESC`)
  const selectAll = db.prepare(`SELECT ${PROJECT_COLS} FROM projects ORDER BY created_at DESC`)
  const updateStmt = db.prepare(
    `UPDATE projects SET name = ?, description = ?, objective = ?, success_criteria_json = ?, status = ?, mode = ?, owner_user_id = ?, office_channel_id = ?, lead_agent_id = ?, plan_version = ?, plan_json = ?, plan_approval_required = ?, config_json = ?, deadline_at = ?, updated_at = ? WHERE id = ?`,
  )

  return {
    create(input: {
      name: string
      description?: string
      objective: string
      successCriteriaJson?: string
      status?: string
      mode?: string
      ownerUserId: string
      officeChannelId?: string | null
      leadAgentId?: string | null
      planJson?: string
      planApprovalRequired?: number
      configJson?: string
      deadlineAt?: string | null
    }): ProjectRow {
      const id = randomUUID()
      const ts = now()
      const row: ProjectRow = {
        id,
        name: input.name,
        description: input.description ?? '',
        objective: input.objective,
        successCriteriaJson: input.successCriteriaJson ?? '[]',
        status: input.status ?? 'draft',
        mode: input.mode ?? 'supervised',
        ownerUserId: input.ownerUserId,
        officeChannelId: input.officeChannelId ?? null,
        leadAgentId: input.leadAgentId ?? null,
        planVersion: 0,
        planJson: input.planJson ?? '{}',
        planApprovalRequired: input.planApprovalRequired ?? 1,
        configJson: input.configJson ?? '{}',
        deadlineAt: input.deadlineAt ?? null,
        createdAt: ts,
        updatedAt: ts,
      }
      insert.run(row.id, row.name, row.description, row.objective, row.successCriteriaJson, row.status, row.mode, row.ownerUserId,
        row.officeChannelId, row.leadAgentId, row.planVersion, row.planJson, row.planApprovalRequired, row.configJson,
        row.deadlineAt, row.createdAt, row.updatedAt)
      return row
    },
    findById(id: string): ProjectRow | undefined {
      return selectById.get(id) as unknown as ProjectRow | undefined
    },
    listByOwner(ownerUserId: string): ProjectRow[] {
      return selectByOwner.all(ownerUserId) as unknown as ProjectRow[]
    },
    listAll(): ProjectRow[] {
      return selectAll.all() as unknown as ProjectRow[]
    },
    update(id: string, patch: Partial<Omit<ProjectRow, 'id' | 'createdAt'>>): ProjectRow | undefined {
      const cur = selectById.get(id) as unknown as ProjectRow | undefined
      if (!cur) return undefined
      const next: ProjectRow = {
        ...cur,
        ...patch,
        id: cur.id,
        createdAt: cur.createdAt,
        updatedAt: now(),
      }
      updateStmt.run(next.name, next.description, next.objective, next.successCriteriaJson, next.status, next.mode,
        next.ownerUserId, next.officeChannelId, next.leadAgentId, next.planVersion, next.planJson,
        next.planApprovalRequired, next.configJson, next.deadlineAt, next.updatedAt, id)
      return next
    },
  }
}

export type ProjectChannelRepo = ReturnType<typeof createProjectChannelRepo>
export function createProjectChannelRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO project_channels (project_id, channel_id, binding_type, charter, status, added_by, added_at, detached_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectByProject = db.prepare(`SELECT ${PROJECT_CHANNEL_COLS} FROM project_channels WHERE project_id = ? ORDER BY added_at ASC`)
  const selectActiveByChannel = db.prepare(`SELECT ${PROJECT_CHANNEL_COLS} FROM project_channels WHERE channel_id = ? AND status = 'active' LIMIT 1`)
  const selectOne = db.prepare(`SELECT ${PROJECT_CHANNEL_COLS} FROM project_channels WHERE project_id = ? AND channel_id = ?`)
  const updateStatus = db.prepare(`UPDATE project_channels SET status = ?, detached_at = ? WHERE project_id = ? AND channel_id = ?`)
  return {
    add(input: { projectId: string, channelId: string, bindingType?: string, charter?: string, addedBy: string }): ProjectChannelRow {
      const row: ProjectChannelRow = {
        projectId: input.projectId,
        channelId: input.channelId,
        bindingType: input.bindingType ?? 'user_bound',
        charter: input.charter ?? '',
        status: 'active',
        addedBy: input.addedBy,
        addedAt: now(),
        detachedAt: null,
      }
      insert.run(row.projectId, row.channelId, row.bindingType, row.charter, row.status, row.addedBy, row.addedAt, row.detachedAt)
      return row
    },
    listByProject(projectId: string): ProjectChannelRow[] {
      return selectByProject.all(projectId) as unknown as ProjectChannelRow[]
    },
    findActiveByChannel(channelId: string): ProjectChannelRow | undefined {
      return selectActiveByChannel.get(channelId) as unknown as ProjectChannelRow | undefined
    },
    findOne(projectId: string, channelId: string): ProjectChannelRow | undefined {
      return selectOne.get(projectId, channelId) as unknown as ProjectChannelRow | undefined
    },
    setStatus(projectId: string, channelId: string, status: string): void {
      updateStatus.run(status, status === 'active' ? null : now(), projectId, channelId)
    },
  }
}

export type ProjectDeliverableRepo = ReturnType<typeof createProjectDeliverableRepo>
export function createProjectDeliverableRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO project_deliverables (id, project_id, name, description, owner_channel_id, required, acceptance_criteria_json, due_at, depends_on_json, status, waiver_reason, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectById = db.prepare(`SELECT ${DELIVERABLE_COLS} FROM project_deliverables WHERE id = ?`)
  const selectByProject = db.prepare(`SELECT ${DELIVERABLE_COLS} FROM project_deliverables WHERE project_id = ? ORDER BY created_at ASC`)
  const updateStatus = db.prepare(`UPDATE project_deliverables SET status = ?, waiver_reason = ?, updated_at = ? WHERE id = ?`)
  return {
    create(input: {
      projectId: string
      name: string
      description?: string
      ownerChannelId?: string | null
      required?: number
      acceptanceCriteriaJson?: string
      dueAt?: string | null
      dependsOnJson?: string
      createdBy?: string
    }): ProjectDeliverableRow {
      const id = randomUUID()
      const ts = now()
      const row: ProjectDeliverableRow = {
        id,
        projectId: input.projectId,
        name: input.name,
        description: input.description ?? '',
        ownerChannelId: input.ownerChannelId ?? null,
        required: input.required ?? 1,
        acceptanceCriteriaJson: input.acceptanceCriteriaJson ?? '[]',
        dueAt: input.dueAt ?? null,
        dependsOnJson: input.dependsOnJson ?? '[]',
        status: 'planned',
        waiverReason: null,
        createdBy: input.createdBy ?? 'project_leader',
        createdAt: ts,
        updatedAt: ts,
      }
      insert.run(row.id, row.projectId, row.name, row.description, row.ownerChannelId, row.required,
        row.acceptanceCriteriaJson, row.dueAt, row.dependsOnJson, row.status, row.waiverReason, row.createdBy,
        row.createdAt, row.updatedAt)
      return row
    },
    findById(id: string): ProjectDeliverableRow | undefined {
      return selectById.get(id) as unknown as ProjectDeliverableRow | undefined
    },
    listByProject(projectId: string): ProjectDeliverableRow[] {
      return selectByProject.all(projectId) as unknown as ProjectDeliverableRow[]
    },
    setStatus(id: string, status: string, waiverReason?: string | null): void {
      updateStatus.run(status, waiverReason ?? null, now(), id)
    },
  }
}

export type ProjectWorkItemRepo = ReturnType<typeof createProjectWorkItemRepo>
export function createProjectWorkItemRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO project_work_items (id, project_id, deliverable_id, channel_id, title, brief, state, state_reason, priority, weight, depends_on_json, acceptance_json, result_key, current_attempt_id, plan_version, contract_json, exec_budget_minutes, trace_id, dedupe_key, deadline_at, rework_count, created_by, created_at, updated_at, closed_at, close_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectById = db.prepare(`SELECT ${WORK_ITEM_COLS} FROM project_work_items WHERE id = ?`)
  const selectByProject = db.prepare(`SELECT ${WORK_ITEM_COLS} FROM project_work_items WHERE project_id = ? ORDER BY created_at ASC`)
  const updateStmt = db.prepare(
    `UPDATE project_work_items SET deliverable_id = ?, channel_id = ?, title = ?, brief = ?, state = ?, state_reason = ?, priority = ?, weight = ?, depends_on_json = ?, acceptance_json = ?, result_key = ?, current_attempt_id = ?, plan_version = ?, contract_json = ?, exec_budget_minutes = ?, trace_id = ?, dedupe_key = ?, deadline_at = ?, rework_count = ?, closed_at = ?, close_reason = ?, updated_at = ? WHERE id = ?`,
  )
  return {
    create(input: {
      projectId: string
      deliverableId: string
      channelId: string
      title: string
      brief?: string
      state?: string
      priority?: number
      weight?: number
      dependsOnJson?: string
      acceptanceJson?: string
      resultKey?: string
      planVersion?: number
      contractJson?: string
      execBudgetMinutes?: number
      traceId?: string
      dedupeKey: string
      deadlineAt?: string | null
      createdBy?: string
    }): ProjectWorkItemRow {
      const id = randomUUID()
      const ts = now()
      const row: ProjectWorkItemRow = {
        id,
        projectId: input.projectId,
        deliverableId: input.deliverableId,
        channelId: input.channelId,
        title: input.title,
        brief: input.brief ?? '',
        state: input.state ?? 'DRAFT',
        stateReason: null,
        priority: input.priority ?? 0,
        weight: input.weight ?? 1,
        dependsOnJson: input.dependsOnJson ?? '[]',
        acceptanceJson: input.acceptanceJson ?? '[]',
        resultKey: input.resultKey ?? 'main',
        currentAttemptId: null,
        planVersion: input.planVersion ?? 0,
        contractJson: input.contractJson ?? '{}',
        execBudgetMinutes: input.execBudgetMinutes ?? 60,
        traceId: input.traceId ?? '',
        dedupeKey: input.dedupeKey,
        deadlineAt: input.deadlineAt ?? null,
        reworkCount: 0,
        createdBy: input.createdBy ?? 'project_leader',
        createdAt: ts,
        updatedAt: ts,
        closedAt: null,
        closeReason: null,
      }
      insert.run(row.id, row.projectId, row.deliverableId, row.channelId, row.title, row.brief, row.state,
        row.stateReason, row.priority, row.weight, row.dependsOnJson, row.acceptanceJson, row.resultKey,
        row.currentAttemptId, row.planVersion, row.contractJson, row.execBudgetMinutes, row.traceId,
        row.dedupeKey, row.deadlineAt, row.reworkCount, row.createdBy, row.createdAt, row.updatedAt,
        row.closedAt, row.closeReason)
      return row
    },
    findById(id: string): ProjectWorkItemRow | undefined {
      return selectById.get(id) as unknown as ProjectWorkItemRow | undefined
    },
    listByProject(projectId: string): ProjectWorkItemRow[] {
      return selectByProject.all(projectId) as unknown as ProjectWorkItemRow[]
    },
    update(id: string, patch: Partial<Omit<ProjectWorkItemRow, 'id' | 'projectId' | 'createdAt'>>): ProjectWorkItemRow | undefined {
      const cur = selectById.get(id) as unknown as ProjectWorkItemRow | undefined
      if (!cur) return undefined
      const next: ProjectWorkItemRow = { ...cur, ...patch, id: cur.id, projectId: cur.projectId, createdAt: cur.createdAt, updatedAt: now() }
      updateStmt.run(next.deliverableId, next.channelId, next.title, next.brief, next.state, next.stateReason,
        next.priority, next.weight, next.dependsOnJson, next.acceptanceJson, next.resultKey, next.currentAttemptId,
        next.planVersion, next.contractJson, next.execBudgetMinutes, next.traceId, next.dedupeKey, next.deadlineAt,
        next.reworkCount, next.closedAt, next.closeReason, next.updatedAt, id)
      return next
    },
  }
}

export type ProjectAttemptRepo = ReturnType<typeof createProjectAttemptRepo>
export function createProjectAttemptRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO project_work_item_attempts (id, project_id, work_item_id, attempt_no, channel_id, channel_task_id, source_key, state, blocked_reason, approval_id, args_digest, trace_id, created_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectById = db.prepare(`SELECT ${ATTEMPT_COLS} FROM project_work_item_attempts WHERE id = ?`)
  const selectLive = db.prepare(`SELECT ${ATTEMPT_COLS} FROM project_work_item_attempts WHERE work_item_id = ? AND closed_at IS NULL LIMIT 1`)
  const selectByTask = db.prepare(`SELECT ${ATTEMPT_COLS} FROM project_work_item_attempts WHERE channel_task_id = ? LIMIT 1`)
  const selectByWorkItem = db.prepare(`SELECT ${ATTEMPT_COLS} FROM project_work_item_attempts WHERE work_item_id = ? ORDER BY attempt_no ASC`)
  const updateDispatch = db.prepare(`UPDATE project_work_item_attempts SET channel_task_id = ?, state = ? WHERE id = ?`)
  const closeStmt = db.prepare(`UPDATE project_work_item_attempts SET state = ?, blocked_reason = ?, closed_at = ? WHERE id = ? AND closed_at IS NULL`)
  return {
    create(input: {
      projectId: string
      workItemId: string
      attemptNo: number
      channelId: string
      sourceKey: string
      traceId?: string
      approvalId?: string | null
      argsDigest?: string
    }): ProjectAttemptRow {
      const row: ProjectAttemptRow = {
        id: randomUUID(),
        projectId: input.projectId,
        workItemId: input.workItemId,
        attemptNo: input.attemptNo,
        channelId: input.channelId,
        channelTaskId: null,
        sourceKey: input.sourceKey,
        state: 'DISPATCHING',
        blockedReason: null,
        approvalId: input.approvalId ?? null,
        argsDigest: input.argsDigest ?? '',
        traceId: input.traceId ?? '',
        createdAt: now(),
        closedAt: null,
      }
      insert.run(row.id, row.projectId, row.workItemId, row.attemptNo, row.channelId, row.channelTaskId,
        row.sourceKey, row.state, row.blockedReason, row.approvalId, row.argsDigest, row.traceId,
        row.createdAt, row.closedAt)
      return row
    },
    findById(id: string): ProjectAttemptRow | undefined {
      return selectById.get(id) as unknown as ProjectAttemptRow | undefined
    },
    findLiveByWorkItem(workItemId: string): ProjectAttemptRow | undefined {
      return selectLive.get(workItemId) as unknown as ProjectAttemptRow | undefined
    },
    findByTask(taskId: string): ProjectAttemptRow | undefined {
      return selectByTask.get(taskId) as unknown as ProjectAttemptRow | undefined
    },
    listByWorkItem(workItemId: string): ProjectAttemptRow[] {
      return selectByWorkItem.all(workItemId) as unknown as ProjectAttemptRow[]
    },
    setDispatched(id: string, channelTaskId: string): void {
      updateDispatch.run(channelTaskId, 'DISPATCHED', id)
    },
    close(id: string, state = 'CLOSED', blockedReason: string | null = null): void {
      closeStmt.run(state, blockedReason, now(), id)
    },
  }
}

export type ProjectResultRepo = ReturnType<typeof createProjectResultRepo>
export function createProjectResultRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO project_results (id, project_id, deliverable_id, channel_id, line_id, work_item_id, attempt_no, result_key, version, title, summary, method, data_window_json, sample_count, confidence, validity_scope, payload_json, evidence_json, change_summary, open_questions, status, source_task_id, supersedes_id, author_agent_id, author_user_id, reviewed_by, reviewed_at, approved_by, approved_at, reject_reason, trace_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectById = db.prepare(`SELECT ${RESULT_COLS} FROM project_results WHERE id = ?`)
  const selectByProject = db.prepare(`SELECT ${RESULT_COLS} FROM project_results WHERE project_id = ? ORDER BY created_at DESC`)
  const selectByWorkItemAttempt = db.prepare(`SELECT ${RESULT_COLS} FROM project_results WHERE work_item_id = ? AND attempt_no = ? AND result_key = ? LIMIT 1`)
  const selectNextVersion = db.prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM project_results WHERE project_id = ? AND deliverable_id = ? AND channel_id = ? AND result_key = ?`)
  const updateStatus = db.prepare(`UPDATE project_results SET status = ?, reviewed_by = ?, reviewed_at = ?, approved_by = ?, approved_at = ?, reject_reason = ? WHERE id = ?`)
  const submitStmt = db.prepare(`UPDATE project_results SET title = ?, summary = ?, method = ?, data_window_json = ?, sample_count = ?, confidence = ?, validity_scope = ?, payload_json = ?, evidence_json = ?, change_summary = ?, open_questions = ?, status = ? WHERE id = ?`)
  return {
    nextVersion(projectId: string, deliverableId: string, channelId: string, resultKey: string): number {
      return Number((selectNextVersion.get(projectId, deliverableId, channelId, resultKey) as { next?: number } | undefined)?.next ?? 1)
    },
    create(input: {
      projectId: string
      deliverableId: string
      channelId: string
      lineId?: string
      workItemId: string
      attemptNo: number
      resultKey?: string
      version: number
      title: string
      summary: string
      method?: string
      dataWindowJson?: string
      sampleCount?: number | null
      confidence?: number | null
      validityScope?: string
      payloadJson?: string
      evidenceJson?: string
      changeSummary?: string
      openQuestions?: string
      status?: string
      sourceTaskId: string
      authorAgentId?: string | null
      authorUserId?: string | null
      traceId?: string
    }): ProjectResultRow {
      const id = randomUUID()
      const row: ProjectResultRow = {
        id,
        projectId: input.projectId,
        deliverableId: input.deliverableId,
        channelId: input.channelId,
        lineId: input.lineId ?? '',
        workItemId: input.workItemId,
        attemptNo: input.attemptNo,
        resultKey: input.resultKey ?? 'main',
        version: input.version,
        title: input.title,
        summary: input.summary,
        method: input.method ?? '',
        dataWindowJson: input.dataWindowJson ?? '{}',
        sampleCount: input.sampleCount ?? null,
        confidence: input.confidence ?? null,
        validityScope: input.validityScope ?? '',
        payloadJson: input.payloadJson ?? '{}',
        evidenceJson: input.evidenceJson ?? '[]',
        changeSummary: input.changeSummary ?? '',
        openQuestions: input.openQuestions ?? '',
        status: input.status ?? 'draft',
        sourceTaskId: input.sourceTaskId,
        supersedesId: null,
        authorAgentId: input.authorAgentId ?? null,
        authorUserId: input.authorUserId ?? null,
        reviewedBy: null,
        reviewedAt: null,
        approvedBy: null,
        approvedAt: null,
        rejectReason: null,
        traceId: input.traceId ?? '',
        createdAt: now(),
      }
      insert.run(row.id, row.projectId, row.deliverableId, row.channelId, row.lineId, row.workItemId,
        row.attemptNo, row.resultKey, row.version, row.title, row.summary, row.method, row.dataWindowJson,
        row.sampleCount, row.confidence, row.validityScope, row.payloadJson, row.evidenceJson,
        row.changeSummary, row.openQuestions, row.status, row.sourceTaskId, row.supersedesId,
        row.authorAgentId, row.authorUserId, row.reviewedBy, row.reviewedAt, row.approvedBy,
        row.approvedAt, row.rejectReason, row.traceId, row.createdAt)
      return row
    },
    findById(id: string): ProjectResultRow | undefined {
      return selectById.get(id) as unknown as ProjectResultRow | undefined
    },
    findByWorkItemAttempt(workItemId: string, attemptNo: number, resultKey: string): ProjectResultRow | undefined {
      return selectByWorkItemAttempt.get(workItemId, attemptNo, resultKey) as unknown as ProjectResultRow | undefined
    },
    listByProject(projectId: string): ProjectResultRow[] {
      return selectByProject.all(projectId) as unknown as ProjectResultRow[]
    },
    submit(id: string, input: {
      title: string
      summary: string
      method: string
      dataWindowJson: string
      sampleCount: number | null
      confidence: number | null
      validityScope: string
      payloadJson: string
      evidenceJson: string
      changeSummary: string
      openQuestions: string
      status: string
    }): void {
      submitStmt.run(input.title, input.summary, input.method, input.dataWindowJson, input.sampleCount,
        input.confidence, input.validityScope, input.payloadJson, input.evidenceJson,
        input.changeSummary, input.openQuestions, input.status, id)
    },
    setStatus(id: string, status: string, meta: { reviewedBy?: string | null, reviewedAt?: string | null, approvedBy?: string | null, approvedAt?: string | null, rejectReason?: string | null } = {}): void {
      updateStatus.run(status, meta.reviewedBy ?? null, meta.reviewedAt ?? null, meta.approvedBy ?? null,
        meta.approvedAt ?? null, meta.rejectReason ?? null, id)
    },
  }
}

export type ProjectDecisionRepo = ReturnType<typeof createProjectDecisionRepo>
export function createProjectDecisionRepo(db: DatabaseSync) {
  const nextSeq = db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM project_decisions WHERE project_id = ?`)
  const insert = db.prepare(
    `INSERT INTO project_decisions (id, project_id, seq, source, decision_type, actor_agent_id, actor_user_id, args_json, args_sha256, snapshot_sha256, state, outcome, reason, approval_id, trace_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectByProject = db.prepare(`SELECT ${DECISION_COLS} FROM project_decisions WHERE project_id = ? ORDER BY seq ASC`)
  return {
    append(input: {
      projectId: string
      source: string
      decisionType: string
      actorAgentId?: string | null
      actorUserId?: string | null
      argsJson?: string
      argsSha256: string
      snapshotSha256?: string
      state?: string
      outcome?: string
      reason?: string
      approvalId?: string | null
      traceId?: string
    }): ProjectDecisionRow {
      const id = randomUUID()
      const seq = Number((nextSeq.get(input.projectId) as { next?: number } | undefined)?.next ?? 1)
      const row: ProjectDecisionRow = {
        id,
        projectId: input.projectId,
        seq,
        source: input.source,
        decisionType: input.decisionType,
        actorAgentId: input.actorAgentId ?? null,
        actorUserId: input.actorUserId ?? null,
        argsJson: input.argsJson ?? '{}',
        argsSha256: input.argsSha256,
        snapshotSha256: input.snapshotSha256 ?? '',
        state: input.state ?? 'proposed',
        outcome: input.outcome ?? '',
        reason: input.reason ?? '',
        approvalId: input.approvalId ?? null,
        traceId: input.traceId ?? '',
        createdAt: now(),
      }
      insert.run(row.id, row.projectId, row.seq, row.source, row.decisionType, row.actorAgentId,
        row.actorUserId, row.argsJson, row.argsSha256, row.snapshotSha256, row.state, row.outcome,
        row.reason, row.approvalId, row.traceId, row.createdAt)
      return row
    },
    listByProject(projectId: string): ProjectDecisionRow[] {
      return selectByProject.all(projectId) as unknown as ProjectDecisionRow[]
    },
  }
}

export type ProjectEventRepo = ReturnType<typeof createProjectEventRepo>
export function createProjectEventRepo(db: DatabaseSync) {
  const nextSeq = db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM project_events WHERE project_id = ?`)
  const insert = db.prepare(
    `INSERT OR IGNORE INTO project_events (id, project_id, seq, type, event_key, channel_id, work_item_id, deliverable_id, agent_id, payload_json, trace_id, consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectByProject = db.prepare(`SELECT ${EVENT_COLS} FROM project_events WHERE project_id = ? ORDER BY seq ASC`)
  const consume = db.prepare(`UPDATE project_events SET consumed_at = ? WHERE project_id = ? AND seq = ? AND consumed_at IS NULL`)
  return {
    append(input: {
      projectId: string
      type: string
      eventKey: string
      channelId?: string | null
      workItemId?: string | null
      deliverableId?: string | null
      agentId?: string | null
      payloadJson?: string
      traceId?: string
    }): { inserted: boolean, seq: number } {
      const seq = Number((nextSeq.get(input.projectId) as { next?: number } | undefined)?.next ?? 1)
      const result = insert.run(randomUUID(), input.projectId, seq, input.type, input.eventKey,
        input.channelId ?? null, input.workItemId ?? null, input.deliverableId ?? null,
        input.agentId ?? null, input.payloadJson ?? '{}', input.traceId ?? '', null, now())
      return { inserted: Number(result.changes ?? 0) > 0, seq }
    },
    listByProject(projectId: string): ProjectEventRow[] {
      return selectByProject.all(projectId) as unknown as ProjectEventRow[]
    },
    consume(projectId: string, seq: number): void {
      consume.run(now(), projectId, seq)
    },
  }
}

export type ProjectApprovalRepo = ReturnType<typeof createProjectApprovalRepo>
export function createProjectApprovalRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO project_approvals (id, project_id, kind, subject_type, subject_id, subject_version, status, requested_by_agent_id, requested_by_user_id, payload_json, args_digest, reason, decision_reason, decided_by_user_id, consumed_at, trace_id, expires_at, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectById = db.prepare(`SELECT ${APPROVAL_COLS} FROM project_approvals WHERE id = ?`)
  const selectPending = db.prepare(`SELECT ${APPROVAL_COLS} FROM project_approvals WHERE project_id = ? AND status = 'pending' ORDER BY created_at ASC`)
  const decideStmt = db.prepare(`UPDATE project_approvals SET status = ?, decision_reason = ?, decided_by_user_id = ?, decided_at = ? WHERE id = ? AND project_id = ? AND status = 'pending' AND (expires_at IS NULL OR expires_at > ?)`)
  const consumeStmt = db.prepare(`UPDATE project_approvals SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved' AND consumed_at IS NULL`)
  const expireStmt = db.prepare(`UPDATE project_approvals SET status = 'expired', decided_at = ? WHERE project_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`)
  return {
    create(input: {
      projectId: string
      kind: string
      subjectType: string
      subjectId: string
      subjectVersion?: number | null
      requestedByAgentId?: string | null
      requestedByUserId?: string | null
      payloadJson?: string
      argsDigest?: string
      reason?: string
      traceId?: string
      expiresAt?: string | null
    }): ProjectApprovalRow {
      const id = randomUUID()
      const ts = now()
      const row: ProjectApprovalRow = {
        id,
        projectId: input.projectId,
        kind: input.kind,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        subjectVersion: input.subjectVersion ?? null,
        status: 'pending',
        requestedByAgentId: input.requestedByAgentId ?? null,
        requestedByUserId: input.requestedByUserId ?? null,
        payloadJson: input.payloadJson ?? '{}',
        argsDigest: input.argsDigest ?? '',
        reason: input.reason ?? '',
        decisionReason: '',
        decidedByUserId: null,
        consumedAt: null,
        traceId: input.traceId ?? '',
        expiresAt: input.expiresAt ?? null,
        createdAt: ts,
        decidedAt: null,
      }
      insert.run(row.id, row.projectId, row.kind, row.subjectType, row.subjectId, row.subjectVersion,
        row.status, row.requestedByAgentId, row.requestedByUserId, row.payloadJson, row.argsDigest,
        row.reason, row.decisionReason, row.decidedByUserId, row.consumedAt, row.traceId,
        row.expiresAt, row.createdAt, row.decidedAt)
      return row
    },
    findById(id: string): ProjectApprovalRow | undefined {
      return selectById.get(id) as unknown as ProjectApprovalRow | undefined
    },
    listPending(projectId: string): ProjectApprovalRow[] {
      return selectPending.all(projectId) as unknown as ProjectApprovalRow[]
    },
    /** 原子决策：pending + 未过期；返回是否抢到 */
    decide(id: string, projectId: string, status: 'approved' | 'rejected', byUserId: string, reason = ''): boolean {
      const result = decideStmt.run(status, reason, byUserId, now(), id, projectId, now())
      return Number(result.changes ?? 0) > 0
    },
    consume(id: string): boolean {
      const result = consumeStmt.run(now(), id)
      return Number(result.changes ?? 0) > 0
    },
    expire(projectId: string): number {
      const result = expireStmt.run(now(), projectId, now())
      return Number(result.changes ?? 0)
    },
  }
}
