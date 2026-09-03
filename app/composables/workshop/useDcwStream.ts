/**
 * useDcwStream —— 写控制(DCW)流的前端单一消费口(与 useDaqStream 对称)。
 *
 * 数据权威在 server:REST 快照(GET /api/workshop/dcw)+ WS 实时帧增量收敛
 * (dcw.written 写 ACK / dcw.node.changed / dcw.controller,均经 townBus 旁路)。
 */
import { reactive } from 'vue'
import { useTownBus } from './useTownBus'
import { apiFetch } from './apiClient'
import type { AepEnvelope } from '#shared/workshop-protocol'
import { DCW_TEMPLATES, type AepDcwControllerState, type AepDcwNodeChange, type AepDcwRead, type AepDcwWritten, type DcwNodeView, type DcwParamLedger, type DcwTemplateDef, type DcwTemplateInput, type LineInput, type LineQueryOpts, type LineQueryResult, type LineRunState, type LineView, type OptimizationRecord, type OptimizationVerdict, type ProductInput, type ProductView, type RecipeInput, type RecipeRunView, type RecipeView, type RecipeRunData } from '#shared/dcw-protocol'

export type { DcwNodeView }

/** 统一客户端:信封解析/业务码保留/GET 幂等重试(5xx 与网络错误;400ms 起退避) */
const api = <T>(path: string, init?: RequestInit): Promise<T> =>
  apiFetch<T>({ base: '/api/workshop/dcw', path, init, retries: (init?.method ?? 'GET').toUpperCase() === 'GET' ? 2 : 0 })

export interface DcwWriteOutcomeView { ok: boolean, message: string, raw: number | null, readback: number | null }
export interface DcwReadOutcomeView { ok: boolean, value: number | null, raw: number | null, message: string, at: string }
export interface DcwWriteHistoryEntry { id: string, nodeId: string, nodeName: string, param: string, eng: number, raw: number | null, ok: boolean, message: string, recipeRunId: string | null, at: string }

