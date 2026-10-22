/**
 * PLC 节点模拟器 —— 共享类型定义(前后端单一事实源)。
 *
 * 与 Platform 互通的约定:
 *   - 寄存器映射 dataType/byteOrder 与主项目 daq/drivers.ts decodeRegisters 同一约定
 *     (big=ABCD 标准大端 / little=DCBA 全小端 / wordSwap=CDAB 字交换);
 *   - 读偏移 = 地址 − 40001(保持)/− 30001(输入);
 *   - MQTT payload 模板与主项目 jsonPath 提取兼容(纯数字或 JSON 占位符)。
 */

export type ProtocolKind = 'modbus-tcp' | 'modbus-rtu' | 'opcua' | 'mqtt' | 'http'

/** 信号生成策略(每信号独立) */
export type SignalStrategy =
  | { kind: 'constant', value: number }
  | { kind: 'sine', base: number, amp: number, periodMs: number }
  | { kind: 'random-walk', start: number, step: number, min: number, max: number }
  | { kind: 'ramp', start: number, end: number, durationMs: number, loop: boolean }
  | { kind: 'first-order', initial: number, tauMs: number, sp: number, noise: number }
  | { kind: 'expression', expr: string }
  | { kind: 'manual', value: number }
  /**
   * hook:用户自定义数据产生器(代码动态注入)。
   * code 是 producer 函数体,每拍(或满足 timegapMs 节流)执行,可直接引用:
   *   now(时间戳) dt(拍间隔ms) prev(上一拍值) state(私有持久对象)
   *   vars(同设备其他信号值) min/max(量程) rand(随机源)
   *   return number                  → 标量值
   *        | { points: number[] }    → vector 向量帧(≤4096 点)
   *        | { png: string, width?, height? } → image 帧(png 为 base64)
   * state 跨拍保留,可实现滤波/积分/缓存的任意逻辑。
   */
  | { kind: 'hook', code: string, timegapMs?: number }

/** 信号数据形态(主项目 v2 帧管线对接:vector/image 走 daq_frames,不走标量库) */
export type SignalFormat = 'scalar' | 'vector' | 'image'

/** 故障注入(可叠加) */
export interface FaultInjection {
  /** 卡值:激活后输出冻结在当前值 */
  stuckAt?: boolean
  /** 尖峰:概率触发,持续 ms,越限量程比例 */
  spike?: { probability: number, durationMs: number, overshoot: number }
  /** 漂移:每 tick 累加 */
  drift?: { perTick: number }
  /** 断链:协议端点拒绝/断开连接,按概率触发持续 durationMs 后自愈 */
  disconnect?: { probability?: number, durationMs: number }
}

/** 信号定义(虚拟设备的物理量) */
export interface SignalDef {
  id: string
  name: string
  /** 工艺语义描述(供平台 semantics / Agent 语义卡消费;写清物理意义与推荐窗口) */
  description?: string
  unit?: string
  min?: number
  max?: number
  decimals?: number
  /** 采样/更新节拍(ms);0 = 跟随设备全局 tickMs */
  tickMs?: number
  strategy: SignalStrategy
  /** 标定:输出 = value × scale + offset(与主项目 DataTransform 同约定) */
  scale?: number
  offset?: number
  /** 数据形态(缺省 scalar;vector/image 由 hook 策略或 plantModel 产出) */
  format?: SignalFormat
  /** 工艺模型输出绑定:本信号的值由 plant-model 状态覆写(模型输出名,如 meltTemp) */
  plantBinding?: string
  faults?: FaultInjection
  /** 运行时状态(不持久化) */
  runtime?: SignalRuntime
}

export interface SignalRuntime {
  value: number
  /** random-walk/ramp/first-order 内部游标;hook 策略复用为上次产生时间戳 */
  cursor?: number
  /** hook 策略:上一拍时间戳(算 dt 用) */
  prevTick?: number
  /** 上次 tick 时间戳 */
  lastTick?: number
  spikeUntil?: number
  disconnectUntil?: number
  /** vector 形态:最近一帧点列 */
  vector?: number[]
  /** image 形态:最近一帧(base64 png + 尺寸) */
  image?: { png: string, width: number, height: number }
  /** 环形历史(前端趋势) */
  hist?: number[]
}

