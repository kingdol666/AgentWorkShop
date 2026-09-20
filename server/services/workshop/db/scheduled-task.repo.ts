/**
 * ScheduledTask 仓储:scheduled_tasks / scheduled_task_runs 两表 CRUD(v16 定时任务)。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例;触发决策(next_run_at 计算)在 runtime 层。
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ScheduledTaskRow, ScheduledTaskRunRow } from './database'

const COLS = `id, channel_id AS channelId, name, title, description, mode, interval_ms AS intervalMs,
  daily_time AS dailyTime, enabled, state, last_run_at AS lastRunAt, next_run_at AS nextRunAt,
  last_task_id AS lastTaskId, run_count AS runCount, fail_count AS failCount,
  consecutive_failures AS consecutiveFailures, max_consecutive_failures AS maxConsecutiveFailures,
  owner_user_id AS ownerUserId, created_at AS createdAt, updated_at AS updatedAt`

const RUN_COLS = `id, schedule_id AS scheduleId, trigger_kind AS triggerKind, task_id AS taskId,
  state, error, started_at AS startedAt, ended_at AS endedAt`

/** 每计划保留的运行历史上限(超出裁剪最旧;GC 在每次触发时顺带执行) */
const RUNS_RETAIN_PER_SCHEDULE = 50

export interface ScheduledTaskCreateInput {
  channelId: string
  name: string
  title: string
  description?: string
  mode: 'interval' | 'daily'
  intervalMs?: number
  dailyTime?: string
  maxConsecutiveFailures?: number
  ownerUserId?: string | null
  /** 首次触发时刻(ISO;由 manager/runtime 计算后传入持久化) */
  nextRunAt?: string | null
}

export interface ScheduledTaskPatch {
  name?: string
  title?: string
  description?: string
  mode?: 'interval' | 'daily'
  intervalMs?: number
  dailyTime?: string
  enabled?: number
  maxConsecutiveFailures?: number
}

export type ScheduledTaskRepo = ReturnType<typeof createScheduledTaskRepo>

