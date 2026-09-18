/**
 * Product 仓库 —— 产线产品(server/data/dcw-products.json)。
 * 产品 = 数据隔离顶层维度:一个产品多个配方;批次/样本逐条携带 productId。
 */

import { createLogger } from '../logger'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProductInput, ProductView } from '../../../../shared/dcw-protocol'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { AppError, ErrorCodes } from '../../../utils/errors'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'

const log = createLogger('dcw.product-repo')

// 配置根 .AgentWorkShop/data（ensureDataDir 自动迁移旧 cwd/server/data 位置）
const DB_PATH = join(ensureDataDir(), 'dcw-products.json')

function load(): ProductView[] {
  try {
    const parsed = loadJsonFile(DB_PATH, null)
    return Array.isArray(parsed) ? parsed.map(normRow) as ProductView[] : []
  }
  catch {
    return []
  }
}

/** 行规范化:paramLimits 键值容错(非有限数字的侧丢弃;min>max 整条丢弃) */
function normRow(p: ProductView): ProductView {
  const raw = p.paramLimits
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return p
  const out: ProductView['paramLimits'] = {}
  for (const [key, range] of Object.entries(raw)) {
    if (!key || range == null || typeof range !== 'object') continue
    const min = range.min == null ? undefined : Number(range.min)
    const max = range.max == null ? undefined : Number(range.max)
    const okMin = min == null || Number.isFinite(min)
    const okMax = max == null || Number.isFinite(max)
    if (!okMin || !okMax) continue
    if (min != null && max != null && min > max) continue
    const entry: { min?: number, max?: number } = {}
    if (min != null) entry.min = min
    if (max != null) entry.max = max
    if (Object.keys(entry).length > 0) out[key] = entry
  }
  return { ...p, paramLimits: out }
}

/** 载荷规范化(创建/更新共用;键级有效性由控制器按产线工艺参数校验) */
function normLimitsInput(v: unknown): Record<string, { min?: number, max?: number }> | undefined {
  if (v == null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'paramLimits 需为对象(键=工艺参数 key)')
  }
  return normRow({ paramLimits: v as ProductView['paramLimits'] } as ProductView).paramLimits
}

class DcwProductRepo {
  private list: ProductView[] = load()

  all(): ProductView[] {
    return this.list
  }

  byId(id: string): ProductView | undefined {
    return this.list.find(p => p.id === id)
  }

  create(input: ProductInput): ProductView {
    const name = String(input.name ?? '').trim()
    if (!name) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '产品名称必填')
    const p: ProductView = {
      id: `pd-${randomUUID().slice(0, 8)}`,
      lineId: String(input.lineId ?? ''),
      name,
      description: String(input.description ?? '').trim(),
      createdAt: new Date().toISOString(),
    }
    const limits = normLimitsInput(input.paramLimits)
    if (limits) p.paramLimits = limits
    this.list.push(p)
    this.flush()
    return p
  }

  update(id: string, patch: Partial<ProductInput>): ProductView {
    const p = this.byId(id)
    if (!p) throw new AppError(404, ErrorCodes.NOT_FOUND, `产品不存在: ${id}`)
    if (patch.name !== undefined) {
      const name = String(patch.name).trim()
      if (!name) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '产品名称必填')
      p.name = name
    }
    if (patch.description !== undefined) p.description = String(patch.description).trim()
    if (patch.lineId !== undefined) p.lineId = String(patch.lineId)
    if (patch.paramLimits !== undefined) {
      const limits = normLimitsInput(patch.paramLimits)
      if (limits && Object.keys(limits).length > 0) p.paramLimits = limits
      else delete p.paramLimits
    }
    this.flush()
    return p
  }

  remove(id: string): boolean {
    const before = this.list.length
    this.list = this.list.filter(p => p.id !== id)
    if (this.list.length !== before) {
      this.flush()
      return true
    }
    return false
  }

  private flush(): void {
    try {
      saveJsonFileAtomic(DB_PATH, this.list)
    }
    catch (err) {
      log.error('[dcw-product] 落盘失败:', err)
    }
  }
}

const g = globalThis as typeof globalThis & { __dcwProductRepo?: DcwProductRepo }

export function getDcwProductRepo(): DcwProductRepo {
  g.__dcwProductRepo ??= new DcwProductRepo()
  return g.__dcwProductRepo
}
