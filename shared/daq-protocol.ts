/**
 * DAQ 数据采集协议 + 模板目录(server ↔ client 单一事实源)。
 *
 * 架构:DaqNode 是服务端实体(class 封装 + 对象持久化),采集由 DaqController
 * 统一调度(mock 驱动先行,驱动接口为 Modbus/OPC-UA 等真实协议预留);
 * 读数经 WS(AEP 信封,type='daq.reading',channelId='' 广播)实时下发,
 * 节点/绑定/控制器变更走 daq.node.changed / daq.controller;客户端渲染完全
 * 由 server 数据驱动 —— 有多少 Node,数字孪生界面就有多少数采节点。
 */

// ============================================================
// 模板目录(薄膜双拉产线信号;创建节点的缺省域来源)
// ============================================================

export interface DaqTemplateDef {
  key: string
  name: string
  /** 位号风格代号(左轨卡片小字) */
  code: string
  /** 通道语义(callout/bind-row 主标题,如 熔体压力) */
  ch: string
  unit: string
  base: number
  amp: number
  min: number
  max: number
  decimals: number
  icon: DaqTemplateIcon
  /** 用户自定义模板(server 落盘可增删改);undefined = 内置 */
  builtin?: boolean
}

/** 模板图标(设计稿 ICONS 键;自定义模板从中选取) */
export const DAQ_TEMPLATE_ICONS = ['thermo', 'pressure', 'tension', 'encoder', 'camera', 'gateway'] as const
export type DaqTemplateIcon = typeof DAQ_TEMPLATE_ICONS[number]

/** 自定义模板创建/编辑载荷(server 校验归一后入库) */
export interface DaqTemplateInput {
  name: string
  /** 通道语义,缺省取 name */
  ch?: string
  /** 位号代号,缺省自动生成 */
  code?: string
  unit: string
  min: number
  max: number
  /** 模拟基值(mock 采样中心),缺省量程中点 */
  base?: number
  /** 模拟波幅,缺省量程 4% */
  amp?: number
  /** 小数位 0..4,缺省 2 */
  decimals?: number
  icon?: DaqTemplateIcon
}

/** daq.template.changed 帧载荷(自定义模板 CRUD 收敛帧) */
export interface AepDaqTemplateChange {
  op: 'added' | 'updated' | 'removed'
  template: DaqTemplateDef | null
}

export const DAQ_TEMPLATES: DaqTemplateDef[] = [
  { key: 'temp-tc', name: '温度传感器', code: 'TEMP · TC', ch: '熔体/箱体温度', unit: '℃', base: 168, amp: 3.2, min: 150, max: 185, decimals: 1, icon: 'thermo' },
  { key: 'pressure-tx', name: '压力变送器', code: 'PRESSURE · TX', ch: '熔体压力', unit: 'MPa', base: 0.82, amp: 0.05, min: 0.6, max: 1.2, decimals: 2, icon: 'pressure' },
  { key: 'tension-cell', name: '张力传感器', code: 'TENSION · CELL', ch: '膜张力', unit: 'kN', base: 21.4, amp: 0.9, min: 18, max: 26, decimals: 1, icon: 'tension' },
  { key: 'line-encoder', name: '速度编码器', code: 'LINE · ENCODER', ch: '产线速度', unit: 'm/min', base: 318, amp: 7, min: 280, max: 360, decimals: 0, icon: 'encoder' },
  { key: 'vision-cam', name: '视觉检测相机', code: 'VISION · CAM', ch: '表面缺陷率', unit: '‰', base: 0.42, amp: 0.09, min: 0.1, max: 0.9, decimals: 2, icon: 'camera' },
  { key: 'power-meter', name: '电参采集器', code: 'POWER · METER', ch: '运行功率', unit: 'kW', base: 45.2, amp: 2.6, min: 38, max: 55, decimals: 1, icon: 'gateway' },
]

export const daqTemplateByKey = (key: string): DaqTemplateDef | undefined =>
  DAQ_TEMPLATES.find(t => t.key === key)

/** 兼容旧 modelRef 形态(`daq-<key>`):从任意引用串提取模板 key */
export const daqKeyFromRef = (ref: string): string =>
  ref.startsWith('daq-') ? ref.slice(4) : ref

// ============================================================
// 节点视图(REST/WS 同构载荷)
// ============================================================

/** 采集驱动:mock 内置模拟;modbus-tcp/opcua 为真实工业协议实现;s7 预留 */
export type DaqDriverKind = 'mock' | 'modbus-tcp' | 'opcua' | 's7'

/** 驱动连接参数字段定义(前端动态表单的单一事实源;server 侧同源校验) */
export interface DriverConfigField {
  key: string
  label: string
  type: 'string' | 'number' | 'select'
  required?: boolean
  default?: string | number
  placeholder?: string
  /** type=select 的可选项 */
  options?: Array<{ value: string, label: string }>
  hint?: string
}

export interface DaqDriverMeta {
  kind: DaqDriverKind
  label: string
  /** builtin=开箱可用(mock) | real=真实协议已实现 | planned=预留 */
  status: 'builtin' | 'real' | 'planned'
  /** 真实连接参数模式(mock 为空表单) */
  configFields: DriverConfigField[]
}

/** Modbus TCP 寄存器读取类型 */
export type ModbusRegisterType = 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32'

