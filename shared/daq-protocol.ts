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
  /** 采集语义(Agent 上下文注入:该被控量的物理意义/判读方法/耦合关系;用户可编辑) */
  semantics?: string
  /** 设备孪生遥测语义键(绑定设备回写 telemetry 的键名;缺省 = templateKey;用户可编辑) */
  telemetryKey?: string
  /** 用户自定义模板(server 落盘可增删改);undefined = 内置 */
  builtin?: boolean
  /** 插件注册模板(内存态,REST 不可增删改;值为来源插件名) */
  plugin?: string
  // ===== 多形态信号(v2 帧管线;缺省 scalar = 既有单点链路,零行为变化)=====
  /** 信号形态:scalar 单点(缺省)/ vector 多点轮廓(测厚仪/扫描仪)/ image 图像帧(CCD) */
  signalKind?: DaqSignalKind
  /** vector 声明(驱动生成/校验点列的依据) */
  vector?: { points: number, min: number, max: number }
  /** 实时下沉处理管线(采样后、入库前按序执行;处理器实现 server 注册表,插件可扩展) */
  sink?: { processors: DaqSinkStep[] }
  /** 派生指标阈值(帧 metrics 越限 → 既有告警链路,边沿触发) */
  metrics?: DaqMetricRule[]
}

/** 信号形态 */
export type DaqSignalKind = 'scalar' | 'vector' | 'image'

/** 下沉处理器步骤(模板配置;处理器实现在 server 注册表,插件可扩展) */
export interface DaqSinkStep {
  name: string
  args?: Record<string, unknown>
}

/** 派生指标阈值规则(帧 metrics 越限告警;alarmLow/High 硬限,warnLow/High 预警带) */
export interface DaqMetricRule {
  key: string
  label: string
  unit?: string
  warnLow?: number
  warnHigh?: number
  alarmLow?: number
  alarmHigh?: number
}

/** 模板 signalKind 归一(undefined/非法 → scalar) */
export const normalizeSignalKind = (k?: string): DaqSignalKind =>
  k === 'vector' || k === 'image' ? k : 'scalar'

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
  /** 采集语义(物理意义/判读方法;注入 Agent 上下文) */
  semantics?: string
  /** 设备孪生遥测语义键(缺省 = templateKey) */
  telemetryKey?: string
  /** 小数位 0..4,缺省 2 */
  decimals?: number
  icon?: DaqTemplateIcon
  /** 信号形态(缺省 scalar) */
  signalKind?: DaqSignalKind
  /** vector 声明(signalKind=vector 时:points 必填 1~4096) */
  vector?: { points: number, min: number, max: number }
  /** 下沉处理管线(signalKind=image 时自动前置 thumbnail/quality-gate) */
  sink?: { processors: DaqSinkStep[] }
  /** 派生指标阈值规则 */
  metrics?: DaqMetricRule[]
}

/** daq.template.changed 帧载荷(自定义模板 CRUD 收敛帧) */
export interface AepDaqTemplateChange {
  op: 'added' | 'updated' | 'removed'
  template: DaqTemplateDef | null
}

