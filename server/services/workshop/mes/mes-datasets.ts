/**
 * MES CSV 数据集服务 —— mes-rest 节点历史取数的落盘事实源。
 *
 * 定位(铁律:MES 原文不进 prompt):Agent 经 mes_fetch 取历史数据时,
 * 行级原文只写进 <configRoot>/datasets/<dataset_id>.csv(表头 ts,value;RFC4180 转义;UTF-8),
 * 工具回包只给 stats + ≤3 行采样。取数作业 = **进程内异步执行**(createFetchJob 里
 * `void run()` 即返,绝不进任何调度循环);账本落 mes_fetch_jobs / mes_datasets 两表。
 *
 * 驱动边界:本模块不 import mes-rest.ts(并行工作流实现中),只经 resolveDcwDriver('mes-rest')
 * 取既有 DcwWriteDriver 的可选 fetchHistory 原语(结构化本地声明,签名与驱动面约定一致)。
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { DcwWriteDriver } from '../dcw/drivers/shared'
import { resolveDcwDriver } from '../dcw/drivers'
import { AppError, ErrorCodes } from '../../../utils/errors'

// ============================================================
// 驱动历史原语(本地结构化声明;不 import 驱动实现)
// ============================================================

/** 历史行(格式全谱:标量/向量/图像/记录;数据集 CSV 只消费 scalar 与 vector) */
export interface DcwHistoryRow {
  ts: string
  value?: number
  values?: number[]
  data?: string
  mime?: string
  record?: unknown
}

export interface DcwFetchHistoryInput {
  driverConfig: Record<string, unknown>
  fromIso: string
  toIso: string
  maxRows: number
  onRows: (rows: DcwHistoryRow[]) => Promise<void> | void
}

export interface DcwFetchHistoryResult { rows: number, complete: boolean }

/** mes-rest 写驱动的本模块视角(既有 DcwWriteDriver + 可选 fetchHistory;kind 放宽为 string,便于测试注入假驱动) */
export type MesHistoryDriver = Omit<DcwWriteDriver, 'kind'> & {
  kind: string
  fetchHistory?(input: DcwFetchHistoryInput): Promise<DcwFetchHistoryResult>
}

// ============================================================
// CSV 原语(RFC4180:引号/逗号/换行转义;CRLF 行结束;UTF-8)
// ============================================================

/** 单字段转义:含 引号/逗号/CR/LF 时加引号并把内部引号翻倍 */
export function csvEscapeField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** 一行数据:ts,value(value 非数值写空串,统计侧跳过) */
export function csvLineOf(ts: string, value: number): string {
  const v = Number.isFinite(value) ? String(value) : ''
  return `${csvEscapeField(ts)},${v}`
}

/**
 * 向量宽表一行:ts,v0..v{n-1}。维度以首行为准:短行补空(统计侧跳过),长行截断;
 * 返回 null = 该行不落盘(非数值向量)。
 */
export function csvVectorLineOf(ts: string, values: number[], dim: number): string | null {
  if (!Array.isArray(values) || values.length === 0 || dim < 1) return null
  const cells = [csvEscapeField(ts)]
  for (let i = 0; i < dim; i++) {
    const v = i < values.length ? values[i] : undefined
    cells.push(Number.isFinite(v) ? String(v) : '')
  }
  return cells.join(',')
}

/** RFC4180 行解析(支持引号内逗号/双引号转义;单行内不含裸换行) */
export function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        }
        else inQuotes = false
      }
      else cur += c
    }
    else if (c === '"') inQuotes = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    }
    else cur += c
  }
  out.push(cur)
  return out
}

// ============================================================
// 行类型
// ============================================================

export interface MesDatasetRow {
  id: string
  lineId: string
  nodeId: string
  nodeName: string
  fromTs: string | null
  toTs: string | null
  rows: number
  sha256: string
  filePath: string
  /** running(取数中) | ready | failed */
  status: string
  error: string
  createdBy: string
  createdAt: string
}

export interface MesFetchJobRow {
  id: string
  datasetId: string
  agentId: string
  /** running | done | failed */
  status: string
  rows: number
  error: string
  createdAt: string
  updatedAt: string
}

