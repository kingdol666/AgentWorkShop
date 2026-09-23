import { computed, reactive, ref, watch, type ComputedRef } from 'vue'
import { useDaqStream, type DaqNodeLive } from '@/app/composables/workshop/useDaqStream'
import { DAQ_DRIVERS, type DaqDriverCatalogEntry, type DaqDriverKind, type DriverConfigField, type DriverTestResult as DaqDriverTestResult } from '#shared/daq-protocol'

/** 参数表单(server 单点控制的唯一副本;node.changed 帧回灌到本对象) */
export interface DaqDetailParamForm {
  enabled: boolean
  driver: DaqDriverKind
  lineId: string
  followGlobal: boolean
  intervalMs: number
  calKind: 'none' | 'linear'
  calScale: number
  calOffset: number
  publishFollow: boolean
  publishEveryFrame: boolean
  publishMs: number
  unit: string
  decimals: number
  min: number
  max: number
  warnLow: number | null
  warnHigh: number | null
}

/**
 * 参数表单 + 驱动连接参数(server 单点控制;变更经 PATCH 落库,node.changed 帧回灌)。
 * 表单对象由本 composable 独占持有,组件经 v-model 就地读写同一份(reactive 对象),
 * 与拆分前的模板写法一致;驱动目录以 server 为权威,REST 未返回时回落静态目录。
 */
export function useDaqDetailParams(nodeId: ComputedRef<string>, node: ComputedRef<DaqNodeLive | null>) {
  const daq = useDaqStream()

  const form = reactive<DaqDetailParamForm>({
    enabled: true,
    driver: 'mock',
    lineId: '',
    followGlobal: true,
    intervalMs: 5000,
    calKind: 'none',
    calScale: 1,
    calOffset: 0,
    publishFollow: true,
    publishEveryFrame: false,
    publishMs: 1000,
    unit: '',
    decimals: 1,
    min: 0,
    max: 100,
    warnLow: null,
    warnHigh: null,
  })
  watch(node, (n) => {
    if (!n) return
    form.enabled = n.enabled
    form.lineId = n.lineId ?? ''
    form.driver = n.driver
    form.followGlobal = n.intervalMs == null
    form.intervalMs = n.intervalMs ?? daq.controller.defaultIntervalMs
    // WS 下发节拍:null=跟随全局;0=每帧;>0 独立间隔
    form.publishFollow = n.publishIntervalMs == null
    form.publishEveryFrame = n.publishIntervalMs === 0
    form.publishMs = n.publishIntervalMs == null ? daq.controller.defaultPublishIntervalMs : n.publishIntervalMs
    form.unit = n.unit
    form.decimals = n.decimals
    form.min = n.min
    form.max = n.max
    form.warnLow = n.warnLow
    form.warnHigh = n.warnHigh
  }, { immediate: true })

  // 驱动连接参数编辑(真实协议:host/register/endpoint...;schema 驱动渲染)
  // 驱动目录:server 权威(内置 + 协议插件自描述;REST 未返回时回落静态目录)
  const driverCatalog = computed<DaqDriverCatalogEntry[]>(() => daq.meta.drivers.length
    ? daq.meta.drivers
    : DAQ_DRIVERS.map(d => ({ ...d })))
  const driverCfg = ref<Record<string, string | number>>({})
  const driverFields = computed<DriverConfigField[]>(() =>
    driverCatalog.value.find(d => d.kind === form.driver)?.configFields ?? [])
  watch(node, (n) => {
    if (n) driverCfg.value = { ...(n.driverConfig as Record<string, string | number>) }
  }, { immediate: true })
  watch(() => form.driver, () => {
    // 切换协议且目标无参数 → 填 schema 缺省
    if (driverFields.value.length && Object.keys(driverCfg.value).length === 0) {
      const cfg: Record<string, string | number> = {}
      for (const f of driverFields.value) if (f.default !== undefined) cfg[f.key] = f.default as string | number
      driverCfg.value = cfg
    }
  }, { immediate: true })
  const testing = ref(false)
  const testResult = ref<DaqDriverTestResult | null>(null)
  async function doTest(): Promise<void> {
    testing.value = true
    testResult.value = null
    try {
      // 先保存当前驱动与参数,再测(测存量节点 = 测已落库配置)
      await daq.patchNode(nodeId.value, { driver: form.driver, driverConfig: { ...driverCfg.value } })
      testResult.value = await daq.testNode(nodeId.value)
    }
    catch (err) {
      testResult.value = { ok: false, message: apiErrorMessage(err) }
    }
    finally {
      testing.value = false
    }
  }

  const saving = ref(false)
  async function saveParams(): Promise<void> {
    const n = node.value
    if (!n || saving.value) return
    saving.value = true
    try {
      await daq.patchNode(n.id, {
        enabled: form.enabled,
        driver: form.driver,
        lineId: form.lineId,
        driverConfig: { ...driverCfg.value },
        intervalMs: form.followGlobal ? null : Math.max(1000, Math.min(60_000, Math.round(form.intervalMs))),
        publishIntervalMs: form.publishFollow
          ? null
          : (form.publishEveryFrame ? 0 : Math.max(0, Math.min(60_000, Math.round(form.publishMs)))),
        unit: form.unit,
        decimals: Math.max(0, Math.min(6, Math.round(form.decimals))),
        min: form.min,
        max: form.max,
        warnLow: form.warnLow,
        warnHigh: form.warnHigh,
      })
    }
    finally {
      saving.value = false
    }
  }

  return { form, driverCatalog, driverCfg, driverFields, testing, testResult, saving, doTest, saveParams }
}