export const DAQ_TEMPLATES: DaqTemplateDef[] = [
  { key: 'temp-tc', name: '温度传感器', code: 'TEMP · TC', ch: '熔体/箱体温度', unit: '℃', base: 168, amp: 3.2, min: 150, max: 185, decimals: 1, icon: 'thermo', telemetryKey: 'temperature', semantics: '熔体/箱体温度:热工艺核心被控量,热惯性大(变化平缓)。判读:与设定值偏差 ±2℃ 内为稳态;持续单边漂移 = 加热/散热失衡;骤升骤降多为扰动或传感器异常。' },
  { key: 'pressure-tx', name: '压力变送器', code: 'PRESSURE · TX', ch: '熔体压力', unit: 'MPa', base: 0.82, amp: 0.05, min: 0.6, max: 1.2, decimals: 2, icon: 'pressure', telemetryKey: 'pressure', semantics: '熔体压力:挤出负荷的「血压计」。判读:与温度负相关(温度升→熔体黏度降→压力降);压力突升常见于滤网堵塞或出料受阻。' },
  { key: 'tension-cell', name: '张力传感器', code: 'TENSION · CELL', ch: '膜张力', unit: 'kN', base: 21.4, amp: 0.9, min: 18, max: 26, decimals: 1, icon: 'tension', semantics: '膜张力:成膜质量直接指标。判读:张力波动与速度/温度设定强耦合,评估张力前先确认速度稳定。' },
  { key: 'line-encoder', name: '速度编码器', code: 'LINE · ENCODER', ch: '产线速度', unit: 'm/min', base: 318, amp: 7, min: 280, max: 360, decimals: 0, icon: 'encoder', semantics: '产线速度:产能直接观测量。判读:实际速度对设定值的跟随滞后反映传动惯量;速度波动会传导至张力与厚度。' },
  { key: 'vision-cam', name: '视觉检测相机', code: 'VISION · CAM', ch: '表面缺陷率', unit: '‰', base: 0.42, amp: 0.09, min: 0.1, max: 0.9, decimals: 2, icon: 'camera' },
  { key: 'power-meter', name: '电参采集器', code: 'POWER · METER', ch: '运行功率', unit: 'kW', base: 45.2, amp: 2.6, min: 38, max: 55, decimals: 1, icon: 'gateway' },
  // ===== 多形态信号模板(v2 帧管线)=====
  {
    key: 'thickness-scan', name: '测厚扫描仪', code: 'THK · SCAN', ch: '厚度轮廓', unit: 'mm',
    base: 0.52, amp: 0.018, min: 0.4, max: 0.65, decimals: 3, icon: 'tension',
    signalKind: 'vector',
    vector: { points: 64, min: 0.4, max: 0.65 },
    sink: { processors: [
      { name: 'resample', args: { n: 64 } },
      { name: 'derive-metric', args: { name: 'avg', op: 'avg' } },
      { name: 'derive-metric', args: { name: 'max', op: 'max' } },
    ] },
    metrics: [
      { key: 'max', label: '最大厚度', unit: 'mm', alarmHigh: 0.62 },
      { key: 'avg', label: '平均厚度', unit: 'mm', warnLow: 0.47, warnHigh: 0.57 },
    ],
    semantics: '测厚仪横向扫描轮廓:多点厚度分布。判读:平均值漂移=工艺整体偏移;单点尖峰=局部缺陷(夹杂/气泡);max 越硬限=超差,须联动分切剔除。',
  },
  {
    key: 'ccd-image', name: 'CCD 视觉相机', code: 'CCD · IMG', ch: '表面图像', unit: '灰度',
    base: 128, amp: 0, min: 0, max: 255, decimals: 0, icon: 'camera',
    signalKind: 'image',
    sink: { processors: [
      { name: 'thumbnail', args: { width: 256 } },
      { name: 'quality-gate' },
    ] },
    metrics: [
      { key: 'brightness', label: '平均亮度', unit: 'gray', alarmLow: 30, alarmHigh: 230 },
    ],
    semantics: 'CCD 图像帧:像素数据入对象存储,Timescale 仅存元数据与派生指标。判读:brightness 过低=曝光不足/镜头遮挡,过高=过曝;缺陷识别算法经插件处理器扩展。',
  },
]

export const daqTemplateByKey = (key: string): DaqTemplateDef | undefined =>
  DAQ_TEMPLATES.find(t => t.key === key)

/** 兼容旧 modelRef 形态(`daq-<key>`):从任意引用串提取模板 key */
export const daqKeyFromRef = (ref: string): string =>
  ref.startsWith('daq-') ? ref.slice(4) : ref

// ============================================================
// 数据语义标定钩子(PLC 原始值 ↔ 真实物理参数)
// ============================================================

/**
 * 数据后处理钩子:衔接"PLC 里的值"与"真实物理参数"。
 *  - DAQ(数采,decoder):物理值 = scale × 采集值 + offset —— 采样后执行,
 *    状态派生/入库/WS 下发全部使用物理值;
 *  - DCW(智控,encode):PLC 设定值 = (物理值 - offset) / scale —— 下发前执行,
 *    回读值再经 decoder 换算回物理值做死区校验。
 * 典型:PLC 0.1℃ 整数(1850 ↔ 185.0℃)→ scale 0.1;0~27648 ↔ 0~10MPa → scale 10/27648。
 * kind='none'(缺省)= 透传:PLC 已给出工程量,禁止二次换算。
 */
export interface DataTransform {
  kind: 'none' | 'linear'
  /** decode 斜率(物理值 = scale × PLC值 + offset);≠0 */
  scale?: number
  /** decode 截距 */
  offset?: number
}

/** transform 元数据校验归一:linear 要求 scale ≠ 0;none/非法 → undefined(透传) */
export function normalizeDataTransform(t?: DataTransform): DataTransform | undefined {
  if (!t || t.kind === 'none' || t.kind !== 'linear') return undefined
  const scale = Number(t.scale)
  if (!Number.isFinite(scale) || scale === 0) return undefined
  const offset = Number(t.offset ?? 0)
  if (!Number.isFinite(offset)) return undefined
  return { kind: 'linear', scale, offset }
}

/** decoder:PLC 值 → 物理值(数采采样后 / 智控回读后) */
export function applyTransform(v: number, t?: DataTransform): number {
  if (!t || t.kind !== 'linear') return v
  const scale = Number.isFinite(t.scale) && t.scale !== 0 ? t.scale! : 1
  const offset = Number.isFinite(t.offset) ? t.offset! : 0
  return scale * v + offset
}

/** encoder:物理值 → PLC 设定值(智控下发前;decoder 的逆变换) */
export function inverseTransform(v: number, t?: DataTransform): number {
  if (!t || t.kind !== 'linear') return v
  const scale = Number.isFinite(t.scale) && t.scale !== 0 ? t.scale! : 1
  const offset = Number.isFinite(t.offset) ? t.offset! : 0
  return (v - offset) / scale
}

