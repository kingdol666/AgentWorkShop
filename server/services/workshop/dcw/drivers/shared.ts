/**
 * 模块头 / 写读输入输出类型 / 工程量↔原始值纯函数
 * (由 server/services/workshop/dcw/drivers.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DcwDriverKind, WriteAckLevel } from '../../../../../shared/dcw-protocol'
import { createRequire } from 'node:module'

/**
 * DCW 写控制驱动 —— 工艺参数写命令的生产者抽象(与数采读驱动对称)。
 *
 * 系统封装边界:用户只提供工程量(物理含义的真实值);驱动负责
 *   ① 工程量 → 原始值线性换算(节点元数据 engMin/engMax ↔ rawMin/rawMax)
 *   ② 原始值编码(数据类型 + 字节序)→ 写 PLC 寄存器/节点
 *   ③ 回读校验(同址读回 → 换算回工程量 → 死区容差比较)→ ACK
 * 连接层复用数采驱动池(同一 PLC 读写共用 TCP 连接/OPC UA 会话)。
 *
 * 注意:本模块不得 import ./registry —— 驱动实现都从 ./shared 取换算纯函数,
 * 反向依赖会形成 registry→driver→shared→registry 环,entry=驱动文件时 TDZ 爆炸
 * (读能力判定 supportsDcwRead 因此放在 registry.ts)。
 */

export const reqNative = createRequire(import.meta.url)

export interface DcwWriteInput {
  /** 工程值(用户语义,已过工艺量程校验) */
  eng: number
  /** 回读容差(工程量;runtime 按量程/精度推导) */
  tolerance: number
  /** 节点工艺量程(换算缺省工程域) */
  domain: { min: number, max: number }
  driverConfig: Record<string, unknown>
}

export interface DcwWriteResult {
  ok: boolean
  message: string
  /** 原始值(换算后,PLC 语义) */
  raw: number | null
  /** 回读换算回的工程值 */
  readback: number | null
  /**
   * 写 ACK 鉴定等级(2026-10-08 生产化):驱动必须**如实**上报自己拿到的确认强度——
   *  - 'readback-verified':独立回读且容差通过(寄存器/OPC UA 驱动内回读);
   *  - 'transport-ack':仅链路受理(mqtt puback / http 2xx 无数值回传);
   *  - 'unverified':发送失败或无任何确认。
   * 缺省时由网关按旧口径归一(ok+readback→verified);新驱动应显式携带。
   */
  ack?: WriteAckLevel
}

export interface DcwWriteDriver {
  readonly kind: DcwDriverKind
  available(): Promise<boolean>
  write(input: DcwWriteInput): Promise<DcwWriteResult>
  test(driverConfig: Record<string, unknown>): Promise<{ ok: boolean, message: string }>
  /** 读当前 PLC 值(可选原语;不支持读的驱动为 undefined,网关按 supportsRead 收敛) */
  read?(input: DcwReadInput): Promise<DcwReadResult>
  /** 可选:该节点配置是否真的具备读能力(如 MQTT 需要 readTopic)。
   *  返回 false 时网关跳过周期读,不把「无回读通道」记成节点读错误(避免每 5s 一条噪音)。 */
  canRead?(driverConfig: Record<string, unknown>): boolean
  /** 拉取历史序列(可选原语;声明式分页由驱动内实现,调用方只管 onRows 增量消费) */
  fetchHistory?(input: DcwFetchHistoryInput): Promise<DcwFetchHistoryResult>
}

export interface DcwReadInput {
  /** 节点工艺量程(原始值↔工程量映射缺省域) */
  domain: { min: number, max: number }
  driverConfig: Record<string, unknown>
}

export interface DcwReadResult {
  ok: boolean
  message: string
  /** 工程量(PLC 语义;寄存器驱动 = 原始值解码后映射,直写型驱动 = 节点值本身) */
  eng: number | null
  /** 原始值(寄存器解码;非寄存器驱动与 eng 同源) */
  raw: number | null
  /** 数据字典(可选;MES 响应可携带字段级语义,供目录/取数/导出透传) */
  dictionary?: DcwFieldDef[]
}

// ============================================================
// 字段级数据字典(MES 多源异构数据的物理含义)
// ============================================================

/**
 * 字段/点位语义。一个字段既可以是一个标量列,也可以是一个向量字段
 * (points 描述向量每个下标/模头点位的含义)。
 *
 * 来源:优先由 MES API 随响应返回(dictionaryPath),其次由节点配置静态声明
 * (driverConfig.dictionary);两者都缺省时 Agent 只能看到原始字段名。
 */
export interface DcwFieldDef {
  /** 字段名(响应里的 key;向量点位用 field=profile 等) */
  field: string
  /** 人话标签(如 膜厚断面) */
  label?: string
  /** 物理单位(如 µm) */
  unit?: string
  /** 物理意义/判读说明 */
  description?: string
  min?: number
  max?: number
  /** 字段形态:scalar 标量列 / vector 向量列 / point 向量内点位 */
  kind?: 'scalar' | 'vector' | 'point'
  /** 向量点位下标(0-based;point 条目使用) */
  index?: number
  /** 向量字段的逐点语义(index 0..N-1) */
  points?: DcwFieldDef[]
}

