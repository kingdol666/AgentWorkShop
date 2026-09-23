import { computed, reactive, ref, watch, type ComputedRef } from 'vue'
import { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import { DAQ_TEMPLATES, type DaqDriverCatalogEntry, type DriverConfigField, type DriverTestResult as DaqDriverTestResult } from '#shared/daq-protocol'

/** 添加节点表单(单一 reactive 对象:向导各字段在同一副本上就地更新) */
export interface DaqAddNodeForm {
  scenario: 'mock' | 'real'
  template: string
  driver: string
  name: string
  interval: number | null
  cfg: Record<string, string | number>
  transform: { kind: 'none' | 'linear', scale: number, offset: number }
  testing: boolean
  test: DaqDriverTestResult | null
  saving: boolean
  error: string
  /** 当前驱动参数字段(随 driver 切换刷新;与表单同体下发) */
  fields: DriverConfigField[]
}

/**
 * 添加节点向导(mock / 真实场景 + 动态参数表单 + 测试连接)。
 * 驱动目录由调用方下发(server 权威;页面已在控制器条上消费同一份)。
 */
export function useDaqAddNode(
  driverCatalog: ComputedRef<DaqDriverCatalogEntry[]>,
  t: (key: string, named?: Record<string, unknown>) => string,
) {
  const daq = useDaqStream()

  const open = ref(false)
  const form = reactive<DaqAddNodeForm>({
    scenario: 'mock',
    template: DAQ_TEMPLATES[0]?.key ?? 'temp-tc',
    driver: 'modbus-tcp',
    name: '',
    interval: null,
    cfg: {},
    transform: { kind: 'none', scale: 1, offset: 0 },
    testing: false,
    test: null,
    saving: false,
    error: '',
    fields: [],
  })

  const driverMeta = computed(() => driverCatalog.value.find(d => d.kind === form.driver))
  const fields = computed<DriverConfigField[]>(() => driverMeta.value?.configFields ?? [])

  watch(() => form.driver, () => {
    // 切协议:表单重置为 schema 缺省值
    const cfg: Record<string, string | number> = {}
    for (const f of fields.value) {
      if (f.default !== undefined) cfg[f.key] = f.default as string | number
    }
    form.cfg = cfg
    form.test = null
  }, { immediate: true })

  // 参数字段随协议刷新进表单本体(向导模板按 form.fields 渲染动态表单)
  watch(fields, (list) => {
    form.fields = list
  }, { immediate: true })

  async function doTestConnection(): Promise<void> {
    form.testing = true
    form.test = null
    try {
      form.test = await daq.testDriver(form.driver, form.cfg)
    }
    catch (err) {
      form.test = { ok: false, message: apiErrorMessage(err) }
    }
    finally {
      form.testing = false
    }
  }

  async function doAddNode(): Promise<void> {
    form.saving = true
    form.error = ''
    try {
      const transform = form.transform.kind === 'linear'
        ? { kind: 'linear' as const, scale: Number(form.transform.scale), offset: Number(form.transform.offset) }
        : undefined
      if (form.scenario === 'mock') {
        await daq.createFromTemplate(`daq-${form.template}`, {
          name: form.name ? { name: form.name }.name : undefined,
          transform,
        })
      }
      else {
        // 校验必填
        for (const f of fields.value) {
          if (f.required && !form.cfg[f.key] && form.cfg[f.key] !== 0) {
            throw new Error(t('daq.kyuadl0125', { p0: f.label }))
          }
        }
        const tpl = daq.templates.find(tp => tp.key === form.template)
        await daq.createFromTemplate(`daq-${form.template}`, {
          name: form.name || undefined,
          driver: form.driver as never,
          driverConfig: { ...form.cfg },
          transform,
          intervalMs: form.interval,
          unit: tpl?.unit,
          min: tpl?.min,
          max: tpl?.max,
          decimals: tpl?.decimals,
        } as never)
      }
      open.value = false
      form.name = ''
      form.test = null
    }
    catch (err) {
      form.error = apiErrorMessage(err)
    }
    finally {
      form.saving = false
    }
  }

  return { open, form, fields, doTestConnection, doAddNode }
}
