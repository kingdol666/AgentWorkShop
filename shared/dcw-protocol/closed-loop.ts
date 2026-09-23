/**
 * 调控闭环:写入来源/台账/Agent 优化记录与广播载荷
 * (由 shared/dcw-protocol.ts 按职责拆出;内容逐行原文搬运)
 */

// ================================================================
// 调控闭环:参数账本 + Agent 优化记录(RecipeRollBack 体系)
// ================================================================

/** 写来源(账本/优化记录的身份分类) */
export type DcwWriteSource = 'manual' | 'recipe' | 'agent' | 'rollback'

/** write() 第 4 参:账本与优化记录的身份信息 */
export interface DcwWriteMeta {
  source: DcwWriteSource
  /** userId / agentId / 'system' */
  actor: string
  /** 呈现用名(运维日志 summary;缺省回退 actor) */
  actorName?: string
  /** Agent 优化任务关联(尽力而为) */
  taskId?: string
  /** Agent 判定假设(作业环第 3 步声明) */
  hypothesis?: string
  /** D8 基准消融臂(仅 AW_BENCH_MODE=1 时被 write() 识别;生产模式恒忽略) */
  benchArm?: 'no-interlock' | 'no-readback' | 'ungated'
}

/** 参数变更锚点(append-only 账本;参数全量在册的最小单元) */
export interface DcwJournalAnchor {
  id: string
  lineId: string
  nodeId: string
  /** 写前值(物理量纲;null = 无基线首写) */
  prevValue: number | null
  newValue: number
  source: DcwWriteSource
  actor: string
  recipeRunId?: string | null
  recordId?: string
  approvalId?: string
  taskId?: string
  at: string
}

/** 优化记录的通道聚合快照(口径与 runData 一致) */
export interface OptimizationChannelMetrics {
  daqNodeId: string
  ch: string
  unit: string
  latest: number | null
  avg: number | null
  min: number | null
  max: number | null
  cnt: number
  /** 窗口内越配方监控窗采样数;-1 = 不可判(无监控窗/无活动配方) */
  breaches: number
}

export interface OptimizationMetrics {
  at: string
  fromMs: number
  toMs: number
  channels: OptimizationChannelMetrics[]
  degraded?: boolean
}

export type OptimizationStatus
  = 'open'
    | 'judged'
    | 'judged-keep'
    | 'rolled-back'
    | 'superseded'
    | 'superseded-manual'
    | 'closed-line-stop'

export type OptimizationVerdict = 'keep' | 'rollback' | 'uncertain'

/** step 判定(Agent / 系统 / 用户三路;谁判的必须入册) */
export interface OptimizationJudge {
  by: 'agent' | 'system' | 'user'
  actor: string
  verdict: OptimizationVerdict
  reason: string
  at: string
}

/**
 * Agent 优化记录 = 一次调控 step 的完整档案:
 * 设定(参数 from→to)→ 窗口数据(setAt→closedAt 数采聚合,窗口归属制)→ 判定(judge)。
 * 开于设定、闭于下次设定/判定回退/停线 —— 「距离下次优化之间的数采数据」即 windowAgg。
 */
export interface OptimizationRecord {
  id: string
  lineId: string
  nodeId: string
  nodeName: string
  /** 关联配方(该线活动 run 的 recipeId;无活动批次为 null) */
  recipeId: string | null
  agentId?: string
  taskId?: string
  hypothesis: string
  params: Array<{ nodeId: string, templateRef: string, from: number | null, to: number }>
  setAt: string
  closedAt?: string
  closedBy?: 'superseded' | 'superseded-manual' | 'line-stop' | 'judged'
  status: OptimizationStatus
  judge: OptimizationJudge | null
  anchorId: string
  /** 设定前基线聚合(近 baselineMs 窗) */
  baseline?: OptimizationMetrics
  /** [setAt → closedAt] 全窗聚合(窗口归属制;异步补齐) */
  windowAgg?: OptimizationMetrics
  aggPending?: boolean
  /** 回退来源记录(回退产生的新记录回指原记录) */
  rollbackOf?: string
  rollbackAnchorId?: string
  policy: 'auto_rollback' | 'approve_rollback' | 'observe_only'
  evaluatedAt?: string
  createdAt: string
}

/** 节点参数台账(三值对照 + 在册历史;一次读全) */
export interface DcwParamLedger {
  nodeId: string
  nodeName: string
  current: number | null
  recipeTarget: number | null
  lastGood: number | null
  journal: DcwJournalAnchor[]
  records: OptimizationRecord[]
}

/** dcw.optimization.changed 帧载荷 */
export interface AepDcwOptimizationChange {
  event: 'opened' | 'judged' | 'closed' | 'rolled-back'
  record: OptimizationRecord
}