const DATASET_COLS = `id, line_id AS lineId, node_id AS nodeId, node_name AS nodeName, from_ts AS fromTs,
  to_ts AS toTs, rows, sha256, file_path AS filePath, status, error, created_by AS createdBy, created_at AS createdAt`
const JOB_COLS = `id, dataset_id AS datasetId, agent_id AS agentId, status, rows, error, created_at AS createdAt, updated_at AS updatedAt`

/** 存储行 → 领域行(数值列归一;进程内异步账本,跨进程的 running 视为 stale) */
function toDatasetRow(r: Record<string, unknown>, bootedAt: string): MesDatasetRow {
  const row = {
    id: String(r.id),
    lineId: String(r.lineId ?? ''),
    nodeId: String(r.nodeId ?? ''),
    nodeName: String(r.nodeName ?? ''),
    fromTs: r.fromTs == null ? null : String(r.fromTs),
    toTs: r.toTs == null ? null : String(r.toTs),
    rows: Number(r.rows ?? 0),
    sha256: String(r.sha256 ?? ''),
    filePath: String(r.filePath ?? ''),
    status: String(r.status ?? 'ready'),
    error: String(r.error ?? ''),
    createdBy: String(r.createdBy ?? ''),
    createdAt: String(r.createdAt ?? ''),
  }
  // 进程内异步:上一进程遗留的 running 永远不会再被本进程 finalize,如实呈现为 failed
  if (row.status === 'running' && row.createdAt < bootedAt) {
    row.status = 'failed'
    row.error = row.error || '服务重启,取数进程已消失(作业未完成)'
  }
  return row
}

function toJobRow(r: Record<string, unknown>, bootedAt: string): MesFetchJobRow {
  const row = {
    id: String(r.id),
    datasetId: String(r.datasetId ?? ''),
    agentId: String(r.agentId ?? ''),
    status: String(r.status ?? 'running'),
    rows: Number(r.rows ?? 0),
    error: String(r.error ?? ''),
    createdAt: String(r.createdAt ?? ''),
    updatedAt: String(r.updatedAt ?? ''),
  }
  if (row.status === 'running' && row.createdAt < bootedAt) {
    row.status = 'failed'
    row.error = row.error || '服务重启,取数进程已消失(作业未完成)'
  }
  return row
}

// ============================================================
// 读取视图
// ============================================================

export type MesDatasetReadMode = 'head' | 'stats' | 'rows'

export interface MesDatasetHeadView { columns: string[], totalRows: number, preview: string[][] }
/** count/min/max/mean/stddev(采样标准差 n-1)针对 value 数值列;首末 ts 取首末数值行 */
export interface MesDatasetStatsView {
  count: number
  min: number | null
  max: number | null
  mean: number | null
  stddev: number | null
  firstTs: string | null
  lastTs: string | null
}
export interface MesDatasetRowsView { offset: number, total: number, rows: string[][] }

export type MesDatasetRead
  = { meta: MesDatasetRow, mode: 'head', head: MesDatasetHeadView }
    | { meta: MesDatasetRow, mode: 'stats', stats: MesDatasetStatsView }
    | { meta: MesDatasetRow, mode: 'rows', rowsView: MesDatasetRowsView }

// ============================================================
// 仓储工厂(全 prepared 占位符绑定,零字符串拼接)
// ============================================================

export interface MesCreateFetchJobInput {
  nodeId: string
  fromIso?: string
  toIso?: string
  maxRows: number
  agentId: string
  lineId?: string
  nodeName?: string
  /** 节点驱动配置(取数时透传给驱动) */
  driverConfig?: Record<string, unknown>
}

export type MesDatasetStore = ReturnType<typeof createMesDatasetStore>

export interface MesDatasetStoreOpts {
  /** 驱动解析(缺省走 dcw 注册表;测试注入假驱动,不联网) */
  resolveDriver?: (kind: string) => MesHistoryDriver
}

