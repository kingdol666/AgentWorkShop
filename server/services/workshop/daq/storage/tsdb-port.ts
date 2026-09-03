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

export interface TsdbPort {
  /** 后端标识(sqlite-emulated | timescale)——REST meta 直报前端 */
  readonly backend: string
  init(): Promise<void>
  writeSamples(rows: DaqSampleRow[]): Promise<void>
  query(nodeId: string, opts: DaqQueryOpts): Promise<TsdbPoint[]>
  /** 按产线打标跨通道查询(产品/配方隔离) */
  queryTagged(q: TsdbTagQuery): Promise<Map<string, TsdbPoint[]>>
  /** 各节点最近一个样本(列表页值列兜底) */
  latest(): Promise<Map<string, DaqSampleRow>>
  // ===== 多形态帧(v2:向量/图像;像素 blob 在对象存储,这里只存元数据+派生指标)=====
  writeFrames(rows: DaqFrameRow[]): Promise<void>
  queryFrames(nodeId: string, opts: DaqFrameQueryOpts): Promise<DaqFrameRecord[]>
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
