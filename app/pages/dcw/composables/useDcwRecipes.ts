import { reactive, ref } from 'vue'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import type { useDcwDetailScope } from './useDcwDetailScope'
import type { useDcwLineRun } from './useDcwLineRun'
import type { useDcwProducts } from './useDcwProducts'
import type { useDcwWrites } from './useDcwWrites'
import type { RecipeRunData, RecipeView } from '#shared/dcw-protocol'

/** 配方编辑表单(页面唯一副本,经 v-model 下发弹窗) */
export interface DcwRecipeForm {
  productId: string
  name: string
  description: string
  params: Array<{ nodeId: string, value: number | '', min: number | '', max: number | '' }>
  daqWindows: Array<{ nodeId: string, min: number | '', max: number | '' }>
}

/** 配方版本历史行(整体修改变更记录:来源/操作者/原因/参数 diff) */
export interface RecipeVersionRow {
  version: number
  at: string
  by?: string
  actorName?: string
  description?: string
  params: Array<{ nodeId: string, value: number, min?: number, max?: number }>
  current?: boolean
}

/**
 * Recipe 配方管理(参数节点级绑定)+ 版本历史(来源/操作者/原因/参数 diff + 回退)。
 * 表单是页面唯一副本(经 v-model 下发到弹窗);应用配方与查看批次数据的错误
 * 与直写共用 writeError 横幅,故由 useDcwWrites 持有、这里只写不读第二份。
 */
