/**
 * AML 元数据 ↔ 实体 对账与实体加载。
 *
 * 平台是「SQLite 元数据 + 磁盘实体」两段式:
 *   元数据行(aml_datasets/jobs/models)给出可检索、可分页、可鉴权的索引;
 *   实体目录(<amlRoot>/{datasets,jobs,models}/<id>/)给出真正的数据(数组/工件/契约)。
 *
 * 两者会漂移:手工删了目录、拷了别人的 ./aml 进来、作业被中途 kill 留下半成品、
 * 元数据行指向的路径被搬走。本模块提供:
 *   - inventory():两侧逐 id 对账,产出 missing / orphan / size 三类差异(只读);
 *   - loadDatasetEntity() / loadModelEntity() / loadJobEntity():按元数据行加载实体,
 *     并校验契约文件齐备 —— 实际作业(预测/训练/评审)直接用它的返回值,不各自拼路径;
 *   - pruneOrphans():删除**孤儿实体目录**(磁盘有、元数据无),带根内越界防护。
 *
 * 纪律:元数据是权威索引,实体是权威内容。宁可报告"实体缺失"也不静默用空数据顶替
 * (静默顶替会让预测用空权重跑出一堆看似正常的垃圾结果)。
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../../../utils/errors'
import { createLogger } from '../logger'
import { getAmlRuntime, isInsideAmlRoot, type AmlRuntime } from './runtime'

const log = createLogger('aml.entity')

export interface EntityIssue {
  kind: 'dataset' | 'job' | 'model'
  id: string
  problem: 'entity_missing' | 'orphan_dir' | 'contract_missing'
  path: string
  detail: string
}

export interface AmlInventory {
  root: string
  counts: { datasets: number, jobs: number, models: number }
  entities: { datasets: number, jobs: number, models: number }
  issues: EntityIssue[]
  ok: boolean
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => {
      try {
        return statSync(join(dir, e)).isDirectory()
      }
      catch {
        return false
      }
    })
  }
  catch {
    return []
  }
}

function fileSize(p: string): number {
  const st = statSync(p, { throwIfNoEntry: false })
  return st?.isFile() ? st.size : 0
}

/** 两侧逐 id 对账(只读;不修改任何东西) */
export function inventory(): AmlInventory {
  const rt = getAmlRuntime()
  const issues: EntityIssue[] = []
  const dsRows = rt.repo.dataset.list({ limit: 100_000 })
  const jobRows = rt.repo.job.list({ limit: 100_000 })
  const modelRows = rt.repo.model.list({ limit: 100_000 })

  const check = (
    kind: EntityIssue['kind'],
    rows: Array<{ id: string, path?: string }>,
    baseDir: string,
    contract: string[],
  ): number => {
    const ids = new Set(rows.map(r => r.id))
    for (const r of rows) {
      const dir = join(baseDir, r.id)
      if (!existsSync(dir)) {
        issues.push({
          kind, id: r.id, problem: 'entity_missing', path: dir,
          detail: `元数据存在但实体目录缺失(可能是手工删除或从别处拷贝了元数据行)`,
        })
        continue
      }
      // 契约文件允许是"多选一"(例如模型:新实体有 io_spec.json,旧实体只有 REGISTERED)
      if (contract.length > 0 && !contract.some(f => existsSync(join(dir, f)))) {
        issues.push({
          kind, id: r.id, problem: 'contract_missing', path: join(dir, contract[0]),
          detail: `实体目录存在但缺少契约文件(${contract.join(' 或 ')}):作业被中途终止或落盘不完整`,
        })
      }
    }
    let n = 0
    for (const d of listDirs(baseDir)) {
      n++
      if (!ids.has(d)) {
        issues.push({
          kind, id: d, problem: 'orphan_dir', path: join(baseDir, d),
          detail: '磁盘有实体目录但元数据无对应行(可安全清理)',
        })
      }
    }
    return n
  }

  // 契约:数据集 = manifest.json(权威,列定义/归一化/形状);
  //       作业 = job.json(提交契约);模型 = REGISTERED 或 io_spec.json(新旧两种形态)
  const dsEntities = check('dataset', dsRows, rt.datasetsDir, ['manifest.json'])
  const jobEntities = check('job', jobRows, rt.jobsDir, ['job.json'])
  const modelEntities = check('model', modelRows, rt.modelsDir, ['REGISTERED', 'io_spec.json'])

  return {
    root: rt.root,
    counts: { datasets: dsRows.length, jobs: jobRows.length, models: modelRows.length },
    entities: { datasets: dsEntities, jobs: jobEntities, models: modelEntities },
    issues,
    ok: issues.length === 0,
  }
}

