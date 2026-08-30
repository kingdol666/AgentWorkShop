/**
 * DaqTemplate 注册表 —— 内置模板(shared 单一事实源)+ 用户自定义模板的统一查询口。
 *
 * 自定义模板落盘 server/data/daq-templates.json(仅存自定义;内置始终在代码里),
 * 与 DaqNodeRepo 同风格:进程内缓存 + 同步落盘(量小无抖动)。节点创建校验、
 * 缺省域、mock 采样一律经 findDaqTemplate 查找 —— 自定义模板与内置同权。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DAQ_TEMPLATES, DAQ_TEMPLATE_ICONS, daqTemplateByKey, type DaqTemplateDef, type DaqTemplateIcon, type DaqTemplateInput } from '../../../../shared/daq-protocol'
import { AppError, ErrorCodes } from '../../../utils/errors'

/** 业务错误捷径(经 defineApiHandler 映射为对应 HTTP 状态与消息) */
const bad = (msg: string): AppError => new AppError(400, ErrorCodes.VALIDATION_ERROR, msg)

const DB_PATH = process.cwd().endsWith('server')
  ? 'data/daq-templates.json'
  : path.join(process.cwd(), 'server', 'data', 'daq-templates.json')

function load(): DaqTemplateDef[] {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as DaqTemplateDef[] : []
  }
  catch {
    return []
  }
}

/** 输入校验 + 归一(base/amp/decimals 等缺省由量程推导;非法值直接抛业务错误) */
function normalize(input: Partial<DaqTemplateInput>, prev?: DaqTemplateDef): DaqTemplateDef {
  const name = String(input.name ?? prev?.name ?? '').trim()
  if (!name) throw bad('模板名称必填')
  const unit = String(input.unit ?? prev?.unit ?? '').trim()
  if (!unit) throw bad('单位必填(如 ℃ / MPa)')

  const min = Number(input.min ?? prev?.min)
  const max = Number(input.max ?? prev?.max)
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    throw bad('量程非法:需满足 min < max 的数字')
  }

  const base = input.base ?? prev?.base ?? (min + max) / 2
  if (!Number.isFinite(Number(base))) throw bad('模拟基值需为数字')

  const amp = Number(input.amp ?? prev?.amp ?? Math.max((max - min) * 0.04, 0.001))
  if (!Number.isFinite(amp) || amp <= 0) throw bad('模拟波幅需为正数')

  const decimals = Math.round(Number(input.decimals ?? prev?.decimals ?? 2))
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) {
    throw bad('小数位需为 0~4 的整数')
  }

  const iconRaw = String(input.icon ?? prev?.icon ?? 'thermo')
  const icon = (DAQ_TEMPLATE_ICONS as readonly string[]).includes(iconRaw)
    ? iconRaw as DaqTemplateIcon
    : 'thermo'

  return {
    key: prev?.key ?? `ct-${randomUUID().slice(0, 8)}`,
    name,
    code: String(input.code ?? prev?.code ?? name).trim().toUpperCase() || name.toUpperCase(),
    ch: String(input.ch ?? prev?.ch ?? name).trim() || name,
    unit,
    base: Number(base),
    amp,
    min,
    max,
    decimals,
    icon,
    semantics: String(input.semantics ?? prev?.semantics ?? '').trim() || undefined,
    telemetryKey: String(input.telemetryKey ?? prev?.telemetryKey ?? '').trim() || undefined,
    builtin: false,
  }
}

class DaqTemplateRegistry {
  private customs: DaqTemplateDef[]

  constructor() {
    this.customs = load()
  }

  /** 全目录:内置在前(统一打 builtin 标记,前端据此分区),自定义在后 */
  all(): DaqTemplateDef[] {
    return [...DAQ_TEMPLATES.map(t => ({ ...t, builtin: true })), ...this.customs]
  }

  byKey(key: string): DaqTemplateDef | undefined {
    return daqTemplateByKey(key) ?? this.customs.find(t => t.key === key)
  }

  create(input: DaqTemplateInput): DaqTemplateDef {
    const tpl = normalize(input)
    if (this.customs.some(t => t.name === tpl.name)) {
      throw new AppError(409, ErrorCodes.CONFLICT, `同名自定义模板已存在: ${tpl.name}`)
    }
    this.customs.push(tpl)
    this.flush()
    return tpl
  }

  update(key: string, patch: Partial<DaqTemplateInput>): DaqTemplateDef {
    const prev = this.customs.find(t => t.key === key)
    if (!prev) {
      throw new AppError(400, ErrorCodes.BAD_REQUEST, daqTemplateByKey(key) ? '内置模板不可修改(可复制为自定义)' : `自定义模板不存在: ${key}`)
    }
    const tpl = normalize(patch, prev)
    this.customs = this.customs.map(t => (t.key === key ? tpl : t))
    this.flush()
    return tpl
  }

  remove(key: string): DaqTemplateDef {
    const prev = this.customs.find(t => t.key === key)
    if (!prev) {
      throw new AppError(400, ErrorCodes.BAD_REQUEST, daqTemplateByKey(key) ? '内置模板不可删除' : `自定义模板不存在: ${key}`)
    }
    this.customs = this.customs.filter(t => t.key !== key)
    this.flush()
    return prev
  }

  private flush(): void {
    try {
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
      fs.writeFileSync(DB_PATH, JSON.stringify(this.customs, null, 2), 'utf-8')
    }
    catch (err) {
      console.error('[daq] 模板落盘失败:', err)
    }
  }
}

// 单例(HMR 存活,与 DaqNodeRepo 同风格)
const g = globalThis as typeof globalThis & { __daqTemplateRegistry?: DaqTemplateRegistry }

export function getDaqTemplateRegistry(): DaqTemplateRegistry {
  g.__daqTemplateRegistry ??= new DaqTemplateRegistry()
  return g.__daqTemplateRegistry
}

/** 目录快照(server 返回给前端时附带 builtin 标记) */
export function listDaqTemplates(): DaqTemplateDef[] {
  return getDaqTemplateRegistry().all()
}

/** 节点缺省域/mock 采样的统一查找口(内置 + 自定义) */
export function findDaqTemplate(key: string): DaqTemplateDef | undefined {
  return getDaqTemplateRegistry().byKey(key)
}
