/**
 * DcwLineRepo —— 产线(生产单元)持久化仓库(lines.json)。
 *
 * 产线 = 节点/产品/配方/批次的顶层隔离维度:开跑、数采门控、写联锁、
 * 数字孪生场景光晕都按 lineId 分组。轻元数据实体,JSON 落盘与产品仓库同构。
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { dcwLineColorFor, type LineInput, type LineView } from '../../../../shared/dcw-protocol'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { AppError, ErrorCodes } from '../../../utils/errors'
import { resolveModeChange } from '../agents/binding-mode'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'

// 配置根 .AgentWorkShop/data（ensureDataDir 自动迁移旧 cwd/server/data 位置）
const DB_PATH = join(ensureDataDir(), 'dcw-lines.json')

function load(): LineView[] {
  const parsed = loadJsonFile(DB_PATH, [])
  return Array.isArray(parsed) ? parsed as LineView[] : []
}

function save(list: LineView[]): void {
  saveJsonFileAtomic(DB_PATH, list)
}

export class DcwLineRepo {
  private list: LineView[] = load().map(l => ({ controlMode: 'manual', ...l }) as LineView)

  all(): LineView[] {
    return this.list
  }

  byId(id: string): LineView | undefined {
    return this.list.find(l => l.id === id)
  }

  /** 线级控制模式总闸(读侧归一):存量数据无字段按 'manual'(fail-safe)生效 */
  controlModeOf(id: string): 'auto' | 'manual' {
    return this.byId(id)?.controlMode === 'auto' ? 'auto' : 'manual'
  }

  create(input: LineInput): LineView {
    const name = String(input.name ?? '').trim()
    if (!name) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '产线名称必填')
    // 新线缺省 manual(fail-safe):宁多批一次,不可漏批一次;显式 controlMode='auto'
    // 视为建线即知悉(带确认语义的调用方使用;REST 建线不透传该字段)。
    const mode = input.controlMode === 'auto' ? 'auto' : 'manual'
    const line: LineView = {
      id: `ln-${randomUUID().slice(0, 8)}`,
      name,
      // 缺省按创建序取光晕色板(1号蓝 2号黄…);用户可显式指定
      color: String(input.color ?? '').trim() || dcwLineColorFor(this.list.length),
      description: String(input.description ?? '').trim(),
      controlMode: mode,
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
    if (patch.controlMode !== undefined) {
      // 复用绑定模式守卫:manual→auto 等于摘掉人工审批闸门,必须显式 confirm:true
      const decision = resolveModeChange(this.controlModeOf(id), patch.controlMode, patch.confirm)
      if (!decision.ok) throw new AppError(400, 'MODE_CONFIRM_REQUIRED', decision.error ?? '切换控制模式需显式风险确认')
      if (!decision.noop) line.controlMode = patch.controlMode
    }
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
