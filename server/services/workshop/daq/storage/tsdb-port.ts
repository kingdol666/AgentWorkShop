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

export interface TsdbPort {
  /** 后端标识(sqlite-emulated | timescale)——REST meta 直报前端 */
  readonly backend: string
  init(): Promise<void>
  writeSamples(rows: DaqSampleRow[]): Promise<void>
  query(nodeId: string, opts: DaqQueryOpts): Promise<TsdbPoint[]>
  /** 各节点最近一个样本(列表页值列兜底) */
  latest(): Promise<Map<string, DaqSampleRow>>
  /** 释放底层连接池/句柄(rebuild 换池时由工厂调用;可选) */
  close?(): Promise<void> | void
}
