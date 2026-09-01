/**
 * useOpsLog —— 运维日志(全操作统一记录)的前端单一消费口。
 *
 * 数据权威在 server:audit_log(SQLite)经 GET /api/workshop/ops-logs 按维度查询
 * (产线/产品/Recipe/来源/分类/关键词/时间区间);POST 手动录入人工事件。
 * 实时:WS ops.log 帧经 townBus 旁路 → recent 环形缓冲(实时事件轨只渲染摘要,
 * 详情由 /logs 日志管理页查询),globalThis 单例防重复订阅。
 */
import { reactive } from 'vue'
import { useTownBus } from './useTownBus'
import { apiFetch } from './apiClient'
import type { AepEnvelope, AepOpsLog } from '#shared/workshop-protocol'

/** 实时事件轨容量(仅摘要;历史完整查询走 REST) */
const RECENT_CAP = 40

/** audit_log 行投影(REST 返回) */
export interface OpsLogRow {
  id: number
  actor: string
  actorName: string
  actorKind: 'user' | 'agent' | 'system'
  action: string
  targetKind: string
  targetId: string
  detailJson: string
  at: string
  lineId: string
  productId: string
  recipeId: string
  kind: string
  summary: string
}

export interface OpsLogQuery {
  lineId?: string
  productId?: string
  recipeId?: string
  actorKind?: string
  kind?: string
  q?: string
  from?: string
  to?: string
  limit?: number
}

const api = <T>(path: string, init?: RequestInit): Promise<T> =>
  apiFetch<T>({ base: '/api/workshop/ops-logs', path, init })

function ingestFrame(p: AepOpsLog): OpsLogRow {
  return {
    id: 0,
    actor: p.actor,
    actorName: p.actorName || p.actor,
    actorKind: p.actorKind,
    action: p.action,
    targetKind: p.targetKind,
    targetId: p.targetId,
    detailJson: '',
    at: p.at,
    lineId: p.lineId,
    productId: p.productId,
    recipeId: p.recipeId,
    kind: p.kind,
    summary: p.summary,
  }
}

const createStore = () => {
  /** 实时事件轨(WS 直推;新→旧) */
  const recent = reactive<OpsLogRow[]>([])
  /** 查询结果(REST 快照;/logs 页与实时轨互不干扰) */
  const results = reactive<OpsLogRow[]>([])
  const loading = reactive({ list: false, posting: false })
  const error = reactive({ list: '', post: '' })

  /** 挂 WS 帧(townBus);幂等。返回退订函数。 */
  function ensureLive(): () => void {
    const g = globalThis as typeof globalThis & { __opsLogFed?: boolean }
    if (g.__opsLogFed) return () => {}
    g.__opsLogFed = true
    void seedRecent()
    return useTownBus().subscribe((e: AepEnvelope) => {
      if (e.type === 'ops.log') {
        const row = ingestFrame(e.payload as AepOpsLog)
        if (!recent.some(r => r.at === row.at && r.actor === row.actor && r.action === row.action)) {
          recent.unshift(row)
          if (recent.length > RECENT_CAP) recent.splice(RECENT_CAP)
        }
      }
    })
  }

  /** 首屏预填:最近 15 条历史摘要(实时轨不必从零等事件) */
  async function seedRecent(): Promise<void> {
    try {
      const data = await api<{ logs: OpsLogRow[] }>('?limit=15')
      for (const row of (data.logs ?? []).reverse()) {
        if (!recent.some(r => r.at === row.at && r.actor === row.actor && r.action === row.action))
          recent.unshift(row)
      }
    }
    catch {
      // 预取失败不阻塞实时轨(下一帧事件照常入列)
    }
  }

  async function fetchLogs(query: OpsLogQuery = {}): Promise<void> {
    loading.list = true
    error.list = ''
    try {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(query)) {
        if (v != null && v !== '') qs.set(k, String(v))
      }
      const data = await api<{ logs: OpsLogRow[], count: number }>(`?${qs.toString()}`)
      results.splice(0, results.length, ...(data.logs ?? []))
    }
    catch (err) {
      error.list = err instanceof Error ? err.message : String(err)
    }
    finally {
      loading.list = false
    }
  }

  /** 人工手动记录事件(值班/处置/备注;与自动操作同一流水) */
  async function postManual(input: { summary: string, lineId?: string, productId?: string, recipeId?: string, detail?: Record<string, unknown> }): Promise<void> {
    loading.posting = true
    error.post = ''
    try {
      await api('', { method: 'POST', body: JSON.stringify(input) })
    }
    catch (err) {
      error.post = err instanceof Error ? err.message : String(err)
      throw err
    }
    finally {
      loading.posting = false
    }
  }

  const store = reactive({
    recent,
    results,
    loading,
    error,
    ensureLive,
    fetchLogs,
    postManual,
  })
  return store
}

type OpsLogStore = ReturnType<typeof createStore>

const GLOBAL_KEY = '__opsLogStream'

/** 单例(globalThis 挂载;跨组件/跨页面安全) */
export function useOpsLog(): OpsLogStore {
  const g = globalThis as typeof globalThis & Record<string, unknown>
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = createStore()
  return g[GLOBAL_KEY] as OpsLogStore
}
