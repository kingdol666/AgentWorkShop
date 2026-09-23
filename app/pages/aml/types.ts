/**
 * AML 页面共享类型(对齐 server/services/workshop/aml 行投影)。
 */

export interface AmlRuntimeStatus {
  python: { ok: boolean, version?: string, reason?: string }
  venvReady: boolean
  amlRoot?: string
  queued: number
  running: number
}
/** uv 探测结果(与 server aml/python-runtime.UvProbe 同形) */
export interface AmlUvProbe {
  ok: boolean
  path?: string
  version?: string
  source?: 'config' | 'project' | 'state' | 'path'
  reason?: string
}
/** 环境异步任务(一键安装 uv / 创建 venv);进度经轮询 GET /env */
export interface AmlEnvTask {
  id: string
  kind: 'install-uv' | 'create-venv'
  status: 'running' | 'done' | 'failed'
  startedAt: string
  endedAt: string | null
  log: string[]
  error: string | null
}
/** 完整环境自检(与 server aml/env-manager.AmlEnvStatus 同形) */
export interface AmlEnvStatus {
  amlRoot: string
  amlRootMode: string
  amlRootSource: string
  projectRoot: string | null
  dirs: { datasets: string, jobs: string, models: string, venv: string, tools: string, runtime: string }
  uv: AmlUvProbe
  python: { ok: boolean, pythonPath?: string, version?: string, reason?: string }
  venv: { ready: boolean, dir: string, pythonPath: string, requirementsHash: string, sizeMb: number }
  disk: { usedMb: number, quotaMb: number }
  canInstallUv: boolean
  task: AmlEnvTask | null
  preflight: { canRunJobs: boolean, blockers: string[] }
}
/** 元数据 ↔ 实体 对账结果 */
export interface AmlInventory {
  root: string
  counts: { datasets: number, jobs: number, models: number }
  entities: { datasets: number, jobs: number, models: number }
  issues: Array<{ kind: string, id: string, problem: string, path: string, detail: string }>
  ok: boolean
}
export interface AmlOverview {
  runtime: AmlRuntimeStatus
  env?: {
    amlRoot: string
    amlRootSource: string
    uv: AmlUvProbe
    venv: AmlEnvStatus['venv']
    disk: AmlEnvStatus['disk']
    preflight: AmlEnvStatus['preflight']
    task: { id: string, kind: string, status: string } | null
  }
  counts: { datasets: number, models: number, productions: number }
}
export interface AmlDatasetRow {
  id: string
  lineId: string
  productId: string
  recipeId: string
  runIds: string[]
  rowCount: number
  createdBy: string
  createdByKind: string
  note: string
  createdAt: string
}
export interface SeriesSummary {
  nodeId: string
  role: string
  count: number
  mean: number
  std: number
  min: number
  max: number
  missingRatio: number
  cleanedRatio: number
}
export interface LagEstimate { controlId: string, targetId: string, lagSteps: number, corr: number }
/** 逐 run 画像(服务端 server/services/workshop/aml/stats.ts 导出;此处镜像其线格式) */
export interface RunProfile {
  runId: string
  steps: number
  /** 目标节点逐 run 均值(漂移检测) */
  targetMeans: Record<string, number>
}
export interface AmlDatasetReport {
  builtAt: string
  nodeSummaries: SeriesSummary[]
  lagEstimates: LagEstimate[]
  runProfiles: RunProfile[]
  cleaning: Record<string, { total: number, droppedState: number, droppedRange: number, droppedHampel: number, interpolated: number, missingRatio: number }>
  runsUsed: string[]
  runsDropped: { runId: string, reason: string }[]
  windowCount: { train: number, val: number, test: number }
}
export interface PlatformMetrics {
  oneStepVal?: { windows: number, nrmse: number } | null
  oneStepTest?: { windows: number, nrmse: number } | null
  rolloutTest?: { windows: number, nrmse: number, horizon: number } | null
}
export interface AmlJobRow {
  id: string
  datasetId: string
  purpose: string
  status: string
  stage: string
  progress: number
  metricsJson: string | null
  error: string | null
  retryCount: number
  createdAt: string
  startedAt: string | null
  endedAt: string | null
}
export interface GateCheck { id: string, name: string, value: number | null, threshold: number | null, pass: boolean, detail: string }
export interface GateReport { passed: boolean, checks: GateCheck[] }
export interface AmlExperiment {
  id: string
  jobId: string
  datasetId: string
  parentExperimentId: string | null
  changeNote: string
  metrics: PlatformMetrics | null
  gates: GateReport | null
  status: string
  createdAt: string
}
export type AmlModelStage = 'candidate' | 'shadow' | 'production' | 'retired'
export interface IoSpec {
  purpose: string
  historySteps: number
  horizonSteps: number
  allNodes: string[]
  controlNodes: string[]
  targetNodes: string[]
  beatMs: number
  assumptions: string
}
export interface AmlModelRow {
  id: string
  experimentId: string
  datasetId: string
  productId: string
  recipeId: string
  purpose: string
  stage: AmlModelStage
  ioSpec: IoSpec | null
  metrics: PlatformMetrics | null
  note: string
  createdAt: string
}
export interface PredictResult {
  modelId: string
  stage: string
  targetNodes: string[]
  forecast: number[][]
  beatMs: number
  assumptions: string
}

/** GET /datasets 信封 */
export interface AmlDatasetListPayload { datasets: AmlDatasetRow[] }
/** GET /datasets/:id 信封(行 + 清洗报告) */
export interface AmlDatasetBundle { dataset: AmlDatasetRow, report: AmlDatasetReport | null }
/** 数据集行内展开态 */
export interface DsDetail { loading: boolean, error: string, report: AmlDatasetReport | null }
/** GET /jobs 信封 */
export interface AmlJobListPayload { jobs: AmlJobRow[] }
/** GET /jobs/:id 信封(行 + 指标 + 门禁) */
export interface AmlJobBundle { job: AmlJobRow, metrics: PlatformMetrics | null, gates: GateReport | null }
/** 作业行内展开态 */
export interface JobDetail { loading: boolean, error: string, metrics: PlatformMetrics | null, gates: GateReport | null, logs: string[] }
/** GET /models 信封 */
export interface AmlModelListPayload { models: AmlModelRow[] }
/** GET /experiments 信封 */
export interface AmlExperimentListPayload { experiments: AmlExperiment[] }
/** 新建数据集表单里的节点草稿(spec 与 server/services/workshop/aml/spec.ts 的 zod 模式对齐) */
export interface DsNodeDraft { nodeId: string, role: 'control' | 'feature' | 'target' }
