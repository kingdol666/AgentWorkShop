/**
 * DCW 数据写控制协议 + 模板目录(server ↔ client 单一事实源)。
 *
 * 概念模型(与 DAQ 读数采对称):写控制节点 = 边缘控制运行时,用户只面向
 * 工艺量纲(真实物理含义的工程值,如 烘箱温度设定 180℃);PLC 底层(寄存器、
 * 数据类型、工程量→原始值线性换算、回读校验)全部由系统封装。
 *
 *   用户设定工程值 → [min,max] 安全校验 → 工程量→原始值换算(节点元数据)
 *     → 驱动写 PLC → 回读校验(死区容差)→ ACK 状态 + 写历史 + WS dcw.written
 *
 * 节点架构与数采一致:每节点独立运行时(DcwNodeRuntime),DcwController 网关
 * 统一调度(保写节拍 = 心跳重下发,镜像数采的采样节拍)。
 */

import type { DataTransform, DriverConfigField } from './daq-protocol'

// 数据语义标定钩子(与数采共用数学:DCW encode 用其逆变换)
export { applyTransform, inverseTransform, normalizeDataTransform, type DataTransform } from './daq-protocol'

// ============================================================
// 控制模板目录(工艺设定值域;创建节点的缺省域来源)
// ============================================================

export interface DcwTemplateDef {
  key: string
  name: string
  /** 位号风格代号 */
  code: string
  /** 参数语义(物理含义,如 烘箱温度设定) */
  ch: string
  unit: string
  /** 工艺安全量程(写入值硬校验;越界 400 拒绝) */
  min: number
  max: number
  decimals: number
  /** 图标(设计稿 ICONS 键) */
  icon: 'thermo' | 'pressure' | 'tension' | 'encoder' | 'camera' | 'gateway'
  /** 工艺语义(Agent 上下文注入:该控制量的物理意义/对产线的影响/调整守则;用户可编辑) */
  semantics?: string
  /** 用户自定义模板(server 落盘可增删改);undefined = 内置 */
  builtin?: boolean
}

export const DCW_TEMPLATE_ICONS = ['thermo', 'pressure', 'tension', 'encoder', 'camera', 'gateway'] as const
export type DcwTemplateIcon = typeof DCW_TEMPLATE_ICONS[number]

export const DCW_TEMPLATES: DcwTemplateDef[] = [
  { key: 'temp-sp', name: '温度设定器', code: 'TEMP · SP', ch: '烘箱温度设定', unit: '℃', min: 150, max: 200, decimals: 1, icon: 'thermo', semantics: '烘箱/熔体温度设定:升高使热塑温度上升(成膜更均匀但能耗高、过热降解风险),降低则偏冷易厚度不均。调整后需等待热惯性(数十秒级)再评估效果。' },
  { key: 'speed-sp', name: '速度设定器', code: 'LINE · SP', ch: '产线速度设定', unit: 'm/min', min: 280, max: 360, decimals: 0, icon: 'encoder', semantics: '产线速度设定:升速提高产能但缩短物料受热时间(温度补偿需联动),降速利于精细工艺。速度变化会同步影响张力与厚度分布。' },
  { key: 'tension-sp', name: '张力设定器', code: 'TENSION · SP', ch: '膜张力设定', unit: 'kN', min: 18, max: 26, decimals: 1, icon: 'tension', semantics: '膜张力设定:张力过大易断膜/拉伸变形,过小则跑偏起皱。调整需平缓,并与速度联动观察。' },
  { key: 'pressure-sp', name: '压力设定器', code: 'PRESSURE · SP', ch: '熔体压力设定', unit: 'MPa', min: 0.6, max: 1.2, decimals: 2, icon: 'pressure', semantics: '熔体压力设定:反映挤出/泵送负荷,压力偏高提示阻力大或温度偏低,偏低可能是料位不足。调整需小幅步进。' },
]

export const dcwTemplateByKey = (key: string): DcwTemplateDef | undefined =>
  DCW_TEMPLATES.find(t => t.key === key)

/** 兼容 `dcw-<key>` 引用形态:提取模板 key */
export const dcwKeyFromRef = (ref: string): string =>
  ref.startsWith('dcw-') ? ref.slice(4) : ref

