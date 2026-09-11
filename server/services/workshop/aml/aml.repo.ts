/**
 * AML 自动建模平台四表仓储:数据集快照 / 训练作业 / 实验谱系 / 模型注册表。
 * 全部参数绑定(无字符串拼 SQL);读写失败向上抛,由调用方决定分类
 * (永久错误如 FK 失配不重试 —— 对齐 ws.ts flushDbBuffer 纪律)。
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

// ===== 行类型 =====

export interface AmlDatasetRow {
  id: string
  lineId: string
  productId: string
  recipeId: string
  runIds: string[]
  specJson: string
  sha256: string
  rowCount: number
  fromMs: number | null
  toMs: number | null
  path: string
  createdBy: string
  createdByKind: string // 'user' | 'agent'
  note: string
  createdAt: string
}

export type AmlJobStatus
  = | 'queued' | 'provisioning' | 'training' | 'evaluating'
    | 'done' | 'failed' | 'cancelled' | 'timeout' | 'interrupted'

export interface AmlJobRow {
  id: string
  datasetId: string
  purpose: string
  status: AmlJobStatus
  stage: string
  progress: number
  budget: Record<string, unknown>
  metricsJson: string | null
  gatesJson: string | null
  artifactsPath: string | null
  error: string | null
  retryCount: number
  agentId: string
  channelId: string
  taskId: string
  createdAt: string
  startedAt: string | null
  endedAt: string | null
}

export interface AmlExperimentRow {
  id: string
  jobId: string
  datasetId: string
  parentExperimentId: string | null
  changeNote: string
  configJson: string
  metricsJson: string
  gatesJson: string
  status: string // running|gates_passed|gates_failed|failed
  seed: number | null
  createdAt: string
}

export type AmlModelStage = 'candidate' | 'shadow' | 'production' | 'retired'

export interface AmlModelRow {
  id: string
  experimentId: string
  datasetId: string
  productId: string
  recipeId: string
  purpose: string
  stage: AmlModelStage
  ioSpecJson: string
  metricsJson: string
  path: string
  artifactsPruned: number
  createdBy: string
  promotedBy: string | null
  promotedAt: string | null
  note: string
  createdAt: string
}

const DS_COLS = `id, line_id AS lineId, product_id AS productId, recipe_id AS recipeId,
  run_ids_json AS runIdsJson, spec_json AS specJson, sha256, row_count AS rowCount,
  from_ms AS fromMs, to_ms AS toMs, path, created_by AS createdBy,
  created_by_kind AS createdByKind, note, created_at AS createdAt`

const JOB_COLS = `id, dataset_id AS datasetId, purpose, status, stage, progress,
  budget_json AS budgetJson, metrics_json AS metricsJson, gates_json AS gatesJson,
  artifacts_path AS artifactsPath, error, retry_count AS retryCount,
  agent_id AS agentId, channel_id AS channelId, task_id AS taskId,
  created_at AS createdAt, started_at AS startedAt, ended_at AS endedAt`

const EXP_COLS = `id, job_id AS jobId, dataset_id AS datasetId,
  parent_experiment_id AS parentExperimentId, change_note AS changeNote,
  config_json AS configJson, metrics_json AS metricsJson, gates_json AS gatesJson,
  status, seed, created_at AS createdAt`

const MODEL_COLS = `id, experiment_id AS experimentId, dataset_id AS datasetId,
  product_id AS productId, recipe_id AS recipeId, purpose, stage,
  io_spec_json AS ioSpecJson, metrics_json AS metricsJson, path,
  artifacts_pruned AS artifactsPruned, created_by AS createdBy,
  promoted_by AS promotedBy, promoted_at AS promotedAt, note, created_at AS createdAt`

function rowToDataset(r: Record<string, unknown>): AmlDatasetRow {
  return { ...(r as unknown as Omit<AmlDatasetRow, 'runIds'>), runIds: JSON.parse(String(r.runIdsJson || '[]')) }
}
function rowToJob(r: Record<string, unknown>): AmlJobRow {
  return {
    ...(r as unknown as Omit<AmlJobRow, 'budget'>),
    budget: JSON.parse(String(r.budgetJson || '{}')),
  }
}
function rowToExperiment(r: Record<string, unknown>): AmlExperimentRow {
  return r as unknown as AmlExperimentRow
}
function rowToModel(r: Record<string, unknown>): AmlModelRow {
  return r as unknown as AmlModelRow
}

export function createAmlRepo(db: DatabaseSync) {
  const dsInsert = db.prepare(
    `INSERT INTO aml_datasets (id, line_id, product_id, recipe_id, run_ids_json, spec_json, sha256,
       row_count, from_ms, to_ms, path, created_by, created_by_kind, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const jobInsert = db.prepare(
    `INSERT INTO aml_jobs (id, dataset_id, purpose, status, stage, progress, budget_json,
       agent_id, channel_id, task_id, created_at)
     VALUES (?, ?, ?, 'queued', '', 0, ?, ?, ?, ?, ?)`,
  )
  const jobState = db.prepare(
    `UPDATE aml_jobs SET status = ?, stage = ?, progress = ? WHERE id = ?`,
  )
  const jobFinish = db.prepare(
    `UPDATE aml_jobs SET status = ?, stage = 'done', progress = 100, metrics_json = ?, gates_json = ?,
       artifacts_path = ?, error = ?, ended_at = ? WHERE id = ?`,
  )
  const jobFail = db.prepare(
    `UPDATE aml_jobs SET status = ?, error = ?, ended_at = ? WHERE id = ?`,
  )
  const jobRetryBump = db.prepare(
    `UPDATE aml_jobs SET retry_count = retry_count + 1, status = 'queued', stage = '', progress = 0,
       error = NULL, started_at = NULL, ended_at = NULL WHERE id = ?`,
  )
  const expInsert = db.prepare(
    `INSERT INTO aml_experiments (id, job_id, dataset_id, parent_experiment_id, change_note,
       config_json, metrics_json, gates_json, status, seed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const expResult = db.prepare(
    `UPDATE aml_experiments SET metrics_json = ?, gates_json = ?, status = ? WHERE id = ?`,
  )
  const modelInsert = db.prepare(
    `INSERT INTO aml_models (id, experiment_id, dataset_id, product_id, recipe_id, purpose, stage,
       io_spec_json, metrics_json, path, created_by, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?, ?, ?)`,
  )
  /** 晋升/退役:SQL 层条件更新兜底并发竞态( WHERE stage 校验) */
  const modelStage = db.prepare(
    `UPDATE aml_models SET stage = ?, promoted_by = ?, promoted_at = ? WHERE id = ? AND stage = ?`,
  )
  const modelPrune = db.prepare(`UPDATE aml_models SET artifacts_pruned = 1 WHERE id = ?`)

  return {
    // ----- datasets -----
    dataset: {
      insert(d: AmlDatasetRow): void {
        dsInsert.run(
          d.id, d.lineId, d.productId, d.recipeId, JSON.stringify(d.runIds), d.specJson, d.sha256,
          d.rowCount, d.fromMs, d.toMs, d.path, d.createdBy, d.createdByKind, d.note, d.createdAt,
        )
      },
      get(id: string): AmlDatasetRow | undefined {
        const r = db.prepare(`SELECT ${DS_COLS} FROM aml_datasets WHERE id = ?`).get(id)
        return r ? rowToDataset(r as Record<string, unknown>) : undefined
      },
      list(filter: { recipeId?: string, productId?: string, lineId?: string, limit?: number } = {}): AmlDatasetRow[] {
        const where: string[] = []
        const args: SQLInputValue[] = []
        if (filter.lineId) {
          where.push('line_id = ?')
          args.push(filter.lineId)
        }
        if (filter.productId) {
          where.push('product_id = ?')
          args.push(filter.productId)
        }
        if (filter.recipeId) {
          where.push('recipe_id = ?')
          args.push(filter.recipeId)
        }
        const sql = `SELECT ${DS_COLS} FROM aml_datasets ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY created_at DESC LIMIT ?`
        args.push(filter.limit ?? 100)
        return (db.prepare(sql).all(...args) as unknown as Record<string, unknown>[]).map(rowToDataset)
      },
      /** 引用计数(GC 用):被实验或模型引用的数据集不可删 */
      referenceCount(id: string): { experiments: number, models: number } {
        const e = db.prepare('SELECT COUNT(*) AS c FROM aml_experiments WHERE dataset_id = ?').get(id) as { c: number }
        const m = db.prepare('SELECT COUNT(*) AS c FROM aml_models WHERE dataset_id = ?').get(id) as { c: number }
        return { experiments: e.c, models: m.c }
      },
      remove(id: string): void {
        db.prepare('DELETE FROM aml_datasets WHERE id = ?').run(id)
      },
      /** 元数据局部更新(备注;CRUD 的 U) */
      updateNote(id: string, note: string): void {
        db.prepare('UPDATE aml_datasets SET note = ? WHERE id = ?').run(note, id)
      },
    },

    // ----- jobs -----
    job: {
      insert(j: {
        id: string
        datasetId: string
        purpose: string
        budget: Record<string, unknown>
        agentId?: string
        channelId?: string
        taskId?: string
        createdAt: string
      }): void {
        jobInsert.run(j.id, j.datasetId, j.purpose, JSON.stringify(j.budget), j.agentId ?? '', j.channelId ?? '', j.taskId ?? '', j.createdAt)
      },
      get(id: string): AmlJobRow | undefined {
        const r = db.prepare(`SELECT ${JOB_COLS} FROM aml_jobs WHERE id = ?`).get(id)
        return r ? rowToJob(r as Record<string, unknown>) : undefined
      },
      list(filter: { status?: string, datasetId?: string, limit?: number } = {}): AmlJobRow[] {
        const where: string[] = []
        const args: SQLInputValue[] = []
        if (filter.status) {
          where.push('status = ?')
          args.push(filter.status)
        }
        if (filter.datasetId) {
          where.push('dataset_id = ?')
          args.push(filter.datasetId)
        }
        const sql = `SELECT ${JOB_COLS} FROM aml_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY created_at DESC LIMIT ?`
        args.push(filter.limit ?? 100)
        return (db.prepare(sql).all(...args) as unknown as Record<string, unknown>[]).map(rowToJob)
      },
      /** 重启恢复:活跃态作业置 interrupted(进程没了,状态不能装活);ended_at 落定供 GC 计龄 */
      markActiveInterrupted(now: string): number {
        const r = db.prepare(
          `UPDATE aml_jobs SET status = 'interrupted', error = '服务重启,作业中断', ended_at = ? WHERE status IN ('queued','provisioning','training','evaluating') AND ended_at IS NULL`,
        ).run(now)
        return Number(r.changes)
      },
      setState(id: string, status: AmlJobStatus, stage: string, progress: number): void {
        jobState.run(status, stage, progress, id)
      },
      markStarted(id: string, status: AmlJobStatus, stage: string, now: string): void {
        db.prepare(`UPDATE aml_jobs SET status = ?, stage = ?, started_at = COALESCE(started_at, ?) WHERE id = ?`)
          .run(status, stage, now, id)
      },
      finish(id: string, status: AmlJobStatus, metricsJson: string, gatesJson: string, artifactsPath: string, now: string): void {
        jobFinish.run(status, metricsJson, gatesJson, artifactsPath, null, now, id)
      },
      fail(id: string, status: AmlJobStatus, error: string, now: string): void {
        jobFail.run(status, error, now, id)
      },
      requeue(id: string): void {
        jobRetryBump.run(id)
      },
      remove(id: string): void {
        db.prepare('DELETE FROM aml_jobs WHERE id = ?').run(id)
      },
      /** 删除作业时级联清实验谱系(否则实验行成为悬挂元数据) */
      removeExperimentsOf(jobId: string): number {
        const r = db.prepare('DELETE FROM aml_experiments WHERE job_id = ?').run(jobId)
        return Number(r.changes)
      },
    },

    // ----- experiments -----
    experiment: {
      insert(e: {
        id: string
        jobId: string
        datasetId: string
        parentExperimentId?: string | null
        changeNote: string
        configJson: string
        seed?: number | null
        createdAt: string
      }): void {
        expInsert.run(e.id, e.jobId, e.datasetId, e.parentExperimentId ?? null, e.changeNote,
          e.configJson, '{}', '{}', 'running', e.seed ?? null, e.createdAt)
      },
      get(id: string): AmlExperimentRow | undefined {
        const r = db.prepare(`SELECT ${EXP_COLS} FROM aml_experiments WHERE id = ?`).get(id)
        return r ? rowToExperiment(r as Record<string, unknown>) : undefined
      },
      listByDataset(datasetId: string, limit = 50): AmlExperimentRow[] {
        return (db.prepare(`SELECT ${EXP_COLS} FROM aml_experiments WHERE dataset_id = ? ORDER BY created_at DESC LIMIT ?`)
          .all(datasetId, limit) as unknown as Record<string, unknown>[]).map(rowToExperiment)
      },
      setResult(id: string, metricsJson: string, gatesJson: string, status: string): void {
        expResult.run(metricsJson, gatesJson, status, id)
      },
      countByDataset(datasetId: string): number {
        const r = db.prepare('SELECT COUNT(*) AS c FROM aml_experiments WHERE dataset_id = ?').get(datasetId) as { c: number }
        return r.c
      },
    },

    // ----- models -----
    model: {
      insert(m: {
        id: string
        experimentId: string
        datasetId: string
        productId: string
        recipeId: string
        purpose: string
        ioSpecJson: string
        metricsJson: string
        path: string
        createdBy: string
        note: string
        createdAt: string
      }): void {
        modelInsert.run(m.id, m.experimentId, m.datasetId, m.productId, m.recipeId, m.purpose,
          m.ioSpecJson, m.metricsJson, m.path, m.createdBy, m.note, m.createdAt)
      },
      get(id: string): AmlModelRow | undefined {
        const r = db.prepare(`SELECT ${MODEL_COLS} FROM aml_models WHERE id = ?`).get(id)
        return r ? rowToModel(r as Record<string, unknown>) : undefined
      },
      list(filter: { stage?: string, recipeId?: string, productId?: string, limit?: number } = {}): AmlModelRow[] {
        const where: string[] = []
        const args: SQLInputValue[] = []
        if (filter.stage) {
          where.push('stage = ?')
          args.push(filter.stage)
        }
        if (filter.productId) {
          where.push('product_id = ?')
          args.push(filter.productId)
        }
        if (filter.recipeId) {
          where.push('recipe_id = ?')
          args.push(filter.recipeId)
        }
        const sql = `SELECT ${MODEL_COLS} FROM aml_models ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY created_at DESC LIMIT ?`
        args.push(filter.limit ?? 100)
        return (db.prepare(sql).all(...args) as unknown as Record<string, unknown>[]).map(rowToModel)
      },
      /** 每组 (product, recipe, purpose) 当前 production 模型(唯一性由晋升事务保证) */
      productionOf(productId: string, recipeId: string, purpose: string): AmlModelRow | undefined {
        const r = db.prepare(
          `SELECT ${MODEL_COLS} FROM aml_models WHERE product_id = ? AND recipe_id = ? AND purpose = ? AND stage = 'production'
           ORDER BY promoted_at DESC LIMIT 1`,
        ).get(productId, recipeId, purpose)
        return r ? rowToModel(r as Record<string, unknown>) : undefined
      },
      /** 条件晋升:仅当仍处于期望旧阶段时生效(并发竞态在 SQL 层兜底);返回是否生效 */
      transition(id: string, fromStage: AmlModelStage, toStage: AmlModelStage, by: string, now: string): boolean {
        const r = modelStage.run(toStage, by, now, id, fromStage)
        return Number(r.changes) > 0
      },
      markPruned(id: string): void {
        modelPrune.run(id)
      },
      remove(id: string): void {
        db.prepare('DELETE FROM aml_models WHERE id = ?').run(id)
      },
      updateNote(id: string, note: string): void {
        db.prepare('UPDATE aml_models SET note = ? WHERE id = ?').run(note, id)
      },
    },
  }
}

export type AmlRepo = ReturnType<typeof createAmlRepo>
