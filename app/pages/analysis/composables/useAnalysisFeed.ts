/**
 * 数据分析页的数据面:REST 快照为底 + WS 实时帧触发节流刷新。
 *
 * 权威查询走 GET /api/workshop/analysis(lineId/category/q/from/to);
 * 实时面是 TownBus 旁路的 ops.log 帧(kind='analysis',由 analysis_save 的 recordOps 广播)——
 * 收到新留痕帧后去抖拉一次快照,避免自己维护两套行形状的合并去重。
 */
import { computed, onScopeDispose, reactive, ref } from 'vue'
import { apiFetch } from '@/app/composables/workshop/apiClient'
import { useTownBus } from '@/app/composables/workshop/useTownBus'
import { ANALYSIS_WINDOW_PRESETS, type AnalysisReportView, type AnalysisWindowPreset } from '../types'

/** 统一客户端:信封 {code,message,data} 解析取 .data(与 aml 页请求写法同源) */
function analysisApi<T>(path: string, init?: RequestInit): Promise<T> {
  return apiFetch<T>({ base: '/api/workshop/analysis', path, init })
}

export function useAnalysisFeed() {
  const bus = useTownBus()

  const q = reactive<{ lineId: string, category: string, preset: AnalysisWindowPreset, text: string }>({
    lineId: '',
    category: '',
    preset: 'all',
    text: '',
  })
  const hasFilter = computed(() => Boolean(q.lineId || q.category || q.preset !== 'all' || q.text.trim()))

  const rows = ref<AnalysisReportView[]>([])
  const loading = ref(false)
  const error = ref('')
  /** 实时轨计数(本会话收到的 analysis 留痕帧数,页头脉冲用) */
  const liveCount = ref(0)

  async function doQuery(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const preset = ANALYSIS_WINDOW_PRESETS.find(p => p.key === q.preset)
      const params = new URLSearchParams()
      if (q.lineId) params.set('lineId', q.lineId)
      if (q.category) params.set('category', q.category)
      if (q.text.trim()) params.set('q', q.text.trim())
      if (preset?.ms) params.set('from', new Date(Date.now() - preset.ms).toISOString())
      params.set('limit', '200')
      const data = await analysisApi<{ reports: AnalysisReportView[], count: number }>(`/?${params.toString()}`)
      rows.value = data.reports ?? []
    }
    catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
    finally {
      loading.value = false
    }
  }

  function resetFilters(): void {
    q.lineId = ''
    q.category = ''
    q.preset = 'all'
    q.text = ''
    void doQuery()
  }

  // WS 实时面:analysis 留痕帧 → 计数 + 去抖刷新快照(连发多份报告只拉一次)。
  // TownBus 信封 type 是宽化联合,kind 按字段读取收窄。
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  const unsubscribe = bus.subscribe((e) => {
    if (e.type !== 'ops.log') return
    const p = e.payload as { kind?: string, action?: string }
    if (p.kind !== 'analysis' || p.action === 'analysis.delete') return
    liveCount.value++
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      void doQuery()
    }, 800)
  })
  onScopeDispose(() => {
    unsubscribe()
    if (refreshTimer) clearTimeout(refreshTimer)
  })

  return { q, hasFilter, rows, loading, error, liveCount, doQuery, resetFilters }
}
