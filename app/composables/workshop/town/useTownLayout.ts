/**
 * 小镇视图 — 布局/编辑模式/选中对象属性(含浮层面板拖拽与舞台引用)
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持):
 *   - 浏览/编辑模式、吸附、变换模式与 Blender 键位;
 *   - 选中对象(设备/角色)属性草稿、换模、删除;
 *   - 运行模式只读提示、布局保存、舞台引用与视角预设。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import type { useEntitiesStore } from '@/app/stores/workshop/entities'
import type { useHttp } from '@/app/composables/useHttp'
import type { useCharacterAssets } from '@/app/composables/workshop/useCharacterAssets'
import type { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'
import type { AgentRangeLayout, TownScene3D } from '@/app/components/workshop/town/TownScene3D'
import { useTownPanelDrag } from './useTownPanelDrag'

export function useTownLayout(params: {
  props: { channelId: string, allChannels?: boolean }
  entities: ReturnType<typeof useEntitiesStore>
  http: ReturnType<typeof useHttp>
  characterAssets: ReturnType<typeof useCharacterAssets>
  deviceTwins: ReturnType<typeof useDeviceTwins>
  scene3dRef: ShallowRef<TownScene3D | null>
  selected: Ref<{ kind: 'agent' | 'device', id: string, scale: number, rotation: number } | null>
  errorText: Ref<string>
  saveState: Ref<{ state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error', at: number } | null>
  onSelectChannel: (cid: string | null) => void
}) {
  const { props, entities, http, characterAssets, deviceTwins, scene3dRef, selected, errorText, saveState, onSelectChannel } = params
  const { t } = useI18n()

  // ---------- 编辑 / 浏览模式 + 布局保存 ----------
  const mode = ref<'browse' | 'edit'>('browse')
  const snap = ref(true)
  function toggleMode(): void {
    mode.value = mode.value === 'browse' ? 'edit' : 'browse'
    scene3dRef.value?.setMode(mode.value)
    if (mode.value === 'browse') {
      closeScale()
      onSelectChannel(null)
    }
    agentDrawingRange.value = false
  }
  /** 变换模式(Blender 键位):G 移动 / R 旋转 / S 缩放;选中设备时与场景手柄联动 */
  const tMode = ref<'translate' | 'rotate' | 'scale'>('translate')
  function setTMode(m: 'translate' | 'rotate' | 'scale'): void {
    tMode.value = m
    scene3dRef.value?.setTransformMode(m)
  }
  // 选中设备(编辑模式)→ 手柄按当前模式出现
  watch(() => [selected.value, mode.value] as const, ([sel, m]) => {
    if (m === 'edit' && sel?.kind === 'device') scene3dRef.value?.setTransformMode(tMode.value)
  })

  // Blender 键位:G/R/S 切换变换模式,Esc 取消选中(输入框聚焦时不劫持)
  function onTownKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    const k = e.key.toLowerCase()
    // Esc:取消选中(任何模式,设计稿 deselect)
    if (e.key === 'Escape') {
      closeScale()
      return
    }
    if (mode.value !== 'edit' || selected.value?.kind !== 'device') return
    if (k === 'g') setTMode('translate')
    else if (k === 'r') setTMode('rotate')
    else if (k === 's') setTMode('scale')
    else if (e.key === 'Delete' || e.key === 'Backspace') removeSelectedDevice()
  }
  function toggleSnap(): void {
    snap.value = !snap.value
    scene3dRef.value?.setSnap(snap.value)
  }
  /** Admin 布局:持久化角色落点(按 Agent 所属频道落库 —— 多频道小镇不能错发到页面主频道) */
  function updateAgentHome(agentId: string, channelId: string, x: number, z: number): Promise<unknown> {
    const cid = channelId || props.channelId
    if (!cid) return Promise.resolve()
    return http.request({
      method: 'PATCH',
      url: `/workshop/channels/${cid}/agents/${agentId}/position`,
      data: { x, z },
    }).catch(() => null)
  }
  /** Admin 布局:持久化角色独立活动范围(改 config.range;null 清除回退频道边界) */
  function updateAgentRange(agentId: string, channelId: string, range: AgentRangeLayout | null): Promise<unknown> {
    const cid = channelId || props.channelId
    if (!cid) return Promise.resolve()
    return http.request({
      method: 'PATCH',
      url: `/workshop/channels/${cid}/agents/${agentId}/range`,
      data: { range },
    }).catch(() => null)
  }
  /** 保存布局:强制全部设备 transform 落库 */
  function saveLayout(): void {
    if (mode.value !== 'edit') {
      runHint()
      return
    }
    scene3dRef.value?.persistAllDevices()
  }

  /** 缩放滑杆:实时 setModelScale + 松手 persistScale(设备同时落库) */
  function onScaleInput(v: number): void {
    if (!selected.value) return
    scene3dRef.value?.setModelScale(selected.value.id, v, selected.value.kind)
  }
  function onScaleCommit(v: number): void {
    if (!selected.value) return
    scene3dRef.value?.persistScale(selected.value.kind, selected.value.id)
    void v
  }
  function closeScale(): void {
    selected.value = null
  }
  // ---------- 场景对象属性管理(选中设备/角色) ----------
  /** 角色模型选项(character 3D .glb;只在成员/选中面板设置,不进设备模型库) */
  const agentModels = computed(() => characterAssets.models.filter(m => m.kind === 'glb'))
  /** 设备模型选项(仅设备模型;换模即时重挂 + 落库) */
  const deviceModels = computed(() => characterAssets.models.filter(m => m.kind === 'dev'))

  /** 选中对象名称草稿(设备可改名;角色只读显示) */
  const objNameDraft = ref('')
  /** 选中角色活动范围草稿(面板滑杆/形状实时 → setAgentRangeScene;提交 → 落库) */
  const agentRangeDraft = ref<{ radiusX: number, radiusZ: number, shape: 'ellipse' | 'rect' } | null>(null)
  /** 框选绘制中标记(面板按钮态;绘制完成/切换选中/退出编辑自动复位) */
  const agentDrawingRange = ref(false)
  watch(() => selected.value, (sel) => {
    objNameDraft.value = sel?.kind === 'device' ? (scene3dRef.value?.getDeviceName?.(sel.id) ?? '') : ''
    agentRangeDraft.value = null
    if (sel?.kind === 'agent') {
      const r = scene3dRef.value?.getAgentRange?.(sel.id)
      agentRangeDraft.value = r ? { radiusX: r.radiusX, radiusZ: r.radiusZ, shape: r.shape } : null
      // 绘制态以场景为准(startRangeDraw 会同步 setSelected,避免被本 watch 复位)
      agentDrawingRange.value = scene3dRef.value?.isRangeDrawing(sel.id) ?? false
    }
    else {
      agentDrawingRange.value = false
    }
  })
  /** 活动范围状态文本(对象面板展示) */
  const agentRangeStatusText = computed(() => {
    const sel = selected.value
    if (!sel || sel.kind !== 'agent') return ''
    const r = scene3dRef.value?.getAgentRange?.(sel.id)
    if (!r) return t('townView.k1v1icf6160')
    return `${r.shape === 'rect' ? t('townView.k43u0g050') : t('townView.k414bc049')} ${Math.round(r.radiusX)} × ${Math.round(r.radiusZ)}`
  })
  /** 框选绘制按钮:进入/退出绘制模式(编辑模式 + 选中角色) */
  function onToggleRangeDraw(): void {
    const sel = selected.value
    if (!sel || sel.kind !== 'agent') return
    if (agentDrawingRange.value) {
      scene3dRef.value?.cancelRangeDraw()
      agentDrawingRange.value = false
      return
    }
    scene3dRef.value?.startRangeDraw(sel.id)
    agentDrawingRange.value = true
  }
  /** 面板滑杆/形状:实时应用到场景(草稿态) */
  function applyAgentRangeDraft(): void {
    if (!selected.value || selected.value.kind !== 'agent' || !agentRangeDraft.value) return
    scene3dRef.value?.setAgentRangeScene(selected.value.id, agentRangeDraft.value)
    saveState.value = { state: 'dirty', at: Date.now() }
  }
  /** 面板提交:范围落库;home 若被迫位移一并落库 */
  function onAgentRangeCommit(): void {
    if (!selected.value || selected.value.kind !== 'agent') return
    scene3dRef.value?.commitAgentRange(selected.value.id)
  }
  /** 清除角色活动范围(回退频道边界;落库 null) */
  function onClearAgentRange(): void {
    const sel = selected.value
    if (!sel || sel.kind !== 'agent') return
    scene3dRef.value?.clearAgentRange(sel.id)
    agentRangeDraft.value = null
    agentDrawingRange.value = false
  }
  /** 设备改名提交(重建名牌 + PATCH 落库,广播后其他客户端同步) */
  function onObjNameCommit(): void {
    if (!selected.value || selected.value.kind !== 'device') return
    const id = selected.value.id
    const name = objNameDraft.value.trim()
    if (!name) return
    scene3dRef.value?.renameDevice(id, name)
    void deviceTwins.update(id, { name }).catch((err) => {
      errorText.value = apiErrorMessage(err)
    })
  }
  /** 角色独立换模型(选中角色 → character 模型下拉即时换装 + 持久化) */
  async function bindAgentModel(modelRef: string): Promise<void> {
    const sel = selected.value
    if (!sel || sel.kind !== 'agent') return
    const agentId = sel.id
    const cid = entities.agents
      ? Object.keys(entities.agents).find(c => (entities.agents[c] ?? []).some(a => a.agentId === agentId))
      : undefined
    if (!cid) {
      errorText.value = t('townView.kpplr16161')
      return
    }
    try {
      await characterAssets.bind(cid, agentId, modelRef)
      // 场景即时换装
      scene3dRef.value?.swapAgentModel(agentId, modelRef)
    }
    catch (err) {
      errorText.value = apiErrorMessage(err)
    }
  }
  /** 设备独立换模型(下拉选择设备模型 → 重挂 + 落库,广播后其他客户端同步) */
  async function bindDeviceModel(modelRef: string): Promise<void> {
    const sel = selected.value
    if (!sel || sel.kind !== 'device') return
    scene3dRef.value?.swapDeviceModel(sel.id, modelRef)
    try {
      await deviceTwins.update(sel.id, { modelRef })
    }
    catch (err) {
      errorText.value = apiErrorMessage(err)
    }
  }
  /** 删除选中设备实例(移除孪生 + 场景节点);两步确认:首击布防 3s,再击执行 */
  const deviceDeleteArmed = ref('')
  function removeSelectedDevice(): void {
    const sel = selected.value
    if (!sel || sel.kind !== 'device') return
    if (deviceDeleteArmed.value !== sel.id) {
      deviceDeleteArmed.value = sel.id
      window.setTimeout(() => {
        if (deviceDeleteArmed.value === sel.id) deviceDeleteArmed.value = ''
      }, 3000)
      return
    }
    deviceDeleteArmed.value = ''
    void scene3dRef.value?.removeDevice(sel.id)
      .then(() => closeScale())
      .catch((err: unknown) => {
        errorText.value = apiErrorMessage(err)
      })
  }
  /** 运行模式只读提示(2.6s 自动消退) */
  let runHintTimer: ReturnType<typeof setTimeout> | null = null
  function runHint(): void {
    errorText.value = t('townView.kt6xb5p162')
    if (runHintTimer) clearTimeout(runHintTimer)
    runHintTimer = setTimeout(() => {
      errorText.value = ''
    }, 2600)
  }
  /* ============================================================
   * 可拖动面板(对象属性卡/边界面板/员工会话台):
   * 抓取标题栏拖动,自由移动避免堆叠在底部;位置经 localStorage 记忆
   * ============================================================ */
  /* 浮层面板拖拽 / 位置记忆(自本文件抽出,细节见 composables/workshop/town/useTownPanelDrag.ts;
   * restorePanelPos 已随实现迁入该 composable 的 onMounted,模板只用 panelPos 与抓手事件) */
  const { panelPos, onPanelGripDown } = useTownPanelDrag()
  /** 舞台引用(全屏)与视角预设 */
  const stageRef = ref<HTMLElement | null>(null)
  const viewPreset = ref<'std' | 'top' | 'front' | 'side'>('std')
  function onViewPreset(e: Event): void {
    viewPreset.value = (e.target as HTMLSelectElement).value as 'std' | 'top' | 'front' | 'side'
    scene3dRef.value?.setViewPreset(viewPreset.value)
  }
  function fullscreenStage(): void {
    if (document.fullscreenElement) document.exitFullscreen()
    else stageRef.value?.requestFullscreen?.()
  }

  onMounted(() => window.addEventListener('keydown', onTownKey))
  onBeforeUnmount(() => window.removeEventListener('keydown', onTownKey))

  return { mode, snap, tMode, setTMode, toggleMode, toggleSnap, onTownKey, updateAgentHome, updateAgentRange, saveLayout, runHint, onScaleInput, onScaleCommit, closeScale, agentModels, deviceModels, objNameDraft, agentRangeDraft, agentDrawingRange, agentRangeStatusText, onToggleRangeDraw, applyAgentRangeDraft, onAgentRangeCommit, onClearAgentRange, onObjNameCommit, bindAgentModel, bindDeviceModel, deviceDeleteArmed, removeSelectedDevice, panelPos, onPanelGripDown, stageRef, viewPreset, onViewPreset, fullscreenStage }
}