// ============================================================
// 节点视图(REST/WS 同构载荷)
// ============================================================

/** 采集驱动:mock 内置模拟;modbus-tcp/opcua 为真实工业协议实现;s7 预留 */
export type DaqDriverKind = 'mock' | 'modbus-tcp' | 'modbus-rtu' | 'opcua' | 'mqtt' | 'http' | 's7'

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
      { key: 'certificateFile', label: '客户端证书路径(可选)', type: 'string', placeholder: 'certs/client_cert.pem', hint: 'Sign/SignAndEncrypt 时的 PEM 证书;留空自动生成自签' },
      { key: 'privateKeyFile', label: '私钥路径(可选)', type: 'string', placeholder: 'certs/client_key.pem', hint: '与证书配对的 PEM 私钥' },
    ],
  },
  {
    kind: 'modbus-rtu',
    label: 'Modbus RTU over TCP(串口网关)',
    status: 'real',
    configFields: [
      { key: 'host', label: '网关地址(host)', type: 'string', required: true, placeholder: '192.168.1.50', hint: '串口服务器/RTU 转 TCP 网关 IP(设备本身走 RS-485)' },
      { key: 'port', label: '端口', type: 'number', default: 502, hint: '网关透传端口(常见 502 / 8899 / 26)' },
      { key: 'unitId', label: '从站地址(unitId)', type: 'number', default: 1, hint: 'RS-485 总线上的从站地址' },
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
    kind: 'mqtt',
    label: 'MQTT(网关/边缘采集)',
    status: 'real',
    configFields: [
      { key: 'host', label: 'Broker 地址(host)', type: 'string', required: true, placeholder: '192.168.1.20 或 mqtt.example.com', hint: 'MQTT Broker(EMQX/Mosquitto/Aliyun IoT)地址' },
      { key: 'port', label: '端口', type: 'number', default: 1883, hint: 'MQTT TCP 标准端口 1883(TLS 8883)' },
      { key: 'topic', label: '主题(topic)', type: 'string', required: true, placeholder: 'factory/line1/temp', hint: '设备上报数值的主题;支持 +/# 通配' },
      { key: 'jsonPath', label: '取值路径(可选)', type: 'string', placeholder: 'data.temperature', hint: 'payload 为 JSON 时按路径取数值,如 data.temp;纯数字报文留空' },
      { key: 'username', label: '用户名(可选)', type: 'string' },
      { key: 'password', label: '密码(可选)', type: 'string' },
    ],
  },
  {
    kind: 'http',
    label: 'HTTP/REST(轮询)',
    status: 'real',
    configFields: [
      { key: 'url', label: '接口地址(URL)', type: 'string', required: true, placeholder: 'http://192.168.1.30/api/sensor', hint: '返回数值或 JSON 的 HTTP 接口' },
      { key: 'jsonPath', label: '取值路径(可选)', type: 'string', placeholder: 'data.value', hint: '响应为 JSON 时按路径取数值,如 data.value;纯文本留空' },
      { key: 'headersJSON', label: '请求头(可选)', type: 'string', placeholder: '{"Authorization":"Bearer xxx"}', hint: 'JSON 对象形式的 HTTP 头' },
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
  /** 数据语义标定钩子(decoder:PLC 采集值 → 物理值) */
  transform?: DataTransform
  /** 节点级采集语义备注(覆盖模板 semantics) */
  semantics?: string
  /** 驱动连接参数(mock 空;modbus-tcp/opcua 按协议 schema 填写;随节点持久化) */
  driverConfig: Record<string, string | number | boolean>
  /** 场景落点(undefined = 未入场景) */
  posX?: number
  posZ?: number
  /** 所属产线('' = 未分配;采集门控/场景光晕按产线隔离) */
  lineId: string
  value: number | null
  state: DaqNodeState
  lastAt: string | null
  /** 最近一次采样失败原因(连接/超时/PLC 异常分类;成功后清空) */
  lastError: string | null
  createdAt: string
}

/** daq.reading 帧载荷(controller 每次采样直推;value = 标定后物理值) */
export interface AepDaqReading {
  nodeId: string
  templateRef: string
  value: number
  state: DaqNodeState
  at: string
}

/** daq.frame 帧载荷(向量/图像帧实时下发;不含原始 blob —— 向量仅 ≤64 点预览,图像仅缩略图 URL) */
export interface AepDaqFrame {
  nodeId: string
  templateRef: string
  kind: 'vector' | 'image'
  at: string
  /** 向量降采样预览(≤64 点;完整点列经 REST frames 查询) */
  preview?: number[]
  /** 派生指标(resample/derive-metric/quality-gate 等下沉处理器产出) */
  metrics?: Record<string, number>
  /** 图像缩略图内容 URL(服务端鉴权流式输出;原图加 &thumb=0) */
  thumbUrl?: string
  state?: DaqNodeState
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
