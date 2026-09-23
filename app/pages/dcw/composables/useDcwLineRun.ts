import { computed, ref } from 'vue'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import type { useDcwDetailScope } from './useDcwDetailScope'

/**
 * 产线开跑/停止(逐产线)—— 产品/配方选择与在飞、提示、错误回显的唯一副本。
 * 运行态 ls 由页面(server 权威)下发,本 composable 只读不复制。
 */
export function useDcwLineRun(scope: ReturnType<typeof useDcwDetailScope>) {
  const { t } = useI18n()
  const dcw = useDcwStream()
  const { lineId, ls, lineRecipesAll } = scope

  // ---------- 产线开跑/停止(逐产线) ----------
  const lineProductId = ref('')
  const lineRecipeId = ref('')
  const lineBusy = ref(false)
  const lineMsg = ref('')
  const lineErr = ref('')

  const lineRecipes = computed(() => lineRecipesAll.value.filter(r => r.productId === lineProductId.value))

  async function doLineStart(): Promise<void> {
    lineBusy.value = true
    lineMsg.value = ''
    lineErr.value = ''
    try {
      if (!lineRecipeId.value) {
        throw new Error(t('dcwDetail.k1b6qe0r135'))
      }
      await dcw.startLine(lineId.value, lineRecipeId.value)
      lineMsg.value = t('dcwDetail.k17jteb9186', { p0: ls.value.productName, p1: ls.value.recipeName, p2: ls.value.runId })
    }
    catch (err) {
      lineErr.value = apiErrorMessage(err)
    }
    finally {
      lineBusy.value = false
    }
  }

  async function doLineStop(): Promise<void> {
    lineBusy.value = true
    lineMsg.value = ''
    lineErr.value = ''
    try {
      const was = `${ls.value.productName ?? ''} · ${ls.value.recipeName ?? ''}`
      await dcw.stopLine(lineId.value)
      lineMsg.value = t('dcwDetail.kzl49pd187', { p0: was })
    }
    catch (err) {
      lineErr.value = apiErrorMessage(err)
    }
    finally {
      lineBusy.value = false
    }
  }

  return { lineProductId, lineRecipeId, lineBusy, lineMsg, lineErr, lineRecipes, doLineStart, doLineStop }
}
