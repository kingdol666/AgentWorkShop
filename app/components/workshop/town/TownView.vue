<script setup lang="ts">
/**
 * 小镇视图(AgentTeam RPG 可视化)— Vue 壳。
 *
 * 职责:挂载 Phaser(SSR 安全动态 import)、从 entities store 构建初始实体基线、
 * 订阅用TownBus(与时间线同源事件流)驱动场景、监听 channel.snapshot 重建、
 * HUD 覆盖层(加载态/连接态/当前说话者/统计)、E2E 钩子。
 */
import type Phaser from 'phaser'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useUserStore } from '@/app/stores/workshop/user'
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { useTownBus } from '@/app/composables/workshop/useTownBus'
import { useCharacterAssets } from '@/app/composables/workshop/useCharacterAssets'
import { useDeviceTwins, type DeviceTwinView } from '@/app/composables/workshop/useDeviceTwins'
import { useSceneLayouts } from '@/app/composables/workshop/useSceneLayouts'
import { useHttp } from '@/app/composables/useHttp'
import type { TownScene, TownEntityInput } from './TownScene'
import type { TownScene3D, ChannelLayout, AgentRangeLayout } from './TownScene3D'
// 频道身份色(与 3D 场景同源:同一 hashHue,UI 用 CSS 色)
import { channelColorCss } from '#shared/town-scene-math'
// 历史聊天:复用事件→气泡意图映射(与 3D 场景同源,确保历史/实时同一语义)
import { useStorage } from '@vueuse/core'
import { mapEnvelopeToIntent } from '#shared/town-protocol'
import type { AepEnvelope } from '#shared/workshop-protocol'
import { DAQ_TEMPLATES } from '#shared/daq-protocol'
import { useDaqStream, type DaqNodeLive } from '@/app/composables/workshop/useDaqStream'
import { useDcwStream } from '@/app/composables/workshop/useDcwStream'

/**
 * 两种渲染器(Phaser 2D / Three.js 3D)共享的最小公开接口。
 * TownView 无感切换:事件订阅/HUD/跑马灯/迷你地图/拖放换装只用这里的方法。
 */
export type TownViewScene
  = | TownScene
    | TownScene3D

const props = defineProps<{
  channelId: string
  /** 独立页 /town:是否汇聚全部挂载频道到同一小镇(默认 false=仅当前频道) */
  allChannels?: boolean
}>()
const entities = useEntitiesStore()
const wsStore = useWorkspacesStore()
const { conn } = useWorkshopWs()
const townBus = useTownBus()
const characterAssets = useCharacterAssets()
const deviceTwins = useDeviceTwins()
const sceneLayouts = useSceneLayouts()
const http = useHttp()

const hostRef = ref<HTMLDivElement | null>(null)
/** 当前渲染器(TownScene / TownScene3D 之一) */
const sceneRef = shallowRef<TownViewScene | null>(null)
const gameRef = shallowRef<Phaser.Game | null>(null)
/** 3D 场景实例(dispose 用) */
const scene3dRef = shallowRef<TownScene3D | null>(null)
/** 渲染模式:默认 3D,?render=2d 回退 Phaser */
const render3d = typeof window !== 'undefined' ? new URLSearchParams(location.search).get('render') !== '2d' : true

// ---------- HUD ----------
const ready = ref(false)
const fps = ref(0)
const agentCount = ref(0)
const blockCount = ref(0)
const activity = ref<{ channelId: string, agentName: string, text: string } | null>(null)
const selected = ref<{ kind: 'agent' | 'device', id: string, scale: number, rotation: number } | null>(null)
const errorText = ref('')
const syncing = computed(() => conn.state === 'connecting')
const activeChannelName = computed(() => entities.channels[props.channelId]?.name ?? '')

// ---------- 编辑 / 浏览模式 + 布局保存 ----------
const mode = ref<'browse' | 'edit'>('browse')
const snap = ref(true)
const saveState = ref<{ state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error', at: number } | null>(null)
const saveStateLabel = computed(() => {
  switch (saveState.value?.state) {
    case 'dirty': return '未保存'
    case 'saving': return '保存中…'
    case 'saved': return '已保存'
    case 'error': return '保存失败'
    default: return ''
  }
})
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

// ---------- 频道坞 + 频道边界编辑 ----------
/** 选中频道(边界编辑面板) */
const selectedChannel = ref<string | null>(null)
/** 边界编辑面板(拖拽中存草稿;确认后场景 applySceneLayouts + 落库) */
const boundaryDraft = ref<ChannelLayout | null>(null)
/** 点选频道回调(场景 pointerup pickChannel → selectChannel) */
function onSelectChannel(cid: string | null): void {
  selectedChannel.value = cid
  boundaryDraft.value = cid ? scene3dRef.value?.getChannelLayout(cid) ?? null : null
}
/** 落库频道布局(PUT);场景已异步 applySceneLayouts,此处仅持久化 */
async function saveChannelLayout(): Promise<void> {
  if (!selectedChannel.value || !boundaryDraft.value) return
  const l = boundaryDraft.value
  const payload = { x: l.x, z: l.z, radiusX: l.radiusX, radiusZ: l.radiusZ, shape: l.shape ?? 'ellipse', rotationY: l.rotationY ?? 0 }
  try {
    await sceneLayouts.save(selectedChannel.value, payload)
    saveState.value = { state: 'saved', at: Date.now() }
  }
  catch (err) {
    saveState.value = { state: 'error', at: Date.now() }
    errorText.value = err instanceof Error ? err.message : String(err)
  }
}
/** 从场景移除频道(其 Agent 一并撤出) */
async function removeChannelFromScene(): Promise<void> {
  if (!selectedChannel.value) return
  try {
    await sceneLayouts.remove(selectedChannel.value)
    scene3dRef.value?.removeChannel(selectedChannel.value)
    onSelectChannel(null)
  }
  catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
  }
}
/** 边界编辑输入 → 场景即时生效(草稿) */
function applyBoundaryDraft(): void {
  if (!selectedChannel.value || !boundaryDraft.value) return
  scene3dRef.value?.updateChannelLayout(selectedChannel.value, boundaryDraft.value)
  saveState.value = { state: 'dirty', at: Date.now() }
}
/** 频道坞:把某频道拖入场景(须拖拽放置;点击不自动落点)。 */
const dockHint = ref('')
function onDockCardClick(ch: { channelId: string, placed: boolean }): void {
  const s = scene3dRef.value
  if (!s) return
  if (ch.placed) {
    // 已放置:聚焦并打开频道管理面板
    s.focusChannel(ch.channelId)
    onSelectChannel(ch.channelId)
    return
  }
  dockHint.value = '请把频道卡片拖拽到场景中放置(松开即安放)'
  window.setTimeout(() => {
    dockHint.value = ''
  }, 2600)
}
/** 把频道放在指定世界坐标(拖拽落点;相同频道只能放置一个,已放置则聚焦) */
function dropChannelAt(channelId: string, x: number, z: number): boolean {
  const s = scene3dRef.value
  if (!s) return false
  const seed = buildTownInput().find(c => c.channelId === channelId)
  const name = seed?.channelName ?? entities.channels[channelId]?.name ?? channelId.slice(0, 8)
  const agentCount = seed?.agents.length ?? (entities.agents[channelId]?.length ?? 0)
  const existing = s.getChannelLayout(channelId)
  if (existing) {
    // 已放置 → 聚焦到现有位置,不重复落点
    dockHint.value = `「${name}」已在场景中(相同频道只能放置一个)`
    window.setTimeout(() => {
      dockHint.value = ''
    }, 2600)
    s.focusChannel(channelId)
    onSelectChannel(channelId)
    return false
  }
  s.dropChannelOnWorld(x, z, channelId, name, agentCount)
  // 新放置:立即落库(刷新后恢复),并聚焦
  void sceneLayouts.save(channelId, {
    x, z,
    radiusX: Math.max(120, 110 + agentCount * 18),
    radiusZ: Math.max(80, 70 + agentCount * 14),
    shape: 'ellipse',
    rotationY: 0,
  })
    .then(() => { saveState.value = { state: 'saved', at: Date.now() } })
    .catch(() => { saveState.value = { state: 'error', at: Date.now() } })
  s.focusChannel(channelId)
  return true
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
  if (!r) return '未设置 · 沿用频道边界'
  return `${r.shape === 'rect' ? '矩形' : '椭圆'} ${Math.round(r.radiusX)} × ${Math.round(r.radiusZ)}`
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
    errorText.value = err instanceof Error ? err.message : String(err)
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
    errorText.value = '找不到所属频道,无法绑定模型'
    return
  }
  try {
    await characterAssets.bind(cid, agentId, modelRef)
    // 场景即时换装
    scene3dRef.value?.swapAgentModel(agentId, modelRef)
  }
  catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
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
    errorText.value = err instanceof Error ? err.message : String(err)
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
      errorText.value = err instanceof Error ? err.message : String(err)
    })
}

// ---------- 频道成员角色模型管理(在频道管理实例中设置) ----------
const channelPanelTab = ref<'boundary' | 'members'>('boundary')
/** 选中频道成员(供成员 tab 为每个成员设置 character 模型) */
const channelMembers = computed(() => {
  if (!selectedChannel.value) return []
  return buildTownInput().find(c => c.channelId === selectedChannel.value)?.agents ?? []
})
/** 成员换装:绑定模型 + 场景即时换装(角色模型只在频道管理中设置) */
async function bindMemberModel(agentId: string, modelRef: string): Promise<void> {
  if (!selectedChannel.value) return
  try {
    await characterAssets.bind(selectedChannel.value, agentId, modelRef)
    scene3dRef.value?.swapAgentModel(agentId, modelRef)
  }
  catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
  }
}
/** 频道管理面板 tab 切换 */
function openChannelTab(tab: 'boundary' | 'members'): void {
  channelPanelTab.value = tab
}

// ---------- 频道坞数据 ----------
/** 场景放置/移除版本戳(blockCount 事件时自增;驱动 dockChannels 对 hasChannel 的响应式重算) */
const dockRev = ref(0)
/** 频道坞列表(所有挂载频道;已放置/未放置标记) */
const dockChannels = computed(() => {
  void dockRev.value
  const cids = allMountedChannelIds()
  return cids.map((cid) => {
    const ch = entities.channels[cid]
    return {
      channelId: cid,
      name: ch?.name ?? cid.slice(0, 8),
      agentCount: (entities.agents[cid] ?? []).length,
      placed: scene3dRef.value?.hasChannel(cid) ?? false,
      color: hashColor(cid),
    }
  })
})
function allMountedChannelIds(): string[] {
  const ids: string[] = []
  for (const ws of wsWorkspaces() ?? []) {
    for (const cid of ws.channelIds ?? []) {
      if (!ids.includes(cid)) ids.push(cid)
    }
  }
  if (!ids.includes(props.channelId)) ids.push(props.channelId)
  return ids
}
/** workspaces store(频道坞列举所有已挂载频道) */
function wsWorkspaces(): Array<{ channelIds?: string[] }> {
  return wsStore.workspaces as Array<{ channelIds?: string[] }>
}
/** 稳定频道色(与场景 channelColorNum 同源:同一 hashHue,UI 用 CSS 色) */
function hashColor(id: string): string {
  return channelColorCss(id)
}
/** 频道坞拖起:写入 channelId 供场景 drop 放置 */
function onChannelDragStart(e: DragEvent, channelId: string): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('application/x-aw-channel', channelId)
  e.dataTransfer.setData('text/plain', channelId)
  e.dataTransfer.effectAllowed = 'copy'
}

/** 从 entities store 构建小镇实体基线(当前 workspace 挂载的 channel) */
function buildTownInput(): TownEntityInput[] {
  const out: TownEntityInput[] = []
  for (const [cid, ch] of Object.entries(entities.channels)) {
    const agents = (entities.agents[cid] ?? []).map((a) => {
      // 当前任务标题/进度:优先取 entities.tasks 里匹配 currentTaskId 的任务
      const curTask = a.currentTaskId
        ? (entities.tasks[cid] ?? []).find(t => t.id === a.currentTaskId)
        : undefined
      return {
        agentId: a.agentId,
        name: a.name,
        role: a.role,
        harness: a.harness,
        state: a.state,
        currentTaskId: a.currentTaskId ?? null,
        currentTaskTitle: curTask?.title ?? null,
        currentTaskProgress: a.currentTaskProgress ?? curTask?.progress ?? null,
        modelRef: a.modelRef ?? null,
        // 管理员布局落点(来自 config.homeX/homeZ;缺省 = 领地环形排布)
        homeX: (a.config as { homeX?: number } | undefined)?.homeX ?? null,
        homeZ: (a.config as { homeZ?: number } | undefined)?.homeZ ?? null,
        // 管理员布局活动范围(来自 config.range;缺省 = 沿用频道边界)
        range: (a.config as { range?: AgentRangeLayout | null } | undefined)?.range ?? null,
      }
    })
    out.push({ channelId: cid, channelName: ch.name, agents })
  }
  return out
}

function syncSceneModels(scene: TownViewScene | null): void {
  if (!scene || !('registerModelsFromList' in scene)) return
  if ('screenToWorld' in scene) {
    scene.registerModelsFromList(characterAssets.models.map(m => ({ id: m.id, file: m.file, name: m.name, kind: m.kind, hFactor: m.hFactor ?? 1 })))
  }
  else {
    scene.registerModelsFromList(characterAssets.models.map(m => ({ id: m.id, file: m.file, name: m.name })))
  }
}

// 签名对比替代 deep 监听:模型资产任何字段变化都曾触发全量 syncSceneModels;
// 实际只有增删/换文件才需要同步(id+file 签名)
watch(() => characterAssets.models.map(m => `${m.id}:${m.file}`).join('|'), () => syncSceneModels(sceneRef.value))

async function boot() {
  if (sceneRef.value || !hostRef.value) return
  if (render3d) {
    await boot3D()
  }
  else {
    await boot2D()
  }
}

/** 3D 引导(默认):Three.js TownScene3D */
async function boot3D(): Promise<void> {
  const host = hostRef.value
  if (!host) return
  // 布局加载不阻塞场景 ready:先建空场地,布局异步到达后 apply + rebuild。
  // 若加载失败(401/网络),keep catch 静默 → 场景保持空场地,用户手动拖入频道。
  const [{ TownScene3D: Scene3D }] = await Promise.all([import('./TownScene3D')])
  const scene = new Scene3D(buildTownInput(), host as HTMLDivElement)
  scene.resolveTaskAssignee = (taskId: string) => {
    const task = (entities.tasks as Record<string, Array<{ id: string, assigneeId: string }>>)[props.channelId]?.find(t => t.id === taskId)
    return task?.assigneeId ?? null
  }
  // 注入数字孪生设备 API(拖 dev 模型进场景时创建设备;场景 transform 变更落库)
  scene.devices = {
    async create(input) {
      const t = await deviceTwins.create({
        name: input.name,
        modelRef: input.modelRef,
        kind: input.kind,
        controls: input.controls,
        posX: input.posX,
        posZ: input.posZ,
        scale: input.scale,
      })
      return { id: t.id }
    },
    async update(id, patch) {
      // 数采节点伪孪生 → 场景落点走 daq REST(节点实体在 server)
      if (daq.nodeById(id)) {
        await daq.saveTransform(id, patch.posX, patch.posZ)
        return undefined
      }
      await deviceTwins.update(id, patch)
      return undefined
    },
    async remove(id) {
      if (daq.nodeById(id)) {
        await daq.removeNode(id)
        return
      }
      await deviceTwins.remove(id)
    },
    async control(id, command, args) {
      return deviceTwins.control(id, command, args)
    },
  }
  // 注入管理员布局:持久化角色落点 + 独立活动范围
  scene.agentApi = {
    async updateHome(agentId, channelId, x, z) {
      return updateAgentHome(agentId, channelId, x, z)
    },
    async updateRange(agentId, channelId, range) {
      return updateAgentRange(agentId, channelId, range)
    },
  }
  // 注入频道布局持久化:频道整体拖拽 / 边界手柄调整后经 useSceneLayouts 落库
  scene.channelApi = {
    async save(channelId, layout) {
      return sceneLayouts.save(channelId, layout)
    },
  }
  sceneRef.value = scene
  syncSceneModels(scene)
  scene3dRef.value = scene

  wireCommon(scene)

  // 选中(3D 专用):点选 Agent/设备 → 弹缩放/旋转滑杆
  scene.on('select', (v) => {
    selected.value = v
  })
  // 保存状态(布局落库进度 → HUD 徽标)
  scene.on('saveState', (v) => {
    saveState.value = v
  })
  // 点选频道 → 打开边界编辑面板
  scene.on('selectChannel', (cid) => {
    onSelectChannel(cid)
  })
  // 频道被拖拽/手柄调整 → 边界面板草稿即时跟随(避免保存时回退旧值)
  scene.on('channelResized', (e) => {
    if (!e) return
    if (selectedChannel.value === e.channelId) boundaryDraft.value = e.layout
  })
  // Agent 活动范围被框选绘制/整框移动/手柄调整/清除 → 对象面板草稿即时跟随
  scene.on('agentRangeChanged', (e) => {
    if (!e) return
    if (selected.value?.kind === 'agent' && selected.value.id === e.agentId) {
      const r = scene3dRef.value?.getAgentRange?.(e.agentId)
      agentRangeDraft.value = r ? { radiusX: r.radiusX, radiusZ: r.radiusZ, shape: r.shape } : null
    }
  })

  // 3D 立即可交互(canvas 同步挂载)
  ready.value = true
  bindSceneInput(scene)
  // 轮询设备遥测 → 驱动 3D 设备节点状态/颜色
  devicePollTimer = bindDevicePoll(scene)

  // 布局异步加载:到达后按数据库元数据统一实例化并初始化场景内全部实例
  // (频道布局 + 实体基线 + 设备孪生 → hydrate;仅放置的频道呈现)。
  // 健壮性:composable 内部已 3 次退避重试;此处再兜底 —— 失败浮出错误并定时重拉,
  // rev-watch 会在数据到达后自动收敛重建,任何时序下频道都不会"消失"。
  void sceneLayouts.load().then(() => {
    scene.hydrate(buildTownInput(), Object.values(sceneLayouts.layouts), sceneTwinPool.value)
    syncChannelDock()
  }).catch((err) => {
    errorText.value = `频道布局加载失败,自动重试中(${err instanceof Error ? err.message : String(err)})`
    window.setTimeout(() => {
      void sceneLayouts.load()
    }, 2500)
  })
}

/** 2D 引导(?render=2d):Phaser TownScene */
async function boot2D(): Promise<void> {
  const host = hostRef.value
  if (!host) return
  const [Phaser, { TownScene: Scene }] = await Promise.all([
    import('phaser'),
    import('./TownScene'),
  ])
  const scene = new Scene(buildTownInput())
  sceneRef.value = scene
  syncSceneModels(scene)
  scene.resolveTaskAssignee = (taskId: string) => {
    const task = (entities.tasks as Record<string, Array<{ id: string, assigneeId: string }>>)[props.channelId]?.find(t => t.id === taskId)
    return task?.assigneeId ?? null
  }
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: host.id || 'town-host',
    width: 1100,
    height: 700,
    backgroundColor: '#eceae4',
    pixelArt: true,
    antialias: false,
    roundPixels: true,
    powerPreference: 'high-performance',
    physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } },
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    scene,
  })
  gameRef.value = game

  wireCommon(scene)

  // 场景 ready 后 canvas 才挂载 → 再绑交互
  scene.on('ready', () => {
    ready.value = true
    bindSceneInput(scene)
  })
}

/**
 * 两种渲染器在 wireCommon 里共用的最小接口(不含 on;on 的事件签名两场景不同,
 * wireCommon 内部用场景实例类型收紧)。
 */
export type CommonTownScene = TownScene | TownScene3D

