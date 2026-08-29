/**
 * DcwLineRepo —— 产线(生产单元)持久化仓库(lines.json)。
 *
 * 产线 = 节点/产品/配方/批次的顶层隔离维度:开跑、数采门控、写联锁、
 * 数字孪生场景光晕都按 lineId 分组。轻元数据实体,JSON 落盘与产品仓库同构。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dcwLineColorFor, type LineInput, type LineView } from '../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../utils/errors'

const DB_PATH = process.cwd().endsWith('server') ? 'data/dcw-lines.json' : path.join(process.cwd(), 'server', 'data', 'dcw-lines.json')

function load(): LineView[] {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}

function save(list: LineView[]): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  fs.writeFileSync(DB_PATH, JSON.stringify(list, null, 2), 'utf-8')
}

export class DcwLineRepo {
  private list: LineView[] = load()

  all(): LineView[] {
    return this.list
  }

  byId(id: string): LineView | undefined {
    return this.list.find(l => l.id === id)
  }

  create(input: LineInput): LineView {
    const name = String(input.name ?? '').trim()
    if (!name) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '产线名称必填')
    const line: LineView = {
      id: `ln-${randomUUID().slice(0, 8)}`,
      name,
      // 缺省按创建序取光晕色板(1号蓝 2号黄…);用户可显式指定
      color: String(input.color ?? '').trim() || dcwLineColorFor(this.list.length),
      description: String(input.description ?? '').trim(),
      createdAt: new Date().toISOString(),
    }
    this.list.push(line)
    save(this.list)
    return line
  }

  update(id: string, patch: Partial<LineInput>): LineView {
    const line = this.byId(id)
    if (!line) throw new AppError(404, ErrorCodes.NOT_FOUND, `产线不存在: ${id}`)
    if (patch.name !== undefined) {
      const name = String(patch.name).trim()
      if (!name) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '产线名称必填')
      line.name = name
    }
    if (patch.color !== undefined) line.color = String(patch.color).trim() || line.color
    if (patch.description !== undefined) line.description = String(patch.description).trim()
    save(this.list)
    return line
  }

  remove(id: string): boolean {
    const prev = this.list.length
    this.list = this.list.filter(l => l.id !== id)
    if (this.list.length !== prev) save(this.list)
    return this.list.length !== prev
  }
}

const g = globalThis as typeof globalThis & { __dcwLineRepo?: DcwLineRepo }

export function getDcwLineRepo(): DcwLineRepo {
  g.__dcwLineRepo ??= new DcwLineRepo()
  return g.__dcwLineRepo
}
