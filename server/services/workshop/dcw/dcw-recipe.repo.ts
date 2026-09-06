/**
 * Recipe 仓库 —— 配方 + 生产批次 + 写历史(server/data/dcw-*.json)。
 *
 * 产品隔离语义:每个 Recipe 应用生成一个 RecipeRun(批次),数采数据/写历史
 * 按批次时间窗归属产品;写历史追加式落盘(上限 3000 条,超出丢最旧)。
 */

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RecipeDaqWindow, RecipeInput, RecipeParam, RecipeRunView, RecipeView } from '../../../../shared/dcw-protocol'
import { dcwKeyFromRef } from '../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../utils/errors'
import { getDcwProductRepo } from './dcw-product.repo'
import { getDcwNodeRepo } from './dcw-node.repo'
import { getDaqNodeRepo } from '../daq/daq-node.repo'
import { loadJsonFile, saveJsonFileAtomic } from '../json-store.mjs'

const DATA_DIR = process.cwd().endsWith('server')
  ? 'data'
  : path.join(process.cwd(), 'server', 'data')
const RECIPES_PATH = path.join(DATA_DIR, 'dcw-recipes.json')
const RUNS_PATH = path.join(DATA_DIR, 'dcw-runs.json')
const WRITES_PATH = path.join(DATA_DIR, 'dcw-writes.json')

const RUNS_CAP = 200
const WRITES_CAP = 3000

function loadJson<T>(file: string, fallback: T): T {
  return loadJsonFile(file, fallback) as T
}

/** 配方变更归因(版本历史/运维日志共用):by=来源,actorName=人话操作者 */
export interface RecipeUpdateMeta {
  by: 'user' | 'agent' | 'system'
  actorName: string
  actor: string
  description: string
}

function saveJson(file: string, data: unknown): void {
  saveJsonFileAtomic(file, data)
}

export interface DcwWriteHistoryEntry {
  id: string
  nodeId: string
  nodeName: string
  /** 参数语义(模板 ch) */
  param: string
  /** 工程值 / 原始值 */
  eng: number
  raw: number | null
  ok: boolean
  message: string
  recipeRunId: string | null
  at: string
}

/**
 * 配方参数归一化(**节点级绑定**):nodeId 必填且必须指向真实控制节点
 * (节点才是真实下发 PLC 的执行体;模板仅分类)。templateRef 为展示冗余,
 * 缺失时按节点自动补全。配方级窗口须 min <= value <= max。
 */
const normParams = (params: RecipeParam[] | undefined, lineId = ''): RecipeParam[] =>
  (params ?? [])
    .filter(p => p && Number.isFinite(Number(p.value)))
    .map((p) => {
      // 节点解析:nodeId 优先;兼容 templateRef 引用(自动解析到该模板最早创建的节点)
      let nodeId = String(p.nodeId ?? '').trim()
      if (!nodeId) {
        const key = dcwKeyFromRef(String(p.templateRef ?? ''))
        const cand = getDcwNodeRepo().all()
          .filter(n => n.templateKey === key)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
        nodeId = cand?.id ?? ''
      }
      if (!nodeId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `配方参数无法解析到控制节点(nodeId/templateRef 均未命中): ${p.templateRef ?? p.nodeId}`)
      const node = getDcwNodeRepo().byId(nodeId)
      if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `配方参数绑定的控制节点不存在: ${nodeId}`)
      // 产线隔离硬约束:参数节点必须属于配方产线;未分配节点自动收编,跨线节点拒绝
      if (lineId) {
        if (!node.lineId) node.lineId = lineId
        else if (node.lineId !== lineId) {
          throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `参数节点「${node.name}」属于其他产线,不可挂入本产线配方(产线隔离)`)
        }
      }
      const label = node.name
      const out: RecipeParam = { nodeId, templateRef: node.templateRef, value: Number(p.value) }
      const min = p.min == null ? undefined : Number(p.min)
      const max = p.max == null ? undefined : Number(p.max)
      if (min != null) {
        if (!Number.isFinite(min)) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `参数 ${label} 的配方下限需为数字`)
        out.min = min
      }
      if (max != null) {
        if (!Number.isFinite(max)) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `参数 ${label} 的配方上限需为数字`)
        out.max = max
      }
      if (out.min != null && out.max != null && out.min > out.max) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `参数 ${label} 的配方窗口非法:min ${out.min} > max ${out.max}`)
      }
      if (out.min != null && out.value < out.min) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `参数 ${label} 设定值 ${out.value} 低于配方下限 ${out.min}`)
      }
      if (out.max != null && out.value > out.max) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `参数 ${label} 设定值 ${out.value} 超出配方上限 ${out.max}`)
      }
      return out
    })

