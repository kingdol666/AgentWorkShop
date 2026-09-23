import { computed, ref } from 'vue'
import { useDcwStream } from '@/app/composables/workshop/useDcwStream'

/** 优化记录的窗口数采序列(客户端渲染 sparkline 用) */
export type OptimizationSeries = Record<string, { channels: Array<{ nodeId: string, nodeName: string, ch: string, unit: string, points: Array<{ at: number, value?: number, avg?: number }> }> }>

/**
 * Agent 优化记录面板(调控闭环;数采中心视角)。
 * 首次展开后保持内容挂载(手风琴动画需要);收起态内容不再重渲染。
 */
export function useDaqOptimizations() {
  const dcw = useDcwStream()

  const optOpen = ref(false)
  const optMounted = ref(false)
  const optFilterLine = ref('')
  const optFilterRecipe = ref('')
  const optSeriesOf = ref<OptimizationSeries>({})
  const optSeriesLoading = ref('')

  /** Recipe 选项:选定产线时只列该线配方,否则全量(与产线筛选级联) */
  const optRecipeOptions = computed(() =>
    dcw.recipes.filter(r => !optFilterLine.value || r.lineId === optFilterLine.value))

  function optStatusKey(s: string): string {
    const map: Record<string, string> = { 'open': 'daq.k1optst001', 'judged': 'daq.k1optst008', 'judged-keep': 'daq.k1optst002', 'rolled-back': 'daq.k1optst003', 'superseded': 'daq.k1optst004', 'superseded-manual': 'daq.k1optst005', 'closed-line-stop': 'daq.k1optst006', 'failed': 'daq.k1optst007' }
    return map[s] ?? 'daq.k1optst001'
  }

  async function toggleOptPanel(): Promise<void> {
    optOpen.value = !optOpen.value
    if (optOpen.value) {
      optMounted.value = true
      await filterOpts()
    }
  }

  async function filterOpts(): Promise<void> {
    await dcw.loadOptimizations({
      lineId: optFilterLine.value || undefined,
      recipeId: optFilterRecipe.value || undefined,
    })
  }

  /** 产线筛选变化:Recipe 级联重置(所选 Recipe 不在新产线内时) */
  function onOptLineChange(): void {
    if (optFilterRecipe.value && !optRecipeOptions.value.some(r => r.id === optFilterRecipe.value))
      optFilterRecipe.value = ''
    void filterOpts()
  }

  async function showOptSeries(id: string): Promise<void> {
    optSeriesLoading.value = id
    try {
      const s = await dcw.optimizationSeries(id)
      optSeriesOf.value = { ...optSeriesOf.value, [id]: s }
    }
    finally {
      optSeriesLoading.value = ''
    }
  }

  function seriesPath(points: Array<{ at: number, value?: number, avg?: number }>, w = 240, h = 36): string {
    const vals = points.map(p => p.value ?? p.avg ?? 0).filter(Number.isFinite)
    if (vals.length < 2) return ''
    const min = Math.min(...vals)
    const max = Math.max(...vals)
    const span = max - min || 1
    return vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - ((v - min) / span) * h}`).join(' ')
  }

  async function rollbackRecord(id: string): Promise<void> {
    await dcw.rollbackOptimization(id)
    await filterOpts()
  }

  /** 序列点换算的小数位(避免 sparkline 抖动) */
  function fmtPoint(v: number | null | undefined): string {
    return v == null ? '--' : String(Number(v.toFixed(2)))
  }

  return {
    optOpen,
    optMounted,
    optFilterLine,
    optFilterRecipe,
    optSeriesOf,
    optSeriesLoading,
    optRecipeOptions,
    optStatusKey,
    toggleOptPanel,
    filterOpts,
    onOptLineChange,
    showOptSeries,
    seriesPath,
    rollbackRecord,
    fmtPoint,
  }
}