/** 自定义控制模板创建/编辑载荷 */
export interface DcwTemplateInput {
  name: string
  ch?: string
  code?: string
  unit: string
  min: number
  max: number
  decimals?: number
  icon?: DcwTemplateIcon
  /** 工艺语义(物理意义/影响/守则;注入 Agent 上下文) */
  semantics?: string
}

// ============================================================
// 写控制驱动目录(与数采驱动同风格:能力自描述 + 动态参数表单)
// ============================================================

export type DcwDriverKind = 'mock' | 'modbus-tcp' | 'modbus-rtu' | 'opcua' | 'mqtt' | 'http'

/** 写换算元数据(工程量 ↔ 原始值线性映射;系统封装,用户配置一次) */
export interface DcwScaleConfig {
  /** 工程量程(缺省取节点量程) */
  engMin: number
  engMax: number
  /** 原始值量程(如 int16 0~2000 表示 0.1℃ 分辨率;float32 缺省 raw=eng) */
  rawMin?: number
  rawMax?: number
}

export interface DcwDriverMeta {
  kind: DcwDriverKind
  label: string
  status: 'builtin' | 'real' | 'planned'
  configFields: DriverConfigField[]
}

export const DCW_DRIVERS: DcwDriverMeta[] = [
  {
    kind: 'mock',
    label: 'Mock 模拟 PLC',
    status: 'builtin',
    configFields: [],
  },
  {
    kind: 'modbus-tcp',
    label: 'Modbus TCP(PLC/网关 写保持寄存器)',
    status: 'real',
    configFields: [
      { key: 'host', label: '设备地址(host)', type: 'string', required: true, placeholder: '192.168.1.10', hint: 'PLC 或 Modbus 网关 IP' },
      { key: 'port', label: '端口', type: 'number', default: 502, hint: 'Modbus TCP 标准端口 502' },
      { key: 'unitId', label: '单元号(unitId)', type: 'number', default: 1, hint: '从站地址,常见 1' },
      { key: 'register', label: '写寄存器地址', type: 'number', required: true, placeholder: '40021', hint: '4xxxx=保持寄存器(写);回读同址校验' },
      { key: 'dataType', label: '数据类型', type: 'select', default: 'float32', options: [
        { value: 'int16', label: 'int16(1 寄存器)' },
        { value: 'uint16', label: 'uint16(1 寄存器)' },
        { value: 'int32', label: 'int32(2 寄存器)' },
        { value: 'uint32', label: 'uint32(2 寄存器)' },
        { value: 'float32', label: 'float32(2 寄存器,常用)' },
      ] },
      { key: 'byteOrder', label: '字节序', type: 'select', default: 'big', options: [
        { value: 'big', label: '大端(AB CD)' },
        { value: 'little', label: '小端(CD AB)' },
        { value: 'wordSwap', label: '字交换(CD AB / 交换单字)' },
      ] },
      { key: 'engMin', label: '工程量程下限', type: 'number', hint: '线性换算:eng ∈ [engMin, engMax] ↔ raw ∈ [rawMin, rawMax];float32 且未填原始量程时 raw=eng' },
      { key: 'engMax', label: '工程量程上限', type: 'number' },
      { key: 'rawMin', label: '原始值下限', type: 'number', hint: '如 int16 用 0~2000 表示 0.1 分辨率' },
      { key: 'rawMax', label: '原始值上限', type: 'number' },
    ],
  },
  {
    kind: 'opcua',
    label: 'OPC UA(PLC/MES 写节点值)',
    status: 'real',
    configFields: [
      { key: 'endpoint', label: '端点(endpoint)', type: 'string', required: true, placeholder: 'opc.tcp://192.168.1.10:4840', hint: 'OPC UA 服务器地址' },
      { key: 'nodeId', label: '节点 ID(NodeId)', type: 'string', required: true, placeholder: 'ns=2;s=Channel1.Device1.SetTemp', hint: '要写入的变量节点' },
      { key: 'securityMode', label: '安全策略', type: 'select', default: 'None', options: [
        { value: 'None', label: 'None(无加密,内网常用)' },
        { value: 'Sign', label: 'Sign(签名)' },
        { value: 'SignAndEncrypt', label: 'SignAndEncrypt(签名+加密)' },
      ] },
      { key: 'username', label: '用户名(可选)', type: 'string' },
      { key: 'password', label: '密码(可选)', type: 'string' },
    ],
  },
  {
    kind: 'modbus-rtu',
    label: 'Modbus RTU over TCP(串口网关 写保持寄存器)',
    status: 'real',
    configFields: [
      { key: 'host', label: '网关地址(host)', type: 'string', required: true, placeholder: '192.168.1.50', hint: '串口服务器/RTU 转 TCP 网关 IP' },
      { key: 'port', label: '端口', type: 'number', default: 502, hint: '网关透传端口(常见 502 / 8899 / 26)' },
      { key: 'unitId', label: '从站地址(unitId)', type: 'number', default: 1, hint: 'RS-485 总线上的从站地址' },
      { key: 'register', label: '写寄存器地址', type: 'number', required: true, placeholder: '40021', hint: '4xxxx=保持寄存器(写);回读同址校验' },
      { key: 'dataType', label: '数据类型', type: 'select', default: 'float32', options: [
        { value: 'int16', label: 'int16(1 寄存器)' },
        { value: 'uint16', label: 'uint16(1 寄存器)' },
        { value: 'int32', label: 'int32(2 寄存器)' },
        { value: 'uint32', label: 'uint32(2 寄存器)' },
        { value: 'float32', label: 'float32(2 寄存器,常用)' },
      ] },
      { key: 'byteOrder', label: '字节序', type: 'select', default: 'big', options: [
        { value: 'big', label: '大端(AB CD)' },
        { value: 'little', label: '小端(CD AB)' },
        { value: 'wordSwap', label: '字交换(CD AB / 交换单字)' },
      ] },
      { key: 'engMin', label: '工程量程下限', type: 'number', hint: '线性换算:eng ∈ [engMin, engMax] ↔ raw ∈ [rawMin, rawMax];float32 且未填原始量程时 raw=eng' },
      { key: 'engMax', label: '工程量程上限', type: 'number' },
      { key: 'rawMin', label: '原始值下限', type: 'number' },
      { key: 'rawMax', label: '原始值上限', type: 'number' },
    ],
  },
  {
    kind: 'mqtt',
    label: 'MQTT(发布设定值到 Broker)',
    status: 'real',
    configFields: [
      { key: 'host', label: 'Broker 地址(host)', type: 'string', required: true, placeholder: '192.168.1.20', hint: 'MQTT Broker 地址(与边缘网关约定同一 Broker)' },
      { key: 'port', label: '端口', type: 'number', default: 1883, hint: 'MQTT TCP 端口 1883' },
      { key: 'topic', label: '下发主题(topic)', type: 'string', required: true, placeholder: 'factory/line1/setpoint', hint: '网关订阅的控制主题(勿与采集主题相同)' },
      { key: 'jsonKey', label: 'JSON 键(可选)', type: 'string', placeholder: 'setpoint', hint: '留空 = 纯数字报文;填写 = {"键":值} JSON 报文' },
      { key: 'qos', label: 'QoS', type: 'number', default: 1, hint: '0=至多一次 1=至少一次(推荐)' },
      { key: 'username', label: '用户名(可选)', type: 'string' },
      { key: 'password', label: '密码(可选)', type: 'string' },
    ],
  },
  {
    kind: 'http',
    label: 'HTTP/REST(POST 设定值)',
    status: 'real',
    configFields: [
      { key: 'url', label: '写接口地址(URL)', type: 'string', required: true, placeholder: 'http://192.168.1.30/api/setpoint', hint: '接收设定值的 HTTP 接口(POST JSON)' },
      { key: 'bodyKey', label: 'JSON 键(可选)', type: 'string', placeholder: 'setpoint', hint: '留空 = {"value": 设定值};填写 = {"键": 设定值}' },
      { key: 'headersJSON', label: '请求头(可选)', type: 'string', placeholder: '{"Authorization":"Bearer xxx"}', hint: 'JSON 对象形式的 HTTP 头' },
    ],
  },
]

