/**
 * DcwTemplate 注册表 —— 内置控制模板 + 用户自定义模板的统一查询口。
 * 自定义落盘 server/data/dcw-templates.json(与 daq-templates 同风格)。
 */

import { createLogger } from '../logger'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DCW_TEMPLATES, DCW_TEMPLATE_ICONS, dcwTemplateByKey, type DcwTemplateDef, type DcwTemplateIcon, type DcwTemplateInput } from '../../../../shared/dcw-protocol'

// dcwTemplateByKey 用于内置判别
import { AppError, ErrorCodes } from '../../../utils/errors'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'

const log = createLogger('dcw.templates')

const DB_PATH = process.cwd().endsWith('server')
  ? 'data/dcw-templates.json'
  : path.join(process.cwd(), 'server', 'data', 'dcw-templates.json')

function load(): DcwTemplateDef[] {
  try {
    const parsed = loadJsonFile(DB_PATH, null)
    return Array.isArray(parsed) ? parsed as DcwTemplateDef[] : []
  }
  catch {
    return []
  }
}

const bad = (msg: string): AppError => new AppError(400, ErrorCodes.VALIDATION_ERROR, msg)

function normalize(input: Partial<DcwTemplateInput>, prev?: DcwTemplateDef): DcwTemplateDef {
  const name = String(input.name ?? prev?.name ?? '').trim()
  if (!name) throw bad('模板名称必填')
  const unit = String(input.unit ?? prev?.unit ?? '').trim()
  if (!unit) throw bad('单位必填(如 ℃ / m/min)')

  const min = Number(input.min ?? prev?.min)
  const max = Number(input.max ?? prev?.max)
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    throw bad('工艺量程非法:需满足 min < max 的数字')
  }
  const decimals = Math.round(Number(input.decimals ?? prev?.decimals ?? 2))
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) throw bad('小数位需为 0~4 的整数')

  const iconRaw = String(input.icon ?? prev?.icon ?? 'thermo')
  const icon = (DCW_TEMPLATE_ICONS as readonly string[]).includes(iconRaw)
    ? iconRaw as DcwTemplateIcon
    : 'thermo'

  return {
    key: prev?.key ?? `cw-${randomUUID().slice(0, 8)}`,
    name,
    code: String(input.code ?? prev?.code ?? name).trim().toUpperCase() || name.toUpperCase(),
    ch: String(input.ch ?? prev?.ch ?? name).trim() || name,
    unit,
    min,
    max,
    decimals,
    icon,
    semantics: String(input.semantics ?? prev?.semantics ?? '').trim() || undefined,
    builtin: false,
  }
}

class DcwTemplateRegistry {
  private customs: DcwTemplateDef[]

  constructor() {
    this.customs = load()
  }

  all(): DcwTemplateDef[] {
    return [...DCW_TEMPLATES.map(t => ({ ...t, builtin: true })), ...this.customs]
  }

  byKey(key: string): DcwTemplateDef | undefined {
    return dcwTemplateByKey(key) ?? this.customs.find(t => t.key === key)
  }

  create(input: DcwTemplateInput): DcwTemplateDef {
    const tpl = normalize(input)
    if (this.customs.some(t => t.name === tpl.name)) {
      throw new AppError(409, ErrorCodes.CONFLICT, `同名自定义模板已存在: ${tpl.name}`)
    }
    this.customs.push(tpl)
    this.flush()
    return tpl
  }

  update(key: string, patch: Partial<DcwTemplateInput>): DcwTemplateDef {
    const prev = this.customs.find(t => t.key === key)
    if (!prev) {
      throw new AppError(400, ErrorCodes.BAD_REQUEST, dcwTemplateByKey(key) ? '内置模板不可修改(可复制为自定义)' : `自定义模板不存在: ${key}`)
    }
    const tpl = normalize(patch, prev)
    this.customs = this.customs.map(t => (t.key === key ? tpl : t))
    this.flush()
    return tpl
  }

  remove(key: string): DcwTemplateDef {
    const prev = this.customs.find(t => t.key === key)
    if (!prev) {
      throw new AppError(400, ErrorCodes.BAD_REQUEST, dcwTemplateByKey(key) ? '内置模板不可删除' : `自定义模板不存在: ${key}`)
    }
    this.customs = this.customs.filter(t => t.key !== key)
    this.flush()
    return prev
  }

  private flush(): void {
    try {
      saveJsonFileAtomic(DB_PATH, this.customs)
    }
    catch (err) {
      log.error('[dcw] 模板落盘失败:', err)
    }
  }
}

const g = globalThis as typeof globalThis & { __dcwTemplateRegistry?: DcwTemplateRegistry }

export function getDcwTemplateRegistry(): DcwTemplateRegistry {
  g.__dcwTemplateRegistry ??= new DcwTemplateRegistry()
  return g.__dcwTemplateRegistry
}

export function listDcwTemplates(): DcwTemplateDef[] {
  return getDcwTemplateRegistry().all()
}

export function findDcwTemplate(key: string): DcwTemplateDef | undefined {
  return getDcwTemplateRegistry().byKey(key)
}
