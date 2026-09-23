/**
 * 小镇视图 — 舞台标注层(悬浮数据卡 + 相机位姿 + 实时数采行)
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持):
 *   - 标注显隐/越近越亮阈值、锚点 150ms 跟随投影(画布外由 miniTick 回填);
 *   - 自动环绕、定位选中、点击标注选中其绑定设备;
 *   - 设备控制台实时数采行(daq/dcw → twinId)。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import type { ComputedRef, Ref, ShallowRef } from 'vue'
import { useStorage } from '@vueuse/core'
import type { useDcwStream, DcwNodeView } from '@/app/composables/workshop/useDcwStream'
import type { DeviceTwinView } from '@/app/composables/workshop/useDeviceTwins'
import type { TownScene3D } from '@/app/components/workshop/town/TownScene3D'
import type { DaqSimState, DcwLiveRow } from './town-view-types'

export function useTownCallouts(params: {
  selected: Ref<{ kind: 'agent' | 'device', id: string, scale: number, rotation: number } | null>
  objNameDraft: Ref<string>
  scene3dRef: ShallowRef<TownScene3D | null>
  stageRef: Ref<HTMLElement | null>
  dcw: ReturnType<typeof useDcwStream>
  daqTwins: ComputedRef<DeviceTwinView[]>
  daqSim: ComputedRef<Map<string, DaqSimState>>
  boundDeviceOf: (daqId: string) => string | null
  sceneTwinById: (id: string) => DeviceTwinView | undefined
  dcwWindowOf: (node: DcwNodeView) => { lo: number, hi: number, src: 'recipe' | 'global' }
  fmtDaq: (st: DaqSimState) => string
  alarmRange: (min: number, max: number) => { lo: number, hi: number }
  errorText: Ref<string>
}) {
  const { selected, objNameDraft, scene3dRef, stageRef, dcw, daqTwins, daqSim, boundDeviceOf, sceneTwinById, dcwWindowOf, fmtDaq, alarmRange, errorText } = params
  const { t } = useI18n()

  /** 标注显隐(设计稿 tPins,默认开) */
  const showCallouts = ref(true)

  /** 点击 callout → 选中其绑定设备(设计稿 co.onclick = select(dev)) */
  function selectDeviceFromCallout(daqId: string): void {
    const devId = boundDeviceOf(daqId) ?? daqId
    const t = sceneTwinById(devId)
    if (!t) return
    selected.value = { kind: 'device', id: devId, scale: selected.value?.scale ?? 1, rotation: selected.value?.rotation ?? 0 }
    objNameDraft.value = t.name
  }
  /** 自动环绕(设计稿 tOrbit) */
  const orbitOn = ref(false)
  function toggleOrbit(): void {
    orbitOn.value = !orbitOn.value
    scene3dRef.value?.setAutoOrbit(orbitOn.value)
  }

  /** 定位选中(设计稿 tLocate):镜头飞到选中实体并压低半径 */function locateSelected(): void {
    const s = scene3dRef.value
    const sel = selected.value
    if (!s) return
    if (!sel) {
      errorText.value = t('townView.k15tn2fh169')
      return
    }
    if (sel.kind === 'device') {
      const n = s.getDeviceNodes().find(x => x.twinId === sel.id)
      if (n) s.focusTo(n.x, n.z)
    }
    else {
      const a = s.getAgent(sel.id)
      if (a) s.focusTo(a.root.position.x, a.root.position.z)
    }
  }
  /** 悬浮标注(绑定设备的实时值;150ms 跟随投影) */
  const calloutPos = ref<Record<string, { x: number, y: number }>>({})
  /** 越近越亮:相机到锚点的 3D 距离阈值(世界单位;用户可在场景控制里调节)。
   *  只有所注视/飞近的设备亮起数据,邻机与远方节点保持静默 —— 数据属于走近的人。 */
  const calloutNearDist = useStorage('aw.twin.calloutNear', 1150)

  /** 设备控制台实时数采(twinId → 相关通道;数采自身 + 绑定设备双挂,随 server 读数流刷新) */
  const daqLive = computed(() => {
    const map: Record<string, Array<{ ch: string, value: string, unit: string, alarm?: boolean }>> = {}
    for (const t of daqTwins.value) {
      const st = daqSim.value.get(t.id)
      if (!st) continue
      const row = { ch: st.tpl.ch, value: fmtDaq(st), unit: st.tpl.unit, alarm: st.alarm ?? false }
      ;(map[t.id] ??= []).push(row)
      const dev = boundDeviceOf(t.id)
      if (dev) (map[dev] ??= []).push(row)
    }
    return map
  })
  const dcwLive = computed<Record<string, DcwLiveRow[]>>(() => {
    const map: Record<string, DcwLiveRow[]> = {}
    for (const n of dcw.nodes) {
      if (!n.deviceBindingId) continue
      const key = n.templateRef.startsWith('dcw-') ? n.templateRef.slice(4) : n.templateRef
      const tpl = dcw.templates.find(t => t.key === key)
      const w = dcwWindowOf(n)
      ;(map[n.deviceBindingId] ??= []).push({
        id: n.id,
        ch: tpl?.ch ?? key,
        name: n.name,
        unit: n.unit,
        value: n.value,
        readValue: n.readValue,
        lastReadAt: n.lastReadAt,
        decimals: n.decimals,
        lo: w.lo,
        hi: w.hi,
        src: w.src,
      })
    }
    return map
  })

  /** 同设备多路通道的竖排堆叠间距(px;卡高 ~88 + 间隙) */
  const CALLOUT_STACK = 104
  /** 相机位姿快照(150ms 刷新;callout 距离显隐的响应式来源) */
  const camPose = ref<{ pos: { x: number, y: number, z: number }, target: { x: number, z: number }, yaw: number, dolly: number }>({
    pos: { x: 0, y: 0, z: 0 }, target: { x: 0, z: 0 }, yaw: 0, dolly: 1,
  })
  const callouts = computed(() => {
    if (!showCallouts.value) return []
    const s3 = scene3dRef.value
    if (!s3) return []
    const nodes = s3.getDeviceNodes()
    const stageW = stageRef.value?.clientWidth ?? 1600
    interface Row { t: DeviceTwinView, st: DaqSimState, anchor: { twinId: string, name: string, x: number, z: number, topY?: number }, pos: { x: number, y: number } }
    const rows: Row[] = []
    for (const t of daqTwins.value) {
      const st = daqSim.value.get(t.id)
      if (!st) continue
      const boundDev = boundDeviceOf(t.id)
      const anchor = boundDev ? nodes.find(n => n.twinId === boundDev) : nodes.find(n => n.twinId === t.id)
      if (!anchor) continue
      const pos = calloutPos.value[t.id]
      if (!pos) continue
      rows.push({ t, st, anchor, pos })
    }
    const anchorTopY = new Map(rows.map(r => [r.anchor.twinId, r.anchor.topY]))
    // 按锚点分组:同设备多路通道 → 一列竖排(稳定按 daqId 排序,闪烁零抖动)
    const byAnchor = new Map<string, Row[]>()
    for (const r of rows) {
      const list = byAnchor.get(r.anchor.twinId) ?? []
      list.push(r)
      byAnchor.set(r.anchor.twinId, list)
    }
    const out: Array<{ id: string, x: number, y: number, label: string, value: string, unit: string, lo: number, hi: number, warn: boolean, near: boolean, leader: boolean }> = []
    for (const group of byAnchor.values()) {
      group.sort((a, b) => (a.t.id < b.t.id ? -1 : 1))
      const head = group[0]!
      const near = Math.hypot(
        camPose.value.pos.x - head.anchor.x,
        camPose.value.pos.y - (anchorTopY.get(head.anchor.twinId) ?? 60),
        camPose.value.pos.z - head.anchor.z,
      ) < calloutNearDist.value
      const cx = Math.min(stageW - 96, Math.max(96, head.pos.x))
      group.forEach((r, i) => {
        const { lo, hi } = alarmRange(r.st.tpl.min, r.st.tpl.max)
        out.push({
          id: r.t.id, x: cx, y: head.pos.y - i * CALLOUT_STACK,
          label: `${r.st.tpl.ch} · ${r.anchor.name || r.t.name}`,
          value: fmtDaq(r.st), unit: r.st.tpl.unit, lo, hi, warn: r.st.alarm ?? false,
          near, leader: i === 0,
        })
      })
    }
    return out
  })
  const calloutTimer: ReturnType<typeof setInterval> | null = null

  onBeforeUnmount(() => {
    if (calloutTimer) clearInterval(calloutTimer)
  })

  return { showCallouts, selectDeviceFromCallout, orbitOn, toggleOrbit, locateSelected, calloutPos, calloutNearDist, daqLive, dcwLive, camPose, callouts }
}