// ============================================================
// 产线(Line)—— 节点/产品/配方/批次的顶层隔离维度
// ============================================================

/** 产线光晕色板(数字孪生场景:同产线节点同色光环;1号蓝 2号黄…) */
export const DCW_LINE_COLORS = ['#3aa0ff', '#f4c542', '#35e0a0', '#41c8f4', '#b58cff', '#ff8a5c'] as const

export const dcwLineColorFor = (index: number): string =>
  DCW_LINE_COLORS[index % DCW_LINE_COLORS.length]!

/** 产线(节点/产品/配方挂载其下;开跑/采集/场景光晕按产线隔离) */
export interface LineView {
  id: string
  name: string
  /** 场景光晕/界面身份色(Hex;缺省按创建序取色板) */
  color: string
  description: string
  createdAt: string
}

export interface LineInput {
  name: string
  color?: string
  description?: string
}

// ============================================================
// 节点视图(REST/WS 同构载荷)
// ============================================================

/** 写通道健康态(writing 写入进行中 / ok 最近一次写 ACK / error 最近一次失败 / offline 停用或网关暂停) */
export type DcwNodeState = 'idle' | 'writing' | 'ok' | 'error' | 'offline'

/** 服务端 DcwNode 投影(REST 列表与 WS 变更帧同构) */
export interface DcwNodeView {
  id: string
  templateRef: string
  name: string
  driver: DcwDriverKind
  enabled: boolean
  /** 保写周期 ms(心跳重下发;null = 仅手动下发) */
  holdIntervalMs: number | null
  /** 数据语义标定钩子(encode:物理值 → PLC 设定值) */
  transform?: DataTransform
  /** 节点级工艺语义备注(覆盖模板 semantics;注入 Agent 上下文) */
  semantics?: string
  unit: string
  decimals: number
  /** 工艺安全量程(写入值硬校验) */
  min: number
  max: number
  deviceBindingId: string | null
  driverConfig: Record<string, string | number | boolean>
  posX?: number
  posZ?: number
  /** 所属产线('' = 未分配;采集/场景光晕按产线隔离) */
  lineId: string
  /** 当前设定值(工程量;null = 从未下发) */
  value: number | null
  /** 最近一次成功下发时刻 / 最近一次写尝试时刻 */
  lastAckAt: string | null
  lastWriteAt: string | null
  state: DcwNodeState
  lastError: string | null
  createdAt: string
}