/** 寄存器映射(Modbus):信号值 ↔ 协议地址 */
export interface RegisterMap {
  /** 协议地址,4xxxx(保持)或 3xxxx(输入) */
  address: number
  area: 'holding' | 'input'
  signalId: string
  dataType: 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32'
  byteOrder: 'big' | 'little' | 'wordSwap'
  /**
   * 写回灌联动目标(SP→PV 闭环):外部写本地址时,除更新本信号外,
   * 同步把目标信号的 first-order.sp 设为写入值(真实 PLC:SP 寄存器即控制目标)。
   */
  writebackTarget?: string
}

/** OPC UA 变量映射 */
export interface OpcUaVarMap {
  /** NodeId 如 ns=2;s=Channel1.Tag1(相对设备命名空间时可只给 name) */
  nodeId: string
  signalId: string
  dataType: 'Double' | 'Float' | 'Int16' | 'UInt16' | 'Int32' | 'UInt32' | 'Boolean'
  /** 可写 setpoint(供 DCW session.write 写入,写入值回灌信号) */
  writable?: boolean
}

/** MQTT 发布映射 */
export interface MqttTopicMap {
  topic: string
  signalId: string
  /** payload 模板:'${value}' 纯数字,或 JSON 如 '{"data":{"temp":${value}}}' */
  payloadTemplate?: string
  qos?: 0 | 1 | 2
  retain?: boolean
}

/** HTTP 端点映射 */
export interface HttpPathMap {
  path: string
  signalId: string
  /** 响应模板:'${value}' 纯数字文本,或 JSON 如 '{"value":${value}}';vector 支持 ${points},image 直出 PNG 二进制 */
  responseTemplate?: string
  /** 可写控制端点:接受 POST {value}(主项目 http DCW 驱动语义),写入回灌信号 */
  writable?: boolean
}

/** 虚拟设备节点 */
export interface DeviceNode {
  id: string
  name: string
  /** 设备级工艺描述(段位/用途/上下游关系;导出与 UI 呈现) */
  description?: string
  protocol: ProtocolKind
  enabled: boolean
  /** 设备全局节拍(ms):信号默认 tick */
  tickMs: number
  signals: SignalDef[]
  /** 协议配置(按 protocol 解释) */
  config: {
    /** modbus:监听参数 */
    host?: string
    port?: number
    unitId?: number
    registerMaps?: RegisterMap[]
    /** opcua */
    endpointPath?: string
    namespaceUri?: string
    opcVars?: OpcUaVarMap[]
    securityMode?: 'None' | 'Sign' | 'SignAndEncrypt'
    username?: string
    password?: string
    /** mqtt:主动发布 */
    brokerUrl?: string
    topics?: MqttTopicMap[]
    /** mqtt:命令主题(主项目 DCW 下发设定值;payload {"setpoint":v} 或纯数字) */
    commandTopic?: string
    /** mqtt:命令主题回灌的目标信号 id */
    commandSignalId?: string
    /** http:GET 端点(挂在模拟器 UI 同端口) */
    paths?: HttpPathMap[]
  }
  /** 运行时状态(不持久化) */
  runtime?: {
    startedAt?: number
    lastError?: string
    /** mqtt 独立发布游标 */
  }
}

export interface SimConfig {
  nodes: DeviceNode[]
  /** 工艺模型(数字孪生物理引擎;单产线级,跨设备联动) */
  plantModel?: PlantModelConfig
  /** 当前激活的命名场景(隔离管理用;仅元数据) */
  activeScenario?: string
}

// ============================================================
// plant-model:挤出流延薄膜产线物理模型(数字孪生试验台)
// ============================================================

export type PlantPhase = 'warmup' | 'steady' | 'batch' | 'disturb'

export type PlantControlKey = 'zone1' | 'zone2' | 'zone3' | 'screw' | 'lineSpeed' | 'dieGap'

export type PlantOutputKey =
  | 'meltTemp'
  | 'meltPressure'
  | 'filmThickness'
  | 'profile'
  | 'defectRate'
  | 'defectImage'
  | 'gels'