export function createMesDatasetStore(db: DatabaseSync, datasetsDir: string, opts: MesDatasetStoreOpts = {}) {
  mkdirSync(datasetsDir, { recursive: true })
  // 进程引导时刻:此前的 running 账本属于已消失的进程(查询侧按 failed 呈现)
  const bootedAt = new Date().toISOString()
  const resolveDriver = opts.resolveDriver ?? ((kind: string): MesHistoryDriver => resolveDcwDriver(kind as Parameters<typeof resolveDcwDriver>[0]))

  const insertDataset = db.prepare(
    `INSERT INTO mes_datasets (id, line_id, node_id, node_name, from_ts, to_ts, rows, sha256, file_path, status, error, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, '', ?, 'running', '', ?, ?)`,
  )
  const finalizeDatasetReady = db.prepare(
    `UPDATE mes_datasets SET rows = ?, sha256 = ?, status = 'ready', error = ? WHERE id = ?`,
  )
  const finalizeDatasetFailed = db.prepare(
    `UPDATE mes_datasets SET status = 'failed', error = ? WHERE id = ?`,
  )
  const selectDatasetById = db.prepare(`SELECT ${DATASET_COLS} FROM mes_datasets WHERE id = ?`)
  const selectDatasetsRecent = db.prepare(`SELECT ${DATASET_COLS} FROM mes_datasets ORDER BY created_at DESC LIMIT ?`)

  const insertJob = db.prepare(
    `INSERT INTO mes_fetch_jobs (id, dataset_id, agent_id, status, rows, error, created_at, updated_at)
     VALUES (?, ?, ?, 'running', 0, '', ?, ?)`,
  )
  const finalizeJobDone = db.prepare(
    `UPDATE mes_fetch_jobs SET status = 'done', rows = ?, error = '', updated_at = ? WHERE id = ?`,
  )
  const finalizeJobFailed = db.prepare(
    `UPDATE mes_fetch_jobs SET status = 'failed', rows = ?, error = ?, updated_at = ? WHERE id = ?`,
  )
  const selectJobById = db.prepare(`SELECT ${JOB_COLS} FROM mes_fetch_jobs WHERE id = ?`)

  /** 同步分块写(处理部分写)+ 增量 sha256(免二次读文件) */
  function writeAll(fd: number, hash: ReturnType<typeof createHash>, text: string): void {
    const buf = Buffer.from(text, 'utf8')
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
    hash.update(buf)
  }

  function csvPathOf(datasetId: string): string {
    // datasetId 由本服务生成(字符集受控);仍防御路径逃逸
    const safe = datasetId.replace(/[^A-Za-z0-9_-]/g, '')
    return join(datasetsDir, `${safe || 'unknown'}.csv`)
  }

  /** 取数执行体(进程内异步;写 CSV → sha256 → dataset=ready → job=done;异常 → 双 failed+error) */
  async function runFetchJob(jobId: string, datasetId: string, input: MesCreateFetchJobInput): Promise<void> {
    const filePath = csvPathOf(datasetId)
    const driver = resolveDriver('mes-rest')
    const maxRows = Math.max(1, Math.min(5000, Math.round(input.maxRows) || 0))
    const hash = createHash('sha256')
    let rows = 0
    let fd: number | null = null
    // 表头延迟决策:首行形态决定标量两列 / 向量宽表(维度以首行为准)
    let headerWritten = false
    let wide = false
    let dim = 0
    let dimDrift = 0
    let skipped = 0
    try {
      if (typeof driver.fetchHistory !== 'function') {
        throw new Error('mes-rest 驱动未提供 fetchHistory 原语(驱动实现缺失或未注册)')
      }
      fd = openSync(filePath, 'w')
      const writeHeader = (line: string): void => {
        writeAll(fd!, hash, `${line}\r\n`)
        headerWritten = true
      }
      const result = await driver.fetchHistory({
        driverConfig: (input.driverConfig ?? {}) as Record<string, unknown>,
        fromIso: String(input.fromIso ?? ''),
        toIso: String(input.toIso ?? ''),
        maxRows,
        onRows: (batch) => {
          if (!Array.isArray(batch) || batch.length === 0) return
          const lines: string[] = []
          for (const r of batch) {
            if (rows >= maxRows) break // 截断保护:即使驱动超发也不越上限
            if (Array.isArray(r?.values)) {
              if (!headerWritten) {
                dim = r.values.length
                wide = true
                writeHeader(`ts,${Array.from({ length: dim }, (_, i) => `v${i}`).join(',')}`)
              }
              if (!wide || dim < 1) {
                skipped++
                continue
              }
              if (r.values.length !== dim) dimDrift++
              const line = csvVectorLineOf(String(r?.ts ?? ''), r.values, dim)
              if (line === null) {
                skipped++
                continue
              }
              lines.push(line)
              rows++
              continue
            }
            // 标量行(或图像/记录行:数据集不落,跳过计数)
            if (typeof r?.value !== 'number') {
              skipped++
              continue
            }
            if (!headerWritten) writeHeader('ts,value')
            lines.push(csvLineOf(String(r?.ts ?? ''), r.value))
            rows++
          }
          if (lines.length > 0) writeAll(fd!, hash, `${lines.join('\r\n')}\r\n`)
        },
      })
      if (!headerWritten) writeHeader('ts,value') // 空结果也要有表头(统计/读回一致性)
      if (fd != null) {
        closeSync(fd)
        fd = null
      }
      // 驱动自报不完整 → ready 但 error 留截断备注(数据仍可用);完整 → error 清空
      const notes = [
        result && result.complete === false ? `truncated:驱动在 maxRows=${maxRows} 内未返回完整窗口` : '',
        wide ? `vector 宽表(dim=${dim}${dimDrift > 0 ? `,维度漂移 ${dimDrift} 行` : ''})` : '',
        skipped > 0 ? `skipped:${skipped} 行不落盘` : '',
      ].filter(Boolean)
      const note = notes.join('; ')
      finalizeDatasetReady.run(rows, hash.digest('hex'), note, datasetId)
      finalizeJobDone.run(rows, new Date().toISOString(), jobId)
    }
    catch (err) {
      if (fd != null) {
        try {
          closeSync(fd)
        }
        catch { /* 已关闭 */ }
      }
      const msg = err instanceof Error ? err.message : String(err)
      // 收敛账本;收尾自身失败(如关机中库已闭)也不允许击穿成 unhandled rejection
      try {
        finalizeDatasetFailed.run(msg.slice(0, 500), datasetId)
        finalizeJobFailed.run(rows, msg.slice(0, 500), new Date().toISOString(), jobId)
      }
      catch (finErr) {
        console.error('[mes-datasets] 取数失败账本收敛异常:', finErr)
      }
    }
  }

  return {
    /** 数据目录(测试/展示用) */
    dir: datasetsDir,

    /** 建 job + dataset(running) 账本并启动进程内异步取数(立即返回,绝不阻塞/不进调度循环) */
    createFetchJob(input: MesCreateFetchJobInput): { jobId: string, datasetId: string } {
      const datasetId = `mesds-${randomUUID().slice(0, 8)}`
      const jobId = `mesjob-${randomUUID().slice(0, 8)}`
      const now = new Date().toISOString()
      const filePath = csvPathOf(datasetId)
      insertDataset.run(
        datasetId, input.lineId ?? '', input.nodeId, input.nodeName ?? '',
        input.fromIso ?? null, input.toIso ?? null, filePath, input.agentId, now,
      )
      insertJob.run(jobId, datasetId, input.agentId, now, now)
      // 进程内异步执行:不 await、不落任何定时器/调度环;异常在 runFetchJob 内自收敛(双 failed)
      void runFetchJob(jobId, datasetId, input)
      return { jobId, datasetId }
    },

    jobStatus(jobId: string): MesFetchJobRow | null {
      const r = selectJobById.get(jobId) as unknown as Record<string, unknown> | undefined
      return r ? toJobRow(r, bootedAt) : null
    },

    datasetMeta(id: string): MesDatasetRow | null {
      const r = selectDatasetById.get(id) as unknown as Record<string, unknown> | undefined
      return r ? toDatasetRow(r, bootedAt) : null
    },

    /** 最近数据集(新→旧) */
    listDatasets(limit = 20): MesDatasetRow[] {
      const rows = selectDatasetsRecent.all(Math.max(1, Math.min(100, Math.round(limit) || 20))) as unknown as Record<string, unknown>[]
      return rows.map(r => toDatasetRow(r, bootedAt))
    },

    /**
     * 读取数据集内容(head/stats/rows)。
     * 数据原文只在结构化字段里返回,渲染层负责「text 只带 stats+≤3 行采样」。
     */
    readDataset(id: string, mode: MesDatasetReadMode = 'head', offset = 0): MesDatasetRead {
      const meta = this.datasetMeta(id)
      if (!meta) throw new AppError(404, ErrorCodes.NOT_FOUND, `数据集 ${id} 不存在(mes_datasets 可列出可见数据集)`)
      if (!existsSync(meta.filePath)) {
        throw new AppError(404, ErrorCodes.NOT_FOUND, `数据集 ${id} 的 CSV 文件缺失(${meta.status === 'running' ? '仍在取数中' : '文件已被清理'})`)
      }
      const raw = readFileSync(meta.filePath, 'utf8')
      const lines = raw.split(/\r?\n/).filter((l, i, arr) => !(l === '' && i === arr.length - 1))
      const columns = lines.length > 0 ? parseCsvLine(lines[0]!) : ['ts', 'value']
      const rows = lines.slice(1).map(l => parseCsvLine(l))
      const valueCol = Math.max(0, columns.indexOf('value') >= 0 ? columns.indexOf('value') : 1)

      if (mode === 'head') {
        return {
          meta,
          mode,
          head: { columns, totalRows: rows.length, preview: rows.slice(0, 5) },
        }
      }
      if (mode === 'stats') {
        const vals: number[] = []
        let firstTs: string | null = null
        let lastTs: string | null = null
        for (const r of rows) {
          const raw = r[valueCol] ?? ''
          // 空串(非数值占位)不能经 Number('')→0 混入统计
          if (raw !== '' && Number.isFinite(Number(raw))) {
            const v = Number(raw)
            vals.push(v)
            if (firstTs == null) firstTs = r[0] ?? null
            lastTs = r[0] ?? lastTs
          }
        }
        const n = vals.length
        const min = n > 0 ? Math.min(...vals) : null
        const max = n > 0 ? Math.max(...vals) : null
        const mean = n > 0 ? vals.reduce((a, b) => a + b, 0) / n : null
        const stddev = n > 1
          ? Math.sqrt(vals.reduce((a, b) => a + (b - mean!) ** 2, 0) / (n - 1))
          : (n === 1 ? 0 : null)
        return { meta, mode, stats: { count: n, min, max, mean, stddev, firstTs, lastTs } }
      }
      // rows:offset 起 20 行分页
      const off = Math.max(0, Math.round(offset) || 0)
      return {
        meta,
        mode,
        rowsView: { offset: off, total: rows.length, rows: rows.slice(off, off + 20) },
      }
    },
  }
}