/** 实体目录大小(递归;目录缺失 = 0) */
export function entitySizeBytes(dir: string): number {
  let total = 0
  const walk = (d: string, depth: number) => {
    if (depth > 8) return
    let entries: string[]
    try {
      entries = readdirSync(d)
    }
    catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e)
      const st = statSync(p, { throwIfNoEntry: false })
      if (!st) continue
      if (st.isDirectory()) walk(p, depth + 1)
      else total += st.size
    }
  }
  walk(dir, 0)
  return total
}

function readJson<T>(p: string, what: string): T {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  }
  catch (err) {
    throw new AppError(500, 'AML_ENTITY_CORRUPT', `${what} 读取失败(${p}):${(err as Error).message}`)
  }
}

export interface DatasetEntity {
  id: string
  dir: string
  spec: Record<string, unknown>
  /** spec 是否来自实体自带的 spec.json(true)/ 回退元数据行(false,旧快照) */
  specFromEntity: boolean
  manifest: {
    columns?: Array<{ name: string, kind?: string, count?: number }>
    rowCount?: number
    beatMs?: number
    horizon?: number
    targetColumns?: string[]
    featureColumns?: string[]
    [k: string]: unknown
  }
  report: Record<string, unknown> | null
  arrays: Array<{ file: string, bytes: number }>
  sizeBytes: number
}

/** 按元数据行加载数据集实体(实际训练/预览的数据入口)
 *
 *  契约文件:`manifest.json` 是**权威**(列定义/归一化/切分/形状),缺它无法训练;
 *  `spec.json` 是自描述副本(取数规格),旧快照可能没有 —— 此时回退元数据行的 specJson,
 *  而不是把可用的数据集判成损坏。
 */
export function loadDatasetEntity(id: string): DatasetEntity {
  const rt = getAmlRuntime()
  const row = rt.repo.dataset.get(id)
  if (!row) throw new AppError(404, 'AML_DATASET_MISSING', `数据集 ${id} 不存在`)
  const dir = join(rt.datasetsDir, id)
  if (!existsSync(dir)) {
    throw new AppError(410, 'AML_ENTITY_MISSING', `数据集 ${id} 的实体目录已丢失(${dir});元数据仍在。请重新构建数据集,或执行实体对账清理该元数据行。`)
  }
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new AppError(410, 'AML_ENTITY_CONTRACT_MISSING', `数据集 ${id} 缺少 manifest.json(权威契约,落盘不完整):${manifestPath}`)
  }
  const arraysDir = join(dir, 'arrays')
  const arrays = existsSync(arraysDir)
    ? readdirSync(arraysDir).map(f => ({ file: f, bytes: fileSize(join(arraysDir, f)) }))
    : []
  // spec 优先取实体自带的 spec.json(可移植),缺失回退元数据行(旧快照)
  const specPath = join(dir, 'spec.json')
  let spec: Record<string, unknown>
  if (existsSync(specPath)) {
    spec = readJson<Record<string, unknown>>(specPath, 'spec.json')
  }
  else {
    try {
      spec = JSON.parse(row.specJson || '{}') as Record<string, unknown>
    }
    catch {
      spec = {}
    }
  }
  return {
    id,
    dir,
    spec,
    specFromEntity: existsSync(specPath),
    manifest: readJson<DatasetEntity['manifest']>(manifestPath, 'manifest.json'),
    report: existsSync(join(dir, 'report.json'))
      ? readJson<Record<string, unknown>>(join(dir, 'report.json'), 'report.json')
      : null,
    arrays,
    sizeBytes: entitySizeBytes(dir),
  }
}

export interface ModelEntity {
  id: string
  dir: string
  onnxPath: string
  onnxBytes: number
  ioSpec: Record<string, unknown>
  /** ioSpec 是否来自实体自带的 io_spec.json(true)/ 回退元数据行(false,旧模型) */
  ioSpecFromEntity: boolean
  metrics: Record<string, unknown>
  sizeBytes: number
}

/** 按元数据行加载模型实体(预测入口;工件缺失直接报错,不用空权重蒙混)
 *
 *  契约:`REGISTERED` 标记或 `io_spec.json` 至少存在其一(旧模型只有 REGISTERED);
 *  io_spec 优先取实体自带副本,缺失回退元数据行的 io_spec_json。
 */