/** 两种渲染器共享:事件订阅 + HUD 事件 + E2E 钩子 */
function wireCommon(scene: CommonTownScene): void {
  // 事件订阅:两场景的 on 签名不同,这里用场景实例类型 + 具体事件名调用
  const s = scene as TownScene3D
  s.on('fps', (v: number) => {
    fps.value = v
  })
  s.on('agentCount', (v: number) => {
    agentCount.value = v
  })
  s.on('blockCount', (v: number) => {
    blockCount.value = v
    dockRev.value++
  })
  s.on('lastActivity', (v) => {
    activity.value = v
  })

  // 事件总线 → 场景(channel.snapshot 重建;其它实时事件驱动)
  const off = townBus.subscribe((e) => {
    try {
      if (e.type === 'channel.snapshot') {
        scene.rebuild(buildTownInput())
        // rebuild 内部 resetAll 清掉全部设备/数采节点,必须立即按全量池恢复
        if (sceneRef.value) syncSceneDevices(sceneRef.value)
        if (props.channelId) scene.focusChannel(props.channelId)
        return
      }
      // 设备场景事件:updated(含遥测直推,1s 节流)走增量合并;
      // created 走全量重拉(新孪生需完整字段);deleted 本地移除
      if (e.type === 'device.updated') {
        deviceTwins.applyRemote((e.payload as unknown as DeviceTwinView))
        if (sceneRef.value) syncSceneDevices(sceneRef.value)
        return
      }
      if (e.type === 'device.created') {
        void deviceTwins.load().then(() => {
          if (sceneRef.value) syncSceneDevices(sceneRef.value)
        })
        return
      }
      if (e.type === 'device.deleted') {
        deviceTwins.removeRemote((e.payload as { id: string }).id)
        if (sceneRef.value) syncSceneDevices(sceneRef.value)
        return
      }
      // 频道布局事件(他人编辑边界/移入移除):重拉布局 → 场景即时收敛
      if (e.type === 'scene.layout.saved' || e.type === 'scene.layout.removed') {
        void sceneLayouts.load().then(() => {
          syncSceneLayouts(sceneRef.value)
          syncChannelDock()
        })
        return
      }
      // 会话台实时缓冲:气泡意图 → 所属角色的近实时消息(与头顶气泡同语义;
      // 独立于事件日志 30 条上限,选中角色的消息不会被其他角色刷屏挤掉)
      const bub = mapEnvelopeToIntent(e)?.bubble
      if (bub?.agentId) appendLiveChat(bub.agentId, bub.kind, bub.text, e.at, e.seq)
      scene.handleTownEvent(e)
    }
    catch (err) {
      errorText.value = err instanceof Error ? err.message : String(err)
    }
  })
  ;(sceneRef as unknown as { _off?: () => void })._off = off

  // E2E 调试钩子
  if (import.meta.client) {
    ;(window as unknown as Record<string, unknown>).__town = {
      get scene() { return sceneRef.value },
      get game() { return gameRef.value },
      buildInput: buildTownInput,
      get characterAssets() { return characterAssets },
    }
  }
}

/**
 * 自由视角相机 + HTML5 模型拖放。
 * - 相机:按住左键拖拽平移(避开点选角色),滚轮缩放;
 * - 拖放:AssetLibrary 的模型卡 dragstart 写入 assetId,落到场景 → 换装/生成。
 * 由场景 ready 事件调用(canvas 已挂载)。
 */
function bindSceneInput(scene: TownViewScene): void {
  if ('screenToWorld' in scene) {
    bindSceneInput3D(scene)
    return
  }
  bindSceneInput2D(scene)
}

/** window 级监听器清理登记(卸载统一移除;匿名 window 监听器持已销毁场景 = 悬空引用) */
const windowCleanups: Array<() => void> = []

/** 2D(Phaser):用 game.canvas + cam.worldView 反解世界坐标 */
function bindSceneInput2D(scene: Exclude<TownViewScene, TownScene3D>): void {
  const canvas = scene.game.canvas
  if (!canvas) return

  // 世界坐标 ← 页面坐标反解(经 camera worldView + canvas DOM 缩放)
  const worldFromPage = (clientX: number, clientY: number): { x: number, y: number } => {
    const cam = scene.cameras.main
    const rect = canvas.getBoundingClientRect()
    const vx = (clientX - rect.left) / rect.width
    const vy = (clientY - rect.top) / rect.height
    const wx = cam.worldView.x + vx * cam.worldView.width
    const wy = cam.worldView.y + vy * cam.worldView.height
    return { x: wx, y: wy }
  }

  // ---- 相机拖拽平移(页面像素 → 世界像素 = 页面px / zoom 缩放比) ----
  let draggingCam = false
  let lastCX = 0
  let lastCY = 0
  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return
    draggingCam = true
    lastCX = e.clientX
    lastCY = e.clientY
  })
  const onCamPointerMove = (e: PointerEvent): void => {
    if (!draggingCam) return
    const cam = scene.cameras.main
    const rect = canvas.getBoundingClientRect()
    // 页面 px → 世界 px:乘以 (canvas 世界宽 / canvas 页面宽) 再除以 zoom
    const scale = scene.game.scale.width / rect.width
    const dx = (e.clientX - lastCX) * scale / cam.zoom
    const dy = (e.clientY - lastCY) * scale / cam.zoom
    cam.scrollX -= dx
    cam.scrollY -= dy
    lastCX = e.clientX
    lastCY = e.clientY
  }
  const onCamPointerUp = (): void => {
    draggingCam = false
  }
  window.addEventListener('pointermove', onCamPointerMove)
  window.addEventListener('pointerup', onCamPointerUp)
  windowCleanups.push(() => window.removeEventListener('pointermove', onCamPointerMove))
  windowCleanups.push(() => window.removeEventListener('pointerup', onCamPointerUp))

  // ---- 滚轮缩放 ----
  canvas.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault()
    const cam = scene.cameras.main
    const nz = cam.zoom + (e.deltaY < 0 ? 0.08 : -0.08)
    cam.setZoom(Math.min(2.4, Math.max(0.6, nz)))
  }, { passive: false })

  // ---- 模型拖放(AssetLibrary.card → scene canvas) ----
  canvas.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'copy'
  })
  canvas.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault()
    const assetId = e.dataTransfer?.getData('application/x-aw-model') || e.dataTransfer?.getData('text/plain')
    if (!assetId) return
    const world = worldFromPage(e.clientX, e.clientY)
    const res = scene.dropModelOnWorld(world.x, world.y, assetId)
    lastDrop.value = res
  })
}

/** 运行模式只读提示(2.6s 自动消退) */
let runHintTimer: ReturnType<typeof setTimeout> | null = null
function runHint(): void {
  errorText.value = '运行模式为只读 · 切换「编辑」后可修改场景'
  if (runHintTimer) clearTimeout(runHintTimer)
  runHintTimer = setTimeout(() => {
    errorText.value = ''
  }, 2600)
}

/** 3D(Three.js):相机交互 1:1 设计稿 OrbitLite ——
 *  左键拖拽=环绕 / 中键·右键·Shift+左键=平移 / 滚轮=dolly(乘性);
 *  实体/领地/手柄拖拽优先,双击实体=flyTo 聚焦(场景内部已实现)。 */
function bindSceneInput3D(scene: TownScene3D): void {
  const canvas = scene.canvas
  if (!canvas) return

  let camMode = 0 // 0 无 / 1 环绕 / 2 平移
  let lastCX = 0
  let lastCY = 0
  canvas.addEventListener('contextmenu', e => e.preventDefault())
  canvas.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button === 1) e.preventDefault()
  })
  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    // 变换手柄悬停/拖拽 → 让出(手柄优先)
    if (scene.isGizmoBusy?.()) return
    const panGesture = e.button === 1 || e.button === 2 || e.shiftKey
    if (panGesture) {
      e.preventDefault()
      camMode = 2
      lastCX = e.clientX
      lastCY = e.clientY
      return
    }
    if (e.button !== 0) return
    // 编辑模式:实体/领地/范围/边界等场景拖拽接管;未接管(空白处)→ 左键环绕
    if (scene.tryStartPointerDrag(e.clientX, e.clientY)) return
    camMode = 1
    lastCX = e.clientX
    lastCY = e.clientY
  })
  const onScenePointerMove = (e: PointerEvent): void => {
    if (scene.isGizmoBusy?.()) return
    if (scene.isPointerDragging()) {
      scene.movePointerDrag(e.clientX, e.clientY)
      return
    }
    if (!camMode) return
    const dx = e.clientX - lastCX
    const dy = e.clientY - lastCY
    lastCX = e.clientX
    lastCY = e.clientY
    if (camMode === 1) scene.orbitBy(dx, dy)
    else scene.panByScreen(dx, dy)
  }
  const onScenePointerUp = (): void => {
    if (scene.isPointerDragging()) {
      scene.endPointerDrag()
      return
    }
    camMode = 0
  }
  window.addEventListener('pointermove', onScenePointerMove)
  window.addEventListener('pointerup', onScenePointerUp)
  windowCleanups.push(() => window.removeEventListener('pointermove', onScenePointerMove))
  windowCleanups.push(() => window.removeEventListener('pointerup', onScenePointerUp))

  // ---- 滚轮 dolly(设计稿:乘性缩放,任意层级手感一致) ----
  canvas.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault()
    scene.zoomBy(e.deltaY > 0 ? 0.12 : -0.11)
  }, { passive: false })

  // ---- 拖放(频道坞→安放频道;模型库→换装/生成居民) ----
  canvas.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'copy'
  })
  canvas.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault()
    const dt = e.dataTransfer
    if (!dt) return
    // 运行模式只读:不接受任何场景投放(频道/数采/设备)
    if (mode.value !== 'edit') {
      runHint()
      return
    }
    // 1) 频道坞拖入 → 安放频道 + 其 Agent
    const channelId = dt.getData('application/x-aw-channel') || dt.getData('text/plain')
    if (channelId && dockChannels.value.some(c => c.channelId === channelId)) {
      const world = scene.screenToWorld(e.clientX, e.clientY)
      dropChannelAt(channelId, world.x, world.z)
      return
    }
    // 1.5) 数采节点拖入 → 创建 server DaqNode(权威实体;WS 广播收敛全端)
    //      落点 ±95 单位内存在设备 → 自动绑定(设计稿:数采靠近设备自动接通道)
    const daqTplId = dt.getData('application/x-aw-daq')
    if (daqTplId) {
      const tpl = daqTemplates.find(t => t.id === daqTplId)
      if (tpl) {
        const world = scene.screenToWorld(e.clientX, e.clientY)
        const seq = daq.nodes.filter(x => x.templateRef === `daq-${tpl.id}`).length + 1
        void daq.createFromTemplate(`daq-${tpl.id}`, {
          name: `${tpl.name} ${String(seq).padStart(2, '0')}`,
          posX: Math.round(world.x),
          posZ: Math.round(world.z),
        }).then((created) => {
          const near = nearestDeviceTwin(world.x, world.z, 95)
          if (near) bindDaq(created.id, near.id)
        }).catch((err: unknown) => {
          errorText.value = err instanceof Error ? err.message : String(err)
        })
      }
      // 1.6) 智控节点拖入 → 创建 server DcwNode(写控制;落点 ±95 内设备自动绑定)
      const dcwTplId = dt.getData('application/x-aw-dcw')
      if (dcwTplId) {
        onDcwDrop(e, scene)
        return
      }
      return
    }
    // 2) 模型拖放 → 换装/生成
    const assetId = dt.getData('application/x-aw-model') || dt.getData('text/plain')
    if (assetId) {
      const world = scene.screenToWorld(e.clientX, e.clientY)
      const res = scene.dropModelOnWorld(world.x, world.z, assetId)
      lastDrop.value = res
    }
  })
}

/** 用全量设备池收敛场景节点(真设备孪生 + 全部 DAQ 节点投影;按节点 id 对账)。
 *  必须传 sceneTwinPool 而非 deviceTwins.twins —— syncDevices 会移除不在清单内的
 *  本地节点,漏掉 daq 投影时设备事件每次到达都会把场景中的数采节点误删。 */
function syncSceneDevices(scene: TownViewScene): void {
  if ('syncDevices' in scene) {
    ;(scene as TownScene3D).syncDevices(sceneTwinPool.value)
  }
}

// 布局数据版本 → 幂等收敛:load 晚到/save/remove/他人编辑后,场景一律重建对齐
// (hydrates 是 resetAll+rebuild,幂等;这是"每次进场都能从数据库实例化"的最终保证)
watch(() => sceneLayouts.rev, (rev) => {
  const scene = scene3dRef.value
  if (!scene || !sceneLayouts.loaded || rev === 0) return
  // 设备输入必须是全量池(含 DAQ 投影):hydrate→syncDevices 按清单对账,漏 daq 会清场
  scene.hydrate(buildTownInput(), Object.values(sceneLayouts.layouts), sceneTwinPool.value)
  syncChannelDock()
})

/** 用频道布局清单收敛场景(已放置频道存在性/边界;供 WS 事件后即时同步) */
function syncSceneLayouts(scene: TownViewScene | null): void {
  if (!scene || !('applySceneLayouts' in scene)) return
  const s = scene as TownScene3D
  // 先应用全部布局到场景(新增/变更/移除),再 rebuild 实体基线(仅放置的频道呈现)
  s.applySceneLayouts(Object.values(sceneLayouts.layouts))
  s.rebuild(buildTownInput())
}

/** 频道坞已放置/未放置标记刷新(布局变化后) */
function syncChannelDock(): void {
  void sceneLayouts.load().finally(() => {
    // 由场景 hasChannel 反映;以下依赖已完成加载
  })
}

/** 设备控制台行点击 → 场景镜头聚焦该实体并选中(工业 HMI 联动手感) */
function onFocusDevice(t: { id: string, posX?: number, posZ?: number }): void {
  const s = scene3dRef.value
  if (!s) return
  if (typeof t.posX === 'number' && typeof t.posZ === 'number') s.focusTo(t.posX, t.posZ)
  ;(s as unknown as { setSelected?: (x: { kind: 'device', id: string }) => void }).setSelected?.({ kind: 'device', id: t.id })
}

/* ============================================================
 * 可拖动面板(对象属性卡/边界面板/员工会话台):
 * 抓取标题栏拖动,自由移动避免堆叠在底部;位置经 localStorage 记忆
 * ============================================================ */
const panelPos = reactive<Record<string, { x: number, y: number }>>({})
const PANEL_POS_KEY = 'aw-town-panel-pos'
function restorePanelPos(): void {
  if (typeof localStorage === 'undefined') return
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_POS_KEY) || '{}') as Record<string, { x: number, y: number }>
    for (const k of Object.keys(saved)) {
      if (saved[k] && Number.isFinite(saved[k].x)) panelPos[k] = saved[k]
    }
  }
  catch { /* 损坏的存档忽略 */ }
}
function savePanelPos(): void {
  try {
    localStorage.setItem(PANEL_POS_KEY, JSON.stringify(panelPos))
  }
  catch { /* 隐私模式等忽略 */ }
}
let dragToken: { frame: HTMLElement, panel: HTMLElement, offX: number, offY: number } | null = null