/**
 * 配方级数采监控窗口归一化:绑定数采节点(必填),产线隔离守卫
 * (未分配自动收编/跨线拒绝),窗口需至少一侧且 min <= max。
 */
const normDaqWindows = (windows: RecipeDaqWindow[] | undefined, lineId = ''): RecipeDaqWindow[] =>
  (windows ?? []).map((w) => {
    const nodeId = String(w.nodeId ?? '').trim()
    if (!nodeId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, '数采监控窗口必须绑定数采节点(nodeId 必填)')
    const node = getDaqNodeRepo().byId(nodeId)
    if (!node) throw new AppError(404, ErrorCodes.NOT_FOUND, `监控窗口绑定的数采节点不存在: ${nodeId}`)
    if (lineId) {
      if (!node.lineId) {
        node.lineId = lineId
        getDaqNodeRepo().flushNow()
      }
      else if (node.lineId !== lineId) {
        throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `数采节点「${node.name}」属于其他产线,不可挂入本产线配方(产线隔离)`)
      }
    }
    const min = w.min == null ? undefined : Number(w.min)
    const max = w.max == null ? undefined : Number(w.max)
    if (min == null && max == null) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `数采节点「${node.name}」的监控窗口需至少提供 min 或 max`)
    if (min != null && !Number.isFinite(min)) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `数采节点「${node.name}」监控下限需为数字`)
    if (max != null && !Number.isFinite(max)) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `数采节点「${node.name}」监控上限需为数字`)
    if (min != null && max != null && min > max) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `数采节点「${node.name}」监控窗口非法:min ${min} > max ${max}`)
    const out: RecipeDaqWindow = { nodeId }
    if (min != null) out.min = min
    if (max != null) out.max = max
    return out
  })

class DcwRecipeRepo {
  private recipes: RecipeView[] = loadJson<RecipeView[]>(RECIPES_PATH, [])
  private runs: RecipeRunView[] = loadJson<RecipeRunView[]>(RUNS_PATH, [])
  private history: DcwWriteHistoryEntry[] = loadJson<DcwWriteHistoryEntry[]>(WRITES_PATH, [])
  private historyFlushTimer: NodeJS.Timeout | null = null

  // ---------- 配方 ----------

  list(): RecipeView[] {
    return this.recipes
  }

  byId(id: string): RecipeView | undefined {
    return this.recipes.find(r => r.id === id)
  }