// ============================================================
// 进程级单例(plugins/workshop.ts 装配;模式同 bindOpsRepos / configureAmlRuntime)
// ============================================================

const g = globalThis as typeof globalThis & { __mesDatasets?: MesDatasetStore }

/** 装配(启动插件调用一次;幂等) */
export function configureMesDatasets(db: DatabaseSync, datasetsDir: string, opts: MesDatasetStoreOpts = {}): MesDatasetStore {
  g.__mesDatasets ??= createMesDatasetStore(db, datasetsDir, opts)
  return g.__mesDatasets
}

/** 读取单例(未装配 = 测试/降级;抛 503 与 manager 未就绪同语义) */
export function getMesDatasets(): MesDatasetStore {
  if (!g.__mesDatasets) {
    throw new AppError(503, 'MES_DATASETS_NOT_READY', 'MES 数据集服务尚未初始化(plugin 未执行)')
  }
  return g.__mesDatasets
}

/** 测试/关机卸载 */
export function resetMesDatasets(): void {
  g.__mesDatasets = undefined
}

/**
 * 默认落盘目录:复用平台配置根解析 —— 运行数据目录(configRoot/data)的上一级,
 * 即 <configRoot>/datasets(与 <configRoot>/aml 同层;dcw-params.json 等以同一条
 * ensureDataDir 链路定位 <configRoot>/data)。
 */
export function defaultDatasetsDir(dataDir: string): string {
  return resolve(dirname(dataDir), 'datasets')
}
