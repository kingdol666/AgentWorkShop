/**
 * DaqTemplate 注册表 —— 内置模板(shared 单一事实源)+ 用户自定义模板的统一查询口。
 *
 * 自定义模板落盘 server/data/daq-templates.json(仅存自定义;内置始终在代码里),
 * 与 DaqNodeRepo 同风格:进程内缓存 + 同步落盘(量小无抖动)。节点创建校验、
 * 缺省域、mock 采样一律经 findDaqTemplate 查找 —— 自定义模板与内置同权。
 */

import { createLogger } from '../logger'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DAQ_TEMPLATES, DAQ_TEMPLATE_ICONS, daqTemplateByKey, normalizeSignalKind, type DaqMetricRule, type DaqSinkStep, type DaqTemplateDef, type DaqTemplateIcon, type DaqTemplateInput } from '../../../../shared/daq-protocol'
import { AppError, ErrorCodes } from '../../../utils/errors'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'

const log = createLogger('daq.templates')

/** 业务错误捷径(经 defineApiHandler 映射为对应 HTTP 状态与消息) */
const bad = (msg: string): AppError => new AppError(400, ErrorCodes.VALIDATION_ERROR, msg)

// 配置根 .AgentWorkShop/data（ensureDataDir 统一解析 + 旧位置迁移）
const DB_PATH = join(ensureDataDir(), 'daq-templates.json')

function load(): DaqTemplateDef[] {
  try {
    const parsed = loadJsonFile(DB_PATH, null)
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

  // 多形态信号(v2 帧管线):signalKind/vector/sink/metrics 归一(缺省 scalar 零行为变化)
  const signalKind = normalizeSignalKind(input.signalKind ?? prev?.signalKind)
  let vector: DaqTemplateDef['vector']
  if (signalKind === 'vector') {
    const points = Math.round(Number(input.vector?.points ?? prev?.vector?.points ?? 64))
    if (!Number.isInteger(points) || points < 2 || points > 4096) {
      throw bad('vector.points 需为 2~4096 的整数')
    }
    const vmin = Number(input.vector?.min ?? prev?.vector?.min ?? min)
    const vmax = Number(input.vector?.max ?? prev?.vector?.max ?? max)
    if (!Number.isFinite(vmin) || !Number.isFinite(vmax) || vmin >= vmax) throw bad('vector 量程非法')
    vector = { points, min: vmin, max: vmax }
  }
  const sink = input.sink ?? prev?.sink
  if (sink && (!Array.isArray(sink.processors) || sink.processors.some(p => !p || typeof p.name !== 'string'))) {
    throw bad('sink.processors 非法:需为 { name, args? } 数组')
  }
  const metrics = (input.metrics ?? prev?.metrics)?.filter(r => r && typeof r.key === 'string' && r.key.trim()) as DaqMetricRule[] | undefined

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
    signalKind,
    vector,
    sink: sink && sink.processors.length > 0 ? { processors: sink.processors as DaqSinkStep[] } : undefined,
    metrics: metrics && metrics.length > 0 ? metrics : undefined,
  }
}

class DaqTemplateRegistry {
  private customs: DaqTemplateDef[]
  /** 插件注册模板(内存态,键 = 模板 key;插件热重载同名覆盖;不经 REST 增删) */
  private pluginTpls = new Map<string, DaqTemplateDef>()

  constructor() {
    this.customs = load()
  }

  /** 全目录:内置在前(统一打 builtin 标记),插件模板居中(打 plugin 标记),自定义在后 */
  all(): DaqTemplateDef[] {
    return [
      ...DAQ_TEMPLATES.map(t => ({ ...t, builtin: true })),
      ...[...this.pluginTpls.values()].map(t => ({ ...t, plugin: t.plugin ?? 'plugin' })),
      ...this.customs,
    ]
  }

  byKey(key: string): DaqTemplateDef | undefined {
    return daqTemplateByKey(key) ?? this.pluginTpls.get(key) ?? this.customs.find(t => t.key === key)
  }

  /**
   * 插件模板注册(同名 key 覆盖 → 插件热重载幂等;REST 不可增删改)。
   * def.key 必填(建议 `plug-<plugin>-<sig>` 命名);signalKind/sink/metrics 全量可用。
   */
  registerPlugin(def: DaqTemplateDef): DaqTemplateDef {
    if (!def?.key || !/^[\w-]+$/.test(def.key)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `插件模板 key 非法: ${def?.key}(需 [\\w-]+)`)
    }
    if (daqTemplateByKey(def.key)) {
      throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `插件模板 key 与内置模板冲突: ${def.key}`)
    }
    const merged: DaqTemplateDef = { ...def, plugin: def.plugin ?? 'plugin' }
    this.pluginTpls.set(def.key, merged)
    log.info(`[daq] 插件模板注册:「${merged.name}」(${def.key},插件=${merged.plugin})`)
    return merged
  }

  isPlugin(key: string): boolean {
    return this.pluginTpls.has(key)
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
    if (this.pluginTpls.has(key)) {
      throw new AppError(400, ErrorCodes.BAD_REQUEST, '插件模板不可经 REST 修改(由插件自身管理)')
    }
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
    if (this.pluginTpls.has(key)) {
      throw new AppError(400, ErrorCodes.BAD_REQUEST, '插件模板不可经 REST 删除(由插件自身管理)')
    }
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
      saveJsonFileAtomic(DB_PATH, this.customs)
    }
    catch (err) {
      log.error('[daq] 模板落盘失败:', err)
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
