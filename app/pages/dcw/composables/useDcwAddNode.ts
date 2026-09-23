import { computed, reactive, ref } from 'vue'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
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
  const addDriver = ref<'mock' | 'modbus-tcp' | 'opcua'>('mock')
  const addName = ref('')
  const addHold = ref<number | null>(null)
  const addRead = ref<number | null>(null)
  const addWriteLock = ref<number>(30)
  const addCfg = ref<Record<string, string | number>>({})
  const addTransform = reactive({ kind: 'none' as 'none' | 'linear', scale: 1, offset: 0 })
  const addSemantics = ref('')
  const addTesting = ref(false)
  const addTest = ref<{ ok: boolean, message: string } | null>(null)
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
    addCfg,
    addTransform,
    addSemantics,
    addTesting,
    addTest,
    addSaving,
    addError,
    driverCatalog,
    addFields,
    doTestConnection,
    doAddNode,
  }
}