export function createScheduledTaskRepo(db: DatabaseSync) {
  const insert = db.prepare(
    `INSERT INTO scheduled_tasks (id, channel_id, name, title, description, mode, interval_ms, daily_time,
       enabled, state, next_run_at, max_consecutive_failures, owner_user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectById = db.prepare(`SELECT ${COLS} FROM scheduled_tasks WHERE id = ?`)
  const selectAll = db.prepare(`SELECT ${COLS} FROM scheduled_tasks ORDER BY createdAt DESC`)
  const selectEnabled = db.prepare(`SELECT ${COLS} FROM scheduled_tasks WHERE enabled = 1 ORDER BY next_run_at ASC`)
  const selectByChannel = db.prepare(`SELECT ${COLS} FROM scheduled_tasks WHERE channel_id = ? ORDER BY createdAt DESC`)
  const countEnabledByChannel = db.prepare(`SELECT COUNT(*) AS n FROM scheduled_tasks WHERE channel_id = ? AND enabled = 1`)
  const updateStmt = db.prepare(
    `UPDATE scheduled_tasks SET name = ?, title = ?, description = ?, mode = ?, interval_ms = ?, daily_time = ?,
       enabled = ?, state = ?, last_run_at = ?, next_run_at = ?, last_task_id = ?, run_count = ?, fail_count = ?,
       consecutive_failures = ?, max_consecutive_failures = ?, updated_at = ?
     WHERE id = ?`,
  )
  const removeStmt = db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`)
  const removeByChannelStmt = db.prepare(`DELETE FROM scheduled_tasks WHERE channel_id = ?`)

  const insertRun = db.prepare(
    `INSERT INTO scheduled_task_runs (id, schedule_id, trigger_kind, task_id, state, error, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectRunsBySchedule = db.prepare(
    `SELECT ${RUN_COLS} FROM scheduled_task_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?`,
  )
  const findRunById = db.prepare(`SELECT ${RUN_COLS} FROM scheduled_task_runs WHERE id = ?`)
  const updateRunStmt = db.prepare(
    `UPDATE scheduled_task_runs SET task_id = ?, state = ?, error = ?, ended_at = ? WHERE id = ?`,
  )
  const listRunningRuns = db.prepare(`SELECT ${RUN_COLS} FROM scheduled_task_runs WHERE state = 'RUNNING'`)
  const pruneRunsStmt = db.prepare(
    `DELETE FROM scheduled_task_runs WHERE schedule_id = ? AND id NOT IN (
       SELECT id FROM scheduled_task_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ${RUNS_RETAIN_PER_SCHEDULE})`,
  )

  return {
    create(input: ScheduledTaskCreateInput): ScheduledTaskRow {
      const now = new Date().toISOString()
      const row: ScheduledTaskRow = {
        id: randomUUID(),
        channelId: input.channelId,
        name: input.name,
        title: input.title,
        description: input.description ?? '',
        mode: input.mode,
        intervalMs: input.intervalMs ?? 0,
        dailyTime: input.dailyTime ?? '',
        enabled: 1,
        state: 'idle',
        lastRunAt: null,
        nextRunAt: input.nextRunAt ?? null,
        lastTaskId: null,
        runCount: 0,
        failCount: 0,
        consecutiveFailures: 0,
        maxConsecutiveFailures: input.maxConsecutiveFailures ?? 0,
        ownerUserId: input.ownerUserId ?? null,
        createdAt: now,
        updatedAt: now,
      }
      insert.run(row.id, row.channelId, row.name, row.title, row.description, row.mode, row.intervalMs,
        row.dailyTime, row.enabled, row.state, row.nextRunAt, row.maxConsecutiveFailures,
        row.ownerUserId, row.createdAt, row.updatedAt)
      return row
    },

    list(): ScheduledTaskRow[] {
      return selectAll.all() as unknown as ScheduledTaskRow[]
    },

    listEnabled(): ScheduledTaskRow[] {
      return selectEnabled.all() as unknown as ScheduledTaskRow[]
    },

    listByChannel(channelId: string): ScheduledTaskRow[] {
      return selectByChannel.all(channelId) as unknown as ScheduledTaskRow[]
    },

    findById(id: string): ScheduledTaskRow | undefined {
      return selectById.get(id) as unknown as ScheduledTaskRow | undefined
    },

    /** 该 channel 当前启用的定时任务数(Channel「定时」标志的单一事实源) */
    countEnabledByChannel(channelId: string): number {
      return (countEnabledByChannel.get(channelId) as unknown as { n: number }).n
    },

    /** 全量计数(按 channel 分组):channels 列表批量附标志用,一次查询替代 N 次 count */
    countEnabledByChannelAll(): Map<string, number> {
      const rows = db.prepare(
        `SELECT channel_id AS channelId, COUNT(*) AS n FROM scheduled_tasks WHERE enabled = 1 GROUP BY channel_id`,
      ).all() as unknown as Array<{ channelId: string, n: number }>
      return new Map(rows.map(r => [r.channelId, r.n]))
    },

    /** 全量更新(runtime 触发/收敛的主写路径;patch 未给字段沿用现值) */
    update(id: string, patch: ScheduledTaskPatch & {
      state?: string
      lastRunAt?: string | null
      nextRunAt?: string | null
      lastTaskId?: string | null
      runCount?: number
      failCount?: number
      consecutiveFailures?: number
    }): ScheduledTaskRow | undefined {
      const current = selectById.get(id) as unknown as ScheduledTaskRow | undefined
      if (!current) return undefined
      const next: ScheduledTaskRow = {
        ...current,
        name: patch.name ?? current.name,
        title: patch.title ?? current.title,
        description: patch.description ?? current.description,
        mode: patch.mode ?? current.mode,
        intervalMs: patch.intervalMs ?? current.intervalMs,
        dailyTime: patch.dailyTime ?? current.dailyTime,
        enabled: patch.enabled ?? current.enabled,
        state: patch.state ?? current.state,
        lastRunAt: patch.lastRunAt !== undefined ? patch.lastRunAt : current.lastRunAt,
        nextRunAt: patch.nextRunAt !== undefined ? patch.nextRunAt : current.nextRunAt,
        lastTaskId: patch.lastTaskId !== undefined ? patch.lastTaskId : current.lastTaskId,
        runCount: patch.runCount ?? current.runCount,
        failCount: patch.failCount ?? current.failCount,
        consecutiveFailures: patch.consecutiveFailures ?? current.consecutiveFailures,
        maxConsecutiveFailures: patch.maxConsecutiveFailures ?? current.maxConsecutiveFailures,
        updatedAt: new Date().toISOString(),
      }
      updateStmt.run(next.name, next.title, next.description, next.mode, next.intervalMs, next.dailyTime,
        next.enabled, next.state, next.lastRunAt, next.nextRunAt, next.lastTaskId, next.runCount,
        next.failCount, next.consecutiveFailures, next.maxConsecutiveFailures, next.updatedAt, id)
      return next
    },

    remove(id: string): void {
      removeStmt.run(id)
    },

    /** channel 级联清理(FK CASCADE 兜底;removeChannel 显式调用以保证旧库无 FK 时也收敛) */
    removeByChannel(channelId: string): void {
      removeByChannelStmt.run(channelId)
    },

    // ===== 运行历史 =====

    createRun(input: { scheduleId: string, triggerKind: 'timer' | 'manual' }): ScheduledTaskRunRow {
      const row: ScheduledTaskRunRow = {
        id: randomUUID(),
        scheduleId: input.scheduleId,
        triggerKind: input.triggerKind,
        taskId: null,
        state: 'RUNNING',
        error: '',
        startedAt: new Date().toISOString(),
        endedAt: null,
      }
      insertRun.run(row.id, row.scheduleId, row.triggerKind, row.taskId, row.state, row.error, row.startedAt, row.endedAt)
      return row
    },

    findRun(runId: string): ScheduledTaskRunRow | undefined {
      return findRunById.get(runId) as unknown as ScheduledTaskRunRow | undefined
    },

    listRuns(scheduleId: string, limit = RUNS_RETAIN_PER_SCHEDULE): ScheduledTaskRunRow[] {
      return selectRunsBySchedule.all(scheduleId, limit) as unknown as ScheduledTaskRunRow[]
    },

    /** 在途运行(重启恢复/对账用) */
    listRunningRuns(): ScheduledTaskRunRow[] {
      return listRunningRuns.all() as unknown as ScheduledTaskRunRow[]
    },

    finishRun(runId: string, patch: { taskId?: string | null, state: 'COMPLETED' | 'FAILED', error?: string }): void {
      updateRunStmt.run(patch.taskId ?? null, patch.state, patch.error ?? '', new Date().toISOString(), runId)
    },

    /** 在途 run 回填 taskId(保持 RUNNING;ended_at 不动——收口统一走 finishRun) */
    attachTask(runId: string, taskId: string): void {
      db.prepare(`UPDATE scheduled_task_runs SET task_id = ? WHERE id = ?`).run(taskId, runId)
    },

    /** 保留策略:每计划只留最近 RUNS_RETAIN_PER_SCHEDULE 条(触发时顺带 GC) */
    pruneRuns(scheduleId: string): void {
      pruneRunsStmt.run(scheduleId, scheduleId)
    },
  }
}
