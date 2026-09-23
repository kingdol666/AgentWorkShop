/**
 * 产品/配方/批次 + 工艺参数映射与 PLC 转换模式
 * (由 shared/dcw-protocol.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DcwDriverKind } from './catalog'
import type { DcwNodeState } from './line'

// ============================================================
// Product 产品 + Recipe 配方(产品-配方-批次三级隔离)
// ============================================================

// ============================================================
// 工艺参数映射(Process Parameter Map)—— 参数语义面 ↔ PLC 执行点
// ============================================================

/** 工艺参数写入限界(单侧可空;缺省侧不约束) */
export interface ParamLimitRange {
  min?: number
  max?: number
}

// ============================================================
// 工艺参数 → PLC 标准转换模式(映射配置期一次性选定)
// ============================================================

/**
 * 标准转换模式 —— 工程量 ↔ PLC 原始数据的双向换算规约。
 * 配置映射时选定一次,运行期系统按此自动双向换算(下发 encode / 回读 decode),
 * 用户与 Agent 全程只面对工程量纲,不接触寄存器数据格式。
 */
export interface ParamConversion {
  /**
   * float32       原始值=工程值,float32 寄存器直写(最常见)
   * int16-scaled  线性标定到 int16(1 寄存器):eng∈[engMin,engMax] ↔ raw∈[rawMin,rawMax],
   *               如 0.1 分辨率温度: eng 0~300 ↔ raw 0~3000
   * int32-scaled  线性标定到 int32(2 寄存器),同上
   */
  mode: 'float32' | 'int16-scaled' | 'int32-scaled'
  /** 字节序(缺省 big 大端 AB CD;wordSwap = 字交换) */
  byteOrder?: 'big' | 'little' | 'wordSwap'
  /** 线性标定工程量程(int16/int32-scaled 必填;float32 忽略) */
  engMin?: number
  engMax?: number
  /** 线性标定原始值量程(int16/int32-scaled 必填) */
  rawMin?: number
  rawMax?: number
}

/**
 * 映射接入规格(创建映射时一次性给定):设备连接 + 寄存器 + 标准转换模式。
 * 系统据此自动生成执行节点(驱动配置由转换模式展开,用户不手工拼装)。
 */
export interface ParamAccessSpec {
  /** 驱动类别(缺省 modbus-tcp) */
  driver?: 'modbus-tcp' | 'modbus-rtu'
  /** 设备地址(PLC/网关 IP) */
  host: string
  /** 端口(modbus-tcp 缺省 502;rtu 网关常见 502/8899/26) */
  port?: number
  /** 从站地址(缺省 1) */
  unitId?: number
  /** 写寄存器地址(4xxxx 保持寄存器;回读同址校验) */
  register: number
  /** 标准转换模式(必选) */
  conversion: ParamConversion
}

/**
 * 工艺参数映射视图 —— 用户/Agent 读写工艺参数的唯一语义面。
 *
 * 一条映射 = 一个工艺参数(key/单位/基准限界) → 一个写控制执行节点。
 * PLC 寻址细节(寄存器地址/数据类型/字节序/工程量换算)全部封装在执行节点的
 * 驱动配置内,参数面只暴露工程量纲 —— 用户与 Agent 永远不直接面对 PLC 寄存器。
 */
export interface DcwParamView {
  id: string
  /** 参数键(执行节点所属产线内唯一;产品限界与 Agent 语义寻址的稳定标识) */
  key: string
  name: string
  /** 语义模板(分类/图标/Agent 工艺语义) */
  templateRef: string
  unit: string
  decimals: number
  /** 基准写入限界(常驻层,叠加于节点安全量程;null = 该侧不额外约束) */
  min: number | null
  max: number | null
  /** PLC 执行节点(映射目标) */
  nodeId: string
  /** 执行节点所属产线(派生自节点;'' = 未分配) */
  lineId: string
  /** 驱动类别(仅类别;不含寄存器等寻址细节) */
  driver: DcwDriverKind
  enabled: boolean
  /** 当前设定值 / PLC 读数(自执行节点投影) */
  value: number | null
  readValue: number | null
  state: DcwNodeState
  /** 标准转换模式摘要(配置期选定;展示/审计用,运行期换算以执行节点驱动配置为准) */
  conversion?: ParamConversion
  createdAt: string
}

/** 工艺参数映射创建/编辑载荷(nodeId 为映射目标;其余为参数语义面) */
export interface DcwParamInput {
  key?: string
  name?: string
  templateRef?: string
  unit?: string
  decimals?: number
  min?: number | null
  max?: number | null
  nodeId?: string
  /** 仅创建:给定接入规格时系统自动创建执行节点(连接+寄存器+标准转换模式一键建映射) */
  access?: ParamAccessSpec
  /** 仅创建(access 路径):新执行节点挂载的产线 */
  lineId?: string
  /** 标准转换模式摘要(记录配置期选定的换算规约;展示/审计用) */
  conversion?: ParamConversion
}

/** 单层写入限界(来源标注;min/max null = 该侧不约束) */
export interface ParamLimitLayer {
  layer: 'node' | 'param' | 'product' | 'recipe'
  /** 人话标签(如 产品「XX」限界) */
  label: string
  min: number | null
  max: number | null
}

/** 有效写入限界(分层展示 + 交集;联锁拒绝信息/参数台账/前端展示共用) */
export interface ParamLimitsBreakdown {
  nodeId: string
  paramId: string | null
  paramKey: string | null
  /** 生效中的限界层(按 node→param→product→recipe 顺序) */
  layers: ParamLimitLayer[]
  /** 各层交集(最紧有效限界;恒有 node 层兜底) */
  effective: { min: number, max: number }
}

