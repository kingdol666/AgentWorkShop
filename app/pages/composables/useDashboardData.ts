/**
 * 仪表盘(/)页面私有数据源 —— 产线运营数字大屏。
 *
 * 数据权威在 server:useDcwStream + useDaqStream(REST 基线 + WS 实时收敛
 * + 5s 低频兜底刷新);趋势缓冲为本页每 5s 一次的量程归一化快照。
 *
 * ⚠️ 页面只调用一次:daq/dcw 是 globalThis 单例,但 trendBuf / harnesses
 * 是本 composable 的私有状态 —— 重复调用会拿到互不相干的第二份缓冲
 * (趋势曲线会被拆成各画各的几条)。装载时序留在页面,图表 option 见
 * useDashboardCharts(消费本 composable 的唯一返回值,不另行取数)。
 */
import { computed, ref } from 'vue'
import { useSiteConfig } from '~/composables/useSiteConfig'
import { useDaqStream } from '~/composables/workshop/useDaqStream'
import { useDcwStream } from '~/composables/workshop/useDcwStream'
import { useWorkshopApi, type HarnessMetaDto } from '~/composables/workshop/useWorkshopApi'
import { useAppStore } from '~/stores/app'

/** 产线清单卡(裁策:清单是导航不是数据库导出) */
export interface DashboardFleetLine {
  id: string
  name: string
  color: string
  active: boolean
  product: string | null
  recipe: string | null
  runId: string | null
  tagged: number
  dcwCount: number
  daqCount: number
}

export function useDashboardData() {
  const site = useSiteConfig()
  const store = useAppStore()
  const daq = useDaqStream()
  const dcw = useDcwStream()

  // 图表色序随主题切换(两套声部,同一语义序):
  //   亮 = Warm Editorial 编辑色板(main.css --chart-* 同源,墨绿→苔绿→琥珀→陶赭)
  //   暗 = 控制室 tone 系统(绿=运行/成功 · 青=数据 · 琥珀=需关注 · 紫=重试 · 红=告警)
  // —— 亮阶把品牌绿当"墨"用,暗阶把同一抹绿当"信号"用,各自在自己的画布上才成立。
  const pal = computed(() => (store.isDark
    ? { accent: '#3fe4ab', cyan: '#41c8f4', amber: '#f6c453', violet: '#a795ff', danger: '#ff8080' }
    : { accent: '#4a6b57', cyan: '#6f8296', amber: '#c9a26a', violet: '#b3714f', danger: '#c25a4e' }))
  /** 明暗判据(节点状态分布的 idle/offline 两档灰阶按主题分色) */
  const isDark = computed(() => store.isDark)

  // ---------- Harness 可用性(引擎 CLI 环境探测;服务端 30s 探测缓存,随兜底节拍刷新) ----------
  const api = useWorkshopApi()
  const harnesses = ref<HarnessMetaDto[]>([])

  const loadHarnesses = async (): Promise<void> => {
    try {
      const res = await api.listHarnesses()
      harnesses.value = (res as unknown as { data?: { harnesses?: HarnessMetaDto[] } })?.data?.harnesses ?? []
    }
    catch { /* 探测不可得时面板留空,不阻塞大屏 */ }
  }
  const harnessOk = computed(() => harnesses.value.filter(h => h.available !== false).length)

  // ---------- KPI ----------
  const linesActive = computed(() => dcw.lines.filter(l => dcw.lineStateOf(l.id).active))
  const daqOnline = computed(() => daq.nodes.filter(n => n.enabled && n.state !== 'offline').length)
  const daqTotal = computed(() => daq.nodes.length)
  const alarmCount = computed(() => daq.nodes.filter(n => n.state === 'alarm').length)
  const writeRate = computed(() => {
    const total = dcw.controller.writesTotal
    if (total === 0) return 100
    return Math.round(((total - dcw.controller.writesFailed) / total) * 1000) / 10
  })

  // ---------- 趋势缓冲(近 3 分钟,5s 一拍,量程归一化) ----------
  interface TrendPoint { t: number, m: Record<string, number | null> }
  const trendBuf = ref<TrendPoint[]>([])
  /** 趋势通道:有实时值的节点优先(在线优先),稳定取前 4 */
  const trendNodes = computed(() => daq.nodes
    .filter(n => n.value != null && n.max > n.min)
    .sort((a, b) => (a.lineId ? 0 : 1) - (b.lineId ? 0 : 1) || a.id.localeCompare(b.id))
    .slice(0, 4))

  function pushTrend(): void {
    const m: Record<string, number | null> = {}
    for (const n of trendNodes.value) {
      m[n.id] = n.value == null ? null : Math.round(((n.value - n.min) / (n.max - n.min)) * 100)
    }
    trendBuf.value.push({ t: Date.now(), m: m as Record<string, number | null> })
    if (trendBuf.value.length > 36) trendBuf.value.shift()
  }

  /** 趋势是否真有数值可画(采样被活动批次门控:未开跑时缓冲里只有 null 占位) */
  const trendHasData = computed(() =>
    trendNodes.value.length > 0
    && trendBuf.value.some(p => trendNodes.value.some(n => typeof p.m[n.id] === 'number')))

  // ---------- 产线清单 ----------
  const lineCards = computed<DashboardFleetLine[]>(() => dcw.lines.map((l) => {
    const st = dcw.lineStateOf(l.id)
    return {
      id: l.id,
      name: l.name,
      color: l.color,
      active: st.active,
      product: st.productName,
      recipe: st.recipeName,
      runId: st.runId,
      tagged: st.taggedSamples,
      dcwCount: dcw.nodes.filter(n => n.lineId === l.id).length,
      daqCount: daq.nodes.filter(n => n.lineId === l.id).length,
    }
  }))
  /** 运行中优先,其次已打标样本多的(最近活跃),稳定排序 */
  const fleetSorted = computed(() => [...lineCards.value].sort((a, b) =>
    Number(b.active) - Number(a.active) || b.tagged - a.tagged || a.name.localeCompare(b.name)))
  const FLEET_CAP = 8
  const fleetShown = computed(() => fleetSorted.value.slice(0, FLEET_CAP))
  const fleetOverflow = computed(() => Math.max(lineCards.value.length - FLEET_CAP, 0))

  return {
    site,
    daq,
    dcw,
    pal,
    isDark,
    harnesses,
    harnessOk,
    loadHarnesses,
    linesActive,
    daqOnline,
    daqTotal,
    alarmCount,
    writeRate,
    trendNodes,
    trendBuf,
    trendHasData,
    pushTrend,
    lineCards,
    fleetShown,
    fleetOverflow,
  }
}

/** 本页数据形状(useDashboardCharts 的入参契约) */
export type DashboardData = ReturnType<typeof useDashboardData>
