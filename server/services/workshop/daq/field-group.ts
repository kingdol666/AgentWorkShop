/**
 * MQTT 单 topic 多字段 → 多子信号节点展开(纯构建,零 IO)。
 *
 * 背景:平台一个数采节点 = 一个信号(标量/向量/图像)。同一 topic 的 JSON 报文常带多个
 * 字段(温度/湿度/压力…),逐个手工建节点既繁琐又容易漏配。这里提供"一次配置、展开成
 * N 个真实节点"的入口:每个字段 = 一个独立节点(独立单位/量程/告警/面板),驱动侧按
 * (broker, topic) 共享同一次订阅,报文按各自 jsonPath 扇出解析。
 *
 * driverConfig.fields 支持两种写法(与 fieldsBase 可选前缀组合):
 *   1) 对象:{"temp":"data.temp","humidity":{"path":"data.humidity","unit":"%","min":0,"max":100,"warnLow":20,"warnHigh":80}}
 *   2) 数组:["data.temp","data.humidity"] 或 [{path:"data.temp",name:"温度",unit:"℃"}]
 *
 * 约束:
 *  - 仅 mqtt 驱动;不支持与 pointsPath/metricsPath/imagePath/decoder(向量/图像/自定义解码)混用;
 *  - 每字段最多 64 个;字段名不得重复;路径必须是点号路径(可含数组下标),不允许空白;
 *  - 字段模板必须是 scalar(由 findDaqTemplate 校验),量程/告警须为有限数字且 warnLow ≤ warnHigh。
 */
import { randomUUID } from 'node:crypto'
import type { DaqCreateInput } from './daq-controller/types'
import type { DaqTemplateDef, DaqDriverKind } from '../../../../shared/daq-protocol'
import { AppError, ErrorCodes } from '../../../utils/errors'
import { findDaqTemplate } from './daq-templates'
import { daqKeyFromRef } from '../../../../shared/daq-protocol'

const MAX_FIELDS = 64
const MAX_LABEL_CHARS = 40
const MAX_PATH_CHARS = 256
/** 与向量/图像/自定义解码互斥的配置键:fields 走纯标量展开 */
const INCOMPATIBLE_KEYS = ['pointsPath', 'metricsPath', 'imagePath', 'imageFormat', 'decoder'] as const

export interface MqttFieldSpec {
  label: string
  /** 完整 JSON 路径(已拼接 fieldsBase) */
  path: string
  unit?: string
  min?: number
  max?: number
  warnLow?: number | null
  warnHigh?: number | null
  decimals?: number
  templateRef?: string
  name?: string
  semantics?: string
}

export interface FieldGroupPlan {
  groupId: string
  baseName: string
  inputs: DaqCreateInput[]
}

type TemplateLookup = (ref: string) => DaqTemplateDef | undefined

function bad(message: string): AppError {
  return new AppError(400, ErrorCodes.VALIDATION_ERROR, message)
}

function asFiniteNumber(value: unknown, what: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) throw bad(`${what} 必须是有限数字(当前: ${String(value)})`)
  return n
}

function normalizeLabel(value: unknown, index: number): string {
  const label = String(value ?? '').trim()
  if (!label) throw bad(`fields 第 ${index + 1} 项缺少字段名(label/name)`)
  if (label.length > MAX_LABEL_CHARS) throw bad(`字段名过长(${label.length} 字符,上限 ${MAX_LABEL_CHARS}):${label}`)
  if ([...label].some(ch => ch.charCodeAt(0) < 0x20)) throw bad(`字段名包含控制字符:${JSON.stringify(label)}`)
  return label
}

function normalizePath(value: unknown, label: string): string {
  const path = String(value ?? '').trim()
  if (!path) throw bad(`字段「${label}」缺少取值路径 path`)
  if (path.length > MAX_PATH_CHARS) throw bad(`字段「${label}」路径过长(${path.length} 字符,上限 ${MAX_PATH_CHARS})`)
  if (/\s/.test(path)) throw bad(`字段「${label}」路径含空白:${path}`)
  return path
}