/** 抓取面板标题栏开始拖动(pointerdown) */
function onPanelGripDown(e: PointerEvent, key: string): void {
  const grip = e.currentTarget as HTMLElement
  const panel = grip.closest<HTMLElement>('.drag-panel')
  const frame = grip.closest<HTMLElement>('.town-frame')
  if (!panel || !frame) return
  e.preventDefault()
  const rect = panel.getBoundingClientRect()
  const fr = frame.getBoundingClientRect()
  // 由「底部居中」布局切换为显式定位(之后完全随拖动)
  panel.style.left = `${rect.left - fr.left}px`
  panel.style.top = `${rect.top - fr.top}px`
  panel.style.bottom = 'auto'
  panel.style.transform = 'none'
  panelPos[key] = { x: rect.left - fr.left, y: rect.top - fr.top }
  dragToken = {
    frame,
    panel,
    offX: e.clientX - rect.left,
    offY: e.clientY - rect.top,
  }
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'grabbing'
  const onMove = (ev: PointerEvent): void => {
    const tk = dragToken
    if (!tk) return
    const fr2 = tk.frame.getBoundingClientRect()
    const x = ev.clientX - tk.offX - fr2.left
    const y = ev.clientY - tk.offY - fr2.top
    const pw = tk.panel.offsetWidth
    const nx = Math.max(-pw + 90, Math.min(x, fr2.width - 30))
    const ny = Math.max(4, Math.min(y, fr2.height - 34))
    tk.panel.style.left = `${nx}px`
    tk.panel.style.top = `${ny}px`
    panelPos[key] = { x: nx, y: ny }
  }
  const onUp = (): void => {
    dragToken = null
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    savePanelPos()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
restorePanelPos()

/* ============================================================
 * 小地图(设计稿 drawMinimap):全域固定比例导航图 + 相机锥/准星。
 * 画布重绘在 miniTimer(150ms);拖拽 = panWorldBy,滚轮 = dolly。
 * ============================================================ */
/** 领地块(2D 场景无形状数据 → 回退圆) */
interface MiniBlock { x: number, y: number, color: number, name: string, shape?: 'ellipse' | 'rect', rx?: number, rz?: number, rot?: number }
interface MiniState {
  world: { w: number, h: number }
  blocks: MiniBlock[]
  agents: Array<{ x: number, y: number, color: number, busy: boolean }>
  devices: Array<{ x: number, y: number, color: number, state: string, twinId?: string, daq?: boolean, bound?: boolean }>
  player: { x: number, y: number }
}
const WORLD_W3D = 3200
const WORLD_H3D = 2400
const minimap = shallowRef<MiniState | null>(null)
const toHex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`

const lastDrop = shallowRef<{ mode: string, agentId?: string, textureKey: string, x: number, y: number } | null>(null)

/** 模型落点反馈(供 HUD 显示) */
const lastDropText = computed(() => {
  const d = lastDrop.value
  if (!d) return ''
  return d.mode === 'rebind'
    ? `已为 ${d.agentId?.slice(0, 8) ?? '角色'} 换装 → ${d.textureKey}`
    : `已在落点放入居民 → ${d.textureKey}`
})

/** 员工会话台:选中角色时展示其「本人」消息(实时缓冲直采,按 agentId 精确归属;重名不串扰) */
const agentChatRows = computed<ChatEntry[]>(() => {
  const sel = selected.value
  if (!sel || sel.kind !== 'agent') return []
  const rows = liveChatBuf.get(sel.id)
  if (!rows || rows.length === 0) return []
  // 只展示历史尾部之后的实时行(REST 回填的历史已包含更早内容,按时间分界去重)
  const lastHistAt = agentHistory.value.length
    ? agentHistory.value[agentHistory.value.length - 1]?.at ?? 0
    : 0
  return rows.filter(r => r.at > lastHistAt)
})
const agentChatTitle = computed(() => {
  if (!selected.value || selected.value.kind !== 'agent') return ''
  return scene3dRef.value?.getAgentName?.(selected.value.id) ?? '员工'
})
/** 选中角色的实体元数据(状态/harness/角色;驱动会话台头部状态章) */
const selectedAgentMeta = computed(() => {
  const sel = selected.value
  if (!sel || sel.kind !== 'agent') return null
  for (const list of Object.values(entities.agents)) {
    const a = (list ?? []).find(x => x.agentId === sel.id)
    if (a) return a
  }
  return null
})
/** 选中角色的职务名(卡片标题/身份章):Leader / Worker —— 以职务取代人称,贴近 Agent Harness 习惯 */
const selectedAgentRoleLabel = computed(() =>
  selectedAgentMeta.value?.role === 'lead' ? 'Leader' : 'Worker',
)
const selectedAgentRoleTag = computed(() =>
  selectedAgentMeta.value?.role === 'lead' ? 'LEADER' : 'WORKER',
)
const agentChatStateLabel = computed(() => {
  const st = selectedAgentMeta.value?.state
  if (st === 'busy') return '工作中'
  if (st === 'stopped') return '已停止'
  return '待命'
})

/* ============================================================
 * Agent 会话台消息流(实时 + 历史统一):
 *  - 实时:towmBus 气泡意图直采进 per-agent 缓冲(独立于 30 条上限的
 *    事件日志,其他角色刷屏不会挤掉本角色的行);
 *  - 历史:REST 频道事件回放,经同一 mapEnvelopeToIntent 还原(与头顶
 *    气泡同语义),带 TTL 缓存 + 手动刷新;
 *  - 合并:历史尾部时间戳之后追加实时行,时间分界天然去重。
 * ============================================================ */
interface ChatEntry {
  id: string
  agentId: string
  text: string
  kind: string
  at: number
  live: boolean
}
const agentHistory = ref<ChatEntry[]>([])
const historyLoading = ref(false)
/** 历史缓存(30s TTL;重选同角色短时间内免拉) */
const historyCache = new Map<string, { rows: ChatEntry[], at: number }>()
const HISTORY_TTL_MS = 30_000
const chatScroll = ref<HTMLElement | null>(null)
/** 实时消息缓冲(agentId → 近实时条目;响应式 Map,computed 直接追踪) */
const liveChatBuf = reactive(new Map<string, ChatEntry[]>())
const LIVE_CAP = 80

/** townBus 气泡意图 → 该角色实时缓冲(wireCommon 订阅内调用;与头顶气泡同语义) */
function appendLiveChat(agentId: string, kind: string, text: string, atRaw: number | string | undefined, seq?: number): void {
  const at = typeof atRaw === 'number' ? atRaw : (atRaw ? Date.parse(String(atRaw)) : Date.now())
  if (!Number.isFinite(at) || at <= 0) return
  let rows = liveChatBuf.get(agentId)
  if (!rows) {
    rows = []
    liveChatBuf.set(agentId, rows)
  }
  // 相邻同文本抖动去重(WS 重连重放窗口)
  const last = rows[rows.length - 1]
  if (last && last.text === text && Math.abs(at - last.at) < 1500) return
  rows.push({ id: `live-${seq ?? at}-${rows.length}`, agentId, text, kind, at, live: true })
  if (rows.length > LIVE_CAP) rows.splice(0, rows.length - LIVE_CAP)
}

function cookieToken(): string {
  if (typeof document === 'undefined') return ''
  return (document.cookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1] ?? '')
}
function channelOfAgent(agentId: string): string | undefined {
  for (const cid of Object.keys(entities.agents)) {
    if ((entities.agents[cid] ?? []).some(a => a.agentId === agentId)) return cid
  }
  return undefined
}

/** 拉取并缓存该角色的历史对话(按 at 升序;force 跳过 TTL 缓存) */
async function loadAgentHistory(agentId: string, channelId: string, force = false): Promise<void> {
  const cached = historyCache.get(agentId)
  if (!force && cached && Date.now() - cached.at < HISTORY_TTL_MS) {
    agentHistory.value = cached.rows
    return
  }
  historyLoading.value = true
  try {
    const tok = cookieToken()
    const q = `/api/workshop/channels/${channelId}/events?limit=500&excludeTypes=agent.delta`
    const res = await fetch(q, { headers: tok ? { authorization: `Bearer ${decodeURIComponent(tok)}` } : {} })
    const json = await res.json().catch(() => null)
    // 接口返回 { data: { channelId, total, maxSeq, items } }(旧代码误把 data 当数组迭代,历史一直为空)
    const events: AepEnvelope[] = json?.data?.items ?? (Array.isArray(json?.data) ? json.data : [])
    const rows: ChatEntry[] = []
    for (const e of events) {
      const b = mapEnvelopeToIntent(e)?.bubble
      if (!b || b.agentId !== agentId) continue
      const atRaw = e.at
      const at = typeof atRaw === 'number' ? atRaw : (atRaw ? Date.parse(String(atRaw)) : 0)
      rows.push({ id: `${String(e.seq ?? rows.length)}-${rows.length}`, agentId: b.agentId, text: b.text, kind: b.kind, at, live: false })
    }
    rows.sort((a, b) => a.at - b.at)
    historyCache.set(agentId, { rows, at: Date.now() })
    agentHistory.value = rows
  }
  catch {
    agentHistory.value = []
  }
  finally {
    historyLoading.value = false
  }
}

/** 手动刷新历史(会话台头部 ↻ 按钮) */
function onRefreshHistory(): void {
  const sel = selected.value
  if (!sel || sel.kind !== 'agent') return
  const cid = channelOfAgent(sel.id)
  if (cid) void loadAgentHistory(sel.id, cid, true)
}

// 切换选中角色:重新加载其历史对话
watch(() => selected.value, (sel) => {
  if (!sel || sel.kind !== 'agent') {
    agentHistory.value = []
    return
  }
  const cid = channelOfAgent(sel.id)
  if (cid) void loadAgentHistory(sel.id, cid)
  else agentHistory.value = []
}, { immediate: true })

/** 选中角色的身份色(频道哈希,与场景环同源) */
const agentChatColor = computed(() => {
  const sel = selected.value
  if (!sel || sel.kind !== 'agent') return '#35e0a0'
  const cid = channelOfAgent(sel.id)
  return cid ? (channelColorCss(cid) ?? '#35e0a0') : '#35e0a0'
})

/** 对话类型标签(工业 HMI 小印章) */
function chatKindLabel(kind: string): string {
  switch (kind) {
    case 'artifact': return '交付'
    case 'delta': return '……'
    case 'info': return '系统'
    case 'error': return '异常'
    default: return ''
  }
}

/** 时间戳(HH:MM:SS;空值占位) */
function fmtTime(at?: number): string {
  if (!at || !Number.isFinite(at) || at <= 0) return '--:--:--'
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

// 新消息自动滚到底部(历史或实时条数变化)
watch(() => agentHistory.value.length + agentChatRows.value.length, async () => {
  await nextTick()
  const el = chatScroll.value
  if (el) el.scrollTop = el.scrollHeight
})

/** 场景管线统一设备池:真实设备孪生(剔除旧 daq 孪生)+ server 数采节点伪孪生 */
/** 智控节点伪孪生投影(与 daqTwins 同构;value = 当前设定值) */
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
    updatedAt: n.lastWriteAt ?? n.createdAt,
  })))

const sceneTwinPool = computed<DeviceTwinView[]>(() => [
  ...deviceTwins.twins.filter(t => !isLegacyDaqTwin(t)),
  ...daqTwins.value,
  ...dcwTwins.value,
])
const sceneTwinById = (id: string): DeviceTwinView | undefined =>
  sceneTwinPool.value.find(t => t.id === id)

/** 轮询设备孪生 → 场景节点同步 + 状态环颜色(设备节点由 dev 模型拖入/服务端恢复生成) */
function bindDevicePoll(scene: TownScene3D): ReturnType<typeof setInterval> {
  // 5s 兜底轮询:遥测/状态主通道是 WS device.updated 直推(server 1s 节流),
  // 轮询仅覆盖断线窗口(useDeviceTwins.load 已 in-flight 去重)
  return setInterval(() => {
    void deviceTwins.load().then(() => {
      if (sceneRef.value !== scene) return
      scene.syncDevices(sceneTwinPool.value)
      for (const node of scene.getDeviceNodes()) {
        const twin = sceneTwinById(node.twinId)
        if (twin) scene.updateDeviceNode(node.twinId, twin.state, twin.telemetry)
      }
    })
  }, 5000)
}

/** 事件流:最近事件队列(at 供右轨"实时事件"面板;2D 场景无 at → 占位) */
const ticker = shallowRef<Array<{ channelId: string, agentName: string, text: string, at?: number }>>([])

/* ============================================================
 * 数采节点 · DAQ(server 数据驱动):节点实体/采集循环/告警派生全部在服务端
 * (DaqNode class + DaqController,WS daq.reading 实时下发)。前端只做:
 * 模板目录渲染(shared 单一事实源)→ 拖入创建 REST 节点 → 绑定设备 → 展示。
 * 有多少 server Node,场景就有多少数采节点。
 * ============================================================ */
/** 数采流单例:REST 快照 + townBus WS 帧(reading/node.changed/controller) */
const daq = useDaqStream()
/** 智控流单例(写控制;与数采对称:模板目录/节点/场景/绑定) */
const dcw = useDcwStream()
/** 智控模板目录(server 权威;与 daqTemplates 同构投影) */
const dcwTemplates = reactive(dcw.templates.map(t => ({
  id: t.key,
  name: t.name,
  code: t.code,
  ch: t.ch,
  unit: t.unit,
  min: t.min,
  max: t.max,
  decimals: t.decimals,
  icon: t.icon,
})))
watch(() => dcw.templates, (list) => {
  if (!list?.length) return
  dcwTemplates.splice(0, dcwTemplates.length, ...list.map(t => ({
    id: t.key,
    name: t.name,
    code: t.code,
    ch: t.ch,
    unit: t.unit,
    min: t.min,
    max: t.max,
    decimals: t.decimals,
    icon: t.icon,
  })))
}, { immediate: true, deep: true })
function onDcwDragStart(e: DragEvent, tpl: { id: string }): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('application/x-aw-dcw', tpl.id)
  e.dataTransfer.setData('text/plain', tpl.id)
  e.dataTransfer.effectAllowed = 'copy'
}
/** 智控节点拖入:创建 server DcwNode + 落点 ±95 内设备自动绑定 */
function onDcwDrop(e: DragEvent, scene: TownScene3D): void {
  const tplId = e.dataTransfer?.getData('application/x-aw-dcw')
  if (!tplId || !dcwTemplates.some(t => t.id === tplId)) return
  const world = scene.screenToWorld(e.clientX, e.clientY)
  void dcw.createFromTemplate(`dcw-${tplId}`, {
    posX: Math.round(world.x),
    posZ: Math.round(world.z),
  }).then((created) => {
    const near = nearestDeviceTwin(world.x, world.z, 95)
    if (near) void dcw.bindNode(created.id, near.id)
    if (sceneRef.value) syncSceneDevices(sceneRef.value)
  }).catch((err: unknown) => {
    errorText.value = err instanceof Error ? err.message : String(err)
  })
}
/** 左轨模板目录(server 权威:内置 + 自定义随 REST/WS 收敛;字段名兼容既有轨道模板标记) */
interface DaqTemplate {
  id: string
  name: string
  code: string
  /** 通道语义(如 熔体压力/膜张力;bind-row 与 callout 主标题) */
  ch: string
  unit: string
  base: number
  amp: number
  min: number
  max: number
  decimals: number
  /** 图标(设计稿 ICONS 键) */
  icon: string
}
const daqTemplates = reactive<DaqTemplate[]>(DAQ_TEMPLATES.map(t => ({
  id: t.key,
  name: t.name,
  code: t.code,
  ch: t.ch,
  unit: t.unit,
  base: t.base,
  amp: t.amp,
  min: t.min,
  max: t.max,
  decimals: t.decimals,
  icon: t.icon,
})))
watch(() => daq.templates, (list) => {
  if (!list?.length) return
  daqTemplates.splice(0, daqTemplates.length, ...list.map(t => ({
    id: t.key,
    name: t.name,
    code: t.code,
    ch: t.ch,
    unit: t.unit,
    base: t.base,
    amp: t.amp,
    min: t.min,
    max: t.max,
    decimals: t.decimals,
    icon: t.icon,
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
    updatedAt: n.lastAt ?? n.createdAt,
  })))

/**
 * 兼容视图:旧 UI 全部消费 DaqSimState(value/hist/tpl/alarm),保留同形结构,
 * 数据源换成 server 读数流(daq.reading → node.hist 由 useDaqStream 填充)。
 */
interface DaqSimState { value: number, hist: number[], phase: number, tpl: DaqTemplate, alarm?: boolean }
const daqSim = computed<Map<string, DaqSimState>>(() => {
  const m = new Map<string, DaqSimState>()
  for (const n of daq.nodes) {
    const tpl = daqTplOf(n)
    if (!tpl || n.value == null) continue
    m.set(n.id, { value: n.value, hist: n.hist, phase: 0, tpl, alarm: n.state === 'alarm' })
  }
  return m
})
const fmtDaq = (st: DaqSimState): string => st.value.toFixed(st.tpl.decimals)

/** 告警推进(server 派生 state 变化 → 场景告警面板;恢复自动消警语义保持) */
const prevDaqState = new Map<string, string>()
watch(() => daq.nodes.map(n => `${n.id}:${n.state}`).join('|'), () => {
  for (const n of daq.nodes) {
    const prev = prevDaqState.get(n.id)
    prevDaqState.set(n.id, n.state)
    if (!prev || prev === n.state) continue
    const tpl = daqTplOf(n)
    const dev = n.deviceBindingId ? deviceTwins.byId(n.deviceBindingId)?.name : null
    const label = dev ?? n.name
    const val = `${n.value?.toFixed(tpl?.decimals ?? 2) ?? '--'} ${tpl?.unit ?? ''}`
    if (n.state === 'alarm') raiseAlarm(`${label} ${tpl?.ch ?? ''}越限量程(${val})`, 'crit', n.name)
    else if (n.state === 'warn') raiseAlarm(`${label} ${tpl?.ch ?? ''}进入预警带(${val})`, 'warn', n.name)
    else if (prev !== 'ok' && n.state === 'ok') raiseAlarm(`${label} ${tpl?.ch ?? ''}恢复正常`, 'info', n.name)
  }
})

function onDaqDragStart(e: DragEvent, tpl: DaqTemplate): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('application/x-aw-daq', tpl.id)
  e.dataTransfer.setData('text/plain', tpl.id)
  e.dataTransfer.effectAllowed = 'copy'
}

/** 数采 → 设备绑定(server 权威:node.deviceBindingId;REST bind 落库 + WS 收敛) */
const boundDeviceOf = (daqId: string): string | null => daq.nodeById(daqId)?.deviceBindingId ?? null
const daqOfDevice = (deviceId: string): string[] =>
  deviceId ? daq.nodes.filter(n => n.deviceBindingId === deviceId).map(n => n.id) : []
function bindDaq(daqId: string, deviceId: string): void {
  void daq.bindNode(daqId, deviceId).catch((err: unknown) => {
    errorText.value = err instanceof Error ? err.message : String(err)
  })
}
function unbindDaq(daqId: string): void {
  void daq.bindNode(daqId, null).catch((err: unknown) => {
    errorText.value = err instanceof Error ? err.message : String(err)
  })
}

/** 数采模板图标(设计稿 ICONS;SVG path 直嵌) */
const DAQ_ICONS: Record<string, string> = {
  thermo: '<path d="M10 4a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0V4Z"/><circle cx="12" cy="16.5" r="1.6"/>',
  pressure: '<circle cx="12" cy="12" r="8"/><path d="m12 12 3.5-3.5"/><circle cx="12" cy="12" r="1.2"/>',
  tension: '<circle cx="12" cy="10" r="4"/><path d="M4 18.5h16M8 18.5V14M16 18.5V14"/><path d="M2.5 10H8M16 10h5.5"/>',
  encoder: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M12 4v3M12 17v3M4 12h3M17 12h3"/>',
  camera: '<rect x="3" y="7" width="13" height="10" rx="2"/><path d="m16 11 5-3v8l-5-3"/><circle cx="8" cy="12" r="2.5"/>',
  gateway: '<rect x="8" y="11" width="8" height="10" rx="1.5"/><circle cx="12" cy="5.5" r="1.5"/><path d="M12 10V7M8.5 8.5a5 5 0 0 1 7 0M6 6a8.5 8.5 0 0 1 12 0"/>',
}
const daqIcon = (icon: string): string => DAQ_ICONS[icon] ?? DAQ_ICONS.gateway!

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

/** bind-pop:添加数采通道(设计稿逻辑 —— 就近复用未绑定同类节点,无则创建并绑定) */
const bindPopOpen = ref(false)
async function addChannelFromTemplate(tpl: DaqTemplate): Promise<void> {
  const devId = selected.value?.id
  if (!devId || selected.value?.kind !== 'device') return
  const devTwin = deviceTwins.twins.find(t => t.id === devId)
  const unbound = daq.nodes
    .filter(n => n.templateRef === `daq-${tpl.id}` && !n.deviceBindingId && typeof n.posX === 'number')
    .map(n => ({ n, d: Math.hypot((n.posX ?? 0) - (devTwin?.posX ?? 0), (n.posZ ?? 0) - (devTwin?.posZ ?? 0)) }))
    .sort((a, b) => a.d - b.d)[0]
  if (unbound && unbound.d < 420) {
    bindDaq(unbound.n.id, devId)
    bindPopOpen.value = false
    return
  }
  try {
    const seq = daq.nodes.filter(x => x.templateRef === `daq-${tpl.id}`).length + 1
    const off = daqOfDevice(devId).length
    await daq.createFromTemplate(`daq-${tpl.id}`, {
      name: `${tpl.name} ${String(seq).padStart(2, '0')}`,
      posX: Math.round((devTwin?.posX ?? 0) + 95 + (off % 3) * 26),
      posZ: Math.round((devTwin?.posZ ?? 0) + 100 + (off % 2) * 30),
    }).then((created) => {
      void daq.bindNode(created.id, devId)
    })
    bindPopOpen.value = false
  }
  catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
  }
}

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
    const t = sceneTwinById(daqId)
    const st = daqSim.value.get(daqId)
    const tpl = st?.tpl ?? daqTplById(t?.modelRef ?? '')
    return {
      daqId,
      name: t?.name ?? daqId,
      ch: tpl?.ch ?? '数据通道',
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
    errorText.value = err instanceof Error ? err.message : String(err)
  })
}
function onDaqThresholdCommit(key: 'min' | 'max' | 'warnLow' | 'warnHigh', raw: string): void {
  const v = Number(raw)
  if (!Number.isFinite(v)) return
  void daq.patchNode(selectedDaqNode.value!.id, { [key]: key.startsWith('warn') ? v : v }).catch((err: unknown) => {
    errorText.value = err instanceof Error ? err.message : String(err)
  })
}

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
    errorText.value = '请先在场景中选中一台设备'
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
let calloutTimer: ReturnType<typeof setInterval> | null = null

/** KPI 条(舞台底部居中浮条) */
const deviceCount = computed(() => deviceTwins.twins.length)
const runningCount = computed(() => deviceTwins.twins.filter(t => t.state === 'running').length)

/** 顶栏用户 */
const userStore = useUserStore()
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

/** 设备健康度(环形图数据) */
const idleCount = computed(() => deviceTwins.twins.filter(t => t.state === 'idle').length)
const alarmCount = computed(() => deviceTwins.twins.filter(t => t.state === 'alarm').length)
const offlineCount = computed(() => deviceTwins.twins.filter(t => t.state === 'offline').length)
const healthPct = computed(() => {
  const total = deviceTwins.twins.length
  if (!total) return 100
  const healthy = runningCount.value + idleCount.value
  return Math.round((healthy / total) * 100)
})
const donutCanvas = ref<HTMLCanvasElement | null>(null)
function drawDonut(): void {
  const cv = donutCanvas.value
  if (!cv) return
  const ctx = cv.getContext('2d')
  if (!ctx) return
  const total = deviceTwins.twins.length || 1
  const segs: Array<{ n: number, color: string }> = [
    { n: runningCount.value, color: '#35e0a0' },
    { n: idleCount.value, color: '#f6c453' },
    { n: alarmCount.value, color: '#ff6b6b' },
    { n: offlineCount.value, color: '#3a4a63' },
  ]
  ctx.clearRect(0, 0, 118, 118)
  ctx.lineWidth = 12
  let ang = -Math.PI / 2
  for (const seg of segs) {
    if (!seg.n) continue
    const sweep = (seg.n / total) * Math.PI * 2
    ctx.beginPath()
    ctx.strokeStyle = seg.color
    ctx.arc(59, 59, 48, ang, ang + sweep)
    ctx.stroke()
    ang += sweep
  }
}
watch(healthPct, () => drawDonut())
watch(() => deviceTwins.twins.length, () => drawDonut())
onMounted(() => drawDonut())

/* ============================================================
 * 告警系统(设计稿:阈值越限自动告警 + 状态流转 待处理→处理中→已确认)
 * ============================================================ */
interface AlarmItem { id: number, txt: string, src: string, time: string, state: 0 | 1 | 2, level: 'warn' | 'crit' | 'info' }
const alarms = ref<AlarmItem[]>([])
let alarmTid = 0
const ALARM_STATES = ['待处理', '处理中', '已确认'] as const
function raiseAlarm(txt: string, level: AlarmItem['level'] = 'warn', src = 'SYSTEM'): void {
  const d = new Date()
  const time = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
  alarms.value.unshift({ id: ++alarmTid, txt, src, time, state: 0, level })
  if (alarms.value.length > 30) alarms.value.pop()
}
const activeAlarmCount = computed(() => alarms.value.filter(a => a.state < 2).length)
function advanceAlarm(id: number): void {
  const a = alarms.value.find(x => x.id === id)
  if (!a) return
  a.state = Math.min(2, a.state + 1) as AlarmItem['state']
}
function clearAlarms(): void {
  alarms.value = alarms.value.map(a => ({ ...a, state: 2 as const }))
}

/** 告警阈值(设计稿 rThresh 60~120%;>100 收紧,<100 放宽) */
const threshPct = ref(100)
/** 量程收紧后的告警上下界(设计稿公式:base ± 按阈值比例的内缩区间) */
function alarmRange(min: number, max: number): { lo: number, hi: number } {
  const t = threshPct.value / 100
  const mid = (min + max) / 2
  return { lo: mid - (mid - min) * t, hi: mid + (max - mid) * t }
}

/** E-STOP(设计稿 btnEstop:全线停机态;告警面板置 crit;再次点击解除) */
const estop = ref(false)
function toggleEstop(): void {
  estop.value = !estop.value
  raiseAlarm(
    estop.value ? '紧急停止(E-STOP)已触发，产线全线停机' : '紧急停止已解除，产线恢复运行',
    estop.value ? 'crit' : 'info',
    'SYSTEM',
  )
}

/** 场景控制:曝光/领地染色/重置视角 */
const exposure = ref(1.12)
const tintOpacity = ref(1)
/** 滑杆填充比例(--fill;轨道随值染色,设计稿 setSliderFill) */
function sliderPct(v: number, min: number, max: number): string {
  return `${Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100)).toFixed(1)}%`
}
function onExposureInput(e: Event): void {
  exposure.value = Number((e.target as HTMLInputElement).value) / 100
  scene3dRef.value?.setExposure(exposure.value)
}
function onTintInput(e: Event): void {
  tintOpacity.value = Number((e.target as HTMLInputElement).value) / 100
  scene3dRef.value?.setTerritoryOpacity(tintOpacity.value)
}
function onResetView(): void {
  scene3dRef.value?.resetView()
  exposure.value = 1.12
  tintOpacity.value = 1
  scene3dRef.value?.setExposure(1.12)
  scene3dRef.value?.setTerritoryOpacity(1)
}
function toggleTrend(id: string): void {
  hiddenTrends.value = { ...hiddenTrends.value, [id]: !hiddenTrends.value[id] }
}

/** 趋势图(数采历史;画布在 dock 趋势卡) */
const trendCanvas = ref<HTMLCanvasElement | null>(null)
const hiddenTrends = ref<Record<string, boolean>>({})
const TREND_COLORS = ['#35e0a0', '#41c8f4', '#f6c453', '#a78bfa', '#ff6b6b', '#4dd0e1']
const trendColor = (id: string): string => TREND_COLORS[Math.abs(id.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % TREND_COLORS.length] ?? '#35e0a0'
function drawTrend(): void {
  const cv = trendCanvas.value
  if (!cv) return
  const dpr = Math.min(window.devicePixelRatio, 2)
  const w = cv.clientWidth
  const h = cv.clientHeight
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr
    cv.height = h * dpr
  }
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  // 网格
  ctx.strokeStyle = 'rgba(29, 42, 66, 0.6)'
  ctx.lineWidth = 1
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
  }
  for (const t of daqTwins.value) {
    if (hiddenTrends.value[t.id]) continue
    const st = daqSim.value.get(t.id)
    if (!st || st.hist.length < 2) continue
    const lo = st.tpl.min
    const hi = st.tpl.max
    ctx.strokeStyle = trendColor(t.id)
    ctx.lineWidth = 1.6
    ctx.beginPath()
    st.hist.forEach((v, i) => {
      const x = (i / (120 - 1)) * w
      const y = h - ((v - lo) / (hi - lo)) * (h - 8) - 4
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }
}
/** 迷你地图/设备孪生轮询定时器(卸载时清理;小地图 150ms 保证镜头居中滑动跟手) */
let miniTimer: ReturnType<typeof setInterval> | null = null
let tickerTimer: ReturnType<typeof setInterval> | null = null
let devicePollTimer: ReturnType<typeof setInterval> | null = null
let daqTimer: ReturnType<typeof setInterval> | null = null

/* ============================================================
 * 3D 导航地图(RPG 规范):相机注视点钉死图心,世界内容随镜头移动在图下滑动。
 * 缩放与 3D 视角同源:窗口宽 = NAV_BASE_WIN × dolly(滚轮/+- 直接调 3D dolly,
 * 小地图与视角永远同步);窗外实体以边缘信标(clamped blip)呈现,全域可见。
 * 拖拽 = 平移镜头;点击 = 聚焦该点。
 * ============================================================ */
const navCanvas = ref<HTMLCanvasElement | null>(null)
const NAV_BASE_WIN = 1600
/** 地图窗口缩放随 3D dolly(夹在 0.4~5;dolly 再深地图不再放大) */
const navScale = computed(() => Math.min(5, Math.max(0.4, camPose.value.dolly)))
let navDrag: { lx: number, ly: number, moved: boolean } | null = null
/** 投影:镜头注视点 = 图心;返回 比例尺(s) 与 画布尺寸。 */
function navProj(cv: HTMLCanvasElement): { s: number, w: number, h: number } {
  const w = cv.clientWidth || 220
  const h = cv.clientHeight || 148
  const winW = NAV_BASE_WIN * navScale.value
  return { s: w / winW, w, h }
}
function drawNavMap(): void {
  const cv = navCanvas.value
  const mm = minimap.value
  const s3 = scene3dRef.value
  if (!cv) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const P = navProj(cv)
  if (cv.width !== Math.round(P.w * dpr) || cv.height !== Math.round(P.h * dpr)) {
    cv.width = Math.round(P.w * dpr)
    cv.height = Math.round(P.h * dpr)
  }
  const x = cv.getContext('2d')
  if (!x) return
  x.setTransform(dpr, 0, 0, dpr, 0, 0)
  x.fillStyle = '#060b13'
  x.fillRect(0, 0, P.w, P.h)
  // 相机注视点(RPG 的"你在这里")= 图心;投影:世界 → 画布
  const pose = s3?.getCameraPose()
  const cx = pose ? pose.target.x : WORLD_W3D / 2
  const cz = pose ? pose.target.z : WORLD_H3D / 2
  const halfW = P.w / 2 / P.s
  const halfH = P.h / 2 / P.s
  const toPx = (wx: number, wz: number): { x: number, y: number } => ({
    x: P.w / 2 + (wx - cx) * P.s,
    y: P.h / 2 + (wz - cz) * P.s,
  })
  const inWin = (wx: number, wz: number, pad = 60): boolean =>
    wx > cx - halfW - pad && wx < cx + halfW + pad && wz > cz - halfH - pad && wz < cz + halfH + pad
  // 网格点阵(仅窗口内;固定世界步长,内容随镜头滑动)
  x.fillStyle = 'rgba(65,200,244,.10)'
  const step = 250
  for (let gx = Math.floor((cx - halfW) / step) * step; gx <= cx + halfW; gx += step) {
    for (let gz = Math.floor((cz - halfH) / step) * step; gz <= cz + halfH; gz += step) {
      const p = toPx(gx, gz)
      x.fillRect(p.x - 1, p.y - 1, 1.6, 1.6)
    }
  }
  // 世界边界(绿框;越界即出画布,提示世界边沿)
  const b0 = toPx(0, 0)
  const b1 = toPx(WORLD_W3D, WORLD_H3D)
  x.strokeStyle = 'rgba(53,224,160,.35)'
  x.lineWidth = 1
  x.strokeRect(b0.x, b0.y, b1.x - b0.x, b1.y - b0.y)
  // 领地(色环 + 淡填充;窗口外跳过)
  for (const b of mm?.blocks ?? []) {
    const wx = b.x * WORLD_W3D
    const wz = b.y * WORLD_H3D
    if (!inWin(wx, wz, 400)) continue
    const p = toPx(wx, wz)
    const rx = Math.max(4, (b.rx ?? 0.03) * WORLD_W3D * P.s)
    const ry = Math.max(3, (b.rz ?? 0.03) * WORLD_H3D * P.s)
    x.strokeStyle = toHex(b.color)
    x.globalAlpha = 0.6
    x.lineWidth = 1
    x.beginPath()
    x.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2)
    x.stroke()
    x.globalAlpha = 0.08
    x.fillStyle = toHex(b.color)
    x.fill()
    x.globalAlpha = 1
  }
  // 绑定链路(数采→设备 青色细线;server 绑定为权威)
  x.strokeStyle = 'rgba(65,200,244,.28)'
  const boundSet = new Set(daq.nodes.filter(n => n.deviceBindingId).map(n => n.id))
  for (const [daqId, devId] of daq.nodes.filter(n => n.deviceBindingId).map(n => [n.id, n.deviceBindingId!] as const)) {
    const dn = (mm?.devices ?? []).find(d => d.twinId === daqId)
    const dv = (mm?.devices ?? []).find(d => d.twinId === devId)
    if (!dn || !dv) continue
    const a = toPx(dn.x * WORLD_W3D, dn.y * WORLD_H3D)
    const b = toPx(dv.x * WORLD_W3D, dv.y * WORLD_H3D)
    x.beginPath()
    x.moveTo(a.x, a.y)
    x.lineTo(b.x, b.y)
    x.stroke()
  }
  // 实体:设备方点 / 数采绿点(绑定光环)/ Agent 圆点;窗外实体 → 边缘信标(夹到图框,
  // 缩小 + 降透明度)—— 所有实体始终在图上有落点,全景不丢导航信息
  const blip = (p: { x: number, y: number }): { x: number, y: number, edge: boolean } => {
    const m = 7
    if (p.x >= m && p.x <= P.w - m && p.y >= m && p.y <= P.h - m) return { ...p, edge: false }
    return { x: Math.min(P.w - m, Math.max(m, p.x)), y: Math.min(P.h - m, Math.max(m, p.y)), edge: true }
  }
  for (const d of mm?.devices ?? []) {
    const wx = d.x * WORLD_W3D
    const wz = d.y * WORLD_H3D
    const p = blip(toPx(wx, wz))
    if (d.daq) {
      x.globalAlpha = p.edge ? 0.4 : 1
      x.fillStyle = '#35e0a0'
      x.beginPath()
      x.arc(p.x, p.y, p.edge ? 1.8 : 2.4, 0, 7)
      x.fill()
      if (!p.edge && d.twinId && boundSet.has(d.twinId)) {
        x.strokeStyle = 'rgba(53,224,160,.5)'
        x.beginPath()
        x.arc(p.x, p.y, 4.4, 0, 7)
        x.stroke()
      }
    }
    else {
      x.globalAlpha = p.edge ? 0.4 : 1
      x.fillStyle = toHex(d.color)
      const s = p.edge ? 3.6 : 5.2
      x.fillRect(p.x - s / 2, p.y - s / 2, s, s)
    }
    x.globalAlpha = 1
  }
  for (const a of mm?.agents ?? []) {
    const wx = a.x * WORLD_W3D
    const wz = a.y * WORLD_H3D
    const p = blip(toPx(wx, wz))
    x.globalAlpha = p.edge ? 0.35 : 1
    x.fillStyle = toHex(a.color)
    x.beginPath()
    x.arc(p.x, p.y, p.edge ? 1.6 : 2.2, 0, 7)
    x.fill()
    x.globalAlpha = 1
  }
  // 图心准星(RPG 规范:钉死中央不随内容移动):
  // 视锥扇形指向注视方向(相机→注视点 = -(sinYaw, cosYaw)),相机本体若在窗内画白点
  if (pose) {
    const viewAng = Math.atan2(-Math.cos(pose.yaw), -Math.sin(pose.yaw))
    const r = Math.min(P.w, P.h) * 0.36
    x.fillStyle = 'rgba(65,200,244,.14)'
    x.strokeStyle = 'rgba(65,200,244,.5)'
    x.lineWidth = 1
    x.beginPath()
    x.moveTo(P.w / 2, P.h / 2)
    x.arc(P.w / 2, P.h / 2, r, viewAng - 0.4, viewAng + 0.4)
    x.closePath()
    x.fill()
    x.stroke()
    const cam = toPx(pose.pos.x, pose.pos.z)
    if (cam.x > 4 && cam.x < P.w - 4 && cam.y > 4 && cam.y < P.h - 4) {
      x.fillStyle = 'rgba(255,255,255,.85)'
      x.beginPath()
      x.arc(cam.x, cam.y, 2.4, 0, 7)
      x.fill()
    }
  }
  x.fillStyle = '#fff'
  x.beginPath()
  x.arc(P.w / 2, P.h / 2, 3, 0, 7)
  x.fill()
  x.strokeStyle = 'rgba(255,255,255,.4)'
  x.beginPath()
  x.arc(P.w / 2, P.h / 2, 5.5, 0, 7)
  x.stroke()
}
/** 地图缩放 = 3D dolly(与视角同源):滚轮/+- 直接驱动场景缩放,小地图自动跟随 */
function onNavWheel(e: WheelEvent): void {
  scene3dRef.value?.zoomBy(e.deltaY > 0 ? 0.14 : -0.12)
}
function onNavDown(e: PointerEvent): void {
  navDrag = { lx: e.clientX, ly: e.clientY, moved: false }
  // headless/合成事件无活动指针 → setPointerCapture 会抛 NotFoundError
  try {
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }
  catch { /* 无真实指针时忽略 */ }
}
function onNavMove(e: PointerEvent): void {
  const cv = navCanvas.value
  const s3 = scene3dRef.value
  if (!navDrag || !cv || !s3) return
  const P = navProj(cv)
  const dx = e.clientX - navDrag.lx
  const dy = e.clientY - navDrag.ly
  if (Math.abs(dx) + Math.abs(dy) > 3) navDrag.moved = true
  const dxw = dx / P.s
  const dzw = dy / P.s
  navDrag.lx = e.clientX
  navDrag.ly = e.clientY
  // 抓取语义:拖右 = 世界右移 = 镜头左扫(注视点/相机同步平移)
  s3.panWorldBy(dxw, dzw)
}
function onNavUp(e: PointerEvent): void {
  // 无拖拽的单击 = RPG 点图移动:镜头聚焦到该世界点
  const cv = navCanvas.value
  const s3 = scene3dRef.value
  if (navDrag && !navDrag.moved && cv && s3) {
    const rect = cv.getBoundingClientRect()
    const P = navProj(cv)
    const pose = s3.getCameraPose()
    const wx = pose.target.x + (e.clientX - rect.left - rect.width / 2) / P.s
    const wz = pose.target.z + (e.clientY - rect.top - rect.height / 2) / P.s
    s3.focusTo(wx, wz)
  }
  navDrag = null
}
/** 150ms HUD 节拍(小地图/相机位/标注跟随;topY 已缓存,不再每拍 Box3 全树) */
function miniTick(): void {
  const s = sceneRef.value
  if (s?.getMinimapState) minimap.value = s.getMinimapState()
  drawNavMap()
  // 标注跟随:锚定绑定设备的模型顶面(无绑定 → 数采立杆顶),150ms 跟手
  const s3 = scene3dRef.value
  if (s3) {
    camPose.value = s3.getCameraPose()
    if (showCallouts.value) {
      const nodes = s3.getDeviceNodes()
      // worldToScreen 返回页面坐标;callout-layer 是 stage 相对定位 → 换算成 stage 内坐标
      const sRect = stageRef.value?.getBoundingClientRect()
      const next: Record<string, { x: number, y: number }> = {}
      for (const t of daqTwins.value) {
        const boundDev = boundDeviceOf(t.id)
        const anchor = boundDev ? nodes.find(n => n.twinId === boundDev) : nodes.find(n => n.twinId === t.id)
        if (!anchor) continue
        const p = s3.worldToScreen(anchor.x, (anchor.topY ?? 92) + 26, anchor.z)
        if (p && sRect) next[t.id] = { x: p.x - sRect.left, y: p.y - sRect.top }
      }
      calloutPos.value = next
    }
  }
}

/** 后台标签页暂停全部 HUD 定时器(前台恢复;恒定 CPU 底噪归零) */
function onVisChange(): void {
  if (document.hidden) {
    if (miniTimer) {
      clearInterval(miniTimer)
      miniTimer = null
    }
    if (daqTimer) {
      clearInterval(daqTimer)
      daqTimer = null
    }
    if (tickerTimer) {
      clearInterval(tickerTimer)
      tickerTimer = null
    }
    return
  }
  if (!miniTimer) miniTimer = setInterval(miniTick, 150)
  if (!daqTimer) {
    daqTimer = setInterval(() => {
      if (daq.nodes.length) {
        drawTrend()
        drawBindSparks()
      }
    }, 1000)
  }
  if (!tickerTimer) {
    tickerTimer = setInterval(() => {
      const s = sceneRef.value
      if (s?.getRecentActivity) ticker.value = s.getRecentActivity()
    }, 400)
  }
}

onMounted(() => {
  window.addEventListener('keydown', onTownKey)
  document.addEventListener('visibilitychange', onVisChange)
  // 数采流:REST 基线 + WS 实时帧(server 权威;进数字孪生空间即建立连接)
  daq.ensureWsFeed()
  void daq.load()
  // 智控流:同款上电(REST 基线 + dcw.* WS 帧),dcwTwins 投影进 sceneTwinPool
  dcw.ensureWsFeed()
  void dcw.load()
  miniTimer = setInterval(miniTick, 150)
  // 数采画布重绘节奏(读数帧由 WS 增量到达;这里只负责趋势/火花线绘制)
  daqTimer = setInterval(() => {
    if (daq.nodes.length) {
      drawTrend()
      drawBindSparks()
    }
  }, 1000)
  tickerTimer = setInterval(() => {
    const s = sceneRef.value
    if (s?.getRecentActivity) ticker.value = s.getRecentActivity()
  }, 400)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onTownKey)
  for (const fn of windowCleanups) {
    try {
      fn()
    }
    catch { /* 尽力清理 */ }
  }
  windowCleanups.length = 0
  document.removeEventListener('visibilitychange', onVisChange)
  if (miniTimer) clearInterval(miniTimer)
  if (daqTimer) clearInterval(daqTimer)
  if (tickerTimer) clearInterval(tickerTimer)
  if (devicePollTimer) clearInterval(devicePollTimer)
  if (calloutTimer) clearInterval(calloutTimer)
  miniTimer = null
  daqTimer = null
  tickerTimer = null
  devicePollTimer = null
  calloutTimer = null
})

/** 首次挂载即建一次(若 entities 已有数据) */
onMounted(() => {
  boot()
  // 若快照尚未到达,稍后 snapshot 事件会触发 rebuild;这里先发一次初始基线
  const seed = buildTownInput()
  if (seed.length > 0 && sceneRef.value) {
    sceneRef.value.rebuild(seed)
  }
})

onBeforeUnmount(() => {
  const off = (sceneRef as unknown as { _off?: () => void })._off
  off?.()
  scene3dRef.value?.dispose()
  scene3dRef.value = null
  gameRef.value?.destroy(true)
  gameRef.value = null
  sceneRef.value = null
})
</script>

<template>
  <div class="town-view">
    <!-- ================= 顶部导航 ================= -->
    <header class="topnav">
      <div class="brand">
        <svg
          class="brand-glyph"
          viewBox="0 0 32 32"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M16 2.5 27.5 9v14L16 29.5 4.5 23V9L16 2.5Z"
            stroke="#35e0a0"
            stroke-width="1.6"
          />
          <path
            d="M16 8.2 22.5 12v8L16 23.8 9.5 20v-8L16 8.2Z"
            stroke="#41c8f4"
            stroke-width="1.3"
            opacity=".85"
          />
          <circle
            cx="16"
            cy="16"
            r="2.4"
            fill="#35e0a0"
          />
          <circle
            cx="25.5"
            cy="7.5"
            r="1.6"
            fill="#41c8f4"
          />
        </svg>
        <div>
          <div class="brand-name">
            DIGITAL <em>TWIN</em>
          </div>
          <div class="brand-sub">
            AGENTWORKSHOP · 数字孪生平台
          </div>
        </div>
      </div>
      <nav
        class="nav-tabs"
        aria-label="场景模式"
      >
        <div class="seg">
          <button
            :class="{ on: mode === 'browse' }"
            @click="mode === 'edit' && toggleMode()"
          >
            运行
          </button>
          <button
            :class="{ on: mode === 'edit' }"
            @click="mode === 'browse' && toggleMode()"
          >
            编辑
          </button>
        </div>
        <button
          class="nav-action"
          :disabled="mode !== 'edit'"
          :title="mode === 'edit' ? '把全部设备的位置/朝向/缩放写入数据库' : '运行模式只读'"
          @click="saveLayout"
        >
          保存布局
        </button>
        <span
          v-if="saveState && saveState.state !== 'idle'"
          class="save-chip"
          :class="`s-${saveState.state}`"
        >{{ saveStateLabel }}</span>
      </nav>
      <div class="nav-right">
        <span
          class="nav-chip mono"
          :class="{ 'nav-bell-warn': activeAlarmCount > 0 }"
          title="活跃告警"
        >◉ {{ activeAlarmCount }}</span>
        <span class="nav-chip mono">{{ fps }} FPS</span>
        <div
          class="avatar-chip"
          title="当前用户"
        >
          <div class="avatar-fallback">
            {{ (userStore.user?.name ?? 'OP').slice(0, 2).toUpperCase() }}
          </div>
          <span>{{ userStore.user?.name || '产线管理员' }}</span>
        </div>
      </div>
    </header>

    <!-- ================= 三栏应用区 ================= -->
    <div class="app">
      <!-- 左轨:设备资源 / 数采节点 / 场景管理 -->
      <aside class="rail rail-left">
        <section class="panel">
          <div class="panel-hd">
            <h3>设备资源</h3>
            <span class="panel-tag">{{ deviceModels.length }}</span>
          </div>
          <WorkshopAssetLibrary class="lib-embed" />
        </section>

        <section class="panel">
          <div class="panel-hd">
            <h3>数采节点 · DAQ</h3>
            <span class="panel-tag">{{ daqTwins.length }}</span>
          </div>
          <!-- 采集总控(server DaqController:全局启停 + 缺省周期;所有节点到期由其统一调度) -->
          <div class="daq-ctrl">
            <button
              class="daq-ctl-btn"
              :class="{ on: daq.controller.running }"
              :title="daq.controller.running ? '暂停全部采集' : '恢复全部采集'"
              @click="daq.controllerAction(daq.controller.running ? 'stop' : 'start')"
            >
              {{ daq.controller.running ? '采集中' : '已暂停' }}
            </button>
            <label
              class="daq-ctl-cycle mono"
              title="缺省采样周期(未单独设置周期的节点跟随此值)"
            >
              周期
              <input
                type="number"
                min="200"
                max="60000"
                step="100"
                :value="daq.controller.defaultIntervalMs"
                @change="daq.controllerAction('config', Number(($event.target as HTMLInputElement).value))"
              >ms
            </label>
          </div>
          <div class="daq-list">
            <div
              v-for="tpl in daqTemplates"
              :key="tpl.id"
              class="daq-card"
              draggable="true"
              :title="`${tpl.name} · ${tpl.ch} · 拖到设备旁自动绑定,量程 ${tpl.min} ~ ${tpl.max} ${tpl.unit}`"
              @dragstart="onDaqDragStart($event, tpl)"
            >
              <span class="daq-ico">
                <svg
                  class="daq-svg"
                  viewBox="0 0 24 24"
                  v-html="daqIcon(tpl.icon)"
                />
              </span>
              <div class="daq-meta">
                <span class="daq-name">{{ tpl.name }}</span>
                <span class="daq-code">{{ tpl.code }}</span>
              </div>
              <span class="daq-count">×{{ daq.nodes.filter(n => n.templateRef === `daq-${tpl.id}`).length }}</span>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-hd">
            <h3>智控节点 · DCW</h3>
            <span class="panel-tag">{{ dcw.nodes.length }}</span>
          </div>
          <div class="daq-list">
            <div
              v-for="tpl in dcwTemplates"
              :key="tpl.id"
              class="daq-card"
              draggable="true"
              :title="`${tpl.name} · ${tpl.ch} · 设定值域 ${tpl.min} ~ ${tpl.max} ${tpl.unit} · 拖到设备旁自动绑定`"
              @dragstart="onDcwDragStart($event, tpl)"
            >
              <span class="daq-ico">
                <svg
                  class="daq-svg"
                  viewBox="0 0 24 24"
                  v-html="daqIcon(tpl.icon)"
                />
              </span>
              <div class="daq-meta">
                <span class="daq-name">{{ tpl.name }}</span>
                <span class="daq-code">{{ tpl.code }}</span>
              </div>
              <span class="daq-count">×{{ dcw.nodes.filter(n => n.templateRef === `dcw-${tpl.id}`).length }}</span>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-hd">
            <h3>场景管理</h3>
            <span class="panel-tag">{{ dockChannels.length }}</span>
          </div>
          <div class="scene-list">
            <div
              v-for="ch in dockChannels"
              :key="ch.channelId"
              class="scene-row"
              :class="{ active: ch.placed }"
              :draggable="!ch.placed && mode === 'edit'"
              :data-channel-id="ch.channelId"
              :title="ch.placed ? '已在场景中,点击定位' : '拖拽到场景放置'"
              @dragstart="ch.placed ? undefined : onChannelDragStart($event, ch.channelId)"
              @click="onDockCardClick(ch)"
            >
              <span
                class="scene-ico"
                :style="{ '--ch': ch.color }"
              />
              <div class="scene-meta-wrap">
                <span class="scene-name">{{ ch.name }}</span>
                <span class="scene-meta">{{ ch.agentCount }} 员工 · {{ ch.placed ? '已放置' : '未放置' }}</span>
              </div>
              <span
                v-if="ch.placed"
                class="scene-cur"
              >✓</span>
              <span
                v-else
                class="scene-add"
              >＋</span>
            </div>
            <div
              v-if="dockHint"
              class="scene-hint"
            >
              {{ dockHint }}
            </div>
          </div>
        </section>
      </aside>

      <!-- 中栏:舞台 + 底部坞 -->
      <main class="stage-col">
        <div
          ref="stageRef"
          class="stage"
        >
          <div
            id="town-host"
            ref="hostRef"
            class="town-host"
          />
          <div class="stage-vignette" />

          <div class="stage-top">
            <div class="vp-title">
              <h2>产线孪生总览</h2>
              <span class="vp-id">CH · {{ activeChannelName || '加载中' }}</span>
            </div>
            <div class="vp-tools">
              <button
                class="vp-tool"
                title="定位选中设备"
                @click="locateSelected"
              >
                <svg
                  class="vp-svg"
                  viewBox="0 0 24 24"
                ><circle
                  cx="12"
                  cy="12"
                  r="7"
                /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>
              </button>
              <button
                class="vp-tool"
                :class="{ on: orbitOn }"
                title="自动环绕"
                @click="toggleOrbit"
              >
                <svg
                  class="vp-svg"
                  viewBox="0 0 24 24"
                ><circle
                  cx="12"
                  cy="12"
                  r="3.2"
                /><path d="M20.5 9a10 10 0 0 1 .3 4.5M3.5 15a10 10 0 0 1-.3-4.5" /></svg>
              </button>
              <button
                class="vp-tool"
                :class="{ on: showCallouts }"
                title="数据标注显隐"
                @click="showCallouts = !showCallouts"
              >
                <svg
                  class="vp-svg"
                  viewBox="0 0 24 24"
                ><path d="M4 8h12l4 4-4 4H4z" /><circle
                  cx="8.5"
                  cy="12"
                  r="1.4"
                /></svg>
              </button>
              <button
                class="vp-tool"
                title="全屏"
                @click="fullscreenStage"
              >
                <svg
                  class="vp-svg"
                  viewBox="0 0 24 24"
                ><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
              </button>
            </div>
          </div>

          <div class="angle-chip">
            <select
              :value="viewPreset"
              aria-label="视角预设"
              @change="onViewPreset($event)"
            >
              <option value="std">
                3D 视角 · 标准
              </option>
              <option value="top">
                俯视 · TOP
              </option>
              <option value="front">
                前视 · FRONT
              </option>
              <option value="side">
                侧视 · SIDE
              </option>
            </select>
          </div>

          <!-- 数据标注层(靠近浮现:callout + 引线 + 锚点;同设备多路竖排堆叠;点击选中设备) -->
          <template v-if="showCallouts">
            <svg class="leaders">
              <g
                v-for="c in callouts"
                v-show="c.leader"
                :key="`ld-${c.id}`"
                :class="{ near: c.near }"
              >
                <path
                  :d="`M ${c.x} ${c.y - 8} L ${c.x} ${c.y - 2}`"
                  :stroke="c.warn ? 'rgba(246,196,83,.8)' : 'rgba(65,200,244,.55)'"
                  stroke-width="1.3"
                  fill="none"
                />
                <circle
                  :cx="c.x"
                  :cy="c.y"
                  r="2.6"
                  :fill="c.warn ? '#f6c453' : '#41c8f4'"
                />
              </g>
            </svg>
            <div class="callout-layer">
              <div
                v-for="c in callouts"
                :key="c.id"
                class="callout"
                :class="{ warn: c.warn, near: c.near }"
                :style="{ left: c.x + 'px', top: c.y + 'px' }"
                title="点击选中该设备"
                @click="selectDeviceFromCallout(c.id)"
              >
                <div class="co-label">
                  <span class="co-dot" />{{ c.label }}
                </div>
                <div class="co-val">
                  {{ c.value }}<small>{{ c.unit }}</small>
                </div>
                <div class="co-range">
                  正常范围 {{ c.lo.toFixed(Math.min(2, (String(c.lo).split('.')[1] ?? '').length + 1)) }} – {{ c.hi.toFixed(Math.min(2, (String(c.hi).split('.')[1] ?? '').length + 1)) }}
                </div>
              </div>
            </div>
          </template>

          <!-- KPI 条(设计稿五项:设备/运行/告警/数采通道/健康度) -->
          <div class="kpi-strip">
            <div class="kpi">
              <span class="kpi-ico c1">
                <svg
                  class="kpi-svg"
                  viewBox="0 0 24 24"
                ><path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5v-7Z" /><path d="M4 8.5l8 4.5 8-4.5M12 13v7" /></svg>
              </span>
              <div class="kpi-meta">
                <div class="kpi-label">
                  设备总数
                </div>
                <div class="kpi-val">
                  {{ deviceCount }}<small>台</small>
                </div>
              </div>
            </div>
            <div class="kpi">
              <span class="kpi-ico c2">
                <svg
                  class="kpi-svg"
                  viewBox="0 0 24 24"
                ><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
              </span>
              <div class="kpi-meta">
                <div class="kpi-label">
                  运行设备
                </div>
                <div class="kpi-val">
                  {{ runningCount }}<small>台</small>
                </div>
              </div>
            </div>
            <div class="kpi">
              <span class="kpi-ico c3">
                <svg
                  class="kpi-svg"
                  viewBox="0 0 24 24"
                ><path d="M12 3 22 20H2L12 3Z" /><path d="M12 10v4M12 17v.2" /></svg>
              </span>
              <div class="kpi-meta">
                <div class="kpi-label">
                  活跃告警
                </div>
                <div class="kpi-val">
                  {{ activeAlarmCount }}<small>条</small>
                </div>
              </div>
            </div>
            <div class="kpi">
              <span class="kpi-ico c4">
                <svg
                  class="kpi-svg"
                  viewBox="0 0 24 24"
                ><path d="M9.5 14.5 14.5 9.5" /><path d="M11 6.5 12.8 4.7a4 4 0 0 1 5.6 5.6L16.5 12" /><path d="m13 17.5-1.8 1.8a4 4 0 0 1-5.6-5.6L7.5 12" /></svg>
              </span>
              <div class="kpi-meta">
                <div class="kpi-label">
                  数采通道
                </div>
                <div class="kpi-val">
                  {{ daqTwins.length }}<small>路</small>
                </div>
              </div>
            </div>
            <div class="kpi">
              <span class="kpi-ico c5">
                <svg
                  class="kpi-svg"
                  viewBox="0 0 24 24"
                ><path d="M5 19a9 9 0 1 1 14 0" /><path d="M12 13l3.5-3.5" /><circle
                  cx="12"
                  cy="13"
                  r="1.4"
                /></svg>
              </span>
              <div class="kpi-meta">
                <div class="kpi-label">
                  线体健康度
                </div>
                <div class="kpi-val">
                  {{ healthPct }}<small>%</small>
                </div>
              </div>
            </div>
          </div>

          <div
            v-if="blockCount === 0 && ready"
            class="empty-hint"
          >
            <b>空场景</b>
            <span>从左侧「设备资源 / 数采节点」拖入实体,开始搭建数字孪生空间</span>
          </div>

          <!-- 频道边界编辑(浮动) -->
          <div
            v-if="selectedChannel && boundaryDraft"
            class="boundary-panel drag-panel"
            :style="panelPos.boundary ? { left: panelPos.boundary.x + 'px', top: panelPos.boundary.y + 'px', bottom: 'auto', transform: 'none' } : undefined"
          >
            <div
              class="bp-title drag-grip"
              title="拖动移动面板"
              @pointerdown="onPanelGripDown($event, 'boundary')"
            >
              <span class="bp-name">{{ entities.channels[selectedChannel]?.name ?? selectedChannel.slice(0, 8) }}</span>
              <span class="bp-sub">频道管理</span>
              <div class="bp-tabs">
                <button
                  class="bp-tab"
                  :class="{ on: channelPanelTab === 'boundary' }"
                  @click="openChannelTab('boundary')"
                >
                  边界
                </button>
                <button
                  class="bp-tab"
                  :class="{ on: channelPanelTab === 'members' }"
                  @click="openChannelTab('members')"
                >
                  成员 {{ channelMembers.length }}
                </button>
              </div>
            </div>
            <template v-if="channelPanelTab === 'boundary'">
              <div class="bp-row">
                <span class="bp-label">形状</span>
                <div class="bp-seg">
                  <button
                    class="seg-btn"
                    :class="{ on: boundaryDraft.shape === 'ellipse' }"
                    @click="boundaryDraft.shape = 'ellipse'; applyBoundaryDraft()"
                  >
                    椭圆
                  </button>
                  <button
                    class="seg-btn"
                    :class="{ on: boundaryDraft.shape === 'rect' }"
                    @click="boundaryDraft.shape = 'rect'; applyBoundaryDraft()"
                  >
                    矩形
                  </button>
                </div>
              </div>
              <div class="bp-row">
                <span class="bp-label">横轴半径</span>
                <input
                  v-model.number="boundaryDraft.radiusX"
                  class="bp-range"
                  type="range"
                  min="80"
                  max="4000"
                  step="8"
                  :style="{ '--fill': sliderPct(boundaryDraft.radiusX, 80, 4000) }"
                  @change="applyBoundaryDraft"
                >
                <span class="bp-val">{{ Math.round(boundaryDraft.radiusX) }}</span>
              </div>
              <div class="bp-row">
                <span class="bp-label">纵轴半径</span>
                <input
                  v-model.number="boundaryDraft.radiusZ"
                  class="bp-range"
                  type="range"
                  min="60"
                  max="4000"
                  step="8"
                  :style="{ '--fill': sliderPct(boundaryDraft.radiusZ, 60, 4000) }"
                  @change="applyBoundaryDraft"
                >
                <span class="bp-val">{{ Math.round(boundaryDraft.radiusZ) }}</span>
              </div>
              <div class="bp-row">
                <span class="bp-label">朝向</span>
                <input
                  v-model.number="boundaryDraft.rotationY"
                  class="bp-range"
                  type="range"
                  min="0"
                  max="360"
                  step="5"
                  :style="{ '--fill': sliderPct(boundaryDraft.rotationY ?? 0, 0, 360) }"
                  @change="applyBoundaryDraft"
                >
                <span class="bp-val">{{ Math.round(boundaryDraft.rotationY ?? 0) }}°</span>
              </div>
            </template>
            <template v-else>
              <div class="bp-hint">
                为频道成员选择 3D 角色模型(实时换装并持久化)
              </div>
              <div class="member-list">
                <div
                  v-for="m in channelMembers"
                  :key="m.agentId"
                  class="member-row"
                >
                  <span
                    class="member-ava"
                    :style="{ color: hashColor(selectedChannel) }"
                  >{{ m.name.charAt(0).toUpperCase() }}</span>
                  <div class="member-info">
                    <span class="member-name">{{ m.name }}</span>
                    <span
                      class="member-role"
                      :class="m.role === 'lead' ? 'r-lead' : 'r-worker'"
                    >{{ m.role === 'lead' ? 'Leader' : 'Worker' }}</span>
                  </div>
                  <select
                    class="member-select"
                    :value="(m.modelRef ?? '') || 'hero-3d'"
                    @change="bindMemberModel(m.agentId, ($event.target as HTMLSelectElement).value)"
                  >
                    <option
                      v-for="model in agentModels"
                      :key="model.id"
                      :value="model.id"
                    >
                      {{ model.name }}
                    </option>
                  </select>
                </div>
                <div
                  v-if="channelMembers.length === 0"
                  class="bp-hint"
                >
                  该频道暂无成员
                </div>
              </div>
            </template>
            <div class="bp-actions">
              <button
                v-if="channelPanelTab === 'boundary'"
                class="bp-btn save"
                @click="saveChannelLayout"
              >
                保存边界
              </button>
              <button
                class="bp-btn danger"
                @click="removeChannelFromScene"
              >
                移除频道
              </button>
              <button
                class="bp-btn"
                @click="onSelectChannel(null)"
              >
                关闭
              </button>
            </div>
          </div>

          <!-- 反馈芯片 -->
          <div
            v-if="lastDropText"
            class="drop-chip"
          >
            {{ lastDropText }}
          </div>
          <div
            v-if="errorText"
            class="error-chip"
          >
            {{ errorText }}
          </div>

          <!-- 加载遮罩 -->
          <div
            v-if="!ready"
            data-hud="town-loading"
            class="loading-mask"
          >
            <div class="loading-spinner" />
            <span class="loading-text">正在铺设数字孪生空间…</span>
          </div>
        </div>

        <!-- 底部坞:场景控制 + 趋势分析 -->
        <div class="dock">
          <section class="dock-card">
            <div class="dock-hd">
              <h3>场景控制</h3>
              <span class="dock-mode">{{ mode === 'edit' ? '编辑模式' : '运行模式' }}</span>
            </div>
            <div class="ctl-row">
              <span class="ctl-name">环境光照</span>
              <input
                class="ctl-range"
                type="range"
                min="30"
                max="220"
                :value="Math.round(exposure * 100)"
                :style="{ '--fill': sliderPct(Math.round(exposure * 100), 30, 220) }"
                @input="onExposureInput($event)"
              >
              <span class="ctl-val">{{ Math.round(exposure * 100) }}%</span>
            </div>
            <div class="ctl-row">
              <span class="ctl-name">构造透明度</span>
              <input
                class="ctl-range"
                type="range"
                min="10"
                max="100"
                :value="Math.round(tintOpacity * 100)"
                :style="{ '--fill': sliderPct(Math.round(tintOpacity * 100), 10, 100) }"
                @input="onTintInput($event)"
              >
              <span class="ctl-val">{{ Math.round(tintOpacity * 100) }}%</span>
            </div>
            <div class="ctl-row">
              <span class="ctl-name">告警阈值</span>
              <input
                class="ctl-range"
                type="range"
                min="60"
                max="120"
                :value="threshPct"
                :style="{ '--fill': sliderPct(threshPct, 60, 120) }"
                @input="threshPct = Number(($event.target as HTMLInputElement).value)"
              >
              <span class="ctl-val">{{ threshPct }}%</span>
            </div>
            <div class="ctl-row">
              <span
                class="ctl-name"
                title="相机靠近设备多少距离内显示数采数据卡"
              >数采可视距离</span>
              <input
                class="ctl-range"
                type="range"
                min="0"
                max="3000"
                step="50"
                :value="calloutNearDist"
                :style="{ '--fill': sliderPct(calloutNearDist, 0, 3000) }"
                @input="calloutNearDist = Number(($event.target as HTMLInputElement).value)"
              >
              <span class="ctl-val">{{ calloutNearDist === 0 ? '关' : `${calloutNearDist}` }}</span>
            </div>
            <div class="ctl-row">
              <span class="ctl-name">网格吸附</span>
              <button
                class="snap-toggle"
                :class="{ on: snap }"
                @click="toggleSnap"
              >
                {{ snap ? '开' : '关' }}
              </button>
              <span class="ctl-val" />
            </div>
            <div class="ctl-btns">
              <button
                class="btn btn-primary"
                @click="onResetView"
              >
                重置视角
              </button>
              <button
                class="btn btn-ghost"
                :disabled="mode !== 'edit'"
                :title="mode === 'edit' ? '保存全部设备布局' : '运行模式只读'"
                @click="saveLayout"
              >
                保存布局
              </button>
              <button
                class="btn btn-danger"
                :class="{ armed: estop }"
                @click="toggleEstop"
              >
                紧急停止
              </button>
            </div>
          </section>

          <section class="dock-card">
            <div class="dock-hd">
              <h3>趋势分析</h3>
              <div class="trend-legend">
                <button
                  v-for="t in daqTwins"
                  :key="t.id"
                  class="lg-chip"
                  :class="{ off: hiddenTrends[t.id] }"
                  @click="toggleTrend(t.id)"
                >
                  <span
                    class="lg-dot"
                    :style="{ background: trendColor(t.id) }"
                  />{{ t.name }}
                </button>
              </div>
            </div>
            <div class="trend-wrap">
              <canvas
                ref="trendCanvas"
                class="trend-cv"
              />
              <span
                v-if="!daqTwins.length"
                class="trend-empty"
              >从左侧拖入数采节点,实时趋势将在此绘制</span>
            </div>
          </section>
        </div>
      </main>

      <!-- 右轨:Inspector / 设备运行状态 / 关键设备 / 实时事件 / 导航 -->
      <aside class="rail rail-right">
        <section
          v-if="selected"
          class="panel inspector"
        >
          <div class="panel-hd">
            <h3>{{ selected.kind === 'device' ? (selectedIsDaq ? '数采节点' : '设备实例') : selectedAgentRoleLabel }}</h3>
            <button
              class="mini-btn"
              title="取消选中"
              @click="closeScale"
            >
              ✕
            </button>
          </div>

          <div class="ins-chip-row">
            <span class="ins-chip mono">{{ selected.id.slice(0, 8) }}</span>
            <span
              v-if="selected.kind === 'device' && selectedIsDaq"
              class="ins-chip accent"
            >DAQ</span>
          </div>

          <template v-if="selected.kind === 'device'">
            <div
              v-if="selectedIsDaq"
              class="daq-info"
            >
              <div class="daq-info-row">
                <span>实时值</span>
                <b class="cy">{{ selectedDaqSim ? fmtDaq(selectedDaqSim) : '--' }} {{ selectedDaqSim?.tpl.unit }}</b>
              </div>
              <div class="daq-info-row">
                <span>正常范围</span>
                <b>{{ selectedDaqSim?.tpl.min }} ~ {{ selectedDaqSim?.tpl.max }}</b>
              </div>
              <div class="daq-info-row">
                <span>绑定设备</span>
                <b>{{ daqBoundDeviceName || '未绑定' }}</b>
              </div>
              <div
                v-if="mode === 'edit'"
                class="daq-bind-bar"
              >
                <select
                  v-model="bindPick"
                  class="bind-select"
                >
                  <option value="">
                    选择设备实例…
                  </option>
                  <option
                    v-for="dv in deviceTwins.twins.filter(x => !isLegacyDaqTwin(x) && x.id !== (selected?.id ?? ''))"
                    :key="dv.id"
                    :value="dv.id"
                  >
                    {{ dv.name }}
                  </option>
                </select>
                <button
                  class="bind-add-btn"
                  :disabled="!bindPick"
                  @click="daqBoundDeviceName ? unbindDaq(selected.id) : bindDaq(selected.id, bindPick); bindPick = ''"
                >
                  {{ daqBoundDeviceName ? '解绑' : '绑定' }}
                </button>
              </div>
              <!-- 节点单点控制(server DaqNode 参数:启停/周期/量程/预警带;REST 落库即时生效) -->
              <div
                v-if="mode === 'edit' && selectedDaqNode"
                class="daq-node-ctl"
              >
                <div class="daq-info-row">
                  <span>采样周期</span>
                  <span class="daq-th-inputs">
                    <input
                      v-model.number="daqIntervalDraft"
                      type="number"
                      min="200"
                      max="60000"
                      step="100"
                      class="daq-num"
                      @change="onDaqIntervalCommit"
                    ><small>ms(空=跟随全局)</small>
                  </span>
                </div>
                <div class="daq-info-row">
                  <span>预警带</span>
                  <span class="daq-th-inputs">
                    <input
                      :value="selectedDaqNode.warnLow"
                      type="number"
                      step="any"
                      class="daq-num"
                      @change="onDaqThresholdCommit('warnLow', ($event.target as HTMLInputElement).value)"
                    >
                    ~
                    <input
                      :value="selectedDaqNode.warnHigh"
                      type="number"
                      step="any"
                      class="daq-num"
                      @change="onDaqThresholdCommit('warnHigh', ($event.target as HTMLInputElement).value)"
                    >
                  </span>
                </div>
                <div class="daq-info-row">
                  <span>硬限量程</span>
                  <span class="daq-th-inputs">
                    <input
                      :value="selectedDaqNode.min"
                      type="number"
                      step="any"
                      class="daq-num"
                      @change="onDaqThresholdCommit('min', ($event.target as HTMLInputElement).value)"
                    >
                    ~
                    <input
                      :value="selectedDaqNode.max"
                      type="number"
                      step="any"
                      class="daq-num"
                      @change="onDaqThresholdCommit('max', ($event.target as HTMLInputElement).value)"
                    >
                  </span>
                </div>
                <div class="daq-info-row">
                  <span>采集</span>
                  <button
                    class="bind-add-btn"
                    :class="{ warn: selectedDaqNode.enabled }"
                    @click="daq.patchNode(selected.id, { enabled: !selectedDaqNode.enabled })"
                  >
                    {{ selectedDaqNode.enabled ? '停用本节点' : '启用本节点' }}
                  </button>
                </div>
                <div class="daq-info-row">
                  <span>删除</span>
                  <button
                    class="bind-add-btn danger"
                    title="删除该数采节点(server 实体一并移除)"
                    @click="removeSelectedDevice()"
                  >
                    删除节点
                  </button>
                </div>
              </div>
              <div
                v-else
                class="ins-empty"
              >
                运行模式 · 只读
              </div>
            </div>
            <template v-else>
              <div class="obj-row">
                <span class="obj-label">名称</span>
                <input
                  v-model="objNameDraft"
                  class="obj-input"
                  placeholder="设备名称"
                  :disabled="mode !== 'edit'"
                  :title="mode === 'edit' ? '设备名称' : '运行模式只读'"
                  @change="onObjNameCommit"
                  @keydown.enter="onObjNameCommit"
                >
              </div>
              <div class="obj-row">
                <span class="obj-label">模型</span>
                <select
                  class="obj-select"
                  :value="scene3dRef?.getDeviceModelRef?.(selected.id) ?? ''"
                  :disabled="mode !== 'edit'"
                  @change="bindDeviceModel(($event.target as HTMLSelectElement).value)"
                >
                  <option
                    v-for="m in deviceModels"
                    :key="m.id"
                    :value="m.id"
                  >
                    {{ m.name }}
                  </option>
                </select>
              </div>

              <!-- 数采绑定(设计稿 bind-row:图标 + 通道 + 实时值 + 迷你折线 + 解绑;运行模式只读展示) -->
              <div class="sect-hd">
                数据绑定 · {{ boundDaqRows.length }} 路通道
              </div>
              <div
                v-for="r in boundDaqRows"
                :key="r.daqId"
                class="bind-row"
              >
                <span class="bind-ico">
                  <svg
                    class="bind-svg"
                    viewBox="0 0 24 24"
                    v-html="daqIcon(r.icon)"
                  />
                </span>
                <span class="bind-meta">
                  <span class="bind-label">{{ r.ch }}</span>
                  <span class="bind-val"><b>{{ r.value }}</b> {{ r.unit }} · {{ r.name }}</span>
                </span>
                <canvas
                  :ref="el => setSparkRef(r.daqId, el)"
                  class="bind-spark"
                  width="56"
                  height="20"
                />
                <button
                  v-if="mode === 'edit'"
                  class="bind-x"
                  title="解除绑定"
                  @click="unbindDaq(r.daqId)"
                >
                  ✕
                </button>
              </div>
              <div
                v-if="!boundDaqRows.length"
                class="ins-empty"
              >
                暂无数据通道 · 拖入数采节点靠近此设备即可自动绑定
              </div>
              <div
                v-if="mode === 'edit'"
                class="bind-add-wrap"
              >
                <button
                  class="bind-add"
                  @click="bindPopOpen = !bindPopOpen"
                >
                  ＋ 添加数采通道
                </button>
                <div
                  v-if="bindPopOpen"
                  class="bind-pop"
                >
                  <button
                    v-for="tpl in daqTemplates"
                    :key="tpl.id"
                    @click="addChannelFromTemplate(tpl)"
                  >
                    <svg
                      class="bind-svg"
                      viewBox="0 0 24 24"
                      v-html="daqIcon(tpl.icon)"
                    />
                    <span>{{ tpl.name }} · {{ tpl.ch }}</span>
                  </button>
                </div>
              </div>

              <!-- 变换模式(Blender G/R/S;仅编辑模式) -->
              <template v-if="mode === 'edit'">
                <div class="sect-hd">
                  变换 · BLENDER
                </div>
                <div class="xz-seg">
                  <button
                    class="seg-btn"
                    :class="{ on: tMode === 'translate' }"
                    @click="setTMode('translate')"
                  >
                    移动 G
                  </button>
                  <button
                    class="seg-btn"
                    :class="{ on: tMode === 'rotate' }"
                    @click="setTMode('rotate')"
                  >
                    旋转 R
                  </button>
                  <button
                    class="seg-btn"
                    :class="{ on: tMode === 'scale' }"
                    @click="setTMode('scale')"
                  >
                    缩放 S
                  </button>
                </div>
                <div class="scale-row">
                  <span class="scale-min">0.2×</span>
                  <input
                    class="scale-range"
                    type="range"
                    min="0.2"
                    max="5"
                    step="0.05"
                    :value="selected.scale"
                    @input="onScaleInput(Number(($event.target as HTMLInputElement).value))"
                    @change="onScaleCommit(Number(($event.target as HTMLInputElement).value))"
                  >
                  <span class="scale-max">5×</span>
                </div>
                <div class="scale-val">
                  {{ Math.round(selected.scale * 100) }}%
                </div>

                <div class="ins-foot">
                  <button
                    class="btn btn-danger ins-del"
                    :class="{ armed: deviceDeleteArmed === selected.id }"
                    @click="removeSelectedDevice"
                  >
                    {{ deviceDeleteArmed === selected.id ? '再次点击确认删除' : '删除设备实例' }}
                  </button>
                </div>
              </template>
              <div
                v-else
                class="ins-empty"
              >
                运行模式 · 只读(切换「编辑」可调整变换/删除)
              </div>
            </template>
          </template>

          <template v-else-if="selected.kind === 'agent'">
            <div class="chat-id-row">
              <span
                class="chat-badge"
                :style="{ '--p-acc': agentChatColor }"
              >{{ agentChatTitle.slice(0, 1).toUpperCase() }}</span>
              <div class="chat-nameplate">
                <span class="chat-name">{{ agentChatTitle }}</span>
                <span class="chat-meta">
                  <span
                    class="chat-role"
                    :class="selectedAgentMeta?.role === 'lead' ? 'r-lead' : 'r-worker'"
                  >{{ selectedAgentRoleTag }}</span>
                  <span
                    class="chat-state"
                    :class="`s-${selectedAgentMeta?.state ?? 'idle'}`"
                  >{{ agentChatStateLabel }}</span>
                  <span
                    v-if="selectedAgentMeta?.harness"
                    class="chat-harness"
                  >{{ selectedAgentMeta.harness.toUpperCase() }}</span>
                  <span class="chat-count">{{ agentHistory.length + agentChatRows.length }} 条</span>
                </span>
              </div>
            </div>
            <div class="obj-row">
              <span class="obj-label">模型</span>
              <select
                class="obj-select"
                :value="(scene3dRef?.getAgentModel?.(selected.id) ?? '') || 'hero-3d'"
                :disabled="mode !== 'edit'"
                @change="bindAgentModel(($event.target as HTMLSelectElement).value)"
              >
                <option
                  v-for="m in agentModels"
                  :key="m.id"
                  :value="m.id"
                >
                  {{ m.name }}
                </option>
              </select>
            </div>
            <div class="obj-sep" />
            <div class="obj-row">
              <span class="obj-label">活动范围</span>
              <span class="range-status">{{ agentRangeStatusText }}</span>
              <button
                v-if="mode === 'edit'"
                class="obj-mini"
                :class="{ on: agentDrawingRange }"
                title="在场景中拖动框选,确定该角色的移动范围"
                @click="onToggleRangeDraw"
              >
                {{ agentDrawingRange ? '绘制中' : '框选绘制' }}
              </button>
            </div>
            <template v-if="agentRangeDraft && mode === 'edit'">
              <div class="obj-row">
                <span class="obj-label">形状</span>
                <div class="bp-seg">
                  <button
                    class="seg-btn"
                    :class="{ on: agentRangeDraft.shape === 'ellipse' }"
                    @click="agentRangeDraft.shape = 'ellipse'; applyAgentRangeDraft()"
                  >
                    椭圆
                  </button>
                  <button
                    class="seg-btn"
                    :class="{ on: agentRangeDraft.shape === 'rect' }"
                    @click="agentRangeDraft.shape = 'rect'; applyAgentRangeDraft()"
                  >
                    矩形
                  </button>
                </div>
              </div>
              <div class="obj-row">
                <span class="obj-label">横轴</span>
                <input
                  v-model.number="agentRangeDraft.radiusX"
                  class="obj-range"
                  type="range"
                  min="40"
                  max="4000"
                  step="8"
                  @input="applyAgentRangeDraft"
                  @change="onAgentRangeCommit"
                >
                <span class="bp-val">{{ Math.round(agentRangeDraft.radiusX) }}</span>
              </div>
              <div class="obj-row">
                <span class="obj-label">纵轴</span>
                <input
                  v-model.number="agentRangeDraft.radiusZ"
                  class="obj-range"
                  type="range"
                  min="40"
                  max="4000"
                  step="8"
                  @input="applyAgentRangeDraft"
                  @change="onAgentRangeCommit"
                >
                <span class="bp-val">{{ Math.round(agentRangeDraft.radiusZ) }}</span>
              </div>
              <button
                class="obj-mini danger"
                @click="onClearAgentRange"
              >
                清除范围(回退频道)
              </button>
            </template>
            <div
              v-else
              class="ins-empty"
            >
              未设置:沿用频道边界活动;点「框选绘制」定制
            </div>

            <!-- 会话记录(侧边信息;历史 + 实时,不再悬浮于场景) -->
            <div class="obj-sep" />
            <div class="sect-hd chat-sect">
              会话记录 · {{ agentChatTitle }}
              <button
                class="mini-btn chat-refresh"
                title="重新拉取该角色的历史对话"
                @click="onRefreshHistory"
              >
                {{ historyLoading ? '…' : '↻' }}
              </button>
            </div>
            <div
              ref="chatScroll"
              class="rpg-lines chat-embed"
            >
              <div
                v-if="historyLoading"
                class="rpg-note"
              >
                正在读取历史对话…
              </div>
              <template v-if="agentHistory.length">
                <div class="rpg-divider">
                  历史记录 · {{ agentHistory.length }}
                </div>
                <div
                  v-for="r in agentHistory"
                  :key="r.id"
                  class="rpg-line hist"
                >
                  <span class="rpg-time">{{ fmtTime(r.at) }}</span>
                  <div class="rpg-bubble">
                    <span
                      v-if="chatKindLabel(r.kind)"
                      class="rpg-kind"
                      :class="`k-${r.kind}`"
                    >{{ chatKindLabel(r.kind) }}</span>
                    <span class="rpg-text">{{ r.text }}</span>
                  </div>
                </div>
              </template>
              <div
                v-if="agentChatRows.length"
                class="rpg-divider live"
              >
                实时 · {{ agentChatRows.length }}
              </div>
              <div
                v-for="r in agentChatRows"
                :key="r.id"
                class="rpg-line live"
              >
                <span class="rpg-time">{{ fmtTime(r.at) }}</span>
                <div class="rpg-bubble">
                  <span class="rpg-text">{{ r.text }}</span>
                </div>
              </div>
              <div
                v-if="selectedAgentMeta?.state === 'busy'"
                class="rpg-typing"
              >
                <span class="ty-dot" /><span class="ty-dot" /><span class="ty-dot" />
                <span class="ty-label">执行中</span>
              </div>
              <div
                v-if="!historyLoading && !agentHistory.length && !agentChatRows.length"
                class="rpg-note"
              >
                暂无对话 · 该员工尚未发言
              </div>
            </div>
          </template>
        </section>

        <section class="panel">
          <div class="panel-hd">
            <h3>设备运行状态</h3>
          </div>
          <div class="health-body">
            <div class="donut-wrap">
              <canvas
                ref="donutCanvas"
                width="118"
                height="118"
              />
              <div class="donut-center">
                <b>{{ healthPct }}%</b>
                <span>设备健康度</span>
              </div>
            </div>
            <div class="health-legend">
              <div class="hl-row">
                <span
                  class="hl-dot"
                  :style="{ background: 'var(--hud-accent)' }"
                />
                运行中
                <span class="n">{{ runningCount }}</span>
              </div>
              <div class="hl-row">
                <span
                  class="hl-dot"
                  :style="{ background: 'var(--hud-amber)' }"
                />
                待命
                <span class="n">{{ idleCount }}</span>
              </div>
              <div class="hl-row">
                <span
                  class="hl-dot"
                  :style="{ background: 'var(--hud-danger)' }"
                />
                告警
                <span class="n">{{ alarmCount }}</span>
              </div>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-hd">
            <h3>关键设备监控</h3>
            <span class="panel-tag">{{ deviceTwins.twins.length }}</span>
          </div>
          <WorkshopDeviceTwinPanel
            class="kd-embed"
            :daq-live="daqLive"
            @focus-device="onFocusDevice"
          />
        </section>

        <section class="panel">
          <div class="panel-hd">
            <h3>实时告警</h3>
            <span class="panel-tag">{{ activeAlarmCount }} 条</span>
            <button
              class="mini-btn"
              title="全部确认"
              @click="clearAlarms"
            >
              ✓
            </button>
          </div>
          <div class="alarm-list">
            <div
              v-for="a in alarms.slice(0, 8)"
              :key="a.id"
              class="al-row"
            >
              <span
                class="al-ico"
                :class="a.state === 2 ? 'info' : a.state === 1 ? 'warn' : 'crit'"
              >
                <svg
                  class="al-svg"
                  viewBox="0 0 24 24"
                ><path d="M12 3 22 20H2L12 3Z" /><path d="M12 10v4M12 17v.2" /></svg>
              </span>
              <div class="al-body">
                <div class="al-txt">
                  {{ a.txt }}
                </div>
                <div class="al-src">
                  {{ a.src }} · {{ a.time }}
                </div>
              </div>
              <button
                class="al-state"
                :class="`s${a.state}`"
                @click="advanceAlarm(a.id)"
              >
                {{ ALARM_STATES[a.state] }}
              </button>
            </div>
            <div
              v-if="!alarms.length"
              class="al-empty"
            >
              暂无告警，产线运行平稳
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-hd">
            <h3>实时事件</h3>
            <span class="panel-tag">{{ ticker.length }}</span>
          </div>
          <div class="event-list">
            <div
              v-for="(t, i) in [...ticker].reverse()"
              :key="`${t.at}-${i}`"
              class="event-row"
            >
              <span class="ev-time">{{ fmtTime(t.at) }}</span>
              <span
                class="ev-name"
                :title="t.agentName"
              >{{ t.agentName }}</span>
              <span
                class="ev-text"
                :title="t.text"
              >{{ t.text }}</span>
            </div>
            <div
              v-if="!ticker.length"
              class="event-empty"
            >
              事件总线待命
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-hd">
            <h3>3D 视图导航</h3>
          </div>
          <div class="mm-body">
            <div
              class="mm-wrap"
              title="RPG 导航图 · 准星=镜头 · 拖动平移 · 点击聚焦 · 滚轮同步视角缩放"
            >
              <canvas
                ref="navCanvas"
                class="nav-cv"
                @pointerdown="onNavDown"
                @pointermove="onNavMove"
                @pointerup="onNavUp"
                @pointercancel="onNavUp"
                @wheel.prevent="onNavWheel"
              />
            </div>
            <div class="mm-col">
              <button
                class="vp-tool"
                title="重置视角"
                @click="onResetView"
              >
                <svg
                  class="vp-svg"
                  viewBox="0 0 24 24"
                ><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" /></svg>
              </button>
              <button
                class="vp-tool"
                title="缩小视角(小地图同步)"
                @click="scene3dRef?.zoomBy(0.22)"
              >
                <svg
                  class="vp-svg"
                  viewBox="0 0 24 24"
                ><circle
                  cx="11"
                  cy="11"
                  r="6.5"
                /><path d="m16 16 4.5 4.5M8.5 11h5" /></svg>
              </button>
              <button
                class="vp-tool"
                title="放大视角(小地图同步)"
                @click="scene3dRef?.zoomBy(-0.18)"
              >
                <svg
                  class="vp-svg"
                  viewBox="0 0 24 24"
                ><circle
                  cx="11"
                  cy="11"
                  r="6.5"
                /><path d="m16 16 4.5 4.5M8.5 11h5M11 8.5v5" /></svg>
              </button>
            </div>
          </div>
          <div class="mm-meta mono">
            准星=镜头 · 同步视角 ×{{ navScale.toFixed(1) }} · {{ minimap?.devices?.length ?? 0 }} 设备
          </div>
        </section>
      </aside>
    </div>

    <!-- ================= 状态栏 ================= -->
    <footer class="statusbar">
      <span>
        <span
          class="sb-dot"
          :class="{ red: conn.state !== 'open' }"
        />系统状态 <b>{{ conn.state === 'open' ? '正常' : syncing ? '同步中' : '离线' }}</b>
      </span>
      <span class="sb-stats">
        频道 <b>{{ blockCount }}</b><i>·</i>员工 <b>{{ agentCount }}</b><i>·</i>设备 <b>{{ deviceCount }}</b>
      </span>
      <span class="sb-lat mono">
        {{ fps }} FPS
      </span>
      <span class="copy">
        © 2026 ABO · DIGITAL TWIN · 演示数据为模拟信号
      </span>
    </footer>

    <!-- 加载遮罩(全页) -->
    <div
      v-if="!ready"
      data-hud="town-loading"
      class="loading-mask"
    >
      <div class="loading-spinner" />
      <span class="loading-text">正在铺设数字孪生空间…</span>
    </div>
  </div>
</template>

<style scoped>
/* ============================================================
 * DIGITAL TWIN · 控制室 UI(设计稿 1:1 架构)
 * topnav 50 / 三栏网格(250 · 1fr · 342) / dock / statusbar 30
 * ============================================================ */
.town-view {
  --hud-bg: #070b13;
  --hud-panel: #0d1420;
  --hud-panel-2: #111a2b;
  --hud-panel-raised: #152034;
  --hud-panel-hover: #16233a;
  --hud-line: #1d2a42;
  --hud-line-soft: #16202f;
  --hud-line-hi: #2c4568;
  --hud-input: #0a111d;
  --hud-text: #e8eef8;
  --hud-dim: #8fa0b5;
  --hud-faint: #5f6e84;
  --hud-accent: #35e0a0;
  --hud-accent-dim: #1f9e6e;
  --hud-cyan: #41c8f4;
  --hud-amber: #f6c453;
  --hud-ok: #35e0a0;
  --hud-danger: #ff6b6b;
  --hud-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
  --hud-ease: cubic-bezier(0.22, 0.68, 0.36, 1);
  --hud-r-sm: 8px;
  --hud-r-md: 10px;
  --hud-r-lg: 12px;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--hud-bg);
  color: var(--hud-text);
  font-family: var(--font-body);
  font-size: 13px;
}

/* ===== 顶部导航 ===== */
.topnav {
  height: 50px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 16px;
  background: linear-gradient(180deg, #0c1320, #0a101b);
  border-bottom: 1px solid var(--hud-line-soft);
  position: relative;
  z-index: 60;
}
/* 顶栏下缘呼吸光:制造深度,不做渐变横幅 */
.topnav::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 1px;
  background: linear-gradient(90deg, transparent 4%, rgba(53, 224, 160, 0.35) 50%, transparent 96%);
  pointer-events: none;
}
.brand { display: flex; align-items: center; gap: 10px; min-width: 230px; }
.brand-glyph { width: 26px; height: 26px; flex: none; }
.brand-name { font-weight: 800; font-size: 14.5px; letter-spacing: 0.06em; }
.brand-name em { font-style: normal; color: var(--hud-accent); }
.brand-sub { font-size: 10px; color: var(--hud-faint); letter-spacing: 0.18em; margin-top: 2px; }
.nav-tabs {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 10px;
  align-items: center;
}
.nav-action {
  background: transparent;
  height: 32px;
  padding: 0 14px;
  border-radius: var(--hud-r-sm);
  font-size: 12px;
  font-weight: 600;
  color: var(--hud-text);
  border: 1px solid #27395c;
  transition: background 0.15s var(--hud-ease), border-color 0.15s var(--hud-ease);
}
.nav-action:hover { background: #14203a; border-color: #33507c; }
.save-chip {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  padding: 3px 9px;
  border-radius: 6px;
  border: 1px solid var(--hud-line);
  color: var(--hud-dim);
  white-space: nowrap;
}
.save-chip.s-dirty { color: var(--hud-amber); border-color: rgba(246, 196, 83, 0.4); }
.save-chip.s-saving { color: var(--hud-dim); }
.save-chip.s-saved { color: var(--hud-accent); border-color: rgba(53, 224, 160, 0.4); }
.save-chip.s-error { color: var(--hud-danger); border-color: rgba(255, 107, 107, 0.4); }
.nav-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.nav-chip {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--hud-dim);
  border: 1px solid var(--hud-line);
  border-radius: 6px;
  padding: 2px 8px;
  font-variant-numeric: tabular-nums;
}
.avatar-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px 4px 4px;
  border-radius: 999px;
  border: 1px solid var(--hud-line-soft);
  background: #0e1626;
}
.avatar-chip span { font-size: 12px; color: var(--hud-text); }
.avatar-fallback {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: linear-gradient(135deg, #1f9e6e, #41c8f4);
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 700;
  color: #04120c;
}
.seg {
  display: inline-flex;
  background: #0a111d;
  border: 1px solid var(--hud-line);
  border-radius: var(--hud-r-sm);
  padding: 2px;
}
.seg button {
  padding: 4px 16px;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--hud-dim);
  font-weight: 600;
  transition: background 0.15s var(--hud-ease), color 0.15s var(--hud-ease);
}
.seg button.on {
  background: var(--hud-accent);
  color: #04120c;
  box-shadow: 0 0 12px rgba(53, 224, 160, 0.35);
}

/* ===== 三栏应用区 ===== */
.app {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 250px minmax(540px, 1fr) 342px;
}
.rail {
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: #080d16;
}
.rail-left { border-right: 1px solid var(--hud-line-soft); }
.rail-right { border-left: 1px solid var(--hud-line-soft); }
.rail::-webkit-scrollbar { width: 8px; }
.rail::-webkit-scrollbar-thumb { background: #1c2942; border-radius: 4px; border: 2px solid #080d16; }
.rail::-webkit-scrollbar-track { background: transparent; }

.panel {
  background: linear-gradient(180deg, #101827 0%, #0d1420 100%);
  border: 1px solid var(--hud-line);
  border-radius: var(--hud-r-lg);
  padding: 12px;
  flex: none;
}
.panel-hd {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.panel-hd h3 {
  position: relative;
  margin: 0;
  padding-left: 11px;
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  flex: 1;
}
/* 左缘数据条:与 3D 场景名牌(makeLabel)同一 motif,双端一致 */
.panel-hd h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  width: 3px;
  height: 12px;
  transform: translateY(-50%);
  background: var(--hud-accent);
  border-radius: 2px;
  box-shadow: 0 0 8px color-mix(in srgb, var(--hud-accent) 45%, transparent);
}
.panel-tag {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--hud-cyan);
  background: rgba(65, 200, 244, 0.1);
  border: 1px solid rgba(65, 200, 244, 0.25);
  padding: 0 6px;
  border-radius: 6px;
  line-height: 15px;
}

/* ===== 左轨:资源 / DAQ / 场景管理 ===== */
.lib-embed { margin: -4px 0 0; }
.daq-list, .scene-list { display: flex; flex-direction: column; gap: 4px; }
.daq-card {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 8px 9px;
  border-radius: var(--hud-r-md);
  background: var(--hud-panel-2);
  border: 1px solid rgba(31, 74, 58, 0.55);
  margin-bottom: 4px;
  cursor: grab;
  transition: transform 0.15s var(--hud-ease), border-color 0.15s var(--hud-ease), background 0.15s var(--hud-ease);
}
.daq-card:hover {
  transform: translateY(-1px);
  border-color: rgba(53, 224, 160, 0.5);
  background: #12291f;
}
.daq-card:active { cursor: grabbing; }
.daq-ico {
  width: 34px;
  height: 34px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--hud-accent);
  border-radius: 9px;
  background: linear-gradient(160deg, #12291f, #0e1a24);
  border: 1px solid rgba(31, 74, 58, 0.65);
}
.daq-svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.daq-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.daq-name { font-size: 12px; font-weight: 600; color: var(--hud-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.daq-code { font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.08em; color: var(--hud-faint); }
.daq-count {
  flex: none;
  font-family: var(--font-mono);
  font-size: 9px;
  color: var(--hud-accent);
  background: rgba(53, 224, 160, 0.1);
  border: 1px solid rgba(53, 224, 160, 0.28);
  padding: 0 6px;
  border-radius: 6px;
  line-height: 15px;
}
.scene-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 9px;
  border-radius: var(--hud-r-md);
  border: 1px solid transparent;
  margin-bottom: 4px;
  cursor: grab;
  transition: background 0.15s var(--hud-ease), border-color 0.15s var(--hud-ease);
}
.scene-row:hover { background: #111b2c; }
.scene-row.active {
  background: rgba(53, 224, 160, 0.06);
  border-color: rgba(53, 224, 160, 0.35);
}
.scene-row:active { cursor: grabbing; }
.scene-ico {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  flex: none;
  background: color-mix(in srgb, var(--ch, var(--hud-accent)) 16%, #101a2c);
  border: 1px solid color-mix(in srgb, var(--ch, var(--hud-accent)) 45%, transparent);
}
.scene-row.active .scene-ico { box-shadow: 0 0 10px color-mix(in srgb, var(--ch, var(--hud-accent)) 40%, transparent); }
.scene-meta-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.scene-name { font-size: 12px; font-weight: 600; color: var(--hud-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.scene-meta { font-family: var(--font-mono); font-size: 9px; color: var(--hud-faint); }
.scene-cur, .scene-add {
  margin-left: auto;
  flex: none;
  font-size: 10px;
  border-radius: 6px;
  padding: 1px 7px;
}
.scene-cur { color: var(--hud-accent); border: 1px solid rgba(53, 224, 160, 0.4); }
.scene-add { color: var(--hud-dim); border: 1px solid var(--hud-line); }
.scene-hint {
  font-size: 10px;
  color: var(--hud-amber);
  padding: 6px 4px 0;
  line-height: 1.5;
}

/* ===== 舞台 ===== */
.stage-col { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.stage { flex: 1; position: relative; min-height: 320px; background: #060a11; overflow: hidden; }
.stage:fullscreen { border-radius: 0; }
.town-host { position: absolute; inset: 0; }
.town-host canvas { display: block; image-rendering: auto; }
.stage-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 3;
  background:
    radial-gradient(120% 90% at 50% 38%, transparent 52%, rgba(2, 4, 9, 0.5) 100%),
    linear-gradient(180deg, rgba(8, 13, 24, 0.32), transparent 18%),
    repeating-linear-gradient(0deg, rgba(255, 255, 255, 0.012) 0 1px, transparent 1px 3px);
}
.stage-top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 6;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 14px 16px;
  pointer-events: none;
}
.stage-top > * { pointer-events: auto; }
.vp-title {
  display: flex;
  align-items: center;
  gap: 10px;
  background: rgba(9, 14, 24, 0.72);
  border: 1px solid #1c2942;
  border-radius: var(--hud-r-md);
  padding: 8px 12px;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.vp-title h2 { margin: 0; font-size: 15px; font-weight: 700; letter-spacing: 0.02em; }
.vp-id {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--hud-dim);
  border: 1px solid #223050;
  border-radius: 6px;
  padding: 1px 8px;
  white-space: nowrap;
  background: rgba(10, 17, 29, 0.6);
}
.vp-tools { display: flex; gap: 8px; align-items: center; }
.vp-tool {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--hud-dim);
  background: rgba(13, 20, 32, 0.85);
  border: 1px solid #223050;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  font-size: 12px;
  font-weight: 600;
  transition: color 0.15s var(--hud-ease), border-color 0.15s var(--hud-ease), background 0.15s var(--hud-ease);
}
.vp-tool:hover { color: var(--hud-text); border-color: #33507c; }
.vp-tool.on {
  color: #04120c;
  background: var(--hud-accent);
  border-color: var(--hud-accent);
  box-shadow: 0 0 12px rgba(53, 224, 160, 0.3);
}
.vp-svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.leaders {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 7;
  pointer-events: none;
}
.angle-chip {
  position: absolute;
  top: 64px;
  left: 16px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(9, 14, 24, 0.78);
  border: 1px solid #1c2942;
  border-radius: var(--hud-r-sm);
  padding: 5px 8px;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  font-size: 11.5px;
  color: var(--hud-dim);
}
.angle-chip select {
  background: transparent;
  border: 0;
  color: var(--hud-text);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
}
.angle-chip select option { background: #0e1626; }

/* 标注层 */
.callout-layer {
  position: absolute;
  inset: 0;
  z-index: 7;
  pointer-events: none;
  overflow: hidden;
}
.callout {
  position: absolute;
  min-width: 150px;
  transform: translate(-50%, -112%) translateY(5px);
  opacity: 0;
  pointer-events: none;
  background: linear-gradient(180deg, rgba(16, 26, 43, 0.94), rgba(10, 16, 28, 0.94));
  border: 1px solid rgba(65, 200, 244, 0.4);
  border-radius: var(--hud-r-md);
  padding: 9px 12px 8px;
  box-shadow: var(--hud-shadow);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  transition: opacity 0.22s var(--hud-ease), transform 0.22s var(--hud-ease), border-color 0.15s var(--hud-ease);
}
/* 越近越亮:相机进入阈值半径后淡入上浮(数据只属于走近的人) */
.callout.near {
  opacity: 1;
  transform: translate(-50%, -112%);
  pointer-events: auto;
}
.leaders g { opacity: 0; transition: opacity 0.22s var(--hud-ease); }
.leaders g.near { opacity: 1; }
.callout.warn { border-color: rgba(246, 196, 83, 0.6); }
.co-label {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 10.5px;
  color: var(--hud-dim);
  white-space: nowrap;
}
.co-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--hud-cyan);
  box-shadow: 0 0 8px rgba(65, 200, 244, 0.9);
  flex: none;
}
.callout.warn .co-dot { background: var(--hud-amber); box-shadow: 0 0 8px rgba(246, 196, 83, 0.9); }
.co-val {
  font-family: var(--font-mono);
  font-size: 21px;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin-top: 2px;
  color: var(--hud-text);
  font-variant-numeric: tabular-nums;
}
.co-val small { font-size: 10.5px; color: var(--hud-dim); font-weight: 500; margin-left: 3px; }
.co-range {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--hud-faint);
  margin-top: 1px;
}
.callout.warn .co-range { color: var(--hud-amber); }

/* KPI 条 */
.kpi-strip {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 12px;
  z-index: 6;
  display: flex;
  gap: 10px;
  justify-content: center;
  padding: 0 16px;
  pointer-events: none;
  flex-wrap: wrap;
}
.kpi {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  pointer-events: auto;
  background: rgba(12, 19, 32, 0.9);
  border: 1px solid #1e2c46;
  border-radius: var(--hud-r-md);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  transition: border-color 0.2s var(--hud-ease), transform 0.2s var(--hud-ease);
}
.kpi:hover { border-color: #2c4568; transform: translateY(-1px); }
.kpi-ico {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  flex: none;
  font-size: 12px;
  font-weight: 700;
}
.kpi-ico.c1 { background: rgba(65, 200, 244, 0.12); color: var(--hud-cyan); }
.kpi-ico.c2 { background: rgba(53, 224, 160, 0.12); color: var(--hud-accent); }
.kpi-ico.c3 { background: rgba(246, 196, 83, 0.12); color: var(--hud-amber); }
.kpi-ico.c4 { background: rgba(167, 139, 250, 0.14); color: #a78bfa; }
.kpi-ico.c5 { background: rgba(255, 107, 107, 0.12); color: var(--hud-danger); }
.kpi-svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.kpi-meta { line-height: 1.25; }
.kpi-label { font-size: 10px; color: var(--hud-dim); letter-spacing: 0.08em; text-transform: uppercase; }
.kpi-val {
  font-family: var(--font-mono);
  font-size: 19px;
  font-weight: 700;
  color: var(--hud-text);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
}
.kpi-val small { font-size: 10px; color: var(--hud-faint); font-weight: 500; margin-left: 2px; }
.empty-hint {
  position: absolute;
  left: 50%;
  top: 44%;
  transform: translate(-50%, -50%);
  z-index: 4;
  text-align: center;
  color: var(--hud-dim);
  pointer-events: none;
}
.empty-hint b { color: var(--hud-text); font-size: 14px; display: block; margin-bottom: 4px; }
.empty-hint span { font-size: 12px; }

/* ===== 底部坞 ===== */
.dock {
  flex: none;
  display: grid;
  grid-template-columns: 308px 1fr;
  gap: 10px;
  padding: 10px;
  background: #080d16;
  border-top: 1px solid var(--hud-line-soft);
}
.dock-card {
  background: linear-gradient(180deg, #101827 0%, #0d1420 100%);
  border: 1px solid var(--hud-line);
  border-radius: var(--hud-r-lg);
  padding: 12px 14px;
  min-height: 178px;
  display: flex;
  flex-direction: column;
}
.dock-hd { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.dock-hd h3 { margin: 0; font-size: 12.5px; font-weight: 700; flex: 1; }
.dock-mode {
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  color: var(--hud-faint);
  border: 1px solid var(--hud-line);
  border-radius: 6px;
  padding: 1px 7px;
}
.ctl-row { display: flex; align-items: center; gap: 10px; margin-bottom: 9px; }
.ctl-name { font-size: 11.5px; color: var(--hud-dim); width: 64px; flex: none; }
.ctl-val {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--hud-text);
  width: 38px;
  text-align: right;
  flex: none;
  font-variant-numeric: tabular-nums;
}
.ctl-range {
  -webkit-appearance: none;
  appearance: none;
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--hud-accent-dim) var(--fill, 50%), #1d2a42 var(--fill, 50%));
  cursor: pointer;
}
.ctl-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  border: 2.5px solid var(--hud-accent);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  transition: transform 0.15s var(--hud-ease), box-shadow 0.15s var(--hud-ease);
}
.ctl-range:hover::-webkit-slider-thumb { transform: scale(1.18); box-shadow: 0 0 0 5px rgba(53, 224, 160, 0.12), 0 1px 4px rgba(0, 0, 0, 0.5); }
.ctl-range:active::-webkit-slider-thumb { transform: scale(1.05); }
.bp-range { accent-color: var(--hud-accent); }
.bp-range::-webkit-slider-thumb { transition: transform 0.15s var(--hud-ease); }
.bp-range:hover::-webkit-slider-thumb { transform: scale(1.15); }
.snap-toggle {
  flex: 1;
  height: 22px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--hud-dim);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 6px;
  cursor: pointer;
}
.snap-toggle.on { color: var(--hud-accent); border-color: rgba(53, 224, 160, 0.4); background: rgba(53, 224, 160, 0.08); }
.ctl-btns { display: flex; gap: 8px; margin-top: auto; }
.btn {
  background: transparent;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--hud-r-sm);
  font-size: 12px;
  font-weight: 600;
  flex: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: filter 0.15s var(--hud-ease), background 0.15s var(--hud-ease), border-color 0.15s var(--hud-ease);
}
.btn-primary { background: var(--hud-accent-dim); color: #04120c; }
.btn-primary:hover { background: #25b57e; }
.btn-ghost { border: 1px solid #27395c; color: var(--hud-text); }
.btn-ghost:hover { background: #14203a; border-color: #33507c; }
.btn-danger { background: #b3273a; color: #fff; }
.btn-danger:hover { background: #d1304a; }
.btn:not(:disabled):active { transform: translateY(1px); }
/* 只读态:禁用控件降透明度 + 禁止光标(运行模式视觉语言) */
.btn:disabled, .nav-action:disabled, .obj-input:disabled, .obj-select:disabled,
.bind-select:disabled, .obj-mini:disabled {
  opacity: 0.38;
  cursor: not-allowed;
  filter: saturate(0.4);
}
.btn:disabled:hover, .nav-action:disabled:hover { background: inherit; }

/* 趋势 */
.trend-legend { display: flex; gap: 5px; flex-wrap: wrap; margin-left: auto; }
.lg-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: var(--hud-dim);
  border: 1px solid var(--hud-line);
  border-radius: 6px;
  padding: 2px 8px;
  cursor: pointer;
  transition: opacity 0.15s var(--hud-ease);
}
.lg-chip.off { opacity: 0.32; }
.lg-dot { width: 7px; height: 7px; border-radius: 2px; }
.trend-wrap { flex: 1; min-height: 0; position: relative; }
.trend-cv { position: absolute; inset: 0; width: 100%; height: 100%; }
.trend-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--hud-faint);
}

/* ===== 右轨 ===== */
.inspector { animation: rise 0.18s var(--hud-ease); }
@keyframes rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.ins-chip-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.ins-chip {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--hud-dim);
  border: 1px solid #26354a;
  border-radius: 6px;
  padding: 1.5px 7px;
}
.ins-chip.accent { color: var(--hud-accent); border-color: rgba(53, 224, 160, 0.4); }
.sect-hd {
  font-size: 10px;
  color: var(--hud-faint);
  letter-spacing: 0.16em;
  font-weight: 700;
  margin: 10px 0 7px;
}
.obj-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.obj-label { flex: none; width: 52px; font-size: 10.5px; color: var(--hud-dim); }
.obj-input, .obj-select {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--hud-text);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 7px;
  padding: 5px 8px;
  transition: border-color 0.15s var(--hud-ease);
}
.obj-input:focus, .obj-select:focus { outline: none; border-color: var(--hud-accent); }
.obj-sep { height: 1px; background: var(--hud-line-soft); margin: 8px 0; }
.range-status { flex: 1; min-width: 0; font-size: 10px; color: var(--hud-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.obj-mini {
  flex: none;
  padding: 4px 10px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--hud-dim);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 7px;
  cursor: pointer;
}
.obj-mini.on { color: #04120c; background: var(--hud-accent); border-color: var(--hud-accent); }
.obj-mini.danger { color: var(--hud-danger); margin-top: 4px; width: 100%; }
.obj-range { flex: 1; accent-color: var(--hud-accent); }
.bp-val {
  flex: none;
  width: 40px;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--hud-text);
  font-variant-numeric: tabular-nums;
}
.bp-seg { display: flex; gap: 4px; }
.seg-btn {
  padding: 4px 12px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--hud-dim);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 7px;
  cursor: pointer;
  transition: border-color 0.14s var(--hud-ease), color 0.14s var(--hud-ease), background 0.14s var(--hud-ease);
}
.seg-btn:hover { border-color: var(--hud-line-hi); color: var(--hud-text); }
.seg-btn.on { color: #04120c; background: var(--hud-accent); border-color: var(--hud-accent); }
.xz-seg { display: flex; gap: 6px; margin-bottom: 8px; }
.xz-seg .seg-btn { flex: 1; }
.scale-row { display: flex; gap: 8px; align-items: center; }
.scale-min, .scale-max { font-family: var(--font-mono); font-size: 9px; color: var(--hud-faint); }
.scale-range { flex: 1; accent-color: var(--hud-accent); }
.scale-val {
  text-align: center;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--hud-text);
  font-variant-numeric: tabular-nums;
  margin-bottom: 4px;
}
.ins-foot { display: flex; gap: 8px; margin-top: 12px; }
.ins-del { border: 0; background: rgba(255, 107, 107, 0.1); color: var(--hud-danger); border: 1px solid rgba(255, 107, 107, 0.4); }
.ins-del.armed { background: var(--hud-danger); color: #fff; }
.ins-empty { color: var(--hud-faint); font-size: 11px; text-align: center; padding: 8px 0 6px; }

/* 设备健康环 */
.health-body { display: flex; align-items: center; gap: 14px; }
.donut-wrap { position: relative; width: 118px; height: 118px; flex: none; }
.donut-wrap canvas { width: 118px; height: 118px; }
.donut-center {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  text-align: center;
}
.donut-center b { font-family: var(--font-mono); font-size: 21px; font-weight: 700; color: var(--hud-accent); }
.donut-center span { font-size: 9.5px; color: var(--hud-faint); }
.health-legend { flex: 1; display: flex; flex-direction: column; gap: 8px; }
.hl-row { display: flex; align-items: center; gap: 7px; font-size: 11.5px; }
.hl-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.hl-row .n { margin-left: auto; font-family: var(--font-mono); font-weight: 700; font-size: 13px; color: var(--hud-text); }

/* 实时事件 */
.event-list {
  flex: 1;
  min-height: 0;
  max-height: 200px;
  display: flex;
  flex-direction: column;
  overflow: hidden auto;
}
.event-row {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 4px 6px;
  border-radius: 7px;
  transition: background 0.13s var(--hud-ease);
}
.event-row:hover { background: rgba(53, 224, 160, 0.05); }
.ev-time { flex: none; font-family: var(--font-mono); font-size: 9px; font-variant-numeric: tabular-nums; color: var(--hud-faint); }
.ev-name {
  flex: none;
  max-width: 70px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  color: var(--hud-text);
}
.ev-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10.5px;
  color: var(--hud-dim);
}
.event-empty { padding: 12px; font-family: var(--font-mono); font-size: 9.5px; color: var(--hud-faint); text-align: center; }

/* 导航图 */
.mm-body { display: flex; gap: 8px; align-items: stretch; }
.mm-wrap {
  flex: 1;
  position: relative;
  border-radius: var(--hud-r-md);
  overflow: hidden;
  border: 1px solid #223050;
  min-height: 148px;
  background: #060b13;
}
.mini-svg { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; }
.nav-cv { position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair; touch-action: none; }
.alarm-list { display: flex; flex-direction: column; }
.al-row {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  padding: 9px 8px;
  border-radius: var(--hud-r-md);
  transition: background 0.15s;
}
.al-row:hover { background: #101a2c; }
.al-ico {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  flex: none;
}
.al-ico.crit { background: rgba(255, 107, 107, 0.12); color: var(--hud-danger); }
.al-ico.warn { background: rgba(246, 196, 83, 0.12); color: var(--hud-amber); }
.al-ico.info { background: rgba(65, 200, 244, 0.12); color: var(--hud-cyan); }
.al-svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.al-body { flex: 1; min-width: 0; }
.al-txt { font-size: 12px; font-weight: 500; line-height: 1.35; color: var(--hud-text); }
.al-src { font-family: var(--font-mono); font-size: 9.5px; color: var(--hud-faint); margin-top: 2px; }
.al-state {
  font-size: 9.5px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 6px;
  flex: none;
  cursor: pointer;
  border: 1px solid;
  background: transparent;
  margin-top: 2px;
}
.al-state.s0 { color: var(--hud-danger); background: rgba(255, 107, 107, 0.1); border-color: rgba(255, 107, 107, 0.4); }
.al-state.s1 { color: var(--hud-amber); background: rgba(246, 196, 83, 0.1); border-color: rgba(246, 196, 83, 0.35); }
.al-state.s2 { color: var(--hud-dim); background: rgba(143, 160, 181, 0.08); border-color: rgba(143, 160, 181, 0.3); }
.al-empty { color: var(--hud-faint); font-size: 11.5px; text-align: center; padding: 14px 0; }
.nav-bell-warn { color: var(--hud-danger); border-color: rgba(255, 107, 107, 0.5); }
.mm-col { display: flex; flex-direction: column; gap: 6px; }
.mm-col .vp-tool { width: 30px; height: 30px; border-radius: 8px; }
.mm-meta {
  margin-top: 8px;
  font-size: 9.5px;
  color: var(--hud-faint);
  letter-spacing: 0.08em;
  text-align: center;
}

/* ===== 浮动:员工会话台 / 频道边界 / 芯片 ===== */
/* 会话记录侧边嵌入态:静态入轨,高度受限滚动(悬浮壳已废) */
.rpg-lines.chat-embed {
  max-height: 268px;
  padding: 2px 0 4px;
  background: rgba(15, 23, 38, 0.5);
  border: 1px solid var(--hud-line-soft);
  border-radius: var(--hud-r-md);
}
.chat-sect {
  display: flex;
  align-items: center;
  gap: 8px;
}
.chat-sect .chat-refresh { margin-left: auto; }
.chat-id-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}
.chat-badge {
  --p-acc: var(--hud-accent);
  flex: none;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  font-family: var(--font-mono);
  font-size: 15px;
  font-weight: 700;
  color: var(--p-acc);
  background: color-mix(in srgb, var(--p-acc) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--p-acc) 45%, transparent);
  border-radius: var(--hud-r-sm);
}
.chat-nameplate { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.chat-name { font-size: 13px; font-weight: 650; color: var(--hud-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-meta { display: flex; gap: 6px; align-items: center; }
.chat-state {
  font-family: var(--font-mono);
  font-size: 8.5px;
  letter-spacing: 0.1em;
  color: var(--hud-dim);
  padding: 1px 6px;
  border: 1px solid var(--hud-line);
  border-radius: 6px;
}
/* 职务章:Leader(琥珀=指挥)/ Worker(青=执行),与 KPI 语义色同源 */
.chat-role {
  font-family: var(--font-mono);
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  padding: 1px 7px;
  border-radius: 6px;
}
.chat-role.r-lead { color: var(--hud-amber); background: rgba(246, 196, 83, 0.1); border: 1px solid rgba(246, 196, 83, 0.45); }
.chat-role.r-worker { color: var(--hud-cyan); background: rgba(65, 200, 244, 0.1); border: 1px solid rgba(65, 200, 244, 0.4); }
.chat-state.s-busy { color: var(--hud-amber); border-color: rgba(246, 196, 83, 0.5); }
.chat-state.s-stopped { color: var(--hud-danger); border-color: rgba(255, 107, 107, 0.5); }
.chat-harness { font-family: var(--font-mono); font-size: 8.5px; letter-spacing: 0.1em; color: var(--hud-faint); }
.chat-count { font-family: var(--font-mono); font-size: 8.5px; color: var(--hud-faint); }
.chat-refresh {
  flex: none;
  width: 22px;
  height: 22px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--hud-dim);
  background: transparent;
  border: 1px solid var(--hud-line);
  border-radius: 6px;
  cursor: pointer;
  transition: border-color 0.14s var(--hud-ease), color 0.14s var(--hud-ease), transform 0.32s var(--hud-ease);
}
.chat-refresh:hover { border-color: var(--hud-accent); color: var(--hud-accent); }
.chat-refresh:active { transform: rotate(180deg); }
.rpg-lines {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px 12px;
  overflow: hidden auto;
}
.rpg-divider { margin: 4px 0 2px; font-family: var(--font-mono); font-size: 8.5px; letter-spacing: 0.2em; color: var(--hud-faint); }
.rpg-divider.live { color: var(--hud-amber); }
.rpg-line { display: flex; gap: 8px; align-items: flex-start; }
.rpg-time {
  flex: none;
  width: 52px;
  text-align: right;
  margin-top: 5px;
  font-family: var(--font-mono);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  color: var(--hud-faint);
}
.rpg-bubble {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 11px;
  background: var(--hud-panel-2);
  border: 1px solid var(--hud-line);
  border-radius: var(--hud-r-md);
}
.rpg-line.hist { opacity: 0.62; }
.rpg-line.live .rpg-bubble {
  animation: rise 0.26s var(--hud-ease) both;
  background: #14213a;
  border-color: var(--hud-line-hi);
}
.rpg-kind { align-self: flex-start; font-family: var(--font-mono); font-size: 8px; letter-spacing: 0.14em; color: var(--hud-faint); }
.rpg-kind.k-artifact { color: var(--hud-accent); }
.rpg-kind.k-error { color: var(--hud-danger); }
.rpg-text { font-size: 13px; line-height: 1.6; color: var(--hud-text); word-break: break-word; text-wrap: pretty; }
.rpg-line.live .rpg-text { color: #edf4fa; }
.rpg-typing { display: flex; gap: 4px; align-items: center; padding: 5px 2px; }
.ty-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--hud-amber);
  animation: ty-bounce 1.15s var(--hud-ease) infinite;
}
.ty-dot:nth-child(2) { animation-delay: 0.15s; }
.ty-dot:nth-child(3) { animation-delay: 0.3s; }
.ty-label { margin-left: 5px; font-family: var(--font-mono); font-size: 9px; color: var(--hud-faint); }
.rpg-note { font-family: var(--font-mono); font-size: 10px; color: var(--hud-dim); text-align: center; padding: 14px 0; }

/* 频道边界编辑(浮动) */
.boundary-panel {
  position: absolute;
  top: 84px;
  left: 16px;
  width: 302px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 12px 14px;
  z-index: 9;
  background: linear-gradient(180deg, rgba(16, 24, 39, 0.97), rgba(13, 20, 32, 0.97));
  border: 1px solid var(--hud-line);
  border-radius: var(--hud-r-lg);
  box-shadow: var(--hud-shadow);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  pointer-events: auto;
}
.bp-title { display: flex; gap: 8px; align-items: center; padding-bottom: 8px; border-bottom: 1px solid var(--hud-line); cursor: grab; touch-action: none; }
.bp-title:active { cursor: grabbing; }
.bp-name { font-size: 13px; font-weight: 700; color: var(--hud-text); }
.bp-sub { font-family: var(--font-mono); font-size: 8.5px; letter-spacing: 0.12em; color: var(--hud-faint); }
.bp-tabs { display: flex; gap: 4px; margin-left: auto; }
.bp-tab {
  padding: 3px 10px;
  font-size: 10px;
  font-weight: 600;
  color: var(--hud-dim);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 6px;
  cursor: pointer;
}
.bp-tab.on { color: #04120c; background: var(--hud-accent); border-color: var(--hud-accent); }
.bp-row { display: flex; gap: 8px; align-items: center; }
.bp-label { flex: none; width: 52px; font-size: 10.5px; color: var(--hud-dim); }
.bp-range {
  -webkit-appearance: none;
  appearance: none;
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--hud-accent-dim) var(--fill, 50%), #1d2a42 var(--fill, 50%));
  cursor: pointer;
}
.bp-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  border: 2px solid var(--hud-accent);
  transition: transform 0.15s var(--hud-ease);
}
.bp-range:hover::-webkit-slider-thumb { transform: scale(1.15); }
.bp-hint { font-size: 10px; line-height: 1.6; color: var(--hud-faint); }
.bp-actions { display: flex; gap: 6px; margin-top: 4px; }
.bp-btn {
  flex: 1;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--hud-text);
  background: transparent;
  border: 1px solid #27395c;
  border-radius: var(--hud-r-sm);
  cursor: pointer;
}
.bp-btn:hover { border-color: #33507c; background: #14203a; }
.bp-btn.save { color: #04120c; background: var(--hud-accent-dim); border-color: var(--hud-accent-dim); }
.bp-btn.save:hover { background: #25b57e; }
.bp-btn.danger { color: var(--hud-danger); border-color: rgba(255, 107, 107, 0.4); }
.bp-btn.danger:hover { background: rgba(255, 107, 107, 0.1); }
.member-list { display: flex; flex-direction: column; gap: 5px; max-height: 220px; overflow: hidden auto; }
.member-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  background: var(--hud-panel-2);
  border: 1px solid var(--hud-line-soft);
  border-radius: var(--hud-r-md);
}
.member-ava {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  color: var(--hud-text);
  background: var(--hud-panel-raised);
  border: 1px solid var(--hud-line);
  border-radius: 7px;
}
.member-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.member-name { font-size: 11px; font-weight: 600; color: var(--hud-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.member-role { font-family: var(--font-mono); font-size: 8.5px; letter-spacing: 0.06em; color: var(--hud-faint); }
.member-role.r-lead { color: var(--hud-amber); }
.member-role.r-worker { color: var(--hud-cyan); }
.member-select { flex: 1; min-width: 0; font-size: 10px; color: var(--hud-text); background: var(--hud-input); border: 1px solid var(--hud-line); border-radius: 6px; padding: 3px 6px; }

/* 芯片(Toast 风) */
.drop-chip, .error-chip {
  position: absolute;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 14px;
  font-size: 11.5px;
  background: rgba(14, 22, 38, 0.96);
  border: 1px solid #2a3d63;
  border-radius: var(--hud-r-md);
  box-shadow: var(--hud-shadow);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  max-width: 70%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drop-chip { color: var(--hud-accent); }
.error-chip { color: var(--hud-danger); border-color: rgba(255, 107, 107, 0.4); }

/* 数采绑定/信息 */
/* 数采绑定行(设计稿 bind-row:图标 + 通道 + 实时值 + 迷你折线 + 解绑) */
.bind-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 7px 9px;
  margin-bottom: 6px;
  background: #0f1726;
  border: 1px solid var(--hud-line-soft);
  border-radius: var(--hud-r-md);
}
.bind-ico {
  width: 26px;
  height: 26px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--hud-accent);
  background: #0d1a26;
  border-radius: 7px;
}
.bind-svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.bind-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.bind-label { font-size: 11px; font-weight: 600; color: var(--hud-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bind-val { font-family: var(--font-mono); font-size: 10px; color: var(--hud-cyan); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bind-val b { font-size: 11px; font-weight: 700; }
.bind-spark { width: 56px; height: 20px; flex: none; }
.bind-x {
  flex: none;
  width: 22px;
  height: 22px;
  color: var(--hud-faint);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}
.bind-x:hover { background: rgba(255, 107, 107, 0.12); color: var(--hud-danger); }
.bind-add-wrap { position: relative; }
.bind-add {
  width: 100%;
  height: 30px;
  font-size: 11px;
  color: var(--hud-dim);
  background: transparent;
  border: 1px dashed #274064;
  border-radius: var(--hud-r-sm);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.bind-add:hover { border-color: var(--hud-accent-dim); color: var(--hud-accent); }
.bind-pop {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 4px);
  z-index: 30;
  overflow: hidden;
  background: #0e1626;
  border: 1px solid #27395c;
  border-radius: var(--hud-r-md);
  box-shadow: var(--hud-shadow-pop, 0 16px 40px rgba(0, 0, 0, 0.55));
}
.bind-pop button {
  display: flex;
  width: 100%;
  gap: 8px;
  align-items: center;
  padding: 7px 10px;
  font-size: 11.5px;
  color: var(--hud-dim);
  background: transparent;
  border: 0;
  cursor: pointer;
}
.bind-pop button:hover { background: #12203a; color: var(--hud-text); }
.bind-pop .bind-svg { color: var(--hud-accent); }
.daq-bind-bar { display: flex; gap: 6px; }
.bind-select {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: var(--hud-dim);
  background: var(--hud-input);
  border: 1px dashed #274064;
  border-radius: var(--hud-r-sm);
  padding: 5px 8px;
}
.bind-select:focus { outline: none; border-color: var(--hud-accent); color: var(--hud-text); }
.bind-add-btn {
  flex: none;
  height: 28px;
  padding: 0 12px;
  font-size: 10.5px;
  font-weight: 600;
  color: #04120c;
  background: var(--hud-accent-dim);
  border: 0;
  border-radius: var(--hud-r-sm);
  cursor: pointer;
}
.bind-add-btn:disabled { opacity: 0.4; cursor: default; }
.daq-info-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: var(--hud-dim);
  padding: 3px 0;
}
.daq-info-row b { font-family: var(--font-mono); font-weight: 600; color: var(--hud-text); font-variant-numeric: tabular-nums; }
.daq-info-row b.cy { color: var(--hud-cyan); font-size: 13px; }

/* ===== 数采总控(左轨)+ 节点单点控制(检查器)===== */
.daq-ctrl {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  margin-bottom: 10px;
  background: var(--hud-panel);
  border: 1px solid var(--hud-line);
  border-radius: var(--hud-r-sm);
}
.daq-ctl-btn {
  padding: 4px 12px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.05em;
  color: var(--hud-dim);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--hud-line-hi);
  border-radius: var(--hud-r-sm);
}
.daq-ctl-btn.on {
  color: var(--hud-accent);
  border-color: rgba(53, 224, 160, 0.45);
}
.daq-ctl-cycle {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  font-size: 10.5px;
  color: var(--hud-faint);
}
.daq-ctl-cycle input,
.daq-num {
  width: 64px;
  padding: 2px 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--hud-text);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 6px;
}
.daq-th-inputs {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  font-size: 10px;
  color: var(--hud-faint);
}
.bind-add-btn.warn:not(:disabled) {
  color: var(--hud-amber);
  border-color: rgba(246, 196, 83, 0.4);
}
.bind-add-btn.danger:not(:disabled) {
  color: var(--hud-danger);
  border-color: rgba(255, 107, 107, 0.4);
}

/* ===== 状态栏 ===== */
.statusbar {
  height: 30px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 14px;
  background: #0a101b;
  border-top: 1px solid var(--hud-line-soft);
  font-size: 11px;
  color: var(--hud-dim);
  position: relative;
  z-index: 60;
}
.statusbar b { color: var(--hud-accent); font-weight: 600; }
.statusbar .sb-stats {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.sb-stats b { color: var(--hud-text); font-weight: 600; }
.sb-stats i { font-style: normal; color: var(--hud-line-hi); }
.sb-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--hud-accent);
  box-shadow: 0 0 6px var(--hud-accent);
  display: inline-block;
  margin-right: 6px;
  vertical-align: 1px;
}
.sb-dot.red { background: var(--hud-danger); box-shadow: 0 0 6px var(--hud-danger); }
.sb-dot:not(.red) { animation: sb-pulse 2.4s var(--hud-ease) infinite; }
@keyframes sb-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@media (prefers-reduced-motion: reduce) {
  .sb-dot:not(.red) { animation: none; }
}
.sb-lat {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.statusbar .copy { margin-left: auto; color: var(--hud-faint); font-family: var(--font-mono); font-size: 10px; }

/* ===== 加载遮罩 ===== */
.loading-mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-items: center;
  justify-content: center;
  background: var(--hud-bg);
}
.loading-spinner {
  width: 30px;
  height: 30px;
  border: 2.5px solid var(--hud-line);
  border-top-color: var(--hud-accent);
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
.loading-text {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.24em;
  color: var(--hud-dim);
}
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes ty-bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
  30% { transform: translateY(-3px); opacity: 1; }
}

/* 拖动面板抓手 */
.drag-grip { cursor: grab; touch-action: none; }
.drag-grip:active { cursor: grabbing; }
.drag-panel { will-change: left, top; }

/* 滚动条 */
.town-view ::-webkit-scrollbar { width: 8px; height: 8px; }
.town-view ::-webkit-scrollbar-track { background: transparent; }
.town-view ::-webkit-scrollbar-thumb { background: #1c2942; border-radius: 4px; border: 2px solid #080d16; }
.town-view ::-webkit-scrollbar-thumb:hover { background: #2c4568; }

/* ============================================================
 * 微交互抛光(丝滑:统一曲线 + 按压反馈 + 键盘焦点环 + 降级动画)
 * ============================================================ */
/* 按压态:轻微下沉,松手回弹(所有可点元件统一手感) */
.btn:active, .vp-tool:active, .mini-btn:active, .snap-toggle:active,
.lg-chip:active, .bind-add:active, .bind-x:active, .al-state:active,
.bp-btn:active, .obj-mini:active {
  transform: scale(0.96);
}
.btn, .vp-tool, .mini-btn, .snap-toggle, .lg-chip, .bind-add, .al-state, .bp-btn, .obj-mini {
  transition-property: filter, background, border-color, color, transform, opacity;
  transition-duration: 0.15s;
  transition-timing-function: var(--hud-ease);
}
/* 键盘可达:焦点环(设计稿 --focus-ring) */
.town-view button:focus-visible,
.town-view input:focus-visible,
.town-view select:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--hud-bg), 0 0 0 4px rgba(65, 200, 244, 0.45);
  border-radius: 6px;
}
/* 视口标题明确亮色(避免继承发灰) */
.vp-title h2 { color: var(--hud-text); }
/* E-STOP armed 呼吸(设计稿 estop keyframes) */
@keyframes estop-pulse { 50% { filter: brightness(1.35); } }
.btn-danger.armed { animation: estop-pulse 1s ease-in-out infinite; }
/* 减少动态偏好:关停入场/呼吸动画 */
@media (prefers-reduced-motion: reduce) {
  .inspector, .callout { animation: none; }
  .btn-danger.armed { animation: none; }
}

@media (prefers-reduced-motion: reduce) {
  .rpg-line.live .rpg-bubble, .ty-dot, .loading-spinner { animation: none; }
}

/* 窄屏:轨道收为抽屉 */
@media (max-width: 1180px) {
  .app { grid-template-columns: 0 1fr 0; }
  .rail { position: fixed; top: 50px; bottom: 30px; z-index: 70; width: 288px; background: #0a101b; transition: transform 0.22s var(--hud-ease); box-shadow: var(--hud-shadow); }
  .rail-left { left: 0; transform: translateX(-104%); }
  .rail-right { right: 0; transform: translateX(104%); }
  .dock { grid-template-columns: 1fr; }
  .stage-dock { grid-template-columns: 1fr; }
}
</style>
