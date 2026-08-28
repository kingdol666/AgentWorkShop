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
  /** 用户自定义模板(server 落盘可增删改);undefined = 内置 */
  builtin?: boolean
}

export const DCW_TEMPLATE_ICONS = ['thermo', 'pressure', 'tension', 'encoder', 'camera', 'gateway'] as const
export type DcwTemplateIcon = typeof DCW_TEMPLATE_ICONS[number]

export const DCW_TEMPLATES: DcwTemplateDef[] = [
  { key: 'temp-sp', name: '温度设定器', code: 'TEMP · SP', ch: '烘箱温度设定', unit: '℃', min: 150, max: 200, decimals: 1, icon: 'thermo' },
  { key: 'speed-sp', name: '速度设定器', code: 'LINE · SP', ch: '产线速度设定', unit: 'm/min', min: 280, max: 360, decimals: 0, icon: 'encoder' },
  { key: 'tension-sp', name: '张力设定器', code: 'TENSION · SP', ch: '膜张力设定', unit: 'kN', min: 18, max: 26, decimals: 1, icon: 'tension' },
  { key: 'pressure-sp', name: '压力设定器', code: 'PRESSURE · SP', ch: '熔体压力设定', unit: 'MPa', min: 0.6, max: 1.2, decimals: 2, icon: 'pressure' },
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
}

// ============================================================
// 写控制驱动目录(与数采驱动同风格:能力自描述 + 动态参数表单)
// ============================================================

export type DcwDriverKind = 'mock' | 'modbus-tcp' | 'opcua'

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
]

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
  unit: string
  decimals: number
  /** 工艺安全量程(写入值硬校验) */
  min: number
  max: number
  deviceBindingId: string | null
  driverConfig: Record<string, string | number | boolean>
  posX?: number
  posZ?: number
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

/** 产品(一个产品可有多个配方;数据隔离的顶层维度) */
export interface ProductView {
  id: string
  name: string
  description: string
  createdAt: string
}

export interface ProductInput {
  name: string
  description?: string
}

/** 配方参数项(引用控制模板 + 目标工程值) */
export interface RecipeParam {
  templateRef: string
  value: number
  /** 显式指定目标控制节点(缺省按模板匹配最早创建的节点) */
  nodeId?: string
  /** 配方级工艺下限(叠加在节点全局量程之上;该配方运行期间写入值不得低于此值) */
  min?: number
  /** 配方级工艺上限 */
  max?: number
}

export interface RecipeView {
  id: string
  /** 所属产品(产线开跑与数据归属的必需维度) */
  productId: string
  name: string
  description: string
  params: RecipeParam[]
  createdAt: string
  updatedAt: string
}

export interface RecipeInput {
  productId?: string
  name: string
  description?: string
  params?: RecipeParam[]
}

/** 生产批次(Recipe 应用的隔离窗口:数采数据/写历史按窗口归属产品) */
export interface RecipeRunView {
  id: string
  recipeId: string
  recipeName: string
  productId: string
  startedAt: string
  endedAt: string | null
  /** apply 时逐参数写结果快照 */
  results: Array<{ templateRef: string, nodeId: string | null, ok: boolean, message: string, value: number }>
}

/** 产线运行状态(开跑必设配方;活动窗口内数采逐样本打标 productId/recipeId/runId) */
export interface LineRunState {
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

/** 产线数据查询(产品/配方/工艺参数/时间/间隔 五维) */
export interface LineQueryOpts {
  productId?: string
  recipeId?: string
  /** 工艺参数(DAQ 模板 key;缺省全部通道) */
  paramKey?: string
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
