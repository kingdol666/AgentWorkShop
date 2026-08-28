/**
 * useDcwStream —— 写控制(DCW)流的前端单一消费口(与 useDaqStream 对称)。
 *
 * 数据权威在 server:REST 快照(GET /api/workshop/dcw)+ WS 实时帧增量收敛
 * (dcw.written 写 ACK / dcw.node.changed / dcw.controller,均经 townBus 旁路)。
 */
import { reactive } from 'vue'
import { useTownBus } from './useTownBus'
import type { AepEnvelope } from '#shared/workshop-protocol'
import { DCW_TEMPLATES, type AepDcwControllerState, type AepDcwNodeChange, type AepDcwWritten, type DcwNodeView, type DcwTemplateDef, type DcwTemplateInput, type LineQueryOpts, type LineQueryResult, type LineRunState, type ProductInput, type ProductView, type RecipeInput, type RecipeRunView, type RecipeView, type RecipeRunData } from '#shared/dcw-protocol'

export type { DcwNodeView }

function headers(json = true): Record<string, string> {
  const cookieToken = typeof document !== 'undefined'
    ? (document.cookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1] ?? '')
    : ''
  const h: Record<string, string> = {}
  if (cookieToken) h.authorization = `Bearer ${decodeURIComponent(cookieToken)}`
  if (json) h['content-type'] = 'application/json'
  return h
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/workshop/dcw${path}`, { headers: headers(), ...init })
  const json = await res.json().catch(() => ({}))
  if (json?.code !== 0) throw new Error(json?.message ?? `dcw api 失败: ${res.status}`)
  return json.data as T
}

export interface DcwWriteOutcomeView { ok: boolean, message: string, raw: number | null, readback: number | null }
export interface DcwWriteHistoryEntry { id: string, nodeId: string, nodeName: string, param: string, eng: number, raw: number | null, ok: boolean, message: string, recipeRunId: string | null, at: string }

function createStore() {
  const nodes = reactive<DcwNodeView[]>([])
  const controller = reactive<AepDcwControllerState>({ running: true, nodesTotal: 0, nodesOnline: 0, writesTotal: 0, writesFailed: 0 })
  const templates = reactive<DcwTemplateDef[]>(DCW_TEMPLATES.map(t => ({ ...t })))
  const recipes = reactive<RecipeView[]>([])
  const runs = reactive<RecipeRunView[]>([])
  const history = reactive<DcwWriteHistoryEntry[]>([])
  const products = reactive<ProductView[]>([])
  const line = reactive<LineRunState>({ active: false, runId: null, recipeId: null, recipeName: null, productId: null, productName: null, startedAt: null, taggedSamples: 0 })

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
      else if (e.type === 'dcw.node.changed') applyChange(e.payload as AepDcwNodeChange)
      else if (e.type === 'dcw.controller') Object.assign(controller, e.payload as AepDcwControllerState)
    })
  }

  async function load(): Promise<void> {
    try {
      const data = await api<{ controller: AepDcwControllerState, nodes: DcwNodeView[], templates?: DcwTemplateDef[], recipes?: RecipeView[], runs?: RecipeRunView[], history?: DcwWriteHistoryEntry[], products?: ProductView[], line?: LineRunState }>('')
      nodes.splice(0, nodes.length, ...data.nodes)
      Object.assign(controller, data.controller)
      if (data.templates?.length) templates.splice(0, templates.length, ...data.templates.map(t => ({ ...t })))
      recipes.splice(0, recipes.length, ...(data.recipes ?? []))
      runs.splice(0, runs.length, ...(data.runs ?? []))
      history.splice(0, history.length, ...(data.history ?? []))
      products.splice(0, products.length, ...(data.products ?? []))
      if (data.line) Object.assign(line, data.line)
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
    line,
    loaded: false,
    error: '',
    ensureWsFeed,
    load,
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
    testDriver: async (driver: string, driverConfig: Record<string, unknown>): Promise<{ ok: boolean, message: string }> => {
      return api<{ test: { ok: boolean, message: string } }>('/test-driver', { method: 'POST', body: JSON.stringify({ driver, driverConfig }) }).then(r => r.test)
    },
    testNode: async (id: string): Promise<{ ok: boolean, message: string }> => {
      return api<{ test: { ok: boolean, message: string } }>(`/${id}/test`, { method: 'POST' }).then(r => r.test)
    },
    startStop: async (action: 'start' | 'stop'): Promise<void> => {
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
    // ---------- 产线运营 ----------
    startLine: async (recipeId: string): Promise<void> => {
      const data = await api<{ line: LineRunState }>('/line/start', { method: 'POST', body: JSON.stringify({ recipeId }) })
      Object.assign(line, data.line)
    },
    stopLine: async (): Promise<void> => {
      const data = await api<{ line: LineRunState }>('/line/stop', { method: 'POST' })
      Object.assign(line, data.line)
    },
    queryLine: (opts: LineQueryOpts): Promise<LineQueryResult> => {
      const qs = new URLSearchParams()
      if (opts.productId) qs.set('productId', opts.productId)
      if (opts.recipeId) qs.set('recipeId', opts.recipeId)
      if (opts.paramKey) qs.set('paramKey', opts.paramKey)
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
