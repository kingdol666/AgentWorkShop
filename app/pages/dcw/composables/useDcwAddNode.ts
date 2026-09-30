import { computed, reactive, ref } from 'vue'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import { ApiError } from '~/composables/workshop/apiClient'
import type { useDcwDetailScope } from './useDcwDetailScope'
import { DCW_DRIVERS } from '#shared/dcw-protocol'
import type { DaqDriverCatalogEntry, DriverConfigField } from '#shared/daq-protocol'

/**
 * 添加控制节点向导(mock / 真实场景 + 动态驱动参数 + 测试连接 + 数据语义标定)。
 * 向导各字段是页面唯一副本(经 v-model 下发到弹窗);新建控制模板成功后
 * useDcwDetailTemplates 会把 addTemplate 指向新模板,使向导下拉即刻可选。
 */
export function useDcwAddNode(scope: ReturnType<typeof useDcwDetailScope>) {
  const { t } = useI18n()
  const dcw = useDcwStream()
  const { lineId } = scope

  // ---------- 添加控制节点向导 ----------
  const addOpen = ref(false)
  const addScenario = ref<'mock' | 'real'>('mock')
  const addTemplate = ref(dcw.templates[0]?.key ?? '')
  // 驱动 kind 由驱动目录(server 权威)自描述:mock/modbus-tcp/opcua/…/mes-rest,
  // 放宽为 string 以容纳并行加入的 mes-rest 等新驱动
  const addDriver = ref<string>('mock')
  const addName = ref('')
  const addHold = ref<number | null>(null)
  const addRead = ref<number | null>(null)
  const addWriteLock = ref<number>(60)
  const addStepLimit = ref<number | null>(null)
  const addCfg = ref<Record<string, string | number>>({})
  const addTransform = reactive({ kind: 'none' as 'none' | 'linear', scale: 1, offset: 0 })
  const addSemantics = ref('')
  const addTesting = ref(false)
  const addTest = ref<{ ok: boolean, message: string } | null>(null)
  // MES REST 试读(mes-rest 驱动专属;与「测试连接」写链路并列的读链路验证)
  const addMesTesting = ref(false)
  const addMesResult = ref<{ ok: boolean, eng: number | null, ts: string | null, latencyMs: number | null, message: string } | null>(null)
  const addSaving = ref(false)
  const addError = ref('')

  // 写驱动目录:server 权威(内置 + 协议插件自描述;REST 未返回时回落静态目录)
  const driverCatalog = computed<DaqDriverCatalogEntry[]>(() => dcw.driverCatalog.length
    ? dcw.driverCatalog
    : DCW_DRIVERS.map(d => ({ ...d })))
  const addDriverMeta = computed(() => driverCatalog.value.find(d => d.kind === addDriver.value))
  const addFields = computed<DriverConfigField[]>(() => addDriverMeta.value?.configFields ?? [])

  function resetAddCfg(): void {
    const cfg: Record<string, string | number> = {}
    for (const f of addFields.value) {
      if (f.default !== undefined) cfg[f.key] = f.default
    }
    addCfg.value = cfg
    addTest.value = null
    addMesResult.value = null
  }
  void resetAddCfg()

  async function doTestConnection(): Promise<void> {
    addTesting.value = true
    addTest.value = null
    try {
      addTest.value = await dcw.testDriver(addDriver.value, addCfg.value)
    }
    catch (err) {
      addTest.value = { ok: false, message: apiErrorMessage(err) }
    }
    finally {
      addTesting.value = false
    }
  }

  /** MES REST 试读:组装当前表单 driverConfig POST /dcw/mes-test-read,内联呈现 eng/耗时/服务端文案 */
  async function doMesTestRead(): Promise<void> {
    addMesTesting.value = true
    addMesResult.value = null
    try {
      const r = await dcw.mesTestRead({ ...addCfg.value })
      addMesResult.value = { ok: !!r.ok, eng: r.eng ?? null, ts: r.ts ?? null, latencyMs: r.latencyMs ?? null, message: '' }
    }
    catch (err) {
      // 后端端点与前端并行开发:404 = mes-test-read 未上线,提示"服务端未就绪"而非报错崩坏
      const notReady = err instanceof ApiError && err.status === 404
      addMesResult.value = {
        ok: false,
        eng: null,
        ts: null,
        latencyMs: null,
        message: notReady ? t('dcwDetail.mesNotReady') : apiErrorMessage(err),
      }
    }
    finally {
      addMesTesting.value = false
    }
  }

  async function doAddNode(): Promise<void> {
    addSaving.value = true
    addError.value = ''
    try {
      for (const f of addFields.value) {
        if (f.required && (addCfg.value[f.key] === undefined || addCfg.value[f.key] === '')) {
          throw new Error(t('dcwDetail.k8x1un1184', { p0: f.label }))
        }
      }
      const transform = addTransform.kind === 'linear'
        ? { kind: 'linear' as const, scale: Number(addTransform.scale), offset: Number(addTransform.offset) }
        : undefined
      await dcw.createFromTemplate(`dcw-${addTemplate.value}`, {
        name: addName.value.trim() || undefined,
        driver: addDriver.value,
        driverConfig: { ...addCfg.value },
        transform,
        holdIntervalMs: addHold.value,
        readIntervalMs: addRead.value,
        writeLockSeconds: addWriteLock.value,
        ...(addStepLimit.value != null ? { stepLimit: addStepLimit.value } : {}),
        lineId: lineId.value,
        semantics: addSemantics.value.trim() || undefined,
      })
      addOpen.value = false
      addName.value = ''
      addSemantics.value = ''
    }
    catch (err) {
      addError.value = apiErrorMessage(err)
    }
    finally {
      addSaving.value = false
    }
  }

  return {
    addOpen,
    addScenario,
    addTemplate,
    addDriver,
    addName,
    addHold,
    addRead,
    addWriteLock,
    addStepLimit,
    addCfg,
    addTransform,
    addSemantics,
    addTesting,
    addTest,
    addMesTesting,
    addMesResult,
    addSaving,
    addError,
    driverCatalog,
    addFields,
    doTestConnection,
    doMesTestRead,
    doAddNode,
  }
}