  create(input: RecipeInput): RecipeView {
    const name = String(input.name ?? '').trim()
    if (!name) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Recipe 名称必填')
    // 配方必挂产品(数据隔离顶层维度:产品 → 配方 → 批次 → 样本)
    const productId = String(input.productId ?? '').trim()
    if (!productId) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'productId 必填:配方必须归属产品')
    const product = getDcwProductRepo().byId(productId)
    if (!product) throw new AppError(404, ErrorCodes.NOT_FOUND, `产品不存在: ${productId}`)
    const now = new Date().toISOString()
    const recipe: RecipeView = {
      id: `rc-${randomUUID().slice(0, 8)}`,
      productId,
      lineId: product.lineId,
      name,
      description: String(input.description ?? '').trim(),
      params: normParams(input.params, product.lineId),
      daqWindows: normDaqWindows(input.daqWindows, product.lineId),
      version: 1,
      paramsHistory: [],
      lastGoodRunId: null,
      createdAt: now,
      updatedAt: now,
    }
    this.recipes.push(recipe)
    this.flushRecipes()
    return recipe
  }

  update(id: string, patch: Partial<RecipeInput>, meta?: RecipeUpdateMeta): RecipeView {
    const r = this.byId(id)
    if (!r) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${id}`)
    if (patch.productId !== undefined && patch.productId !== r.productId) {
      const product = getDcwProductRepo().byId(String(patch.productId))
      if (!product) throw new AppError(404, ErrorCodes.NOT_FOUND, `产品不存在: ${patch.productId}`)
      r.productId = String(patch.productId)
    }
    if (patch.name !== undefined) {
      const name = String(patch.name).trim()
      if (!name) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Recipe 名称必填')
      r.name = name
    }
    if (patch.description !== undefined) r.description = String(patch.description).trim()
    if (patch.params !== undefined) {
      const fresh = normParams(patch.params, r.lineId)
      // 参数版本化(调控闭环):活动批次外的参数修改 → 版本自增 + 旧版入史(cap 20);
      // 归因元数据(by/actorName/actor/description)随版本入史,前端/Agent 可查谁改的为什么改
      const changed = JSON.stringify(fresh) !== JSON.stringify(r.params)
      if (changed) {
        r.paramsHistory ??= []
        r.paramsHistory.push({
          version: r.version ?? 1,
          params: r.params,
          at: new Date().toISOString(),
          by: meta?.by ?? 'user',
          actorName: meta?.actorName ?? meta?.actor ?? 'user',
          actor: meta?.actor ?? '',
          description: meta?.description ?? '',
        })
        if (r.paramsHistory.length > 20)
          r.paramsHistory.splice(0, r.paramsHistory.length - 20)
        r.version = (r.version ?? 1) + 1
      }
      r.params = fresh
    }
    if (patch.daqWindows !== undefined) r.daqWindows = normDaqWindows(patch.daqWindows, r.lineId)
    r.updatedAt = new Date().toISOString()
    this.flushRecipes()
    return r
  }

  /**
   * 回退配方参数到指定历史版本(或已知良好批次快照),生成新版本(非破坏,历史完整保留)。
   * target: { version: N } = 回到 vN 的参数;{ toLastGood: true } = 回到 lastGood 批次的参数冻结。
   * 失效参数剪枝:目标快照里已删除/已改挂其他产线的节点参数先剔除(否则归一化整体失败),
   * 剔除动作如实记录进版本描述。
   */
  revertToVersion(id: string, target: { version?: number, toLastGood?: boolean }, meta: RecipeUpdateMeta): RecipeView {
    const r = this.byId(id)
    if (!r) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${id}`)
    let snapshot: RecipeParam[]
    let desc: string
    if (target.toLastGood) {
      const run = r.lastGoodRunId ? this.runById(r.lastGoodRunId) : undefined
      if (!run?.paramsSnapshot?.length) {
        throw new AppError(409, ErrorCodes.CONFLICT, `配方「${r.name}」无可回退的良好批次(先标记 lastGood 或指定 version)`)
      }
      snapshot = run.paramsSnapshot
      desc = `回退到已知良好批次 ${run.id.slice(0, 8)} 的参数冻结`
    }
    else {
      const v = Number(target.version)
      if (!Number.isFinite(v)) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'version 必须为数字版本号')
      const hit = (r.paramsHistory ?? []).find(h => h.version === v)
      if (!hit) {
        const avail = (r.paramsHistory ?? []).map(h => h.version).sort((a, b) => b - a)
        throw new AppError(404, ErrorCodes.NOT_FOUND, `版本 v${v} 不存在(可用历史版本:${avail.length ? avail.map(n => `v${n}`).join(', ') : '无'};当前 v${r.version ?? 1})`)
      }
      snapshot = hit.params
      desc = `回退到 v${v}(该版变更于 ${hit.at.slice(0, 19).replace('T', ' ')}${hit.actorName ? `,原操作者 ${hit.actorName}` : ''})`
    }
    if (JSON.stringify(snapshot) === JSON.stringify(r.params)) {
      throw new AppError(409, ErrorCodes.CONFLICT, `目标版本参数与当前 v${r.version ?? 1} 完全一致,无需回退`)
    }
    // 失效参数剪枝:已删除节点、已解绑/已改挂其他产线的节点参数剔除(不自动收编,尊重显式解绑)
    const stale = snapshot.filter((p) => {
      const node = getDcwNodeRepo().byId(p.nodeId)
      return !node || node.lineId !== r.lineId
    })
    const usable = snapshot.filter(p => !stale.some(s => s.nodeId === p.nodeId))
    if (usable.length === 0) {
      throw new AppError(409, ErrorCodes.CONFLICT, '目标版本的全部参数节点均已删除或解绑,无可恢复内容')
    }
    let fullDesc = `${meta.description ? `${meta.description};` : ''}${desc}`
    if (stale.length > 0) {
      const names = stale.map(s => getDcwNodeRepo().byId(s.nodeId)?.name ?? s.nodeId).join('、')
      fullDesc += `;已剔除失效参数(${names}:节点已删除或解绑)`
    }
    return this.update(id, {
      params: usable.map(p => ({ nodeId: p.nodeId, templateRef: p.templateRef, value: p.value, min: p.min, max: p.max })),
    }, { ...meta, description: fullDesc })
  }

  /** 参数版本历史(旧→新;含当前版尾部) */
  versions(id: string): Array<{ version: number, at: string, by?: string, actorName?: string, description?: string, params: RecipeParam[], current?: boolean }> {
    const r = this.byId(id)
    if (!r) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${id}`)
    const rows: Array<{ version: number, at: string, by?: string, actorName?: string, description?: string, params: RecipeParam[], current?: boolean }> = (r.paramsHistory ?? []).map(h => ({
      version: h.version,
      at: h.at,
      by: h.by,
      actorName: h.actorName,
      description: h.description,
      params: h.params,
    }))
    rows.push({
      version: r.version ?? 1,
      at: r.updatedAt,
      by: undefined,
      actorName: undefined,
      description: '当前版本',
      params: r.params,
      current: true,
    })
    return rows
  }

  /** 标记已知良好批次(基准恢复的目标;Trial keep / 手动均可调) */
  markGood(recipeId: string, runId: string): RecipeView {
    const r = this.byId(recipeId)
    if (!r) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${recipeId}`)
    if (!this.runById(runId)) throw new AppError(404, ErrorCodes.NOT_FOUND, `批次不存在: ${runId}`)
    r.lastGoodRunId = runId
    this.flushRecipes()
    return r
  }

  remove(id: string): boolean {
    const before = this.recipes.length
    this.recipes = this.recipes.filter(r => r.id !== id)
    if (this.recipes.length !== before) {
      this.flushRecipes()
      return true
    }
    return false
  }

  // ---------- 生产批次 ----------

  listRuns(): RecipeRunView[] {
    return this.runs
  }

  runById(id: string): RecipeRunView | undefined {
    return this.runs.find(r => r.id === id)
  }

  /** 产品换线级联:直接设置配方产线归属 */
  setRecipeLine(id: string, lineId: string): void {
    const r = this.byId(id)
    if (r && r.lineId !== lineId) {
      r.lineId = lineId
      this.flushRecipes()
    }
  }

  /** 产线删除时解挂:配方 lineId 归空(数据保留) */
  detachLine(id: string): void {
    const r = this.byId(id)
    if (r && r.lineId !== '') {
      r.lineId = ''
      this.flushRecipes()
    }
  }

  createRun(recipe: RecipeView): RecipeRunView {
    const run: RecipeRunView = {
      id: `rr-${randomUUID().slice(0, 8)}`,
      recipeId: recipe.id,
      recipeName: recipe.name,
      productId: recipe.productId,
      lineId: recipe.lineId,
      startedAt: new Date().toISOString(),
      endedAt: null,
      results: [],
      // 参数冻结(调控闭环):配方事后修改不影响本批次的审计与回放
      paramsSnapshot: recipe.params.map(p => ({ ...p })),
    }
    this.runs.push(run)
    if (this.runs.length > RUNS_CAP) this.runs.splice(0, this.runs.length - RUNS_CAP)
    this.flushRuns()
    return run
  }

  closeRun(id: string): RecipeRunView {
    const run = this.runById(id)
    if (!run) throw new AppError(404, ErrorCodes.NOT_FOUND, `批次不存在: ${id}`)
    if (run.endedAt == null) run.endedAt = new Date().toISOString()
    this.flushRuns()
    return run
  }

  updateRun(run: RecipeRunView): void {
    this.flushRuns()
    void run
  }

  // ---------- 写历史 ----------

  appendHistory(entry: DcwWriteHistoryEntry): void {
    this.history.push(entry)
    if (this.history.length > WRITES_CAP) this.history.splice(0, this.history.length - WRITES_CAP)
    // 短窗防抖:保写心跳每 holdIntervalMs 追加一条,同步全量重写 writes.json
    // (≤3000 条)随节点数放大成周期性 fs 抖动;崩溃丢窗口内心跳帧无审计价值损失
    this.historyFlushTimer ??= setTimeout(() => {
      this.historyFlushTimer = null
      this.flushHistory()
    }, 1500)
    this.historyFlushTimer.unref?.()
  }

  historyList(limit = 100): DcwWriteHistoryEntry[] {
    return this.history.slice(-limit).reverse()
  }

  /** 批次窗口内的写历史(产品隔离查询;runId 直属优先,窗口兜底覆盖保写帧) */
  historyInWindow(startedAt: string, endedAt: string | null, runId: string): DcwWriteHistoryEntry[] {
    const end = endedAt ?? new Date().toISOString()
    return this.history.filter(h => h.at >= startedAt && h.at <= end && (h.recipeRunId === runId || h.recipeRunId === null))
  }

  private flushRecipes(): void {
    saveJson(RECIPES_PATH, this.recipes)
  }

  private flushRuns(): void {
    saveJson(RUNS_PATH, this.runs)
  }

  private flushHistory(): void {
    saveJson(WRITES_PATH, this.history)
  }
}

const g = globalThis as typeof globalThis & { __dcwRecipeRepo?: DcwRecipeRepo }

export function getDcwRecipeRepo(): DcwRecipeRepo {
  g.__dcwRecipeRepo ??= new DcwRecipeRepo()
  return g.__dcwRecipeRepo
}