/** 产品(挂载产线;一个产品可有多个配方) */
export interface ProductView {
  id: string
  /** 所属产线('' = 未分配) */
  lineId: string
  name: string
  description: string
  /** 产品级工艺参数写入限界(键=工艺参数 key;生产本产品期间生效,与其他层取交集;
   *  用户/Agent/配方下发越界一律拒绝) */
  paramLimits?: Record<string, ParamLimitRange>
  createdAt: string
}

export interface ProductInput {
  name: string
  description?: string
  /** 所属产线(产线隔离顶层归属) */
  lineId?: string
  /** 产品级工艺参数写入限界(键=工艺参数 key;仅可收窄不可放宽其他层) */
  paramLimits?: Record<string, ParamLimitRange>
}

/**
 * 配方级数采监控窗口:活动批次内,数采节点实时值越出窗口即判 alarm
 * (实时报警:节点标红 + 孪生红环 + 告警面板)。不同 Recipe 可设不同窗口。
 */
export interface RecipeDaqWindow {
  /** 目标数采节点(必填;窗口按节点寻址) */
  nodeId: string
  min?: number
  max?: number
}

/**
 * 配方参数项 —— **节点级绑定**:每个参数显式指向一个控制节点
 * (节点才是真实控制 PLC 工艺参数的执行体;模板只负责分类,不参与下发寻址)。
 */
export interface RecipeParam {
  /** 目标控制节点(必填;写入/联锁/结果快照均按节点寻址) */
  nodeId: string
  /** 冗余模板引用(展示用;服务端按节点归一化) */
  templateRef?: string
  value: number
  /** 配方级工艺下限(叠加在节点全局量程之上;该配方运行期间写入值不得低于此值) */
  min?: number
  /** 配方级工艺上限 */
  max?: number
}

export interface RecipeView {
  id: string
  /** 所属产品(产线开跑与数据归属的必需维度) */
  productId: string
  /** 所属产线(创建时自产品继承;产线隔离) */
  lineId: string
  name: string
  description: string
  params: RecipeParam[]
  /** 配方级数采监控窗口(活动批次内越限即报警;产线隔离) */
  daqWindows: RecipeDaqWindow[]
  /** 参数版本(活动批次外的 params 修改自增;回退/审计定位用) */
  version?: number
  /** 参数版本历史(cap 20:每次活动批次外的 params 修改存旧版;by/actorName/actor/description 为变更归因) */
  paramsHistory?: Array<{
    version: number
    params: RecipeParam[]
    at: string
    /** 变更来源:user/agent/system */
    by?: string
    /** 人话操作者(用户名或「Channel名/成员名」) */
    actorName?: string
    /** 原始 id(userId/agentId/'system') */
    actor?: string
    /** 变更描述/原因 */
    description?: string
  }>
  /** 已知良好批次(判定 keep / 手动标记;基准恢复的目标) */
  lastGoodRunId?: string | null
  createdAt: string
  updatedAt: string
}

export interface RecipeInput {
  productId?: string
  name: string
  description?: string
  params?: RecipeParam[]
  /** 配方级数采监控窗口(目标数采节点 + 越限上下限) */
  daqWindows?: RecipeDaqWindow[]
}

/** 生产批次(Recipe 应用的隔离窗口:数采数据/写历史按窗口归属产品) */
export interface RecipeRunView {
  id: string
  recipeId: string
  recipeName: string
  productId: string
  /** 所属产线(自配方继承) */
  lineId: string
  startedAt: string
  endedAt: string | null
  /** apply 时逐参数写结果快照(节点级寻址) */
  results: Array<{ templateRef: string, nodeId: string | null, ok: boolean, message: string, value: number }>
  /** 建批时的参数冻结(配方事后修改不影响审计与回放) */
  paramsSnapshot?: RecipeParam[]
}

/** 单条产线的运行状态(开跑必设配方;活动窗口内数采逐样本打标 lineId/productId/recipeId/runId) */
export interface LineRunState {
  /** 产线 id */
  lineId: string
  active: boolean
  runId: string | null
  recipeId: string | null
  recipeName: string | null
  productId: string | null
  productName: string | null
  startedAt: string | null
  /** 本窗口已入库的打标样本数 */
  taggedSamples: number
}

/** 运行批次数据视图(数采汇总 + 写历史,按批次窗口隔离) */
export interface RecipeRunData {
  run: RecipeRunView
  /** 数采通道汇总(批次窗口内;按 DAQ 模板聚合) */
  daq: Array<{ templateRef: string, nodeId: string, nodeName: string, ch: string, unit: string, latest: number | null, avg: number | null, min: number | null, max: number | null, cnt: number }>
  /** 批次窗口内的写历史 */
  writes: Array<{ nodeId: string, nodeName: string, param: string, eng: number, raw: number | null, ok: boolean, at: string }>
}

/** 产线数据查询(产品/配方/工艺参数/时间/间隔 五维;lineId 限定产线通道) */
export interface LineQueryOpts {
  /** 限定产线(仅聚合该产线的数采节点) */
  lineId?: string
  productId?: string
  recipeId?: string
  /** 工艺参数(DAQ 模板 key;缺省全部通道) */
  paramKey?: string
  /** 节点过滤(单个 id 或逗号分隔多 id;缺省全部) */
  nodeId?: string
  fromMs?: number
  toMs?: number
  /** 聚合桶宽 ms(缺省原始点) */
  bucketMs?: number
  limit?: number
}

/** 产线查询结果(逐通道序列) */
export interface LineQueryResult {
  productId: string | null
  recipeId: string | null
  channels: Array<{
    nodeId: string
    nodeName: string
    templateRef: string
    ch: string
    unit: string
    points: Array<{ at: number, value?: number, avg?: number, min?: number, max?: number, cnt?: number }>
  }>
}