// ============================================================
// biax:双向拉伸薄膜产线(BOPET 类)物理模型键空间
// 全线 = 干燥上料 → 挤出 → 计量泵 → 模头铸片 → 纵拉 MDO → 横拉 TDO → 测厚 → 电晕/检测 → 收卷
// ============================================================

export type PlantModelKind = 'castfilm' | 'biax'

export type BiaxControlKey =
  // 干燥上料单元
  | 'dryTemp' | 'dewPoint' | 'feedRate'
  // 挤出机(机筒五区 + 螺杆)
  | 'zone1' | 'zone2' | 'zone3' | 'zone4' | 'zone5' | 'screw'
  // 熔体计量泵
  | 'pump'
  // 模头铸片单元(模唇/急冷辊/铸片速度/静电吸附)
  | 'dieLip' | 'chillTemp' | 'castSpd' | 'pinning'
  // 纵向拉伸 MDO(预热三辊 + 慢/快辊 + 退火)
  | 'mdoPreheat1' | 'mdoPreheat2' | 'mdoPreheat3' | 'slowRoll' | 'fastRoll' | 'mdoAnneal'
  // 横向拉伸 TDO 烘箱(预热/拉伸/定型 + 链速 + 出口轨宽)
  | 'tdoPreheat' | 'tdoStretch' | 'tdoAnneal' | 'chain' | 'railOut'
  // 电晕处理
  | 'corona'
  // 收卷(张力/锥度/接触辊/卷取速度)
  | 'windTension' | 'windTaper' | 'windContact' | 'windSpeed'

export type BiaxOutputKey =
  | 'dryTemp' | 'moisture' | 'meltTemp' | 'meltPressure' | 'pumpOutlet' | 'castTemp'
  | 'mdoTemp' | 'mdRatio' | 'tdoTemp' | 'tdRatio' | 'railWidth'
  | 'thickness' | 'sigma' | 'profile' | 'defect' | 'haze' | 'dyne' | 'tension' | 'rollDia'

export interface PlantBinding {
  nodeId: string
  signalId: string
}

export interface PlantDisturbances {
  /** 加热器效率衰减 0~1(1=正常;0.9 = 加热能力 -10%,模拟设备老化) */
  heaterDecay?: number
  /** 进料温度阶跃(℃,叠加在 zone1 有效设定上) */
  feedTempStep?: number
  /** 进料温度慢漂移(℃/min,随机游走) */
  feedDriftPerMin?: number
}

export interface PlantParams {
  /** 加热区时间常数(s) */
  tauZone: number
  /** 区间热传导系数 0~1 */
  kHeat: number
  /** 熔体输送纯滞后(s) */
  tauMelt: number
  /** Arrhenius 粘度指数(K) */
  arrheniusB: number
  /** 参考 粘度(Pa·s)/温度(K) */
  mu0: number
  tRef: number
  /** 流量系数(kg/min 每 rpm) */
  flowK: number
  /** 泵送增益(kg/min 每 MPa)——P = Q/Kp */
  pumpK: number
  /** 泵送腔时间常数(s) */
  tauP: number
  /** 模口宽度(m) */
  dieWidth: number
  /** 模口到测厚仪距离(m);厚度纯滞后 = L/v */
  gaugeDistance: number
  /** 固化膜密度(kg/m³) */
  filmDensity: number
  /** 缺感参考温度(℃)——缺陷率最低点 */
  defectT: number
  /** 名义模口间隙(mm) */
  dieGapRef: number
  /** 传感器噪声 σ:温度/压力/厚度/缺陷/晶点 */
  noiseTemp: number
  noisePressure: number
  noiseThickness: number
  noiseDefect: number
  noiseGels: number
}