export function loadModelEntity(id: string): ModelEntity {
  const rt = getAmlRuntime()
  const row = rt.repo.model.get(id)
  if (!row) throw new AppError(404, 'AML_MODEL_MISSING', `模型 ${id} 不存在`)
  const dir = join(rt.modelsDir, id)
  if (!existsSync(dir)) {
    throw new AppError(410, 'AML_ENTITY_MISSING', `模型 ${id} 的实体目录已丢失(${dir});元数据仍在。`)
  }
  const ioPath = join(dir, 'io_spec.json')
  if (!existsSync(ioPath) && !existsSync(join(dir, 'REGISTERED'))) {
    throw new AppError(410, 'AML_ENTITY_CONTRACT_MISSING', `模型 ${id} 既无 io_spec.json 也无 REGISTERED 标记(注册不完整):${dir}`)
  }
  let ioSpec: Record<string, unknown>
  if (existsSync(ioPath)) {
    ioSpec = readJson<Record<string, unknown>>(ioPath, 'io_spec.json')
  }
  else {
    try {
      ioSpec = JSON.parse(row.ioSpecJson || '{}') as Record<string, unknown>
    }
    catch {
      ioSpec = {}
    }
  }
  const onnxPath = join(dir, 'model.onnx')
  return {
    id,
    dir,
    onnxPath,
    onnxBytes: fileSize(onnxPath),
    ioSpec,
    ioSpecFromEntity: existsSync(ioPath),
    metrics: (() => {
      try {
        return JSON.parse(row.metricsJson || '{}') as Record<string, unknown>
      }
      catch {
        return {}
      }
    })(),
    sizeBytes: entitySizeBytes(dir),
  }
}

export interface JobEntity {
  id: string
  dir: string
  job: Record<string, unknown>
  workspace: string[]
  logTail: string
  artifacts: Array<{ file: string, bytes: number }>
  sizeBytes: number
}

/** 按元数据行加载作业实体(工作区/日志/工件;供日志查看与工件评审) */
export function loadJobEntity(id: string): JobEntity {
  const rt = getAmlRuntime()
  const row = rt.repo.job.get(id)
  if (!row) throw new AppError(404, 'AML_JOB_MISSING', `作业 ${id} 不存在`)
  const dir = join(rt.jobsDir, id)
  if (!existsSync(dir)) {
    throw new AppError(410, 'AML_ENTITY_MISSING', `作业 ${id} 的实体目录已丢失(${dir});元数据仍在。`)
  }
  const wsDir = join(dir, 'workspace')
  const artDir = join(dir, 'artifacts')
  const logPath = join(dir, 'run.log')
  let logTail = ''
  try {
    if (existsSync(logPath)) logTail = readFileSync(logPath, 'utf8').slice(-4000)
  }
  catch { /* 日志不可读不影响其余实体 */ }
  return {
    id,
    dir,
    job: existsSync(join(dir, 'job.json'))
      ? readJson<Record<string, unknown>>(join(dir, 'job.json'), 'job.json')
      : { note: 'job.json 缺失(作业提交时未落盘)' },
    workspace: existsSync(wsDir) ? readdirSync(wsDir) : [],
    logTail,
    artifacts: existsSync(artDir)
      ? readdirSync(artDir).map(f => ({ file: f, bytes: fileSize(join(artDir, f)) }))
      : [],
    sizeBytes: entitySizeBytes(dir),
  }
}

/**
 * 删除实体目录(带 AML 根内越界防护)。
 * 只删 <amlRoot>/{datasets,jobs,models}/<id> 形状的路径 —— 元数据里的 path 字段
 * 来自历史写入,不能无条件信任(它可能是任意绝对路径)。
 */
export function removeEntityDir(rt: AmlRuntime, kind: 'dataset' | 'job' | 'model', id: string): { removed: boolean, dir: string } {
  const base = kind === 'dataset' ? rt.datasetsDir : kind === 'job' ? rt.jobsDir : rt.modelsDir
  const dir = join(base, id)
  if (!isInsideAmlRoot(rt, dir) || !dir.startsWith(base)) {
    log.warn(`[aml-entity] 拒绝删除越界路径:${dir}`)
    return { removed: false, dir }
  }
  if (!existsSync(dir)) return { removed: false, dir }
  try {
    rmSync(dir, { recursive: true, force: true })
    return { removed: true, dir }
  }
  catch (err) {
    throw new AppError(500, 'AML_ENTITY_DELETE_FAILED', `删除实体目录失败(${dir}):${(err as Error).message}`)
  }
}

/** 清理孤儿实体目录(磁盘有、元数据无);dryRun=true 只报告不删除 */
export function pruneOrphans(dryRun = false): { removed: string[], kept: number, dryRun: boolean } {
  const rt = getAmlRuntime()
  const inv = inventory()
  const orphans = inv.issues.filter(i => i.problem === 'orphan_dir')
  const removed: string[] = []
  if (!dryRun) {
    for (const o of orphans) {
      const r = removeEntityDir(rt, o.kind, o.id)
      if (r.removed) removed.push(r.dir)
    }
    if (removed.length > 0) log.info(`[aml-entity] 已清理 ${removed.length} 个孤儿实体目录`)
  }
  return { removed, kept: inv.issues.length - orphans.length, dryRun }
}
