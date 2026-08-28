/**
 * Product 仓库 —— 产线产品(server/data/dcw-products.json)。
 * 产品 = 数据隔离顶层维度:一个产品多个配方;批次/样本逐条携带 productId。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProductInput, ProductView } from '../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../utils/errors'

const DB_PATH = process.cwd().endsWith('server')
  ? 'data/dcw-products.json'
  : path.join(process.cwd(), 'server', 'data', 'dcw-products.json')

function load(): ProductView[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'))
    return Array.isArray(parsed) ? parsed as ProductView[] : []
  }
  catch {
    return []
  }
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
      name,
      description: String(input.description ?? '').trim(),
      createdAt: new Date().toISOString(),
    }
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
      fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
      fs.writeFileSync(DB_PATH, JSON.stringify(this.list, null, 2), 'utf-8')
    }
    catch (err) {
      console.error('[dcw-product] 落盘失败:', err)
    }
  }
}

const g = globalThis as typeof globalThis & { __dcwProductRepo?: DcwProductRepo }

export function getDcwProductRepo(): DcwProductRepo {
  g.__dcwProductRepo ??= new DcwProductRepo()
  return g.__dcwProductRepo
}
