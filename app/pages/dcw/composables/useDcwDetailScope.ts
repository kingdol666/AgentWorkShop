import { computed, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import { useDaqStream } from '~/composables/workshop/useDaqStream'
import { useDeviceTwins } from '~/composables/workshop/useDeviceTwins'

/** 配方参数节点失效态(已删除/已停用/已取消绑定;灰化 + 徽标) */
export interface StaleRef { code: 'deleted' | 'disabled' | 'unbound', label: string }

/**
 * 单产线控制台的路由作用域层 —— 路由 id、产线实体、本产线作用域数据(节点/产品/配方/批次/写历史)、
 * 未分配资产收编、模板与驱动的展示标签、以及跨面板复用的纯查表函数(StaleRef 类型随之导出)。
 * 三个 store 都是模块级单例:本 composable 只持有一份派生视图,不复制任何响应式源。
 * WS 喂帧(节点变更/写 ACK 实时收敛)的时序与原页面逐字一致。
 */
export function useDcwDetailScope() {
  const { t } = useI18n()

  const route = useRoute()
  const dcw = useDcwStream()
  const daq = useDaqStream()
  const deviceTwins = useDeviceTwins()
  void daq.load()

  /** 路由产线 id;总览页「产线管理」进入 */
  const lineId = computed(() => String(route.params.id ?? ''))
  const line = computed(() => dcw.lines.find(l => l.id === lineId.value))
  const ls = computed(() => dcw.lineStateOf(lineId.value))

  void dcw.load()
  /** WS 喂帧:节点变更(dcw.node.changed)/写 ACK 实时收敛 —— 本页状态同步的通道 */
  const unsubDcw = dcw.ensureWsFeed()
  onUnmounted(() => unsubDcw())

  const nodeDeviceNames = (n: { deviceIds?: string[], deviceBindingId?: string | null }): string =>
    (n.deviceIds ?? (n.deviceBindingId ? [n.deviceBindingId] : []))
      .map(id => deviceName(id))
      .join(' / ') || '—'
  const deviceName = (id: string | null): string =>
    id ? (deviceTwins.twins.find(t => t.id === id)?.name ?? id) : t('dcwDetail.k3own4q121')

  const stateLabel = computed<Record<string, string>>(() => ({
    idle: t('dcwDetail.k3zgkk122'), writing: t('dcwDetail.k3l3h80123'), ok: t('dcwDetail.stAck'), error: t('dcwDetail.k40reu124'), offline: t('dcwDetail.k44c2n125'),
  }))

  function dcwTemplateRefCh(templateRef?: string): string {
    const ref = templateRef ?? ''
    const tpl = dcw.templates.find(t => t.key === (ref.startsWith('dcw-') ? ref.slice(4) : ref))
    return tpl?.ch ?? ref
  }

  /** 配方参数窗口提示:目标节点的全局工艺量程 */
  function nodeMin(nodeId: string): number | undefined {
    return dcw.nodeById(nodeId)?.min
  }
  function nodeMax(nodeId: string): number | undefined {
    return dcw.nodeById(nodeId)?.max
  }

  /** 本产线数采节点(配方监控窗口的可选目标) */
  const lineDaqNodes = computed(() => daq.nodes.filter(n => n.lineId === lineId.value))

  /** 监控窗口 chip 显示:数采节点参数语义 */
  function daqNodeCh(nodeId: string): string {
    return daq.nodeById(nodeId)?.name ?? nodeId
  }

  // ---------- 产线作用域数据(仅本产线 + 未分配收编) ----------
  /** 本产线节点(直写表) */
  const lineNodes = computed(() => dcw.nodes.filter(n => n.lineId === lineId.value))
  /** 本产线产品 */
  const lineProducts = computed(() => dcw.products.filter(p => p.lineId === lineId.value))
  /** 本产线配方 */
  const lineRecipesAll = computed(() => dcw.recipes.filter(r => r.lineId === lineId.value))
  /** 本产线批次 */
  const lineRuns = computed(() => dcw.runs.filter(r => r.lineId === lineId.value))
  /** 本产线写历史(按本产线节点过滤) */
  const lineHistory = computed(() => {
    const ids = new Set(lineNodes.value.map(n => n.id))
    return dcw.history.filter(h => ids.has(h.nodeId))
  })
  /** 未分配节点/产品(可收编进本产线) */
  const unassignedNodes = computed(() => dcw.nodes.filter(n => !n.lineId))
  const unassignedProducts = computed(() => dcw.products.filter(p => !p.lineId))

  async function adoptNode(id: string): Promise<void> {
    await dcw.patchNode(id, { lineId: lineId.value })
    const n = dcw.nodeById(id)
    if (n) n.lineId = lineId.value
  }
  async function adoptProduct(id: string): Promise<void> {
    await dcw.updateProduct(id, { lineId: lineId.value })
    await dcw.load()
  }

  const productName = (id: string): string => dcw.products.find(p => p.id === id)?.name ?? id

  // ---------- 配方参数节点失效态(已删除/已停用/已取消绑定;灰化 + 徽标) ----------
  function paramStatus(nodeId: string, lineId: string): StaleRef | null {
    const node = dcw.nodes.find(n => n.id === nodeId)
    if (!node) return { code: 'deleted', label: t('dcwDetail.staleDeleted') }
    if (!node.enabled) return { code: 'disabled', label: t('dcwDetail.staleDisabled') }
    if (lineId && node.lineId !== lineId) return { code: 'unbound', label: t('dcwDetail.staleUnbound') }
    return null
  }
  function paramNodeName(nodeId: string): string {
    return dcw.nodes.find(n => n.id === nodeId)?.name ?? nodeId
  }
  function daqWindowStatus(nodeId: string, lineId: string): StaleRef | null {
    const node = daq.nodes.find(n => n.id === nodeId)
    if (!node) return { code: 'deleted', label: t('dcwDetail.staleDeleted') }
    if (!node.enabled) return { code: 'disabled', label: t('dcwDetail.staleDisabled') }
    if (lineId && node.lineId !== lineId) return { code: 'unbound', label: t('dcwDetail.staleUnbound') }
    return null
  }

  return {
    dcw,
    daq,
    deviceTwins,
    lineId,
    line,
    ls,
    stateLabel,
    dcwTemplateRefCh,
    nodeMin,
    nodeMax,
    lineDaqNodes,
    daqNodeCh,
    lineNodes,
    lineProducts,
    lineRecipesAll,
    lineRuns,
    lineHistory,
    unassignedNodes,
    unassignedProducts,
    adoptNode,
    adoptProduct,
    productName,
    paramStatus,
    paramNodeName,
    daqWindowStatus,
    nodeDeviceNames,
  }
}