/** 解析 driverConfig.fields(字符串 JSON / 对象 / 数组)→ 字段规格表;无 fields 返回 null。 */
export function parseMqttFieldSpecs(raw: unknown, fieldsBase?: unknown): MqttFieldSpec[] | null {
  if (raw === undefined || raw === null || raw === '') return null
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return null
    try {
      parsed = JSON.parse(text)
    }
    catch (err) {
      throw bad(`fields 不是合法 JSON:${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const base = fieldsBase == null ? '' : String(fieldsBase).trim().replace(/\.+$/, '')
  if (base && /\s/.test(base)) throw bad(`fieldsBase 含空白:${base}`)

  const specs: MqttFieldSpec[] = []
  const seen = new Set<string>()
  const push = (label: string, value: unknown) => {
    if (specs.length >= MAX_FIELDS) throw bad(`fields 数量超过上限 ${MAX_FIELDS}`)
    if (seen.has(label)) throw bad(`fields 字段名重复:${label}`)
    seen.add(label)
    let pathRaw: unknown
    let rest: Record<string, unknown> = {}
    if (typeof value === 'string') {
      pathRaw = value
    }
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      rest = value as Record<string, unknown>
      pathRaw = rest.path ?? rest.jsonPath
    }
    else {
      throw bad(`fields 字段「${label}」的值必须是路径字符串或对象 {path,...}`)
    }
    const path = normalizePath(pathRaw, label)
    const fullPath = base && !path.startsWith(`${base}.`) && path !== base ? `${base}.${path}` : path
    const min = asFiniteNumber(rest.min, `字段「${label}」min`)
    const max = asFiniteNumber(rest.max, `字段「${label}」max`)
    if (min !== undefined && max !== undefined && min >= max) throw bad(`字段「${label}」量程非法:min(${min}) 必须小于 max(${max})`)
    const warnLow = asFiniteNumber(rest.warnLow, `字段「${label}」warnLow`)
    const warnHigh = asFiniteNumber(rest.warnHigh, `字段「${label}」warnHigh`)
    if (warnLow !== undefined && warnHigh !== undefined && warnLow > warnHigh) {
      throw bad(`字段「${label}」预警带非法:warnLow(${warnLow}) 不能大于 warnHigh(${warnHigh})`)
    }
    const decimals = asFiniteNumber(rest.decimals, `字段「${label}」decimals`)
    if (decimals !== undefined && (!Number.isInteger(decimals) || decimals < 0 || decimals > 4)) {
      throw bad(`字段「${label}」decimals 必须是 0~4 的整数(当前: ${String(rest.decimals)})`)
    }
    specs.push({
      label,
      path: fullPath,
      unit: rest.unit == null ? undefined : String(rest.unit),
      min,
      max,
      warnLow: warnLow ?? null,
      warnHigh: warnHigh ?? null,
      decimals,
      templateRef: rest.templateRef == null ? undefined : String(rest.templateRef),
      name: rest.name == null ? undefined : String(rest.name).trim(),
      semantics: rest.semantics == null ? undefined : String(rest.semantics),
    })
  }

  if (Array.isArray(parsed)) {
    parsed.forEach((item, i) => {
      if (typeof item === 'string') {
        const path = normalizePath(item, `#${i + 1}`)
        const label = path.split('.').pop() || `field${i + 1}`
        push(label, item)
      }
      else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>
        const path = normalizePath(obj.path ?? obj.jsonPath, `#${i + 1}`)
        const label = normalizeLabel(obj.label ?? obj.name ?? path.split('.').pop() ?? `field${i + 1}`, i)
        push(label, item)
      }
      else {
        throw bad(`fields 第 ${i + 1} 项必须是路径字符串或对象`)
      }
    })
  }
  else if (parsed && typeof parsed === 'object') {
    let i = 0
    for (const [labelRaw, value] of Object.entries(parsed as Record<string, unknown>)) {
      push(normalizeLabel(labelRaw, i), value)
      i++
    }
  }
  else {
    throw bad('fields 必须是对象或数组(JSON)')
  }

  if (!specs.length) throw bad('fields 不能为空:至少声明一个字段')
  if (specs.length > MAX_FIELDS) throw bad(`fields 数量超过上限 ${MAX_FIELDS}(${specs.length})`)
  return specs
}

/** 是否声明了多字段配置(用于 API 分流;不抛错)。 */
export function hasMqttFieldSpecs(driverConfig: Record<string, unknown> | undefined, topLevel?: unknown): boolean {
  if (topLevel !== undefined && topLevel !== null && topLevel !== '') return true
  const raw = driverConfig?.fields
  return raw !== undefined && raw !== null && raw !== ''
}

