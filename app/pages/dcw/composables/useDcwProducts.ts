import { computed, reactive, ref } from 'vue'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import type { useDcwDetailScope } from './useDcwDetailScope'
import type { useDcwLineRun } from './useDcwLineRun'

/** 新建产品表单(页面唯一副本,经 v-model 下发弹窗) */
export interface DcwProductForm { name: string, description: string }

/**
 * 产品管理 —— 新建产品弹窗 + 产品筛选(驱动配方清单与查询下拉的可见配方)。
 * 新建成功后同步选中产线运行控制的产品(与原页面一致),不复制任何 store 状态。
 */
export function useDcwProducts(
  scope: ReturnType<typeof useDcwDetailScope>,
  lineRun: ReturnType<typeof useDcwLineRun>,
) {
  const dcw = useDcwStream()
  const { lineId, lineRecipesAll } = scope
  const { lineProductId } = lineRun

  // ---------- 产品管理 ----------
  const productOpen = ref(false)
  const productSaving = ref(false)
  const productError = ref('')
  const productForm = reactive<DcwProductForm>({ name: '', description: '' })
  const filterProductId = ref('')

  async function doCreateProduct(): Promise<void> {
    productSaving.value = true
    productError.value = ''
    try {
      const p = await dcw.createProduct({ name: productForm.name.trim(), description: productForm.description.trim(), lineId: lineId.value })
      lineProductId.value = p.id
      filterProductId.value = p.id
      productOpen.value = false
      productForm.name = ''
      productForm.description = ''
    }
    catch (err) {
      productError.value = apiErrorMessage(err)
    }
    finally {
      productSaving.value = false
    }
  }

  const visibleRecipes = computed(() =>
    filterProductId.value
      ? lineRecipesAll.value.filter(r => r.productId === filterProductId.value)
      : lineRecipesAll.value,
  )

  return { productOpen, productSaving, productError, productForm, filterProductId, visibleRecipes, doCreateProduct }
}
