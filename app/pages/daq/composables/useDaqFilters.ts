import { computed, reactive, ref, watch } from 'vue'
import { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'
import { DAQ_DRIVERS, daqKeyFromRef, type DaqNodeState, type DaqNodeView, type DaqDriverCatalogEntry } from '#shared/daq-protocol'

/** 行级展示状态(真实场景语义;筛选用,pill 呈现在 DaqNodeRow 行组件)
 *  状态机:disabled(人为停用) → unassigned(未挂产线,永不采集) → idle(产线未开跑,采集门控)
 *  → offline(网关暂停,或产线运行中却采不到新数据) → ok/warn/alarm(新鲜数据按量程/预警带/配方窗口派生) */
export type RowState = DaqNodeState | 'idle' | 'disabled' | 'unassigned'

/** 数据时间语义桶:最后采样距 now 的新鲜度(与行级 stale 判定同源的诚实时间观) */
export type TimeBucket = 'live' | 'hour' | 'day' | 'old' | 'never'

/**
 * 节点筛选(产线/设备绑定/产线运行态/节点状态 + 模板/驱动/数据时间/名称搜索;全部 AND 复合)。
 * 筛选态是页面唯一副本:行状态派生、选项计数、窗口化切片都从这里取。
 */
export function useDaqFilters() {
  const daq = useDaqStream()
  const dcw = useDcwStream()
  const deviceTwins = useDeviceTwins()
  const { t: tt } = useI18n()

  const filters = reactive({ lineId: '', deviceId: '', template: '', driver: '', lineRun: '', state: '', time: '', search: '' })
  const hasFilters = computed(() => !!(filters.lineId || filters.deviceId || filters.template || filters.driver || filters.lineRun || filters.state || filters.time || filters.search.trim()))
  function clearFilters(): void {
    filters.lineId = ''
    filters.deviceId = ''
    filters.template = ''
    filters.driver = ''
    filters.lineRun = ''
    filters.state = ''
    filters.time = ''
    filters.search = ''
  }

  /** 模板筛选选项:节点中出现过的 templateRef(计数),名称走 server 模板目录降级原文 */
  const templateOptions = computed(() => {
    const used = new Map<string, number>()
    for (const n of daq.nodes) used.set(n.templateRef, (used.get(n.templateRef) ?? 0) + 1)
    return [...used.entries()].map(([ref, count]) => ({ ref, count, label: daqTemplateRefCh(ref) }))
  })

  /** 驱动筛选选项:节点中出现过的驱动(计数) */
  const driverOptions = computed(() => {
    const used = new Map<string, number>()
    for (const n of daq.nodes) used.set(n.driver, (used.get(n.driver) ?? 0) + 1)
    return [...used.entries()].map(([kind, count]) => ({
      kind,
      count,
      label: daq.meta.drivers.find(d => d.kind === kind)?.label ?? kind,
    }))
  })

  function timeBucketOf(n: DaqNodeView): TimeBucket {
    if (!n.lastAt) return 'never'
    const age = Date.now() - Date.parse(n.lastAt)
    if (age <= 5 * 60_000) return 'live'
    if (age <= 3_600_000) return 'hour'
    if (age <= 86_400_000) return 'day'
    return 'old'
  }
  function timeMatch(n: DaqNodeView): boolean {
    return !filters.time || timeBucketOf(n) === filters.time
  }
  function searchMatch(n: DaqNodeView): boolean {
    const q = filters.search.trim().toLowerCase()
    if (!q) return true
    return n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)
  }

  /** 数据新鲜度:超过 max(4×有效周期, 12s) 无新样本视为「采不到数据」(容忍 5s REST 刷新拍与时钟偏差) */
  function staleOf(n: DaqNodeView): boolean {
    if (!n.lastAt) return true
    const iv = n.intervalMs ?? daq.controller.defaultIntervalMs
    return Date.now() - Date.parse(n.lastAt) > Math.max(iv * 4, 12_000)
  }

  function rowStateOf(n: DaqNodeView): RowState {
    if (!n.enabled) return 'disabled'
    if (!n.lineId) return 'unassigned'
    if (!dcw.lineStateOf(n.lineId).active) return 'idle'
    if (!daq.controller.running || staleOf(n)) return 'offline'
    return n.state
  }

  /** 产线运行态筛选语义:on = 节点所属产线开跑中;off = 待机或未分配(均未采集) */
  function lineRunMatch(n: DaqNodeView): boolean {
    if (!filters.lineRun) return true
    const active = !!n.lineId && dcw.lineStateOf(n.lineId).active
    return filters.lineRun === 'on' ? active : !active
  }

  /** 设备名映射(device-twins 注册表;绑定筛选下拉展示用) */
  const nodeDevices = new Map<string, string>()
  watch(() => deviceTwins.twins, (list) => {
    for (const t of list) nodeDevices.set(t.id, t.name)
  }, { immediate: true, deep: true })

  /** 筛选下拉的设备选项:仅列出至少绑定了一个节点的设备(空设备筛选无意义) */
  const boundDevices = computed<Array<{ id: string, name: string, count: number }>>(() => {
    const used = new Map<string, number>()
    for (const n of daq.nodes) {
      for (const d of n.deviceIds ?? (n.deviceBindingId ? [n.deviceBindingId] : [])) {
        used.set(d, (used.get(d) ?? 0) + 1)
      }
    }
    return deviceTwins.twins
      .filter(t => used.has(t.id))
      .map(t => ({ id: t.id, name: nodeDevices.get(t.id) ?? t.name, count: used.get(t.id)! }))
  })

  const filteredNodes = computed(() => daq.nodes.filter((n) => {
    if (filters.lineId && (filters.lineId === 'none' ? !!n.lineId : (n.lineId ?? '') !== filters.lineId)) return false
    const nodeDevIds = n.deviceIds ?? (n.deviceBindingId ? [n.deviceBindingId] : [])
    if (filters.deviceId && (filters.deviceId === 'none' ? nodeDevIds.length > 0 : !nodeDevIds.includes(filters.deviceId))) return false
    if (filters.template && n.templateRef !== filters.template) return false
    if (filters.driver && n.driver !== filters.driver) return false
    if (!lineRunMatch(n)) return false
    if (filters.state && rowStateOf(n) !== filters.state) return false
    if (!timeMatch(n)) return false
    if (!searchMatch(n)) return false
    return true
  }))

  /** 筛选产线的上下文横幅(运行态/产品/Recipe;未筛选到具体产线时回退全局门控提示) */
  const filteredLine = computed(() => dcw.lines.find(l => l.id === filters.lineId) ?? null)
  const filteredLineState = computed(() =>
    filteredLine.value ? dcw.lineStateOf(filteredLine.value.id) : null)

  /** 模板通道语义(server 目录为唯一事实源;模板已删除 → 显示 templateRef 原文降级) */
  function daqTemplateRefCh(templateRef: string): string {
    const tpl = daq.templates.find(t => t.key === daqKeyFromRef(templateRef))
    return tpl ? `${catalogTplName(tt, tpl)} · ${tpl.ch}` : templateRef || '-'
  }

  return {
    filters,
    hasFilters,
    clearFilters,
    templateOptions,
    driverOptions,
    boundDevices,
    filteredNodes,
    filteredLine,
    filteredLineState,
    timeBucketOf,
    rowStateOf,
    lineRunMatch,
    staleOf,
    daqTemplateRefCh,
  }
}

/** 驱动目录:server 权威(内置 + 协议插件自描述;REST 未返回时回落静态目录) */
export function useDaqDriverCatalog() {
  const daq = useDaqStream()

  const driverCatalog = computed<DaqDriverCatalogEntry[]>(() =>
    daq.meta.drivers.length ? daq.meta.drivers : DAQ_DRIVERS.map(d => ({ ...d })))

  /** 协议是否可用(planned / 依赖包缺失 → 置灰提示) */
  const driverReady = (kind: string): boolean =>
    daq.meta.drivers.find(d => d.kind === kind)?.status !== 'planned' && (daq.meta.driverAvailable?.[kind] !== false)

  return { driverCatalog, driverReady }
}

/** 控制器总控条的两个周期输入(本地编辑 → change 时下发 config) */
export function useDaqControllerForm() {
  const daq = useDaqStream()
  const reconnecting = ref(false)

  async function doReconnect(): Promise<void> {
    reconnecting.value = true
    try {
      await daq.reconnectInfra()
    }
    catch { /* 横幅仍在,30s 后台也会自动重试 */ }
    finally {
      reconnecting.value = false
    }
  }

  return { reconnecting, doReconnect }
}
