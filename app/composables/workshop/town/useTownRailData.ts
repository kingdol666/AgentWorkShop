/**
 * 小镇视图 — 左轨数据(数采/智控模板·节点树·实时读数·伪孪生投影·火花线)
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持):
 *   - 模板目录(REST/WS 收敛)、树形分组与展开记忆;
 *   - 读数帧直写 rtc 缓冲 + 200ms 合批失效(daqSim 兼容视图);
 *   - 数采/智控伪孪生投影(进场景 syncDevices / callout 管线)。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import { useStorage } from '@vueuse/core'
import type { useDeviceTwins, DeviceTwinView } from '@/app/composables/workshop/useDeviceTwins'
import type { useDaqStream, DaqNodeLive } from '@/app/composables/workshop/useDaqStream'
import type { useDcwStream, DcwNodeView } from '@/app/composables/workshop/useDcwStream'
import type { useTownBus } from '@/app/composables/workshop/useTownBus'
import { DAQ_TEMPLATES } from '#shared/daq-protocol'
import type { TownViewScene } from '@/app/components/workshop/town/TownView.vue'
import type { AlarmItem, DaqSimState, DaqTemplate, RailLeafState, RtcPoint } from './town-view-types'
import type { TownScene3D } from '@/app/components/workshop/town/TownScene3D'

export function useTownRailData(params: {
  daq: ReturnType<typeof useDaqStream>
  dcw: ReturnType<typeof useDcwStream>
  deviceTwins: ReturnType<typeof useDeviceTwins>
  townBus: ReturnType<typeof useTownBus>
  sceneRef: ShallowRef<TownViewScene | null>
  scene3dRef: ShallowRef<TownScene3D | null>
  errorText: Ref<string>
  ready: Ref<boolean>
  blockCount: Ref<number>
  raiseAlarm: (txt: string, level?: AlarmItem['level'], src?: string) => void
}) {
  const { daq, dcw, deviceTwins, townBus, sceneRef, scene3dRef, errorText, ready, blockCount, raiseAlarm } = params
  const { t } = useI18n()

  /** 用全量设备池收敛场景节点(真设备孪生 + 全部 DAQ 节点投影;按节点 id 对账)。
   *  必须传 sceneTwinPool 而非 deviceTwins.twins —— syncDevices 会移除不在清单内的
   *  本地节点,漏掉 daq 投影时设备事件每次到达都会把场景中的数采节点误删。 */
  function syncSceneDevices(scene: TownViewScene): void {
    if ('syncDevices' in scene) {
      ;(scene as TownScene3D).syncDevices(sceneTwinPool.value)
    }
  }
  /** 场景管线统一设备池:真实设备孪生(剔除旧 daq 孪生)+ server 数采节点伪孪生 */
  /** 产线光晕色(lineId → Hex;未分配 undefined = 缺省绿) */
  const lineColorOf = (lid: string): string | undefined =>
    dcw.lines.find(l => l.id === lid)?.color

  /** 智控节点伪孪生投影(与 daqTwins 同构;value = 当前设定值;lineColor = 产线光环) */
  const dcwTwins = computed<DeviceTwinView[]>(() =>
    dcw.nodes.map(n => ({
      id: n.id,
      workspaceId: '',
      name: n.name,
      modelRef: `dcw-${n.templateRef.startsWith('dcw-') ? n.templateRef.slice(4) : n.templateRef}`,
      boundAgentId: null,
      kind: 'daq' as const,
      telemetry: { value: n.value ?? 0 },
      desired: {},
      controls: [],
      state: n.enabled ? (n.state === 'error' ? 'alarm' : 'running') : 'offline',
      posX: n.posX,
      posZ: n.posZ,
      lineId: n.lineId || undefined,
      lineColor: n.lineId ? lineColorOf(n.lineId) : undefined,
      updatedAt: n.lastWriteAt ?? n.createdAt,
    })))

  const sceneTwinPool = computed<DeviceTwinView[]>(() => [
    ...deviceTwins.twins.filter(t => !isLegacyDaqTwin(t)),
    ...daqTwins.value,
    ...dcwTwins.value,
  ])
  const sceneTwinById = (id: string): DeviceTwinView | undefined =>
    sceneTwinPool.value.find(t => t.id === id)

  /** 空场景提示判定:场景里没有任何「已落位」实体(设备/数采/数控)且无频道积木时才提示。
   *  只看 blockCount 会在清空频道布局后、设备与工业节点仍在场时误报"空场景"。 */
  const sceneEmpty = computed(() =>
    ready.value
    && blockCount.value === 0
    && !sceneTwinPool.value.some(t => typeof t.posX === 'number' && typeof t.posZ === 'number'),
  )
  /* ============================================================
   * 数采节点 · DAQ(server 数据驱动):节点实体/采集循环/告警派生全部在服务端
   * (DaqNode class + DaqController,WS daq.reading 实时下发)。前端只做:
   * 模板目录渲染(shared 单一事实源)→ 拖入创建 REST 节点 → 绑定设备 → 展示。
   * 有多少 server Node,场景就有多少数采节点。
   * ============================================================ */
  /* daq / dcw 流单例由父组件创建并经参数注入(单例不重复调用) */

  /** 智控模板目录(server 权威;与 daqTemplates 同构投影) */
  const dcwTemplates = reactive(dcw.templates.map(tpl => ({
    id: tpl.key,
    name: catalogTplName(t, tpl),
    code: tpl.code,
    ch: tpl.ch,
    unit: tpl.unit,
    min: tpl.min,
    max: tpl.max,
    decimals: tpl.decimals,
    icon: tpl.icon,
  })))
  watch(() => dcw.templates, (list) => {
    if (!list?.length) return
    dcwTemplates.splice(0, dcwTemplates.length, ...list.map(tpl => ({
      id: tpl.key,
      name: catalogTplName(t, tpl),
      code: tpl.code,
      ch: tpl.ch,
      unit: tpl.unit,
      min: tpl.min,
      max: tpl.max,
      decimals: tpl.decimals,
      icon: tpl.icon,
    })))
  }, { immediate: true, deep: true })
  /** 左轨树形目录:模板 = 可展开分组(不可拖拽),节点 = 可拖入场景的叶子。
   *  展开状态持久化(aw.twin.treeOpen),拖拽载荷 = 既有节点 id(非模板)。 */
  const treeOpen = useStorage<Record<string, boolean>>('aw.twin.treeOpen', {})
  function toggleTreeGroup(key: string): void {
    treeOpen.value[key] = !treeOpen.value[key]
  }
  const daqNodesByTpl = computed<Map<string, DaqNodeLive[]>>(() => {
    const m = new Map<string, DaqNodeLive[]>()
    for (const n of daq.nodes) {
      const key = n.templateRef.startsWith('daq-') ? n.templateRef.slice(4) : n.templateRef
      const arr = m.get(key) ?? []
      arr.push(n)
      m.set(key, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    return m
  })
  const dcwNodesByTpl = computed<Map<string, DcwNodeView[]>>(() => {
    const m = new Map<string, DcwNodeView[]>()
    for (const n of dcw.nodes) {
      const key = n.templateRef.startsWith('dcw-') ? n.templateRef.slice(4) : n.templateRef
      const arr = m.get(key) ?? []
      arr.push(n)
      m.set(key, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    return m
  })
  /** 模板行 ＋:就地新建节点(不落位,入树后拖进场景);daq 沿用模板序号命名 */
  async function createDaqFromTemplate(tpl: DaqTemplate): Promise<void> {
    try {
      const seq = (daqNodesByTpl.value.get(tpl.id)?.length ?? 0) + 1
      await daq.createFromTemplate(`daq-${tpl.id}`, { name: `${tpl.name} ${String(seq).padStart(2, '0')}` })
      treeOpen.value[`daq:${tpl.id}`] = true
    }
    catch (err: unknown) {
      errorText.value = apiErrorMessage(err)
    }
  }
  async function createDcwFromTemplate(tpl: { id: string }): Promise<void> {
    try {
      await dcw.createFromTemplate(`dcw-${tpl.id}`, {})
      treeOpen.value[`dcw:${tpl.id}`] = true
    }
    catch (err: unknown) {
      errorText.value = apiErrorMessage(err)
    }
  }
  /** 节点叶子拖拽(编辑模式):载荷 = server 节点 id,投放走 PATCH 落位。
   *  effectAllowed 必须 ⊇ 画布 dragover 声明的 dropEffect('copy'),否则真实拖拽
   *  在浏览器拖拽控制器协商阶段被拒(drop 永不触发)。 */
  function onDaqNodeDragStart(e: DragEvent, n: DaqNodeLive): void {
    if (!e.dataTransfer) return
    e.dataTransfer.setData('application/x-aw-daq-node', n.id)
    e.dataTransfer.setData('text/plain', n.id)
    e.dataTransfer.effectAllowed = 'copy'
  }
  function onDcwNodeDragStart(e: DragEvent, n: DcwNodeView): void {
    if (!e.dataTransfer) return
    e.dataTransfer.setData('application/x-aw-dcw-node', n.id)
    e.dataTransfer.setData('text/plain', n.id)
    e.dataTransfer.effectAllowed = 'copy'
  }
  function daqLeafState(n: DaqNodeLive): RailLeafState {
    if (!daq.controller.running || !n.enabled || n.state === 'offline') return 'offline'
    if (n.state === 'alarm') return 'alarm'
    if (n.state === 'warn') return 'warn'
    return 'running'
  }
  function dcwLeafState(n: DcwNodeView): RailLeafState {
    if (!n.enabled || n.state === 'error') return 'offline'
    return 'running'
  }
  const daqTemplates = reactive<DaqTemplate[]>(DAQ_TEMPLATES.map(tpl => ({
    id: tpl.key,
    name: catalogTplName(t, tpl),
    code: tpl.code,
    ch: tpl.ch,
    unit: tpl.unit,
    base: tpl.base,
    amp: tpl.amp,
    min: tpl.min,
    max: tpl.max,
    decimals: tpl.decimals,
    icon: tpl.icon,
  })))
  watch(() => daq.templates, (list) => {
    if (!list?.length) return
    daqTemplates.splice(0, daqTemplates.length, ...list.map(tpl => ({
      id: tpl.key,
      name: catalogTplName(t, tpl),
      code: tpl.code,
      ch: tpl.ch,
      unit: tpl.unit,
      base: tpl.base,
      amp: tpl.amp,
      min: tpl.min,
      max: tpl.max,
      decimals: tpl.decimals,
      icon: tpl.icon,
    })))
  }, { immediate: true, deep: true })
  const daqTplById = (ref: string): DaqTemplate | undefined => {
    const key = ref.startsWith('daq-') ? ref.slice(4) : ref
    return daqTemplates.find(t => t.id === key)
  }
  const daqTplOf = (n: DaqNodeLive): DaqTemplate | undefined => daqTplById(n.templateRef)

  /** 孪生状态映射(node state → DeviceTwin.state 联合;warn 在值卡层表达) */
  function effectiveTwinState(n: DaqNodeLive): DeviceTwinView['state'] {
    if (!daq.controller.running || !n.enabled) return 'offline'
    if (n.state === 'alarm') return 'alarm'
    return 'running'
  }

  /** 场景中的数采实例(server Node → 伪孪生投影;与设备孪生同构进 syncDevices/callout 管线) */
  const isLegacyDaqTwin = (t: DeviceTwinView): boolean =>
    t.kind === 'daq' || (t.modelRef ?? '').startsWith('daq-')
  const daqTwins = computed<DeviceTwinView[]>(() =>
    daq.nodes.map(n => ({
      id: n.id,
      workspaceId: '',
      name: n.name,
      modelRef: `daq-${daqTplOf(n)?.id ?? 'unknown'}`,
      boundAgentId: null,
      kind: 'daq',
      telemetry: { value: n.value ?? 0 },
      desired: {},
      controls: [],
      state: effectiveTwinState(n),
      posX: n.posX,
      posZ: n.posZ,
      lineId: n.lineId || undefined,
      lineColor: n.lineId ? lineColorOf(n.lineId) : undefined,
      updatedAt: n.lastAt ?? n.createdAt,
    })))
  /**
   * 兼容视图:旧 UI 全部消费 DaqSimState(value/hist/tpl/alarm),保留同形结构。
   *
   * 双通道数据消费(与渲染帧率彻底解耦):
   *  - 消费层:WS 读数帧直写 rtcVals/rtcHist(非响应式,帧到即入,零合批延迟),
   *    告警边沿检测同帧完成(异常事件即时上屏);
   *  - 展示层:daqSim 计算属性消费 rtc 覆盖 + store hist(趋势),帧计数器作失效信号,
   *    Vue 渲染管线自行合批 DOM 更新;场景渲染循环每帧只取「当前最新值」。
   */
  const RTC_HIST_CAP = 120
  const liveTick = ref(0)
  const rtcVals = new Map<string, RtcPoint>()
  const rtcHist = new Map<string, number[]>()
  let unsubLiveVals: (() => void) | null = null
  /** 帧计数合批:高频帧流按 200ms 定时节拍失效(原 rAF 合批在 60-220Hz rAF 下每秒
   *  重建 60-220 次 227 条目的 daqSim Map,是实测长任务主源;200ms 展示延迟不可感知) */
  let tickQueued = false
  function bumpLiveTick(): void {
    if (tickQueued) return
    tickQueued = true
    setTimeout(() => {
      tickQueued = false
      liveTick.value++
    }, 200)
  }

  /** 读数帧消费:实时缓冲直写 + 状态边沿即时告警(与批量 watch 共享 prevDaqState 去重) */
  function consumeReading(p: { nodeId?: string, value?: number, state?: string, at?: string }): void {
    if (!p.nodeId || typeof p.value !== 'number' || !Number.isFinite(p.value)) return
    const nextState = p.state ?? 'ok'
    rtcVals.set(p.nodeId, { value: p.value, state: nextState, atMs: Date.parse(p.at ?? '') || Date.now() })
    let h = rtcHist.get(p.nodeId)
    if (!h) {
      h = []
      rtcHist.set(p.nodeId, h)
    }
    h.push(p.value)
    if (h.length > RTC_HIST_CAP) h.shift()
    // 状态边沿 → 即时告警(prevDaqState 与批量 watch 共享,先到先记,后到去重)
    const prevState = prevDaqState.get(p.nodeId)
    if (prevState && prevState !== nextState) stateEdgeAlarm(p.nodeId, prevState, nextState, p.value)
    if (prevState !== nextState) prevDaqState.set(p.nodeId, nextState)
    bumpLiveTick()
  }

  const daqSim = computed<Map<string, DaqSimState>>(() => {
    // 依赖:每条读数帧到达即重算(标注/设备卡真·实时);帧计数器兼作失效信号
    const tick = liveTick.value
    void tick
    const m = new Map<string, DaqSimState>()
    for (const n of daq.nodes) {
      const tpl = daqTplOf(n)
      if (!tpl) continue
      const lv = rtcVals.get(n.id)
      // 直通帧仅在比 store 快照新时采用(节点停采后自然回落到权威快照)
      const fresher = lv && (!n.lastAt || lv.atMs >= Date.parse(n.lastAt))
      const value = fresher ? lv!.value : n.value
      if (value == null) continue
      const state = fresher ? lv!.state : n.state
      m.set(n.id, { value, hist: rtcHist.get(n.id) ?? n.hist, phase: 0, tpl, alarm: state === 'alarm' })
    }
    return m
  })
  const fmtDaq = (st: DaqSimState): string => st.value.toFixed(st.tpl.decimals)

  /** 告警推进(server 派生 state 变化 → 场景告警面板;恢复自动消警语义保持)。
   *  prevDaqState 为帧通道(即时)与批量 watch(兜底)共享的去重账本 —— 先到先记。 */
  const prevDaqState = new Map<string, string>()

  /** 状态边沿 → 告警文案(crit/warn/恢复 info;label 优先绑定设备名) */
  function stateEdgeAlarm(nodeId: string, prevState: string, nextState: string, value: number | null): void {
    const n = daq.nodeById(nodeId)
    const tpl = n ? daqTplOf(n) : null
    const devIds = n?.deviceIds ?? (n?.deviceBindingId ? [n.deviceBindingId] : [])
    const dev = devIds.length ? devIds.map(id => deviceTwins.byId(id)?.name ?? id.slice(0, 8)).join(' / ') : null
    const label = dev ?? n?.name ?? nodeId.slice(0, 8)
    const val = `${value?.toFixed(tpl?.decimals ?? 2) ?? '--'} ${tpl?.unit ?? ''}`
    if (nextState === 'alarm') raiseAlarm(t('townView.k113fir9195', { p0: label, p1: tpl?.ch ?? '', p2: val }), 'crit', label)
    else if (nextState === 'warn') raiseAlarm(t('townView.k1knv89d196', { p0: label, p1: tpl?.ch ?? '', p2: val }), 'warn', label)
    else if (prevState !== 'ok' && nextState === 'ok') raiseAlarm(t('townView.ksjancw197', { p0: label, p1: tpl?.ch ?? '' }), 'info', label)
  }

  /** 批量兜底:REST 快照收敛时捕捉帧通道未见的边沿(如离线判定);帧通道已记的自动去重 */
  watch(() => daq.nodes.map(n => `${n.id}:${n.state}`).join('|'), () => {
    for (const n of daq.nodes) {
      const prev = prevDaqState.get(n.id)
      prevDaqState.set(n.id, n.state)
      if (!prev || prev === n.state) continue
      stateEdgeAlarm(n.id, prev, n.state, n.value)
    }
  })
  /** bind-row 迷你折线(实时历史;ref 回调收集画布,1s tick 重绘) */
  const sparkRefs = new Map<string, HTMLCanvasElement>()
  function setSparkRef(id: string, el: unknown): void {
    const c = el as HTMLCanvasElement | null
    if (c) sparkRefs.set(id, c)
    else sparkRefs.delete(id)
  }
  function drawBindSparks(): void {
    for (const [id, canvas] of sparkRefs) {
      const st = daqSim.value.get(id)
      const ctx = canvas.getContext('2d')
      if (!st || !ctx) continue
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)
      const hist = st.hist
      if (hist.length < 2) continue
      let lo = hist[0]!
      let hi = hist[0]!
      for (const v of hist) {
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      const span = Math.max(1e-6, hi - lo)
      ctx.strokeStyle = trendColor(id)
      ctx.lineWidth = 1.4
      ctx.beginPath()
      hist.forEach((v, i) => {
        const x = (i / (hist.length - 1)) * (w - 2) + 1
        const y = h - 2 - ((v - lo) / span) * (h - 4)
        if (i) ctx.lineTo(x, y)
        else ctx.moveTo(x, y)
      })
      ctx.stroke()
    }
  }
  /** 场景链路同步:绑定关系 → TownScene3D.syncDaqLinks(虚线 + 脉冲);server 绑定为权威 */
  // DAQ 节点清单(增删/落点/启停/状态/绑定)变化 → 场景即时收敛
  // (签名不含 value:每秒读数帧不值得全量 reconcile,实时值走 callout/KPI 管线)
  watch(() => daq.nodes.map(n => `${n.id}:${n.posX ?? ''}:${n.posZ ?? ''}:${n.enabled}:${n.state}:${n.deviceBindingId ?? ''}`).join('|'), () => {
    if (sceneRef.value) syncSceneDevices(sceneRef.value)
  })
  // 智控节点清单(增删/落点/绑定/设定值)变化 → 场景即时收敛
  // (签名含 value:dcw.written 帧更新设定值后场景 telemetry 必须跟随;
  //  写操作低频,无需像 daq 读数那样做签名剔除)
  watch(() => dcw.nodes.map(n => `${n.id}:${n.posX ?? ''}:${n.posZ ?? ''}:${n.enabled}:${n.deviceBindingId ?? ''}:${n.value ?? ''}`).join('|'), () => {
    if (sceneRef.value) syncSceneDevices(sceneRef.value)
  })
  watch(() => daq.nodes.map(n => `${n.id}:${n.deviceBindingId ?? ''}`).join('|'), () => {
    const s = scene3dRef.value
    if (!s || !('syncDaqLinks' in s)) return
    s.syncDaqLinks(daq.nodes
      .filter(n => n.deviceBindingId)
      .map(n => ({ daqId: n.id, deviceId: n.deviceBindingId! })))
  })
  const TREND_COLORS = ['#35e0a0', '#41c8f4', '#f6c453', '#a78bfa', '#ff6b6b', '#4dd0e1']
  const trendColor = (id: string): string => TREND_COLORS[Math.abs(id.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % TREND_COLORS.length] ?? '#35e0a0'

  onMounted(() => {
    // 数采流:REST 基线 + WS 实时帧(server 权威;进数字孪生空间即建立连接)
    daq.ensureWsFeed()
    void daq.load()
    // 实时消费层:读数帧零缓冲直写 rtc(标注/设备卡/KPI/趋势全部真·实时;
    // 渲染循环每帧只读最新值,与帧率选择无关)
    unsubLiveVals = townBus.subscribe((e) => {
      if (e.type === 'daq.reading') consumeReading(e.payload as { nodeId?: string, value?: number, state?: string, at?: string })
    })
    // 智控流:同款上电(REST 基线 + dcw.* WS 帧),dcwTwins 投影进 sceneTwinPool
    dcw.ensureWsFeed()
    void dcw.load()
  })
  onBeforeUnmount(() => {
    unsubLiveVals?.()
  })

  return { dcwTwins, sceneTwinPool, sceneTwinById, sceneEmpty, syncSceneDevices, daqTemplates, dcwTemplates, treeOpen, toggleTreeGroup, daqNodesByTpl, dcwNodesByTpl, createDaqFromTemplate, createDcwFromTemplate, onDaqNodeDragStart, onDcwNodeDragStart, daqLeafState, dcwLeafState, daqTplById, daqTplOf, isLegacyDaqTwin, daqTwins, daqSim, fmtDaq, trendColor, rtcHist, RTC_HIST_CAP, setSparkRef, drawBindSparks }
}
