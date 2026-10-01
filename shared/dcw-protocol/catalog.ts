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

export type DcwDriverKind = 'mock' | 'modbus-tcp' | 'modbus-rtu' | 'opcua' | 'mqtt' | 'http' | 'mes-rest'

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
  {
    kind: 'mes-rest',
    label: 'MES 集成(REST API 映射)',
    status: 'real',
    configFields: [
      { key: 'baseUrl', label: 'MES 服务地址(baseUrl)', type: 'string', required: true, placeholder: 'https://mes.example.com', hint: '仅 http/https;内网地址需同时开启 allowPrivateHost' },
      { key: 'authType', label: '认证方式(authType)', type: 'select', default: 'bearer', options: [
        { value: 'bearer', label: 'Bearer(Authorization 头)' },
        { value: 'header', label: '自定义头(authHeaderName)' },
        { value: 'none', label: '无认证' },
      ], hint: '凭据注入方式' },
      { key: 'secretRef', label: '凭据引用(secretRef)', type: 'string', placeholder: 'line1-mes', hint: '凭据引用名;token 从 env AW_MES_<REF大写>_TOKEN 或运行时设置 mes.secret.<ref> 读取,不落明文' },
      { key: 'authHeaderName', label: '自定义认证头名(可选)', type: 'string', placeholder: 'X-Api-Token', hint: 'authType=header 时的自定义头名' },
      { key: 'requestTimeoutMs', label: '请求超时(ms)', type: 'number', default: 10000, hint: '单次 MES 请求超时,缺省 10s' },
      { key: 'allowPrivateHost', label: '内网地址白名单', type: 'select', default: 'false', options: [
        { value: 'false', label: '拒绝(默认,SSRF 防护)' },
        { value: 'true', label: '允许(内网 MES 显式开启)' },
      ], hint: '内网/环回地址显式白名单开关(生产 MES 通常在内网)' },
      { key: 'desc', label: '节点语义描述(desc)', type: 'string', placeholder: '烘箱温度设定回写 MES 工单;异常时先查工单状态', hint: '节点语义描述(给 Agent 看):参数物理含义、异常时先查什么' },
      { key: 'headers', label: '默认请求头(headers)', type: 'text', placeholder: '{"X-Unit":"L01","X-API-Token":"{{SECRET:MES_PRIMARY}}"}', hint: '默认请求头 JSON(随读/写/史所有请求携带;值支持 {{SECRET:REF}} 引用凭据不落明文;映射级 headers 与认证头可覆盖)' },
      { key: 'readMap', label: '当前值映射(readMap)', type: 'text', placeholder: '{"path":"/api/v1/params/{name}/current","query":{"name":"TEMP_SP"},"response":{"valuePath":"data.value","tsPath":"data.ts","tsFormat":"epoch_ms"}}', hint: '当前值映射 JSON:{method,path,query,headers,response:{valuePath,tsPath,tsFormat}}' },
      { key: 'writeMap', label: '写映射(writeMap)', type: 'text', placeholder: '{"method":"POST","path":"/api/v1/params/{name}/setpoint","query":{"name":"TEMP_SP"},"bodyTemplate":{"value":"{{value}}"},"successOn":[200,201],"response":{"ackPath":"ack"}}', hint: '写映射 JSON(可选):{method,path,bodyTemplate,successOn,response:{ackPath}};bodyTemplate 里 {{value}} 为治理后工程值' },
      { key: 'historyMap', label: '历史映射(historyMap)', type: 'text', placeholder: '{"path":"/api/v1/params/{name}/history","query":{"name":"TEMP_SP"},"response":{"rowsPath":"data.rows[*]","valuePath":"value","tsPath":"ts","nextCursorPath":"data.nextCursor"},"pageSize":500,"maxPages":40}', hint: '历史映射 JSON(可选):{method,path,query,response:{rowsPath,valuePath,tsPath,nextCursorPath},pageSize,maxPages};response.format 支持数据格式全谱:scalar(缺省,每时间点一个数值)/vector(检测向量如膜厚断面,配 valuesPath)/image(图像帧如 CCD,配 dataPath+mimePath)/table/event(记录流)' },
      { key: 'requestHook', label: '请求构造钩子(requestHook)', type: 'text', placeholder: 'function (param, ctx) {\n  // param = Agent 传入的参数对象;返回请求覆盖(合入映射声明,钩子优先)\n  return { query: { from: param.from, to: param.to, lane: param.lane } }\n}', hint: '可选 JS 函数表达式:(param, ctx) => {path?,query?,headers?};返回值合入映射声明(钩子优先);独立子进程执行,4s 超时击杀' },
      { key: 'dataHook', label: '数据下沉钩子(dataHook)', type: 'text', placeholder: 'function (param, data, ctx) {\n  // data.rows = 格式化行(标量 value/向量 values/图像 data+mime/记录 record);data.node = 点位信息\n  const means = data.rows.map(r => r.values.reduce((a, b) => a + b, 0) / r.values.length)\n  ctx.plot({ name: \'trend\', title: data.node.name, series: [{ name: \'rowMean\', points: means.map((v, i) => [i, v]) }] })\n  ctx.saveCsv({ name: \'rows\', rows: [[\'ts\', \'mean\']].concat(data.rows.map(r => [r.ts, r.values[0]])) })\n  return { summary: `行数 ${data.rows.length},均值 ${means[0].toFixed(2)}`, context: \'已绘图并存 CSV\' }\n}', hint: '可选 JS 函数表达式:(param, data, ctx) => {summary?,context?,stats?};ctx 提供 saveCsv/saveJson/saveText/savePng/plot(SVG)/log/now,产物落数据根 mes-artifacts/<点位id>/;Agent 取数回包自动附处理摘要与产物清单;独立子进程执行,4s 超时击杀' },
    ],
  },
]