export function useDcwRecipes(
  scope: ReturnType<typeof useDcwDetailScope>,
  products: ReturnType<typeof useDcwProducts>,
  lineRun: ReturnType<typeof useDcwLineRun>,
  writes: ReturnType<typeof useDcwWrites>,
) {
  const { t } = useI18n()
  const dcw = useDcwStream()
  const { lineNodes, lineProducts } = scope
  const { filterProductId } = products
  const { lineProductId } = lineRun
  const { writeError } = writes

  // ---------- 配方版本历史(整体修改变更记录;来源=用户/Agent/系统 + 操作者 + 回退) ----------
  const verOpen = ref(false)
  const verRecipe = ref<RecipeView | null>(null)
  const verRows = ref<RecipeVersionRow[]>([])
  const verLoading = ref(false)
  const verMsg = ref('')

  async function openRecipeHistory(id: string): Promise<void> {
    verRecipe.value = dcw.recipes.find(r => r.id === id) ?? null
    verOpen.value = true
    verMsg.value = ''
    verLoading.value = true
    try {
      verRows.value = await dcw.recipeVersions(id)
    }
    catch (err) {
      verMsg.value = apiErrorMessage(err)
    }
    finally {
      verLoading.value = false
    }
  }

  const verSrcLabel = (by?: string): string => (by === 'agent' ? 'Agent' : by === 'system' ? t('dcwDetail.srcSystem') : t('dcwDetail.srcUser'))

  function verDiff(row: RecipeVersionRow, idx: number): string {
    if (idx === 0) return t('dcwDetail.histInit')
    const prev = verRows.value[idx - 1]!
    const changed = row.params
      .map(p => ({ p, old: prev.params.find(x => x.nodeId === p.nodeId) }))
      .filter(({ p, old }) => !old || old.value !== p.value)
      .map(({ p, old }) => `${dcw.nodes.find(n => n.id === p.nodeId)?.name ?? p.nodeId}: ${old?.value ?? t('dcwDetail.histAdded')} → ${p.value}`)
    return changed.length > 0 ? changed.join('；') : t('dcwDetail.histNoChange')
  }

  async function doRevert(version: number): Promise<void> {
    if (!verRecipe.value) return
    verMsg.value = ''
    try {
      const recipe = await dcw.revertRecipe(verRecipe.value.id, { version, reason: t('dcwDetail.revertReasonUi') })
      verMsg.value = t('dcwDetail.revertOk', { p0: recipe.version ?? 0 })
      verRows.value = await dcw.recipeVersions(verRecipe.value.id)
    }
    catch (err) {
      verMsg.value = apiErrorMessage(err)
    }
  }

  // ---------- Recipe 配方管理(参数节点级绑定) ----------
  const recipeOpen = ref(false)
  const recipeEditing = ref<string | null>(null)
  const recipeSaving = ref(false)
  const recipeError = ref('')
  const recipeStaleNote = ref('')
  const recipeForm = reactive<DcwRecipeForm>({
    productId: '',
    name: '',
    description: '',
    params: [] as Array<{ nodeId: string, value: number | '', min: number | '', max: number | '' }>,
    daqWindows: [] as Array<{ nodeId: string, min: number | '', max: number | '' }>,
  })
  const applyResult = ref<{ runId: string, ok: number, total: number } | null>(null)
  const runDataView = ref<{ runId: string, data: RecipeRunData } | null>(null)
  const runDataLoading = ref(false)

  function openRecipeCreate(): void {
    recipeEditing.value = null
    recipeError.value = ''
    recipeForm.productId = filterProductId.value || lineProductId.value || lineProducts.value[0]?.id || ''
    recipeForm.name = ''
    recipeForm.description = ''
    recipeForm.params = [{ nodeId: lineNodes.value[0]?.id ?? '', value: '', min: '', max: '' }]
    recipeForm.daqWindows = []
    recipeOpen.value = true
  }

  function openRecipeEdit(id: string): void {
    const r = dcw.recipes.find(x => x.id === id)
    if (!r) return
    recipeEditing.value = id
    recipeError.value = ''
    // 失效参数自动清理:节点已删除的参数行直接剔除(保存会被后端归一化拒绝);
    // 停用/解绑节点参数保留可编辑,状态由 select 旁徽标标示
    const live = r.params.filter(p => dcw.nodes.some(n => n.id === p.nodeId))
    const dropped = r.params.length - live.length
    recipeStaleNote.value = dropped > 0 ? t('dcwDetail.staleDropped', { p0: dropped }) : ''
    recipeForm.productId = r.productId
    recipeForm.name = r.name
    recipeForm.description = r.description
    recipeForm.params = live.map(p => ({
      nodeId: p.nodeId,
      value: p.value,
      min: p.min ?? '',
      max: p.max ?? '',
    }))
    recipeForm.daqWindows = (r.daqWindows ?? []).map(w => ({
      nodeId: w.nodeId,
      min: w.min ?? '',
      max: w.max ?? '',
    }))
    recipeOpen.value = true
  }

  async function saveRecipe(): Promise<void> {
    recipeSaving.value = true
    recipeError.value = ''
    try {
      const input = {
        productId: recipeForm.productId,
        name: recipeForm.name.trim(),
        description: recipeForm.description.trim(),
        params: recipeForm.params
          .filter(p => p.nodeId && p.value !== '' && Number.isFinite(Number(p.value)))
          .map(p => ({
            nodeId: p.nodeId,
            value: Number(p.value),
            ...(p.min !== '' && Number.isFinite(Number(p.min)) ? { min: Number(p.min) } : {}),
            ...(p.max !== '' && Number.isFinite(Number(p.max)) ? { max: Number(p.max) } : {}),
          })),
        daqWindows: recipeForm.daqWindows
          .filter(w => w.nodeId && (w.min !== '' || w.max !== ''))
          .map(w => ({
            nodeId: w.nodeId,
            ...(w.min !== '' && Number.isFinite(Number(w.min)) ? { min: Number(w.min) } : {}),
            ...(w.max !== '' && Number.isFinite(Number(w.max)) ? { max: Number(w.max) } : {}),
          })),
      }
      if (recipeEditing.value) await dcw.updateRecipe(recipeEditing.value, input)
      else await dcw.createRecipe(input)
      recipeOpen.value = false
    }
    catch (err) {
      recipeError.value = apiErrorMessage(err)
    }
    finally {
      recipeSaving.value = false
    }
  }

  async function doApplyRecipe(id: string): Promise<void> {
    applyResult.value = null
    writeError.value = ''
    try {
      const run = await dcw.applyRecipe(id)
      const ok = run.results.filter(r => r.ok).length
      applyResult.value = { runId: run.id, ok, total: run.results.length }
      if (ok < run.results.length) writeError.value = t('dcwDetail.ks7szkt188', { p0: run.results.filter(r => !r.ok).map(r => r.message).join(';') })
    }
    catch (err) {
      writeError.value = apiErrorMessage(err)
    }
  }

  async function doViewRun(id: string): Promise<void> {
    runDataLoading.value = true
    try {
      const data = await dcw.runData(id)
      runDataView.value = { runId: id, data }
    }
    catch (err) {
      writeError.value = apiErrorMessage(err)
    }
    finally {
      runDataLoading.value = false
    }
  }

  return {
    verOpen,
    verRecipe,
    verRows,
    verLoading,
    verMsg,
    verSrcLabel,
    verDiff,
    openRecipeHistory,
    doRevert,
    recipeOpen,
    recipeEditing,
    recipeSaving,
    recipeError,
    recipeStaleNote,
    recipeForm,
    applyResult,
    runDataView,
    runDataLoading,
    openRecipeCreate,
    openRecipeEdit,
    saveRecipe,
    doApplyRecipe,
    doViewRun,
  }
}
