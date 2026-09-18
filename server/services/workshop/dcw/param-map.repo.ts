/**
 * DcwParamRepo —— 工艺参数映射仓库(data/dcw-params.json)。
 *
 * 工艺参数映射 = 「工艺参数(语义面) → 写控制执行节点(PLC 面)」的显式绑定:
 * 用户/Agent 只面向参数(key/单位/工程量)读写,寄存器/数据类型/字节序等 PLC
 * 细节全部封装在执行节点驱动配置内(单一事实源,参数面不透出)。
 *
 * 生命周期:节点创建即自动生成同名映射(开箱即得的参数面,ensureForNode);
 * 节点删除级联清理映射(removeForNode);映射删除不影响节点执行能力。
 * lineId 不落盘 —— 派生自执行节点(节点换线参数自动跟随,单一事实源)。
 */

import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DcwNodeView, DcwParamInput, DcwParamView } from '../../../../shared/dcw-protocol'
import { ensureDataDir } from '@/shared/config/home.mjs'
import { AppError, ErrorCodes } from '../../../utils/errors'
import { createLogger } from '../logger'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'
import { getDcwNodeRepo } from './dcw-node.repo'
import type { DcwNode } from './dcw-node'

const log = createLogger('dcw.param-repo')

// 配置根 .AgentWorkShop/data（ensureDataDir 自动迁移旧 cwd/server/data 位置）
const DB_PATH = join(ensureDataDir(), 'dcw-params.json')

interface DcwParamRow {
  id: string
  /** 参数键(执行节点所属产线内唯一) */
  key: string
  name: string
  templateRef: string
  unit: string
  decimals: number
  /** 基准写入限界(null = 该侧不约束) */
  min: number | null
  max: number | null
  /** 映射目标:写控制执行节点 */
  nodeId: string
  /** 标准转换模式摘要(配置期选定;运行期换算以执行节点驱动配置为单一事实源) */
  conversion?: DcwParamView['conversion']
  createdAt: string
}

function load(): DcwParamRow[] {
  try {
    const parsed = loadJsonFile(DB_PATH, null)
    return Array.isArray(parsed) ? parsed as DcwParamRow[] : []
  }
  catch {
    return []
  }
}

/** 参数键规范化:去空白;空串拒绝 */
const normKey = (key: unknown): string => String(key ?? '').trim()

class DcwParamRepo {
  private list: DcwParamRow[] = load()

  all(): DcwParamRow[] {
    return this.list
  }

  byId(id: string): DcwParamRow | undefined {
    return this.list.find(p => p.id === id)
  }

  byNode(nodeId: string): DcwParamRow | undefined {
    return this.list.find(p => p.nodeId === nodeId)
  }

  /** 按 key 检索(可能跨产线同名;返回全部命中) */
  byKey(key: string): DcwParamRow[] {
    const k = normKey(key)
    return this.list.filter(p => p.key === k)
  }

  /** key 在某产线内是否已被占用(经执行节点的产线归属判定) */
  keyTakenOnLine(key: string, lineId: string, excludeId?: string): boolean {
    const k = normKey(key)
    const nodeRepo = getDcwNodeRepo()
    return this.list.some((p) => {
      if (p.id === excludeId || p.key !== k) return false
      return (nodeRepo.byId(p.nodeId)?.lineId ?? '') === lineId
    })
  }

  /** 产线内唯一化 key:base / base-2 / base-3 … */
  uniqueKeyOnLine(base: string, lineId: string): string {
    const root = normKey(base) || 'param'
    if (!this.keyTakenOnLine(root, lineId)) return root
    for (let i = 2; ; i++) {
      const candidate = `${root}-${i}`
      if (!this.keyTakenOnLine(candidate, lineId)) return candidate
    }
  }

