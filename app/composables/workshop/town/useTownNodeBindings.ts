/**
 * 小镇视图 — 工业节点绑定与设定(检查器/绑定弹层/智控直写)
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持):
 *   - 数采/智控 → 设备绑定(server 权威 deviceBindingId)与绑定弹层候选;
 *   - 选中节点检查器视图(实时值/量程/直写草稿与错误);
 *   - 拖放落点自动绑定(±95 世界单位最近设备)。
 */
import { computed, reactive, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { useDaqStream, DaqNodeLive } from '@/app/composables/workshop/useDaqStream'
import type { useDcwStream, DcwNodeView } from '@/app/composables/workshop/useDcwStream'
import type { useDeviceTwins, DeviceTwinView } from '@/app/composables/workshop/useDeviceTwins'
import type { RecipeParam } from '#shared/dcw-protocol'
import type { DaqSimState, DaqTemplate, DcwBoundRow, DcwTemplate, RailBindChoice } from './town-view-types'

export function useTownNodeBindings(params: {
  selected: Ref<{ kind: 'agent' | 'device', id: string, scale: number, rotation: number } | null>
  daq: ReturnType<typeof useDaqStream>
  dcw: ReturnType<typeof useDcwStream>
  deviceTwins: ReturnType<typeof useDeviceTwins>
  daqSim: ComputedRef<Map<string, DaqSimState>>
  daqTplById: (ref: string) => DaqTemplate | undefined
  daqTplOf: (n: DaqNodeLive) => DaqTemplate | undefined
  isLegacyDaqTwin: (t: DeviceTwinView) => boolean
  fmtDaq: (st: DaqSimState) => string
  sceneTwinById: (id: string) => DeviceTwinView | undefined
  dcwTemplates: DcwTemplate[]
  trendColor: (id: string) => string
  errorText: Ref<string>
}) {
  const { selected, daq, dcw, deviceTwins, daqSim, daqTplById, daqTplOf, isLegacyDaqTwin, fmtDaq, sceneTwinById, dcwTemplates, trendColor, errorText } = params
  const { t } = useI18n()

  /** 数采 → 设备绑定(server 权威:node.deviceBindingId;REST bind 落库 + WS 收敛) */
  const boundDeviceOf = (daqId: string): string | null => daq.nodeById(daqId)?.deviceIds?.[0] ?? daq.nodeById(daqId)?.deviceBindingId ?? null
  const _boundDevicesOf = (daqId: string): string[] => {
    const n = daq.nodeById(daqId)
    return n?.deviceIds ?? (n?.deviceBindingId ? [n.deviceBindingId] : [])
  }
  void _boundDevicesOf
  const daqOfDevice = (deviceId: string): string[] =>
    deviceId ? daq.nodes.filter(n => (n.deviceIds ?? (n.deviceBindingId ? [n.deviceBindingId] : [])).includes(deviceId)).map(n => n.id) : []
  function bindDaq(daqId: string, deviceId: string): void {
    void daq.bindNode(daqId, deviceId).catch((err: unknown) => {
      errorText.value = apiErrorMessage(err)
    })
  }
  function unbindDaq(daqId: string): void {
    void daq.bindNode(daqId, null).catch((err: unknown) => {
      errorText.value = apiErrorMessage(err)
    })
  }

  /** 数采/智控模板图标:注入面收敛在 WorkshopDaqTemplateIcon(唯一 v-html 点) */

  /** 最近设备孪生(拖放自动绑定:数采落点 ±95 世界单位内最近的非数采设备) */
  function nearestDeviceTwin(x: number, z: number, maxDist: number): DeviceTwinView | null {
    let best: DeviceTwinView | null = null
    let bd = maxDist
    for (const t of deviceTwins.twins) {
      if (isLegacyDaqTwin(t)) continue
      if (typeof t.posX !== 'number' || typeof t.posZ !== 'number') continue
      const d = Math.hypot(t.posX - x, t.posZ - z)
      if (d < bd) {
        bd = d
        best = t
      }
    }
    return best
  }
  /** bind-pop:添加数采通道 —— 直接选择节点实例绑定(server 权威 deviceBindingId,双向同源)。
   *  列出未绑定 + 绑在他设备的节点(按模板分组,显示当前归属);不再隐式创建/就近复用。 */
  const bindPopOpen = ref(false)
  const dcwBindPopOpen = ref(false)
  /** 弹层高度钳制:top 恰好贴住所属 Inspector 卡片顶缘(不越出面板、不顶到页面顶部) */
  const bindPopMaxH = ref(420)
  function toggleBindPop(key: 'daq' | 'dcw', e: MouseEvent): void {
    const btn = e.currentTarget as HTMLElement | null
    const panel = btn?.closest('.panel')
    if (btn && panel) {
      const avail = btn.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12
      bindPopMaxH.value = Math.max(160, Math.round(avail))
    }
    if (key === 'daq') bindPopOpen.value = !bindPopOpen.value
    else dcwBindPopOpen.value = !dcwBindPopOpen.value
  }
  const daqBindChoices = computed<Record<string, RailBindChoice[]>>(() => {
    const devId = selected.value?.kind === 'device' ? selected.value.id : ''
    const map: Record<string, RailBindChoice[]> = {}
    if (!devId) return map
    for (const n of daq.nodes) {
      if (n.deviceBindingId === devId) continue
      const tpl = daqTplOf(n)
      if (!tpl) continue
      ;(map[tpl.id] ??= []).push({
        id: n.id,
        name: n.name,
        tpl,
        devName: n.deviceBindingId ? deviceTwins.byId(n.deviceBindingId)?.name ?? null : null,
        placed: typeof n.posX === 'number',
      })
    }
    return map
  })
  const daqBindChoiceCount = computed(() => Object.values(daqBindChoices.value).reduce((s, a) => s + a.length, 0))
  function bindDaqChoice(nodeId: string): void {
    const devId = selected.value?.kind === 'device' ? selected.value.id : ''
    if (!devId) return
    bindDaq(nodeId, devId)
    bindPopOpen.value = false
  }
  /** 选中上下文:是否数采节点 / 其模板 / 实时值 */
  const selectedIsDaq = computed(() =>
    selected.value?.kind === 'device' && (daqOfSelected.value?.modelRef || '').startsWith('daq-'),
  )
  const daqOfSelected = computed(() => {
    if (selected.value?.kind !== 'device') return null as DeviceTwinView | null
    return sceneTwinById(selected.value?.id) ?? null
  })
  const selectedDaqSim = computed(() => {
    const id = selected.value?.id
    return id ? daqSim.value.get(id) ?? null : null
  })
  /** 绑定选择器:待绑定数采下拉 */
  const bindPick = ref('')
  const boundDaqRows = computed(() => {
    const id = selected.value?.id
    if (!id) return []
    return daqOfDevice(id).map((daqId) => {
      const twin = sceneTwinById(daqId)
      const st = daqSim.value.get(daqId)
      const tpl = st?.tpl ?? daqTplById(twin?.modelRef ?? '')
      return {
        daqId,
        name: twin?.name ?? daqId,
        ch: tpl?.ch ?? t('townView.k1ef3cls168'),
        icon: tpl?.icon ?? 'gateway',
        value: st ? fmtDaq(st) : '--',
        unit: st?.tpl.unit ?? tpl?.unit ?? '',
        color: trendColor(daqId),
      }
    })
  })
  /** 数采节点选中:其绑定设备名 */
  const daqBoundDeviceName = computed(() => {
    const id = selected.value?.id
    if (!id) return ''
    const devId = boundDeviceOf(id)
    if (!devId) return ''
    return deviceTwins.twins.find(t => t.id === devId)?.name ?? devId.slice(0, 8)
  })
  // ---------- 智控绑定与设定(选中设备面板直写 + 选中智控节点检查器) ----------
  const dcwOfDevice = (deviceId: string): DcwNodeView[] =>
    deviceId ? dcw.nodes.filter(n => n.deviceBindingId === deviceId) : []

  /** 活动配方对该智控节点的工艺窗口参数(产线未开跑/未命中 → null = 用节点全局量程) */
  /** 节点所属产线的活动配方窗口参数(逐产线运行窗;节点级寻址) */
  function activeRecipeParamOf(dcwId: string): RecipeParam | null {
    const node = dcw.nodeById(dcwId)
    if (!node || !node.lineId) return null
    const run = dcw.lineStateOf(node.lineId)
    if (!run.active || !run.recipeId) return null
    const r = dcw.recipes.find(x => x.id === run.recipeId)
    if (!r) return null
    return r.params.find(p => p.nodeId === dcwId) ?? null
  }

  const boundDcwRows = computed<DcwBoundRow[]>(() => {
    const id = selected.value?.id
    if (!id) return []
    return dcwOfDevice(id).map((n) => {
      const key = n.templateRef.startsWith('dcw-') ? n.templateRef.slice(4) : n.templateRef
      const tpl = dcw.templates.find(t => t.key === key)
      const rp = activeRecipeParamOf(n.id)
      return {
        dcwId: n.id,
        name: n.name,
        ch: tpl?.ch ?? key,
        unit: n.unit,
        icon: tpl?.icon ?? 'gateway',
        value: n.value,
        state: n.state,
        decimals: n.decimals,
        gMin: n.min,
        gMax: n.max,
        rMin: rp?.min ?? null,
        rMax: rp?.max ?? null,
      }
    })
  })

  /** 生效窗口:活动配方窗口优先,否则节点全局量程 */
  function dcwWindowOf(node: DcwNodeView): { lo: number, hi: number, src: 'recipe' | 'global' } {
    const rp = activeRecipeParamOf(node.id)
    if (rp && (rp.min != null || rp.max != null)) {
      return { lo: rp.min ?? Number.NEGATIVE_INFINITY, hi: rp.max ?? Number.POSITIVE_INFINITY, src: 'recipe' }
    }
    return { lo: node.min, hi: node.max, src: 'global' }
  }

  /** 窗口游标(0~100%):当前设定值在生效窗口带上的位置(越界钳边;∞ 窗口居中) */
  function dcwMarkPct(r: { value: number | null, rMin: number | null, rMax: number | null, gMin: number, gMax: number }): number {
    const lo = r.rMin ?? r.gMin
    const hi = r.rMax ?? r.gMax
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo || r.value == null) return 50
    return Math.min(100, Math.max(0, ((r.value - lo) / (hi - lo)) * 100))
  }

  const dcwWriteDrafts = reactive<Record<string, number | ''>>({})
  const dcwWriteErrs = reactive<Record<string, string>>({})

  function doDcwWrite(node: DcwNodeView): void {
    const raw = dcwWriteDrafts[node.id]
    if (raw == null || raw === '') return
    const w = dcwWindowOf(node)
    if (Number(raw) < w.lo || Number(raw) > w.hi) {
      dcwWriteErrs[node.id] = t('townView.kbuyve5198', { p0: w.src === 'recipe' ? t('townView.kb251ac190') : t('townView.k1iwj796179'), p1: Number.isFinite(w.lo) ? w.lo : '-∞', p2: Number.isFinite(w.hi) ? w.hi : '+∞' })
      return
    }
    dcwWriteErrs[node.id] = ''
    void dcw.write(node.id, Number(raw)).then((out) => {
      if (!out.ok) dcwWriteErrs[node.id] = out.message
    }).catch((err: unknown) => {
      dcwWriteErrs[node.id] = apiErrorMessage(err)
    })
  }

  /** 添加智控通道 —— 直接选择节点实例绑定(与数采同构;绑定后设备面板可 SET 直写) */
  const dcwTplById = (ref_: string) => {
    const key = ref_.startsWith('dcw-') ? ref_.slice(4) : ref_
    return dcwTemplates.find(t => t.id === key)
  }
  const dcwBindChoices = computed<Record<string, RailBindChoice[]>>(() => {
    const devId = selected.value?.kind === 'device' ? selected.value.id : ''
    const map: Record<string, RailBindChoice[]> = {}
    if (!devId) return map
    for (const n of dcw.nodes) {
      if (n.deviceBindingId === devId) continue
      const tpl = dcwTplById(n.templateRef)
      if (!tpl) continue
      ;(map[tpl.id] ??= []).push({
        id: n.id,
        name: n.name,
        tpl,
        devName: n.deviceBindingId ? deviceTwins.byId(n.deviceBindingId)?.name ?? null : null,
        placed: typeof n.posX === 'number',
      })
    }
    return map
  })
  const dcwBindChoiceCount = computed(() => Object.values(dcwBindChoices.value).reduce((s, a) => s + a.length, 0))
  function bindDcwChoice(nodeId: string): void {
    const devId = selected.value?.kind === 'device' ? selected.value.id : ''
    if (!devId) return
    void dcw.bindNode(nodeId, devId).catch((err: unknown) => {
      errorText.value = apiErrorMessage(err)
    })
    dcwBindPopOpen.value = false
  }

  function unbindDcw(dcwId: string): void {
    void dcw.bindNode(dcwId, null).catch((err: unknown) => {
      errorText.value = apiErrorMessage(err)
    })
  }

  /** 选中智控节点(检查器:绑定设备 + 设定值直写) */
  const selectedIsDcw = computed(() =>
    selected.value?.kind === 'device' && (sceneTwinById(selected.value?.id)?.modelRef ?? '').startsWith('dcw-'),
  )
  const selectedDcwNode = computed<DcwNodeView | null>(() => {
    const id = selected.value?.id
    return id ? dcw.nodeById(id) ?? null : null
  })
  const selectedDcwWindow = computed(() => {
    const n = selectedDcwNode.value
    return n ? dcwWindowOf(n) : null
  })
  const selectedDcwDeviceName = computed(() => {
    const n = selectedDcwNode.value
    if (!n?.deviceBindingId) return ''
    return deviceTwins.twins.find(t => t.id === n.deviceBindingId)?.name ?? n.deviceBindingId.slice(0, 8)
  })
  const dcwBindPick = ref('')
  function bindSelectedDcw(): void {
    const n = selectedDcwNode.value
    if (!n || !dcwBindPick.value) return
    void dcw.bindNode(n.id, dcwBindPick.value).catch((err: unknown) => {
      errorText.value = apiErrorMessage(err)
    })
    dcwBindPick.value = ''
  }
  function unbindSelectedDcw(): void {
    const n = selectedDcwNode.value
    if (!n) return
    void dcw.bindNode(n.id, null).catch((err: unknown) => {
      errorText.value = apiErrorMessage(err)
    })
  }
  function doWriteSelectedDcw(): void {
    const n = selectedDcwNode.value
    if (!n) return
    doDcwWrite(n)
  }
  function dcwWinLabel(n: DcwNodeView | null): string {
    if (!n) return '--'
    const w = dcwWindowOf(n)
    const lo = Number.isFinite(w.lo) ? w.lo : '-∞'
    const hi = Number.isFinite(w.hi) ? w.hi : '+∞'
    return `${lo} ~ ${hi} ${n.unit}`
  }
  function dcwWinInputPh(n: DcwNodeView | null): string {
    if (!n) return ''
    const w = dcwWindowOf(n)
    const lo = Number.isFinite(w.lo) ? w.lo : ''
    const hi = Number.isFinite(w.hi) ? w.hi : ''
    return `${lo} ~ ${hi}`
  }
  /** 选中数采节点的 live 视图(检查器单点控制用:启停/周期/阈值/解绑/删除) */
  const selectedDaqNode = computed<DaqNodeLive | null>(() => {
    const id = selected.value?.id
    return id ? daq.nodeById(id) ?? null : null
  })
  const daqIntervalDraft = ref<number | null>(null)
  watch(selectedDaqNode, (n) => {
    daqIntervalDraft.value = n ? (n.intervalMs ?? daq.controller.defaultIntervalMs) : null
  }, { immediate: true })
  function onDaqIntervalCommit(): void {
    const n = selectedDaqNode.value
    if (!n || daqIntervalDraft.value == null) return
    void daq.patchNode(n.id, { intervalMs: Math.max(120, Math.min(60_000, Math.round(daqIntervalDraft.value))) }).catch((err: unknown) => {
      errorText.value = apiErrorMessage(err)
    })
  }
  function onDaqThresholdCommit(key: 'min' | 'max' | 'warnLow' | 'warnHigh', raw: string): void {
    const v = Number(raw)
    if (!Number.isFinite(v)) return
    void daq.patchNode(selectedDaqNode.value!.id, { [key]: key.startsWith('warn') ? v : v }).catch((err: unknown) => {
      errorText.value = apiErrorMessage(err)
    })
  }

  return { boundDeviceOf, daqOfDevice, bindDaq, unbindDaq, nearestDeviceTwin, bindPopOpen, dcwBindPopOpen, bindPopMaxH, toggleBindPop, daqBindChoices, daqBindChoiceCount, bindDaqChoice, selectedIsDaq, daqOfSelected, selectedDaqSim, bindPick, boundDaqRows, daqBoundDeviceName, selectedIsDcw, selectedDcwNode, selectedDcwWindow, selectedDcwDeviceName, dcwBindPick, boundDcwRows, bindSelectedDcw, unbindSelectedDcw, doWriteSelectedDcw, dcwWinLabel, dcwWinInputPh, dcwWriteDrafts, dcwWriteErrs, doDcwWrite, dcwBindChoices, dcwBindChoiceCount, dcwMarkPct, bindDcwChoice, unbindDcw, selectedDaqNode, daqIntervalDraft, onDaqIntervalCommit, onDaqThresholdCommit, dcwWindowOf }
}