// ============================================================
// 历史拉取原语(可选;MES REST 等具备历史接口的驱动实现)
// ============================================================

/**
 * 历史行(统一形态:ISO 8601 时间戳 + 按格式的载荷之一)。
 * 格式全谱:scalar=每时间点一个数值;vector=每时间点一个向量(膜厚断面/双折射光谱等
 * 检测算法输出);image=每时间点一帧图像(CCD 相机,base64);table/event=任意记录
 * (批次汇总表/离散事件)。四种载荷互斥;标量历史行只填 value(向后兼容)。
 */
export interface DcwHistoryRow {
  ts: string
  /** scalar:工程值 */
  value?: number
  /** vector:检测向量(断面/光谱;维度同点位恒定) */
  values?: number[]
  /** image:图像 base64(不带 data: 前缀) */
  data?: string
  /** image:MIME(缺省 image/png) */
  mime?: string
  /** table/event:原始记录(JSON 值);vector:行级伴随字段(mean/lane_unit 等,不含向量本体) */
  record?: unknown
}

/** 历史格式(声明在 historyMap.response.format;缺省 scalar) */
export type DcwHistoryFormat = 'scalar' | 'vector' | 'image' | 'table' | 'event'

export interface DcwFetchHistoryInput {
  driverConfig: Record<string, unknown>
  /** 起止时间(ISO 8601;含头含尾语义由映射/MES 决定,驱动原样透传) */
  fromIso: string
  toIso: string
  /** 本次拉取行数硬顶(分页循环的终止条件之一) */
  maxRows: number
  /** 分批回调(每页一次;调用方增量消费/入库) */
  onRows: (rows: DcwHistoryRow[]) => Promise<void> | void
}

export interface DcwFetchHistoryResult {
  /** 实际回调行数 */
  rows: number
  /** true=nextCursor 自然耗尽取完;false=因 maxRows/maxPages 提前截断 */
  complete: boolean
  /** 数据字典(可选;从响应首个非空页解析,随数据集 manifest/工具回包透传) */
  dictionary?: DcwFieldDef[]
}

export const num = (v: unknown): number | undefined => {
  const n = Number(v)
  return v !== '' && v != null && Number.isFinite(n) ? n : undefined
}

/**
 * 工程量 → 原始值:线性映射 eng ∈ [engMin, engMax] ↔ raw ∈ [rawMin, rawMax]。
 * 未提供原始量程时 raw = eng(float32 直写;int 类型仍需映射,缺省按量程直传并取整)。
 * 2026-10-28(S15):换算结果必须落在 rawMin~rawMax 内 —— 此前越界值会被 encodeWords
 * 静默按位回绕(int16/uint16)后写进 PLC,造成"写失败但设备已变"。
 */
export function engToRaw(eng: number, input: DcwWriteInput): number {
  const cfg = input.driverConfig
  const rawMin = num(cfg.rawMin)
  const rawMax = num(cfg.rawMax)
  if (rawMin === undefined || rawMax === undefined || rawMax === rawMin) return eng
  const engMin = num(cfg.engMin) ?? input.domain.min
  const engMax = num(cfg.engMax) ?? input.domain.max
  if (engMax === engMin) return eng
  const out = rawMin + ((eng - engMin) / (engMax - engMin)) * (rawMax - rawMin)
  if (!Number.isFinite(out)) throw new Error(`工程量 ${eng} 换算原始值失败(结果非有限数)`)
  const lo = Math.min(rawMin, rawMax)
  const hi = Math.max(rawMin, rawMax)
  if (out < lo - 1e-9 || out > hi + 1e-9) {
    throw new Error(`工程量 ${eng} 换算原始值 ${Number(out.toFixed(4))} 超出驱动原始量程 ${lo}~${hi}(eng ${engMin}~${engMax});请核对节点量程与 engMin/engMax/rawMin/rawMax 配置`)
  }
  return out
}

/** 原始值 → 工程量(回读换算;映射参数对称) */
export function rawToEng(raw: number, input: DcwWriteInput): number {
  const cfg = input.driverConfig
  const rawMin = num(cfg.rawMin)
  const rawMax = num(cfg.rawMax)
  if (rawMin === undefined || rawMax === undefined || rawMax === rawMin) return raw
  const engMin = num(cfg.engMin) ?? input.domain.min
  const engMax = num(cfg.engMax) ?? input.domain.max
  if (rawMax === rawMin) return engMin
  return engMin + ((raw - rawMin) / (rawMax - rawMin)) * (engMax - engMin)
}

