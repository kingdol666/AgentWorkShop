import { computed, reactive, ref } from 'vue'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import type { useDcwDetailScope } from './useDcwDetailScope'
import type { LineQueryResult } from '#shared/dcw-protocol'

/** 产线数据查询表单(页面唯一副本,经 v-model 下发查询卡) */
export interface DcwQueryForm {
  productId: string
  recipeId: string
  paramKey: string
  nodeId: string
  lastMin: number
  bucketMs: number
}

/**
 * 产线数据查询(产品/配方/参数/时间/间隔;限定本产线通道)。
 * 查询表单与结果/在飞/错误是唯一副本,组件经 v-model 就地读写同一 reactive 对象。
 */
export function useDcwQuery(scope: ReturnType<typeof useDcwDetailScope>) {
  const { t } = useI18n()
  const dcw = useDcwStream()
  const { lineId } = scope

  // ---------- 产线数据查询(产品/配方/参数/时间/间隔;限定本产线通道) ----------
  const query = reactive<DcwQueryForm>({
    productId: '',
    recipeId: '',
    paramKey: '',
    nodeId: '',
    lastMin: 30,
    bucketMs: 15000,
  })
  const queryResult = ref<LineQueryResult | null>(null)
  const queryBusy = ref(false)
  const queryError = ref('')

  async function doQuery(): Promise<void> {
    queryBusy.value = true
    queryError.value = ''
    queryResult.value = null
    try {
      queryResult.value = await dcw.queryLine({
        lineId: lineId.value,
        productId: query.productId || undefined,
        recipeId: query.recipeId || undefined,
        paramKey: query.paramKey || undefined,
        nodeId: query.nodeId || undefined,
        fromMs: Date.now() - query.lastMin * 60_000,
        toMs: Date.now(),
        bucketMs: query.bucketMs > 0 ? query.bucketMs : undefined,
        limit: 2000,
      })
      if (queryResult.value.channels.length === 0) queryError.value = t('dcwDetail.kszv5sq136')
    }
    catch (err) {
      queryError.value = apiErrorMessage(err)
    }
    finally {
      queryBusy.value = false
    }
  }

  /** 查询参数选项(DAQ 模板 key,含自定义) */
  const daqParamKeys = computed(() => dcw.templates.map(t => t.key))

  return { query, queryResult, queryBusy, queryError, doQuery, daqParamKeys }
}