function assertScalarTemplate(ref: string, lookup: TemplateLookup): DaqTemplateDef {
  const tpl = lookup(daqKeyFromRef(ref))
  if (!tpl) throw bad(`未知数采模板: ${ref}`)
  if (tpl.signalKind && tpl.signalKind !== 'scalar') {
    throw bad(`多字段展开仅支持 scalar 信号模板(字段模板 ${ref} 是 ${tpl.signalKind})`)
  }
  return tpl
}

/**
 * 构建"一次配置 → N 个 scalar 节点"的创建输入。
 * 返回 null 表示未声明 fields(调用方走单节点路径)。
 */
export function buildMqttFieldGroup(
  input: DaqCreateInput,
  opts: { groupId?: string, lookup?: TemplateLookup, newGroupId?: () => string } = {},
): FieldGroupPlan | null {
  const driverConfig = (input.driverConfig ?? {}) as Record<string, unknown>
  const raw = driverConfig.fields ?? (input as unknown as Record<string, unknown>).fields
  if (raw === undefined || raw === null || raw === '') return null

  // fields 语义只属于 MQTT:未显式给 driver 时按 mqtt 处理(显式其它驱动则拒绝)
  const driver = (input.driver ?? 'mqtt') as DaqDriverKind
  if (driver !== 'mqtt') throw bad(`fields 多字段展开仅支持 mqtt 驱动(当前: ${driver})`)
  const hit = INCOMPATIBLE_KEYS.find(k => driverConfig[k] !== undefined && driverConfig[k] !== '')
  if (hit) throw bad(`fields 与 ${hit} 互斥:多字段展开只做标量字段解析,向量/图像/自定义解码请单独建节点`)

  const templateRef = String(input.templateRef ?? '').trim()
  if (!templateRef) throw bad('templateRef 必填:数采节点必须绑定信号模板')
  const lookup: TemplateLookup = opts.lookup ?? ((ref: string) => findDaqTemplate(daqKeyFromRef(ref)))
  const parentTpl = assertScalarTemplate(templateRef, lookup)

  const specs = parseMqttFieldSpecs(raw, driverConfig.fieldsBase ?? (input as unknown as Record<string, unknown>).fieldsBase) ?? []
  if (!specs.length) throw bad('fields 不能为空:至少声明一个字段')

  const groupId = opts.groupId ?? `dg-${(opts.newGroupId ?? (() => randomUUID().slice(0, 8)))()}`
  const baseName = String(input.name ?? parentTpl.name ?? 'MQTT 多字段').trim() || 'MQTT 多字段'
  const baseCfg: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(driverConfig)) {
    if (k === 'fields' || k === 'fieldsBase') continue
    // 父级 jsonPath 不复制:每个子节点用自己的字段路径(避免误配成同一字段)
    if (k === 'jsonPath') continue
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') baseCfg[k] = v
  }

  const inputs: DaqCreateInput[] = []
  const seenNames = new Set<string>()
  for (const spec of specs) {
    const childRef = spec.templateRef ?? templateRef
    const childTpl = assertScalarTemplate(childRef, lookup)
    const min = spec.min ?? input.min
    const max = spec.max ?? input.max
    if (min !== undefined && max !== undefined && Number(min) >= Number(max)) {
      throw bad(`字段「${spec.label}」量程非法:min(${min}) 必须小于 max(${max})`)
    }
    const name = spec.name || `${baseName}·${spec.label}`
    if (seenNames.has(name)) throw bad(`多字段展开产生重名节点:${name}`)
    seenNames.add(name)
    inputs.push({
      templateRef: childRef,
      name,
      driver: 'mqtt',
      driverConfig: { ...baseCfg, jsonPath: spec.path, fieldGroup: groupId, fieldLabel: spec.label },
      unit: spec.unit ?? input.unit ?? childTpl.unit,
      decimals: spec.decimals ?? input.decimals ?? childTpl.decimals,
      min: min ?? childTpl.min,
      max: max ?? childTpl.max,
      warnLow: spec.warnLow ?? input.warnLow ?? null,
      warnHigh: spec.warnHigh ?? input.warnHigh ?? null,
      intervalMs: input.intervalMs ?? null,
      publishIntervalMs: input.publishIntervalMs ?? null,
      enabled: input.enabled,
      lineId: input.lineId,
      semantics: spec.semantics ?? input.semantics ?? childTpl.semantics,
      // 场景落点不复制到多子节点:否则多个节点重叠在同一坐标
      posX: undefined,
      posZ: undefined,
    })
  }
  return { groupId, baseName, inputs }
}