/** dcw.written 帧载荷(每次写命令 ACK 直推) */
export interface AepDcwWritten {
  nodeId: string
  templateRef: string
  /** 工程值(用户语义) */
  value: number
  /** 原始值(PLC 语义,换算后) */
  raw: number | null
  ok: boolean
  message: string
  /** 关联的配方批次(单发/保写为 null) */
  recipeRunId: string | null
  at: string
}

/** dcw.node.changed 帧载荷 */
export interface AepDcwNodeChange {
  op: 'added' | 'updated' | 'removed'
  node: DcwNodeView | null
}

/** dcw.controller 帧载荷 */
export interface AepDcwControllerState {
  running: boolean
  nodesTotal: number
  nodesOnline: number
  writesTotal: number
  writesFailed: number
}

// ============================================================
// Product 产品 + Recipe 配方(产品-配方-批次三级隔离)
// ============================================================

/** 产品(挂载产线;一个产品可有多个配方) */
export interface ProductView {
  id: string
  /** 所属产线('' = 未分配) */
  lineId: string
  name: string
  description: string
  createdAt: string
}

export interface ProductInput {
  name: string
  description?: string
  /** 所属产线(产线隔离顶层归属) */
  lineId?: string
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
  /** 参数版本历史(cap 20:每次活动批次外的 params 修改存旧版) */
  paramsHistory?: Array<{ version: number, params: RecipeParam[], at: string }>
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
  /** Agent 优化任务关联(尽力而为) */
  taskId?: string
  /** Agent 判定假设(作业环第 3 步声明) */
  hypothesis?: string
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
