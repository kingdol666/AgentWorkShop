/**
 * TsdbPort —— 时序数据库端口(hexagonal seam)。
 *
 * 数采读数的唯一持久化出口;采集管线只依赖此接口:
 *   采集(生产者) → MQTT 队列 → 消费者 → writeSamples() 落时序库
 *                                                ↘ query()/latest() → 前端历史/图表
 *
 * 实现:
 *  - timescale.adapter —— 生产级 TimescaleDB(PostgreSQL + timescaledb 扩展),
 *    由环境变量 DAQ_TSDB_URL(postgres://…)启用;自动建表 + create_hypertable。
 *  - sqlite.adapter   —— 开发仿真:同一契约落在本地 SQLite(WAL),结构对齐
 *    时序语义(ts_ms 主键、按段聚合)。缺省后端,保证 mock 环境全链路可跑。
 */

export interface DaqSampleRow {
  nodeId: string
  /** epoch 毫秒(内部统一时间轴) */
  tsMs: number
  value: number
  state: string
  /** 平台首次入库时间(epoch ms;首写胜出,同键更正帧本期不支持 → C6) */
  ingestedAt?: number | null
  /** 产线批次打标(活动 LineRun 窗口内的样本逐条携带;null = 线体空闲段) */
  lineId?: string | null
  productId?: string | null
  recipeId?: string | null
  runId?: string | null
}

export interface DaqQueryOpts {
  fromMs?: number
  toMs?: number
  /** 降采样桶宽(ms);给出则返回桶聚合(avg/min/max/cnt) */
  bucketMs?: number
  /** 原始点上限(降采样模式下为桶数上限) */
  limit?: number
}

/** 原始点(raw)或桶聚合(bucket)两种形态 */
export interface TsdbPoint {
  at: number
  value?: number
  avg?: number
  min?: number
  max?: number
  cnt?: number
  state?: string
  /** 首次入库时间(仅逐节点分页/raw 返回;旧数据为 undefined = unknown) */
  ingestedAt?: number
}

/** 跨通道打标查询(产线数据隔离:产品/配方/批次/通道/时间/桶) */
export interface TsdbTagQuery {
  lineId?: string
  productId?: string
  recipeId?: string
  runId?: string
  /** 限定通道(缺省全部) */
  nodeIds?: string[]
  fromMs?: number
  toMs?: number
  bucketMs?: number
  limit?: number
}

/**
 * 逐节点 raw 分页(C7):单节点、稳定 ASC、游标严格 ts_ms > afterTs。
 * 与 queryTagged 的"nodeIds 集合总量 limit"语义**并存而不改**旧语义。
 */
export interface TsdbPageQuery {
  afterTs?: number
  fromMs?: number
  toMs?: number
  /** 每页上限(默认 5000,最大 50 万) */
  limit?: number
  /** 置 false 可省 state 列(默认 true) */
  withState?: boolean
  /**
   * 批次标签过滤(2026-10-29):任一提供即按**等值**过滤(等值天然排除未打标 NULL 行)。
   * 训练/导出等按批次隔离取数的调用方必须传三元组(line/product/recipe[+run]);
   * 留空 = 纯时间窗原始分页(可用性水位等全量观测语义)。
   */
  lineId?: string
  productId?: string
  recipeId?: string
  runId?: string
}

export interface TsdbPage {
  nodeId: string
  points: TsdbPoint[]
  /** 下一页游标(= 本页最后 at);done=true 时为 null */
  nextCursor: number | null
  done: boolean
}

export interface TsdbStats {
  /** 同 (node,ts) 二次写入不同值时被丢弃的帧数(可观测,不静默) */
  correctionDropped: number
}

// ===== 按产线分表(生产布局)=====

/** 布局形态:single = 升级前的单表;per-line = 一产线一表(物理隔离 + 独立保留期) */
export type TsdbLayoutKind = 'single' | 'per-line'

/** 单条产线的物理表与保留策略 */
export interface TsdbLineTableInfo {
  /** 空 = 未分配产线(哨兵行为 __unassigned__) */
  lineId: string
  samplesTable: string
  framesTable?: string | null
  rollupTable?: string | null
  rawRetentionH: number
  minuteRetentionH?: number | null
  hourRetentionH?: number | null
  /** 近似行数(pg_class.reltuples;SQLite 为 NULL) */
  rows?: number | null
  /** 物理占用字节(pg_total_relation_size) */
  bytes?: number | null
}

/** 存储布局/保留期/rollup 水位(运维可见面;不含数据本身) */
export interface TsdbLayoutInfo {
  backend: string
  layout: TsdbLayoutKind
  rawRetentionH: number
  frameRetentionH: number
  rollup: {
    enabled: boolean
    minuteRetentionH: number
    /** 0 = 永久 */
    hourRetentionH: number
    /** key = `${lineId}|${resMs}`;value = 已聚合到的上界 epoch ms */
    watermarks: Record<string, number>
  }
  lines: TsdbLineTableInfo[]
  legacy?: { table: string, rows: number | null, bytes: number | null, migrated: boolean } | null
}

/** 历史查询(跨原始保留期自动走 rollup;起止时间必填) */
export interface TsdbHistoryQuery {
  fromMs: number
  toMs: number
  /** 期望桶宽(≥100ms;1 分钟以上可命中 rollup) */
  bucketMs: number
  limit?: number
  lineId?: string
  productId?: string
  recipeId?: string
  runId?: string
}