function createStore() {
  const nodes = reactive<DcwNodeView[]>([])
  const controller = reactive<AepDcwControllerState>({ running: true, nodesTotal: 0, nodesOnline: 0, writesTotal: 0, writesFailed: 0 })
  const templates = reactive<DcwTemplateDef[]>(DCW_TEMPLATES.map(t => ({ ...t })))
  const recipes = reactive<RecipeView[]>([])
  const runs = reactive<RecipeRunView[]>([])
  const history = reactive<DcwWriteHistoryEntry[]>([])
  const products = reactive<ProductView[]>([])
  const lines = reactive<LineView[]>([])
  /** 逐产线运行状态(lineId → state) */
  const lineStates = reactive<Record<string, LineRunState>>({})
  /** Agent 优化记录(调控闭环;dcw.optimization.changed 实时收敛) */
  const optimizations = reactive<OptimizationRecord[]>([])

  function upsert(node: DcwNodeView): void {
    const i = nodes.findIndex(x => x.id === node.id)
    if (i >= 0) nodes[i] = Object.assign(nodes[i]!, node)
    else nodes.push(node)
  }

  function applyChange(p: AepDcwNodeChange): void {
    if (!p.node) return
    if (p.op === 'removed') {
      const i = nodes.findIndex(x => x.id === p.node!.id)
      if (i >= 0) nodes.splice(i, 1)
      return
    }
    upsert(p.node)
  }

  function ensureWsFeed(): () => void {
    const g = globalThis as typeof globalThis & { __dcwBusFed?: boolean }
    if (g.__dcwBusFed) return () => {}
    g.__dcwBusFed = true
    return useTownBus().subscribe((e: AepEnvelope) => {
      if (e.type === 'dcw.written') {
        const p = e.payload as AepDcwWritten
        const n = nodes.find(x => x.id === p.nodeId)
        if (n) {
          n.value = p.value
          n.state = p.ok ? 'ok' : 'error'
          n.lastWriteAt = p.at
          if (p.ok) n.lastAckAt = p.at
        }
        history.unshift({ id: `${p.nodeId}-${p.at}`, nodeId: p.nodeId, nodeName: n?.name ?? p.nodeId, param: '', eng: p.value, raw: p.raw, ok: p.ok, message: p.message, recipeRunId: p.recipeRunId, at: p.at })
        if (history.length > 60) history.splice(60)
      }
      else if (e.type === 'dcw.read') {
        const p = e.payload as AepDcwRead
        const n = nodes.find(x => x.id === p.nodeId)
        if (n) {
          if (p.ok) n.readValue = p.value
          n.lastReadAt = p.at
          n.lastReadError = p.ok ? null : p.message
        }
      }
      else if (e.type === 'dcw.node.changed') applyChange(e.payload as AepDcwNodeChange)
      else if (e.type === 'dcw.controller') Object.assign(controller, e.payload as AepDcwControllerState)
      else if (e.type === 'dcw.optimization.changed') {
        const p = (e.payload as { event: string, record: OptimizationRecord }).record
        const i = optimizations.findIndex(x => x.id === p.id)
        if (i >= 0) optimizations[i] = p
        else optimizations.unshift(p)
      }
    })
  }

  async function load(): Promise<void> {
    try {
      const data = await api<{ controller: AepDcwControllerState, nodes: DcwNodeView[], templates?: DcwTemplateDef[], recipes?: RecipeView[], runs?: RecipeRunView[], history?: DcwWriteHistoryEntry[], products?: ProductView[], lines?: LineView[], lineStates?: LineRunState[] }>('')
      nodes.splice(0, nodes.length, ...data.nodes)
      Object.assign(controller, data.controller)
      if (data.templates?.length) templates.splice(0, templates.length, ...data.templates.map(t => ({ ...t })))
      recipes.splice(0, recipes.length, ...(data.recipes ?? []))
      runs.splice(0, runs.length, ...(data.runs ?? []))
      history.splice(0, history.length, ...(data.history ?? []))
      products.splice(0, products.length, ...(data.products ?? []))
      lines.splice(0, lines.length, ...(data.lines ?? []))
      for (const k of Object.keys(lineStates)) Reflect.deleteProperty(lineStates, k)
      for (const st of data.lineStates ?? []) lineStates[st.lineId] = st
      store.loaded = true
      store.error = ''
    }
    catch (err) {
      store.error = err instanceof Error ? err.message : String(err)
    }
  }

  const store = reactive({
    nodes,
    controller,
    templates,
    recipes,
    runs,
    history,
    products,
    lines,
    lineStates,
    optimizations,
    loaded: false,
    error: '',
    ensureWsFeed,
    load,
    /** Agent 优化记录查询(调控闭环;默认倒序) */
    loadOptimizations: async (filter?: { lineId?: string, recipeId?: string, nodeId?: string, status?: string, limit?: number }): Promise<void> => {
      const qs = new URLSearchParams()
      if (filter?.lineId) qs.set('lineId', filter.lineId)
      if (filter?.recipeId) qs.set('recipeId', filter.recipeId)
      if (filter?.nodeId) qs.set('nodeId', filter.nodeId)
      if (filter?.status) qs.set('status', filter.status)
      qs.set('limit', String(filter?.limit ?? 100))
      const data = await api<{ records: OptimizationRecord[] }>(`/optimizations?${qs.toString()}`)
      optimizations.splice(0, optimizations.length, ...data.records)
    },
    /** 节点参数台账(三值对照 + 在册历史) */
    fetchLedger: async (nodeId: string): Promise<DcwParamLedger> => {
      const data = await api<{ ledger: DcwParamLedger }>(`/${nodeId}/param-ledger`)
      return data.ledger
    },
    /** 优化记录窗口内数采序列 */
    optimizationSeries: async (id: string, windowMs?: number): Promise<{ record: OptimizationRecord, from: number, to: number, channels: Array<{ nodeId: string, nodeName: string, ch: string, unit: string, points: Array<{ at: number, value?: number, avg?: number }> }> }> => {
      return api(`/optimizations/${id}/series${windowMs ? `?windowMs=${windowMs}` : ''}`)
    },
    /** 优化记录判定(用户路) */
    judgeOptimization: async (id: string, verdict: OptimizationVerdict, reason: string): Promise<void> => {
      await api(`/optimizations/${id}/judge`, { method: 'POST', body: JSON.stringify({ verdict, reason }) })
    },
    /** 执行回退(记录级/节点级) */
    rollbackOptimization: async (id: string): Promise<void> => {
      await api(`/optimizations/${id}/rollback`, { method: 'POST', body: JSON.stringify({}) })
    },
    rollbackNode: async (nodeId: string, to?: string): Promise<void> => {
      await api(`/journal/node/${nodeId}/rollback`, { method: 'POST', body: JSON.stringify({ to }) })
    },
    /** 标记已知良好批次 / 基准恢复 */
    markGood: async (recipeId: string, runId: string): Promise<void> => {
      await api(`/recipes/${recipeId}/mark-good`, { method: 'POST', body: JSON.stringify({ runId }) })
    },
    rollbackRecipeGood: async (recipeId: string): Promise<void> => {
      await api(`/recipes/${recipeId}/rollback-good`, { method: 'POST', body: JSON.stringify({}) })
    },
    createFromTemplate: async (templateRef: string, opts?: Record<string, unknown>): Promise<DcwNodeView> => {
      const data = await api<{ node: DcwNodeView }>('', { method: 'POST', body: JSON.stringify({ templateRef, ...opts }) })
      upsert(data.node)
      return data.node
    },
    patchNode: async (id: string, patch: Record<string, unknown>): Promise<void> => {
      await api(`/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    },
    removeNode: async (id: string): Promise<void> => {
      await api(`/${id}`, { method: 'DELETE' })
      const i = nodes.findIndex(x => x.id === id)
      if (i >= 0) nodes.splice(i, 1)
    },
    bindNode: async (id: string, deviceId: string | null): Promise<void> => {
      const data = await api<{ node: DcwNodeView }>(`/${id}/bind`, { method: 'POST', body: JSON.stringify({ deviceId }) })
      upsert(data.node)
    },
    /** 设定值下发(核心写命令;越界 400/在飞 409 由服务端拒绝) */
    write: async (id: string, value: number): Promise<DcwWriteOutcomeView> => {
      return api<{ outcome: DcwWriteOutcomeView }>(`/${id}/write`, { method: 'POST', body: JSON.stringify({ value }) }).then(r => r.outcome)
    },
    /** 手动读取 PLC 当前值(读写集成的读半边;与周期读同源) */
    readNode: async (id: string): Promise<DcwReadOutcomeView> => {
      return api<{ read: DcwReadOutcomeView }>(`/${id}/read`, { method: 'POST', body: JSON.stringify({}) }).then(r => r.read)
    },
    testDriver: async (driver: string, driverConfig: Record<string, unknown>): Promise<{ ok: boolean, message: string }> => {
      return api<{ test: { ok: boolean, message: string } }>('/test-driver', { method: 'POST', body: JSON.stringify({ driver, driverConfig }) }).then(r => r.test)
    },
    testNode: async (id: string): Promise<{ ok: boolean, message: string }> => {
      return api<{ test: { ok: boolean, message: string } }>(`/${id}/test`, { method: 'POST' }).then(r => r.test)
    },
    startStop: async (action: 'start' | 'stop' | 'pause' | 'resume'): Promise<void> => {
      const data = await api<{ controller: AepDcwControllerState }>('/controller', { method: 'POST', body: JSON.stringify({ action }) })
      Object.assign(controller, data.controller)
    },
    createTemplate: async (input: DcwTemplateInput): Promise<DcwTemplateDef> => {
      const data = await api<{ template: DcwTemplateDef }>('/templates', { method: 'POST', body: JSON.stringify(input) })
      templates.push(data.template)
      return data.template
    },
    createRecipe: async (input: RecipeInput): Promise<RecipeView> => {
      const data = await api<{ recipe: RecipeView }>('/recipes', { method: 'POST', body: JSON.stringify(input) })
      recipes.push(data.recipe)
      return data.recipe
    },
    updateRecipe: async (id: string, patch: Partial<RecipeInput>): Promise<RecipeView> => {
      const data = await api<{ recipe: RecipeView }>(`/recipes/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      const i = recipes.findIndex(r => r.id === id)
      if (i >= 0) recipes[i] = data.recipe
      return data.recipe
    },
    removeRecipe: async (id: string): Promise<void> => {
      await api(`/recipes/${id}`, { method: 'DELETE' })
      const i = recipes.findIndex(r => r.id === id)
      if (i >= 0) recipes.splice(i, 1)
    },
    applyRecipe: async (id: string): Promise<RecipeRunView> => {
      const data = await api<{ run: RecipeRunView }>(`/recipes/${id}/apply`, { method: 'POST' })
      runs.push(data.run)
      return data.run
    },
    closeRun: async (id: string): Promise<RecipeRunView> => {
      const data = await api<{ run: RecipeRunView }>(`/runs/${id}/close`, { method: 'POST' })
      const i = runs.findIndex(r => r.id === id)
      if (i >= 0) runs[i] = data.run
      return data.run
    },
    runData: (id: string): Promise<RecipeRunData> => api(`/runs/${id}/data`),
    nodeById: (id: string): DcwNodeView | undefined => nodes.find(n => n.id === id),
    // ---------- 产品 ----------
    createProduct: async (input: ProductInput): Promise<ProductView> => {
      const data = await api<{ product: ProductView }>('/products', { method: 'POST', body: JSON.stringify(input) })
      products.push(data.product)
      return data.product
    },
    updateProduct: async (id: string, patch: Partial<ProductInput>): Promise<ProductView> => {
      return api<{ product: ProductView }>(`/products/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }).then((r) => {
        void r
        void dcwReloadLight()
        return r.product
      })
    },
    removeProduct: async (id: string): Promise<void> => {
      await api(`/products/${id}`, { method: 'DELETE' })
      const i = products.findIndex(p => p.id === id)
      if (i >= 0) products.splice(i, 1)
    },
    // ---------- 产线(实体 + 逐线运营) ----------
    createLine: async (input: LineInput): Promise<LineView> => {
      const data = await api<{ line: LineView }>('/lines', { method: 'POST', body: JSON.stringify(input) })
      lines.push(data.line)
      return data.line
    },
    updateLine: async (id: string, patch: Partial<LineInput>): Promise<void> => {
      const data = await api<{ line: LineView }>(`/lines/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
      const i = lines.findIndex(l => l.id === id)
      if (i >= 0) lines[i] = data.line
    },
    /** 删除产线;purge=true 连同旗下节点/产品/配方一并清理,否则仅解除挂载 */
    removeLine: async (id: string, purge = false): Promise<void> => {
      await api(`/lines/${id}${purge ? '?purge=1' : ''}`, { method: 'DELETE' })
      const i = lines.findIndex(l => l.id === id)
      if (i >= 0) lines.splice(i, 1)
      Reflect.deleteProperty(lineStates, id)
      await load()
    },
    /** 产线开跑:lineStart(lineId, recipeId);状态收敛到 lineStates */
    startLine: async (lineId: string, recipeId: string): Promise<void> => {
      const data = await api<{ line: LineRunState }>(`/lines/${lineId}/start`, { method: 'POST', body: JSON.stringify({ recipeId }) })
      lineStates[lineId] = data.line
    },
    stopLine: async (lineId: string): Promise<void> => {
      const data = await api<{ line: LineRunState }>(`/lines/${lineId}/stop`, { method: 'POST' })
      lineStates[lineId] = data.line
    },
    lineStateOf: (lineId: string): LineRunState =>
      lineStates[lineId] ?? { lineId, active: false, runId: null, recipeId: null, recipeName: null, productId: null, productName: null, startedAt: null, taggedSamples: 0 },
    queryLine: (opts: LineQueryOpts): Promise<LineQueryResult> => {
      const qs = new URLSearchParams()
      if (opts.lineId) qs.set('lineId', opts.lineId)
      if (opts.productId) qs.set('productId', opts.productId)
      if (opts.recipeId) qs.set('recipeId', opts.recipeId)
      if (opts.paramKey) qs.set('paramKey', opts.paramKey)
      if (opts.nodeId) qs.set('nodeId', opts.nodeId)
      if (opts.fromMs != null) qs.set('from', String(opts.fromMs))
      if (opts.toMs != null) qs.set('to', String(opts.toMs))
      if (opts.bucketMs != null) qs.set('bucketMs', String(opts.bucketMs))
      if (opts.limit != null) qs.set('limit', String(opts.limit))
      return api(`/line/query?${qs.toString()}`)
    },
  })
  async function dcwReloadLight(): Promise<void> {
    try {
      const data = await api<{ products?: ProductView[], recipes?: RecipeView[] }>('')
      products.splice(0, products.length, ...(data.products ?? []))
      recipes.splice(0, recipes.length, ...(data.recipes ?? []))
    }
    catch { /* 忽略:轻量重载失败不阻塞 */ }
  }
  return store
}

type DcwStreamStore = ReturnType<typeof createStore>

const GLOBAL_KEY = '__dcwStream'

export function useDcwStream(): DcwStreamStore {
  const g = globalThis as typeof globalThis & Record<string, unknown>
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = createStore()
  return g[GLOBAL_KEY] as DcwStreamStore
}