/**
 * 同址回读判定与 ACK 拼装(写驱动共用出口):
 * ① ok 判据 = 回读值有限 且 |回读-设定| ≤ 容差 —— 网关与调控闭环只看本布尔;
 * ② 文案统一口径(一致 / 超容差含容差值),寄存器驱动经 rawNote 携带原始值标注。
 * 非有限回读(如 OPC UA 返回非数值)一律按未确认处理,readback 归一为 null。
 */
export function readbackAck(
  input: DcwWriteInput,
  back: number | null,
  opts: { raw: number | null, rawNote?: string },
): DcwWriteResult {
  const readback = typeof back === 'number' && Number.isFinite(back) ? back : null
  const ok = readback != null && Math.abs(readback - input.eng) <= input.tolerance
  const backTxt = readback != null ? String(Number(readback.toFixed(4))) : '非数值'
  const message = ok
    ? `写入并回读一致:${input.eng}${opts.rawNote ? ` → raw ${opts.rawNote}` : ''},回读 ${backTxt}`
    : `回读偏差超容差:写 ${input.eng},回读 ${backTxt}(容差 ${input.tolerance})`
  return { ok, message, raw: opts.raw, readback, ack: ok ? 'readback-verified' : 'unverified' }
}

/**
 * 原始值 → 寄存器字序(数据类型 + 字节序;与数采 decodeRegisters 互逆)。
 * 2026-10-28(S15):整数类型先校验可表示范围,越界抛错而不是按位回绕。
 */
export function encodeWords(raw: number, dataType: string, byteOrder: string): number[] {
  if (dataType === 'int16' || dataType === 'uint16') {
    const r = Math.round(raw)
    if (!Number.isFinite(r)) throw new Error(`原始值 ${raw} 不是有限数,拒绝编码为 ${dataType}`)
    if (dataType === 'int16' && (r < -32768 || r > 32767)) throw new Error(`原始值 ${r} 超出 int16 范围(-32768~32767),拒绝写入`)
    if (dataType === 'uint16' && (r < 0 || r > 65535)) throw new Error(`原始值 ${r} 超出 uint16 范围(0~65535),拒绝写入`)
    return [r & 0xFFFF]
  }
  if (dataType === 'uint32') {
    const r = Math.round(raw)
    if (!Number.isFinite(r) || r < 0 || r > 4294967295) throw new Error(`原始值 ${raw} 超出 uint32 范围,拒绝写入`)
  }
  if (dataType === 'int32') {
    const r = Math.round(raw)
    if (!Number.isFinite(r) || r < -2147483648 || r > 2147483647) throw new Error(`原始值 ${raw} 超出 int32 范围,拒绝写入`)
  }
  const buf = Buffer.alloc(4)
  if (dataType === 'float32') buf.writeFloatBE(raw, 0)
  else if (dataType === 'uint32') buf.writeUInt32BE(Math.round(raw), 0)
  else buf.writeInt32BE(Math.round(raw), 0)
  const B = [buf[0]!, buf[1]!, buf[2]!, buf[3]!]
  const word = (hi: number, lo: number) => ((hi & 0xFF) << 8) | (lo & 0xFF)
  // 与 daq/drivers/modbus-tcp.ts:decodeRegisters 严格互逆(2026-10-28 P0-1):
  //   little=DCBA → [D C][B A];wordSwap=CDAB → [C D][A B];big=ABCD → [A B][C D]
  if (byteOrder === 'little') return [word(B[3]!, B[2]!), word(B[1]!, B[0]!)]
  if (byteOrder === 'wordSwap') return [word(B[2]!, B[3]!), word(B[0]!, B[1]!)]
  return [word(B[0]!, B[1]!), word(B[2]!, B[3]!)]
}

const INT_RANGES: Record<string, [number, number]> = {
  int16: [-32768, 32767],
  uint16: [0, 65535],
  int32: [-2147483648, 2147483647],
  uint32: [0, 4294967295],
}

/**
 * 配置期校验(S15):Modbus 原始量程必须能被 dataType 表示。
 * 在节点创建/编辑时拒绝,避免运行期写坏 PLC 后才发现。
 */
export function assertDriverRawRange(driver: string, cfg: Record<string, unknown> = {}): void {
  if (!driver.startsWith('modbus')) return
  const rawMin = num(cfg.rawMin)
  const rawMax = num(cfg.rawMax)
  if (rawMin === undefined && rawMax === undefined) return
  if (rawMin === undefined || rawMax === undefined) throw new Error('rawMin 与 rawMax 必须同时提供')
  if (!(rawMax > rawMin)) throw new Error('rawMin 必须小于 rawMax')
  const dt = String(cfg.dataType ?? 'float32')
  const range = INT_RANGES[dt]
  if (range && (rawMin < range[0] || rawMax > range[1])) {
    throw new Error(`原始量程 ${rawMin}~${rawMax} 超出 ${dt} 可表示范围 ${range[0]}~${range[1]}`)
  }
  const engMin = num(cfg.engMin)
  const engMax = num(cfg.engMax)
  if (engMin !== undefined && engMax !== undefined && !(engMax > engMin)) throw new Error('engMin 必须小于 engMax')
}