/** 驱动目录(能力自描述;前端按 configFields 渲染参数表单) */
export const DAQ_DRIVERS: DaqDriverMeta[] = [
  {
    kind: 'mock',
    label: 'Mock 模拟源',
    status: 'builtin',
    configFields: [],
  },
  {
    kind: 'modbus-tcp',
    label: 'Modbus TCP(PLC/网关)',
    status: 'real',
    configFields: [
      { key: 'host', label: '设备地址(host)', type: 'string', required: true, placeholder: '192.168.1.10', hint: 'PLC 或 Modbus 网关 IP' },
      { key: 'port', label: '端口', type: 'number', default: 502, hint: 'Modbus TCP 标准端口 502' },
      { key: 'unitId', label: '单元号(unitId)', type: 'number', default: 1, hint: '从站地址,常见 1' },
      { key: 'register', label: '寄存器地址', type: 'number', required: true, placeholder: '40001', hint: '4xxxx=保持寄存器(地址-40001 为协议偏移);3xxxx=输入寄存器' },
      { key: 'registerType', label: '寄存器区', type: 'select', default: 'holding', options: [
        { value: 'holding', label: '保持寄存器(4x)' },
        { value: 'input', label: '输入寄存器(3x)' },
      ] },
      { key: 'dataType', label: '数据类型', type: 'select', default: 'float32', options: [
        { value: 'int16', label: 'int16(1 寄存器)' },
        { value: 'uint16', label: 'uint16(1 寄存器)' },
        { value: 'int32', label: 'int32(2 寄存器)' },
        { value: 'uint32', label: 'uint32(2 寄存器)' },
        { value: 'float32', label: 'float32(2 寄存器,常用)' },
      ] },
      { key: 'scale', label: '缩放系数', type: 'number', default: 1, hint: '原始值 × scale = 工程量(如 0.1)' },
      { key: 'byteOrder', label: '字节序', type: 'select', default: 'big', options: [
        { value: 'big', label: '大端(AB CD)' },
        { value: 'little', label: '小端(CD AB)' },
        { value: 'wordSwap', label: '字交换(CD AB / 交换单字)' },
      ] },
    ],
  },
  {
    kind: 'opcua',
    label: 'OPC UA(PLC/MES)',
    status: 'real',
    configFields: [
      { key: 'endpoint', label: '端点(endpoint)', type: 'string', required: true, placeholder: 'opc.tcp://192.168.1.10:4840', hint: 'OPC UA 服务器地址' },
      { key: 'nodeId', label: '节点 ID(NodeId)', type: 'string', required: true, placeholder: 'ns=2;s=Channel1.Device1.Tag1', hint: '要采集的变量节点' },
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
    kind: 's7',
    label: 'S7(西门子 PLC)',
    status: 'planned',
    configFields: [],
  },
]

export const daqDriverMeta = (kind: DaqDriverKind): DaqDriverMeta | undefined =>
  DAQ_DRIVERS.find(d => d.kind === kind)

/** 连接测试结果(REST/前端向导共用) */
export interface DriverTestResult {
  ok: boolean
  message: string
  /** 成功时带回一次真实读数(工程量) */
  sampleValue?: number
  latencyMs?: number
}

/** 通道健康态(ok 量程内 / warn 越预警带 / alarm 越硬量程 / offline 停用或控制器暂停) */
export type DaqNodeState = 'ok' | 'warn' | 'alarm' | 'offline'

/** 服务端 DaqNode 投影(REST 列表与 WS 变更帧同构) */
export interface DaqNodeView {
  id: string
  templateRef: string
  name: string
  driver: DaqDriverKind
  enabled: boolean
  /** 全局缺省周期(null = 跟随 controller.defaultIntervalMs) */
  intervalMs: number | null
  /** WS 实时下发(消费)间隔 ms;null = 跟随全局,0 = 每帧(随采样节拍) */
  publishIntervalMs: number | null
  unit: string
  decimals: number
  /** 物理量程(硬限;越界 = alarm) */
  min: number
  max: number
  /** 预警带(越带 = warn;null = 不预警) */
  warnLow: number | null
  warnHigh: number | null
  /** 绑定的设备孪生 id(null = 未绑定) */
  deviceBindingId: string | null
  /** 驱动连接参数(mock 空;modbus-tcp/opcua 按协议 schema 填写;随节点持久化) */
  driverConfig: Record<string, string | number | boolean>
  /** 场景落点(undefined = 未入场景) */
  posX?: number
  posZ?: number
  value: number | null
  state: DaqNodeState
  lastAt: string | null
  createdAt: string
}

/** daq.reading 帧载荷(controller 每次采样直推) */
export interface AepDaqReading {
  nodeId: string
  templateRef: string
  value: number
  state: DaqNodeState
  at: string
}

/** daq.node.changed 帧载荷(CRUD/绑定/参数变更收敛帧) */
export interface AepDaqNodeChange {
  op: 'added' | 'updated' | 'removed'
  node: DaqNodeView | null
}

/** daq.controller 帧载荷(全局采集控制状态 + 管线指标) */
export interface AepDaqControllerState {
  running: boolean
  defaultIntervalMs: number
  /** 全局缺省 WS 下发间隔(节点 publishIntervalMs=null 时跟随;0 = 随采样节拍) */
  defaultPublishIntervalMs: number
  nodesTotal: number
  nodesOnline: number
  /** 管线指标:生产/消费/队列丢失(produced-consumed)/时序库入库数 */
  produced?: number
  consumed?: number
  dropped?: number
  samplesStored?: number
  /** 写库侧丢弃(重试耗尽/攒批溢出;与 dropped 的队列侧丢弃分列) */
  tsdbDropped?: number
}