  /**
   * 创建映射。校验:执行节点存在;templateRef 可解析(缺省继承节点);
   * key 产线内唯一(缺省继承模板 key,冲突自动加后缀);min<=max。
   */
  create(input: DcwParamInput): DcwParamRow {
    const nodeRepo = getDcwNodeRepo()
    const nodeId = String(input.nodeId ?? '').trim()
    if (!nodeId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'nodeId 必填:工艺参数映射必须指向一个写控制执行节点')
    const node = nodeRepo.byId(nodeId)
    if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `执行节点不存在: ${nodeId}`)
    const templateRef = String(input.templateRef ?? node.templateRef ?? '').trim()
    if (!templateRef) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'templateRef 必填:工艺参数需绑定语义模板')
    const lineId = node.lineId
    const key = input.key == null
      ? this.uniqueKeyOnLine(node.templateKey, lineId)
      : (() => {
          const k = normKey(input.key)
          if (!k) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '参数键 key 不可为空')
          if (this.keyTakenOnLine(k, lineId)) throw new AppError(409, ErrorCodes.CONFLICT, `参数键「${k}」在本产线已被占用(产线内唯一)`)
          return k
        })()
    const { min, max } = normRange(input.min, input.max, key)
    const row: DcwParamRow = {
      id: `pp-${randomUUID().slice(0, 8)}`,
      key,
      name: String(input.name ?? node.name ?? key).trim() || key,
      templateRef,
      unit: String(input.unit ?? node.unit ?? '').trim(),
      decimals: clampDecimals(input.decimals ?? node.decimals),
      min,
      max,
      nodeId,
      createdAt: new Date().toISOString(),
    }
    if (input.conversion) row.conversion = input.conversion
    this.list.push(row)
    this.flush()
    return row
  }

  update(id: string, patch: DcwParamInput): DcwParamRow {
    const row = this.byId(id)
    if (!row) throw new AppError(404, ErrorCodes.NOT_FOUND, `工艺参数映射不存在: ${id}`)
    const node = getDcwNodeRepo().byId(row.nodeId)
    const lineId = node?.lineId ?? ''
    if (patch.key !== undefined) {
      const k = normKey(patch.key)
      if (!k) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '参数键 key 不可为空')
      if (this.keyTakenOnLine(k, lineId, row.id)) throw new AppError(409, ErrorCodes.CONFLICT, `参数键「${k}」在本产线已被占用(产线内唯一)`)
      row.key = k
    }
    if (patch.name !== undefined) row.name = String(patch.name).trim() || row.key
    if (patch.templateRef !== undefined) {
      const t = String(patch.templateRef).trim()
      if (!t) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'templateRef 不可为空')
      row.templateRef = t
    }
    if (patch.unit !== undefined) row.unit = String(patch.unit).trim()
    if (patch.decimals !== undefined) row.decimals = clampDecimals(patch.decimals)
    if (patch.min !== undefined || patch.max !== undefined) {
      const { min, max } = normRange(
        patch.min === undefined ? row.min : patch.min,
        patch.max === undefined ? row.max : patch.max,
        row.key,
      )
      row.min = min
      row.max = max
    }
    if (patch.conversion !== undefined) {
      if (patch.conversion == null) delete row.conversion
      else row.conversion = patch.conversion
    }
    // nodeId 映射目标不可变:换绑请删建(避免账本/限界层悬空引用)
    this.flush()
    return row
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

  removeForNode(nodeId: string): boolean {
    const before = this.list.length
    this.list = this.list.filter(p => p.nodeId !== nodeId)
    if (this.list.length !== before) {
      this.flush()
      return true
    }
    return false
  }

  /**
   * 节点创建即自动生成参数映射(开箱即得的参数面)。防御性:任何失败只记日志
   * 不阻断节点创建(节点是执行主体,映射面可事后手工补建)。
   */
  ensureForNode(node: DcwNode): DcwParamRow | undefined {
    try {
      const existing = this.byNode(node.id)
      if (existing) return existing
      const row: DcwParamRow = {
        id: `pp-${randomUUID().slice(0, 8)}`,
        key: this.uniqueKeyOnLine(node.templateKey, node.lineId),
        name: node.name,
        templateRef: node.templateRef,
        unit: node.unit,
        decimals: node.decimals,
        min: null,
        max: null,
        nodeId: node.id,
        createdAt: new Date().toISOString(),
      }
      this.list.push(row)
      this.flush()
      return row
    }
    catch (err) {
      log.error('[dcw-param] 节点参数面自动生成失败(不影响节点):', err)
      return undefined
    }
  }

  /** 视图投影(联接执行节点;节点已删除的悬空行过滤返回 null) */
  viewOf(row: DcwParamRow): DcwParamView | null {
    const node = getDcwNodeRepo().byId(row.nodeId)
    if (!node) return null
    return this.project(row, node.toView())
  }

  listViews(): DcwParamView[] {
    const nodeRepo = getDcwNodeRepo()
    const views = new Map(nodeRepo.all().map(n => [n.id, n.toView()]))
    return this.list
      .map(p => views.get(p.nodeId) ? this.project(p, views.get(p.nodeId)!) : null)
      .filter((v): v is DcwParamView => v != null)
  }

  private project(row: DcwParamRow, node: DcwNodeView): DcwParamView {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      templateRef: row.templateRef,
      unit: row.unit || node.unit,
      decimals: row.decimals,
      min: row.min,
      max: row.max,
      nodeId: row.nodeId,
      lineId: node.lineId,
      driver: node.driver,
      enabled: node.enabled,
      value: node.value,
      readValue: node.readValue,
      state: node.state,
      conversion: row.conversion,
      createdAt: row.createdAt,
    }
  }

  private flush(): void {
    try {
      saveJsonFileAtomic(DB_PATH, this.list)
    }
    catch (err) {
      log.error('[dcw-param] 落盘失败:', err)
    }
  }
}

/** 限界规范化:有限数字或 null;min<=max */
function normRange(min: unknown, max: unknown, label: string): { min: number | null, max: number | null } {
  const nOf = (v: unknown): number | null => {
    if (v == null || v === '') return null
    const n = Number(v)
    if (!Number.isFinite(n)) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `工艺参数「${label}」限界需为数字或空(当前: ${String(v)})`)
    return n
  }
  const lo = nOf(min)
  const hi = nOf(max)
  if (lo != null && hi != null && lo > hi) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `工艺参数「${label}」限界非法:min ${lo} > max ${hi}`)
  }
  return { min: lo, max: hi }
}

function clampDecimals(v: unknown): number {
  const d = Number(v)
  if (!Number.isInteger(d) || d < 0 || d > 6) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `decimals 必须为 0..6 的整数(当前: ${String(v)})`)
  }
  return d
}

const g = globalThis as typeof globalThis & { __dcwParamRepo?: DcwParamRepo }

export function getDcwParamRepo(): DcwParamRepo {
  g.__dcwParamRepo ??= new DcwParamRepo()
  return g.__dcwParamRepo
}

export type { DcwParamRow }
