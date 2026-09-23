/**
 * 控制模板与写控制驱动目录(预设数据)+ 模板键辅助
 * (由 shared/dcw-protocol.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DriverConfigField } from '../daq-protocol'

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

// 数据语义标定钩子(与数采共用数学:DCW encode 用其逆变换)
export { applyTransform, inverseTransform, normalizeDataTransform, type DataTransform } from '../daq-protocol'

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
