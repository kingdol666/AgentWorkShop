/**
 * Recipe 仓库 —— 配方 + 生产批次 + 写历史(server/data/dcw-*.json)。
 *
 * 产品隔离语义:每个 Recipe 应用生成一个 RecipeRun(批次),数采数据/写历史
 * 按批次时间窗归属产品;写历史追加式落盘(上限 3000 条,超出丢最旧)。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RecipeInput, RecipeParam, RecipeRunView, RecipeView } from '../../../../shared/dcw-protocol'
import { AppError, ErrorCodes } from '../../../utils/errors'

const DATA_DIR = process.cwd().endsWith('server')
  ? 'data'
  : path.join(process.cwd(), 'server', 'data')
const RECIPES_PATH = path.join(DATA_DIR, 'dcw-recipes.json')
const RUNS_PATH = path.join(DATA_DIR, 'dcw-runs.json')
const WRITES_PATH = path.join(DATA_DIR, 'dcw-writes.json')

const RUNS_CAP = 200
const WRITES_CAP = 3000

function loadJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed ?? fallback
  }
  catch {
    return fallback
  }
}

function saveJson(file: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
  }
  catch (err) {
    console.error('[dcw-recipe] 落盘失败:', file, err)
  }
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

const normParams = (params: RecipeParam[] | undefined): RecipeParam[] =>
  (params ?? [])
    .filter(p => p && typeof p.templateRef === 'string' && Number.isFinite(Number(p.value)))
    .map(p => ({ templateRef: String(p.templateRef), value: Number(p.value) }))

class DcwRecipeRepo {
  private recipes: RecipeView[] = loadJson<RecipeView[]>(RECIPES_PATH, [])
  private runs: RecipeRunView[] = loadJson<RecipeRunView[]>(RUNS_PATH, [])
  private history: DcwWriteHistoryEntry[] = loadJson<DcwWriteHistoryEntry[]>(WRITES_PATH, [])

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
    const now = new Date().toISOString()
    const recipe: RecipeView = {
      id: `rc-${randomUUID().slice(0, 8)}`,
      name,
      description: String(input.description ?? '').trim(),
      params: normParams(input.params),
      createdAt: now,
      updatedAt: now,
    }
    this.recipes.push(recipe)
    this.flushRecipes()
    return recipe
  }

  update(id: string, patch: Partial<RecipeInput>): RecipeView {
    const r = this.byId(id)
    if (!r) throw new AppError(404, ErrorCodes.NOT_FOUND, `Recipe 不存在: ${id}`)
    if (patch.name !== undefined) {
      const name = String(patch.name).trim()
      if (!name) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'Recipe 名称必填')
      r.name = name
    }
    if (patch.description !== undefined) r.description = String(patch.description).trim()
    if (patch.params !== undefined) r.params = normParams(patch.params)
    r.updatedAt = new Date().toISOString()
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

  createRun(recipe: RecipeView): RecipeRunView {
    const run: RecipeRunView = {
      id: `rr-${randomUUID().slice(0, 8)}`,
      recipeId: recipe.id,
      recipeName: recipe.name,
      startedAt: new Date().toISOString(),
      endedAt: null,
      results: [],
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
    this.flushHistory()
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