/** biax(双向拉伸薄膜产线)物理参数 */
export interface BiaxParams {
  /** 干燥塔温度响应时间常数(s) */
  tauDry: number
  /** 机筒加热区时间常数(s) */
  tauZone: number
  /** 区间热传导系数 0~1 */
  kHeat: number
  /** 熔体输送纯滞后(s) */
  tauMelt: number
  /** Arrhenius 粘度指数(K) */
  arrheniusB: number
  /** 参考粘度(Pa·s)/温度(℃) */
  mu0: number
  tRef: number
  /** 计量泵流量系数(kg/h 每 rpm,参考粘度下) */
  flowK: number
  /** 泵出口压力增益(MPa @ 650 kg/h,参考粘度) */
  pumpGain: number
  /** 泵送腔时间常数(s) */
  tauPump: number
  /** 模口宽度(m) */
  dieWidth: number
  /** 铸片颈缩系数(铸片宽/模宽) */
  neckIn: number
  /** TDO 入口轨宽/铸片宽 */
  railInFactor: number
  /** 切边损失比例 */
  trimFraction: number
  /** 固化膜密度(kg/m³,PET) */
  filmDensity: number
  /** MDO 区长度(m) */
  mdoLength: number
  /** TDO 烘箱长度(m) */
  tdoLength: number
  /** TDO 出口到测厚仪距离(m) */
  gaugeDistance: number
  /** 收卷张力响应时间常数(s) */
  tauTension: number
  /** 纸芯/钢芯直径(m) */
  rollCoreDiameter: number
  /** PET 玻璃化温度(℃,决定拉伸窗口) */
  tg: number
  /** MDO 拉伸温度窗(℃) */
  mdoWindow: [number, number]
  /** TDO 拉伸温度窗(℃) */
  tdoStretchWindow: [number, number]
  /** 成品厚度规格目标(μm) */
  thicknessTarget: number
  /** 传感器噪声 σ */
  noiseTemp: number
  noisePressure: number
  noiseThickness: number
  noiseDefect: number
  noiseMoisture: number
}

/** 稳态最优窗口(离线网格搜索产物,ground truth)。字段按模型种类取舍,分数恒在。 */
export interface PlantOptimum {
  /** 目标函数 J ∈ [0,100](约束外 = null 不入网格) */
  score: number
  computedAt: string
  // ── castfilm 解 ──
  zoneTemp?: number
  screw?: number
  lineSpeed?: number
  meltTemp?: number
  pressure?: number
  thickness?: number
  defect?: number
  // ── biax 解 ──
  castSpd?: number
  slowRoll?: number
  fastRoll?: number
  railOut?: number
  chain?: number
  sigma?: number
  haze?: number
}

export interface PlantModelConfig {
  /** 模型种类(缺省 castfilm;biax = 双向拉伸全线物理引擎) */
  kind?: PlantModelKind
  enabled: boolean
  /** 确定性噪声种子(可复现实验) */
  seed: number
  /** 积分步长(ms) */
  dtMs: number
  /** 时间加速倍率(1 = 实时物理;实验用 4~8 压缩收敛等待) */
  timeScale: number
  /** 控制输入绑定(DCW 写入的 SP 信号;按 kind 取键) */
  controls: Partial<Record<PlantControlKey | BiaxControlKey, PlantBinding>>
  /** 模型输出绑定(DAQ 采集信号,模型每拍覆写;按 kind 取键) */
  outputs: Partial<Record<PlantOutputKey | BiaxOutputKey, PlantBinding>>
  /** 物理参数(缺省用文献典型值;按 kind 解释) */
  params?: Partial<PlantParams & BiaxParams>
  /** 当前工况阶段(脚本驱动,真值流打标) */
  phase: PlantPhase
  /** 扰动注入(加热衰减/进料阶跃/漂移) */
  disturbances: PlantDisturbances
  /** 真值/暴露双列 JSONL 导出(评测 ground truth) */
  truthExport?: boolean
  /** 离线稳态最优窗口(网格搜索缓存;null = 未计算) */
  optimum?: PlantOptimum | null
}

/** plant-model 单步真值快照(JSONL 一行;sp/truth/exposed 为「控制键→工程量」平面记录,按 kind 取键) */
export interface PlantTruthSample {
  t: string
  phase: PlantPhase
  /** 控制输入(工程量) */
  sp: Record<string, number>
  /** 物理真值(未加噪,评测用;按 kind 取键,castfilm 含 zoneTemps 数组) */
  truth: Record<string, unknown>
  /** 协议暴露值(加噪后,Agent 看到的世界) */
  exposed: Record<string, number>
}

/** WS 帧 */
export interface SimWsFrame {
  type: 'signal.update' | 'device.changed' | 'device.error'
  payload: Record<string, unknown>
}