export interface TsdbHistoryResult {
  points: TsdbPoint[]
  /** raw = 精确样本;minute/hour = 聚合历史;mixed = 边界两侧拼接 */
  resolution: 'raw' | 'minute' | 'hour' | 'mixed'
  /** 实际可查范围与说明(超出保留期必须显式说明,不得静默返回空) */
  coverage: {
    requestedFromMs: number
    requestedToMs: number
    /** 实际最早可查时刻(null = 无数据/未知) */
    availableFromMs: number | null
    /** 原始样本可用下界(该时刻之前只有聚合) */
    rawFromMs: number
    truncated: boolean
    note: string
  }
}

export interface TsdbRollupResult {
  at: string
  lines: number
  minuteRows: number
  hourRows: number
  /** 因单次预算/窗口未闭合而留待下轮的水位说明 */
  notes: string[]
}

export interface TsdbRetentionPatch {
  rawRetentionH?: number | null
  minuteRetentionH?: number | null
  hourRetentionH?: number | null
}

/** 轻量保留期信息(Agent 工具输出用,不做任何统计扫描) */
export interface TsdbRetentionInfo {
  rawRetentionH: number
  rollupEnabled: boolean
  rollupResolutions: number[]
}

export interface TsdbPort {
  /** 后端标识(sqlite-emulated | timescale)——REST meta 直报前端 */
  readonly backend: string
  /** 布局形态(single | per-line;缺省 single) */
  readonly layout?: TsdbLayoutKind
  /** 单批建议行数(生产者攒批上限;缺省由调用方决定) */
  readonly writeBatchHint?: number
  init(): Promise<void>
  writeSamples(rows: DaqSampleRow[]): Promise<void>
  query(nodeId: string, opts: DaqQueryOpts): Promise<TsdbPoint[]>
  /** 按产线打标跨通道查询(产品/配方隔离) */
  queryTagged(q: TsdbTagQuery): Promise<Map<string, TsdbPoint[]>>
  /** 逐节点分页 raw(新增;旧 queryTagged 零改动)。
   *  可选实现:后端不支持时调用方退化为逐节点 query()(见 dataset-builder)。 */
  queryTaggedPage?(nodeId: string, q?: TsdbPageQuery): Promise<TsdbPage>
  /** 各节点最近一个样本(列表页值列兜底) */
  latest(): Promise<Map<string, DaqSampleRow>>
  /** 运行观测(更正丢弃计数等;可选) */
  stats?(): TsdbStats
  // ===== 多形态帧(v2:向量/图像;像素 blob 在对象存储,这里只存元数据+派生指标)=====
  writeFrames(rows: DaqFrameRow[]): Promise<void>
  queryFrames(nodeId: string, opts: DaqFrameQueryOpts): Promise<DaqFrameRecord[]>
  // ===== 按产线分表后的运维面(可选实现:后端不支持时调用方降级)=====
  /** 布局/保留期/rollup 水位 */
  layoutInfo?(): Promise<TsdbLayoutInfo>
  /** 轻量保留期信息(不扫表) */
  retentionInfo?(): TsdbRetentionInfo
  /**
   * 历史查询:窗口早于原始保留期时自动改走聚合表。
   * 未实现的后端由调用方退化为 query()/queryTagged()。
   */
  queryHistory?(nodeId: string, q: TsdbHistoryQuery): Promise<TsdbHistoryResult>
  /** 增量聚合(幂等:仅处理已闭合窗口;返回本轮处理量) */
  runRollup?(): Promise<TsdbRollupResult>
  /** 逐产线保留期覆写(null = 回到全局缺省) */
  setLineRetention?(lineId: string, patch: TsdbRetentionPatch): Promise<void>
  /** 立即执行一轮保留期清理(运维/测试;定时器本身仍按 30min 跑) */
  sweepNow?(): Promise<void>
  /** 释放底层连接池/句柄(rebuild 换池时由工厂调用;可选) */
  close?(): Promise<void> | void
}

// ===== 帧(daq_frames;Timescale 元数据 + JSONB 向量/指标,图像只存对象键)=====

export interface DaqFrameRow {
  nodeId: string
  tsMs: number
  kind: 'vector' | 'image'
  templateKey?: string | null
  deviceBindingId?: string | null
  lineId?: string | null
  productId?: string | null
  recipeId?: string | null
  runId?: string | null
  /** 向量点数(图像为 0) */
  points: number
  /** 图像元数据 { objectKey, thumbKey, mime, width, height };向量 {} */
  meta: Record<string, unknown>
  /** 派生指标(avg/max/brightness/zone_*…) */
  metrics: Record<string, number>
}

export interface DaqFrameQueryOpts {
  fromMs?: number
  toMs?: number
  kind?: 'vector' | 'image'
  limit?: number
}

/** 帧查询记录(REST 返回形态;blob 按需经对象存储取) */
export interface DaqFrameRecord {
  at: number
  kind: 'vector' | 'image'
  /** 向量完整点列(图像缺省) */
  points?: number[]
  metrics: Record<string, number>
  /** 图像元数据(objectKey/thumbKey/mime/width/height) */
  meta: Record<string, unknown>
  deviceBindingId?: string | null
  lineId?: string | null
  productId?: string | null
  recipeId?: string | null
  runId?: string | null
}
