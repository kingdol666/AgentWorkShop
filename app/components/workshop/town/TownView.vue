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
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { useTownBus } from '@/app/composables/workshop/useTownBus'
import { useCharacterAssets } from '@/app/composables/workshop/useCharacterAssets'
import { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'
import { useSceneLayouts } from '@/app/composables/workshop/useSceneLayouts'
import { useHttp } from '@/app/composables/useHttp'
import type { TownScene, TownEntityInput } from './TownScene'
import type { TownScene3D, ChannelLayout, AgentRangeLayout } from './TownScene3D'
// 频道身份色/世界尺度与 3D 场景同源(避免 UI 与场景两套色相哈希分叉)
import { WORLD_H, WORLD_W, channelColorCss } from '#shared/town-scene-math'

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
function toggleSnap(): void {
  snap.value = !snap.value
  scene3dRef.value?.setSnap(snap.value)
}
/** Admin 布局:持久化角色落点(改 config.homeX/homeZ;与 modelRef 合并保留) */
function updateAgentHome(agentId: string, x: number, z: number): Promise<unknown> {
  if (!props.channelId) return Promise.resolve()
  return http.request({
    method: 'PATCH',
    url: `/workshop/channels/${props.channelId}/agents/${agentId}/position`,
    data: { x, z },
  }).catch(() => null)
}
/** Admin 布局:持久化角色独立活动范围(改 config.range;null 清除回退频道边界) */
function updateAgentRange(agentId: string, range: AgentRangeLayout | null): Promise<unknown> {
  if (!props.channelId) return Promise.resolve()
  return http.request({
    method: 'PATCH',
    url: `/workshop/channels/${props.channelId}/agents/${agentId}/range`,
    data: { range },
  }).catch(() => null)
}
/** 保存布局:强制全部设备 transform 落库 */
function saveLayout(): void {
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
/** 旋转滑杆(编辑模式设备):实时 + 松手落库 */
function onRotationInput(v: number): void {
  if (!selected.value) return
  scene3dRef.value?.setModelRotation(selected.value.id, v, selected.value.kind)
}
function onRotationCommit(): void {
  if (!selected.value) return
  scene3dRef.value?.persistDeviceTransform(selected.value.id)
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
  if (!r) return '未设置 · 沿用频道领地'
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
/** 删除选中设备实例(移除孪生 + 场景节点) */
async function removeSelectedDevice(): Promise<void> {
  const sel = selected.value
  if (!sel || sel.kind !== 'device') return
  const name = scene3dRef.value?.getDeviceName?.(sel.id) ?? sel.id
  if (!window.confirm(`确定移除设备实例「${name}」吗?`)) return
  try {
    await scene3dRef.value?.removeDevice(sel.id)
    closeScale()
  }
  catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
  }
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
    scene.registerModelsFromList(characterAssets.models.map(m => ({ id: m.id, file: m.file, name: m.name, kind: m.kind })))
  }
  else {
    scene.registerModelsFromList(characterAssets.models.map(m => ({ id: m.id, file: m.file, name: m.name })))
  }
}

watch(() => characterAssets.models, () => syncSceneModels(sceneRef.value), { deep: true })

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
      await deviceTwins.update(id, patch)
      return undefined
    },
    async remove(id) {
      await deviceTwins.remove(id)
    },
    async control(id, command, args) {
      return deviceTwins.control(id, command, args)
    },
  }
  // 注入管理员布局:持久化角色落点 + 独立活动范围
  scene.agentApi = {
    async updateHome(agentId, x, z) {
      return updateAgentHome(agentId, x, z)
    },
    async updateRange(agentId, range) {
      return updateAgentRange(agentId, range)
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
  // (频道布局 + 实体基线 + 设备孪生 → hydrate;仅放置的频道呈现;失败保持空场地)
  void sceneLayouts.load().then(() => {
    scene.hydrate(buildTownInput(), Object.values(sceneLayouts.layouts), deviceTwins.twins)
    syncChannelDock()
  }).catch(() => {})
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
        if (props.channelId) scene.focusChannel(props.channelId)
        return
      }
      // 设备场景事件(device.created/updated/deleted):重拉清单 → 场景即时同步
      if (e.type === 'device.created' || e.type === 'device.updated' || e.type === 'device.deleted') {
        void deviceTwins.load().then(() => {
          if (sceneRef.value) syncSceneDevices(sceneRef.value)
        })
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
  window.addEventListener('pointermove', (e: PointerEvent) => {
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
  })
  window.addEventListener('pointerup', () => {
    draggingCam = false
  })

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

/** 3D(Three.js):用 scene.canvas + scene.screenToWorld + panBy/zoomBy */
function bindSceneInput3D(scene: TownScene3D): void {
  const canvas = scene.canvas
  if (!canvas) return

  // ---- 相机拖拽平移(页面位移 → scene.panBy) ----
  let draggingCam = false
  let lastCX = 0
  let lastCY = 0
  canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return
    // 编辑模式:先问场景是否接管(拖设备/角色落点);接管则本手势不再平移相机
    if (scene.tryStartPointerDrag(e.clientX, e.clientY)) return
    draggingCam = true
    lastCX = e.clientX
    lastCY = e.clientY
  })
  window.addEventListener('pointermove', (e: PointerEvent) => {
    if (scene.isPointerDragging()) {
      scene.movePointerDrag(e.clientX, e.clientY)
      return
    }
    if (!draggingCam) return
    const rect = canvas.getBoundingClientRect()
    // 页面 px → 世界单位(近似:视角 45°,取 rect 宽对应世界宽)
    const worldPerPx = WORLD_W3D / rect.width
    const dx = (e.clientX - lastCX) * worldPerPx
    const dy = (e.clientY - lastCY) * worldPerPx
    scene.panBy(dx, dy)
    lastCX = e.clientX
    lastCY = e.clientY
  })
  window.addEventListener('pointerup', () => {
    if (scene.isPointerDragging()) {
      scene.endPointerDrag()
      return
    }
    draggingCam = false
  })

  // ---- 滚轮缩放 ----
  canvas.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault()
    scene.zoomBy(e.deltaY < 0 ? 0.08 : -0.08)
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
    // 1) 频道坞拖入 → 安放频道 + 其 Agent
    const channelId = dt.getData('application/x-aw-channel') || dt.getData('text/plain')
    if (channelId && dockChannels.value.some(c => c.channelId === channelId)) {
      const world = scene.screenToWorld(e.clientX, e.clientY)
      dropChannelAt(channelId, world.x, world.z)
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

/** 用设备孪生清单收敛场景节点(three 3D / phaser 2D 各自实现) */
function syncSceneDevices(scene: TownViewScene): void {
  if ('syncDevices' in scene) {
    ;(scene as TownScene3D).syncDevices(deviceTwins.twins)
  }
}

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

/** 世界宽度估算(与 TownScene3D 的 WORLD_W 对齐;仅供拖拽位移换算) */
const WORLD_W3D = 3200

/** 迷你地图点击 → 镜头聚焦到对应世界点(指挥官快捷跳转) */
function onMinimapClick(e: MouseEvent): void {
  // 拖拽结束后触发 click:位移超过阈值 → 视为拖拽,屏蔽跳转
  if (miniDragMoved.value) {
    miniDragMoved.value = false
    return
  }
  const s = scene3dRef.value
  const svg = e.currentTarget as SVGSVGElement
  const rect = svg.getBoundingClientRect()
  if (!s || rect.width === 0 || rect.height === 0) return
  const wx = ((e.clientX - rect.left) / rect.width) * WORLD_W
  const wz = ((e.clientY - rect.top) / rect.height) * WORLD_H
  s.focusTo(wx, wz)
}

/** 小地图拖拽平移:按下记录起点;移动按世界比例换算 → scene.panBy 平移相机 */
const miniDragging = ref(false)
const miniDragMoved = ref(false)
let miniLast = { x: 0, y: 0 }
function onMinimapDown(e: PointerEvent): void {
  const s = scene3dRef.value
  if (!s || typeof (s as TownScene3D).panBy !== 'function') return
  miniDragging.value = true
  miniDragMoved.value = false
  miniLast = { x: e.clientX, y: e.clientY }
}
function onMinimapMove(e: PointerEvent): void {
  if (!miniDragging.value) return
  const s = scene3dRef.value
  const svg = e.currentTarget as SVGSVGElement
  const rect = svg.getBoundingClientRect()
  if (!s || rect.width === 0 || rect.height === 0) return
  const dx = e.clientX - miniLast.x
  const dy = e.clientY - miniLast.y
  if (Math.abs(dx) + Math.abs(dy) > 3) miniDragMoved.value = true
  // 小地图拖动 → 相机目标反向平移(拖向哪,视口移向哪)
  ;(s as TownScene3D).panBy(-(dx / rect.width) * WORLD_W, -(dy / rect.height) * WORLD_H)
  miniLast = { x: e.clientX, y: e.clientY }
}
function onMinimapUp(): void {
  miniDragging.value = false
}

const lastDrop = shallowRef<{ mode: string, agentId?: string, textureKey: string, x: number, y: number } | null>(null)

/** 模型落点反馈(供 HUD 显示) */
const lastDropText = computed(() => {
  const d = lastDrop.value
  if (!d) return ''
  return d.mode === 'rebind'
    ? `已为 ${d.agentId?.slice(0, 8) ?? '角色'} 换装 → ${d.textureKey}`
    : `已在落点放入居民 → ${d.textureKey}`
})

/** 精魂会话台:选中角色时,只展示其「本人」近实时消息(大字号实时消费);未选中回退全局事件流 */
const agentChatRows = computed(() => {
  if (!selected.value || selected.value.kind !== 'agent') return []
  const name = scene3dRef.value?.getAgentName?.(selected.value.id) ?? ''
  if (!name) return []
  return ticker.value.filter(t => t.agentName === name)
})
const agentChatTitle = computed(() => {
  if (!selected.value || selected.value.kind !== 'agent') return ''
  return scene3dRef.value?.getAgentName?.(selected.value.id) ?? '精魂'
})

/** 轮询设备孪生 → 场景节点同步 + 状态环颜色(设备节点由 dev 模型拖入/服务端恢复生成) */
function bindDevicePoll(scene: TownScene3D): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void deviceTwins.load().then(() => {
      if (sceneRef.value !== scene) return
      scene.syncDevices(deviceTwins.twins)
      for (const node of scene.getDeviceNodes()) {
        const twin = deviceTwins.byId(node.twinId)
        if (twin) scene.updateDeviceNode(node.twinId, twin.state, twin.telemetry)
      }
    })
  }, 1500)
}

/** 迷你地图:节流轮询场景 getMinimapState,渲染缩略世界 */
const minimap = shallowRef<ReturnType<TownScene['getMinimapState']> | null>(null)
/** 事件跑马灯:最近事件队列 */
const ticker = shallowRef<Array<{ channelId: string, agentName: string, text: string }>>([])
/** 迷你地图/设备孪生轮询定时器(卸载时清理) */
let miniTimer: ReturnType<typeof setInterval> | null = null
let devicePollTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  miniTimer = setInterval(() => {
    const s = sceneRef.value
    if (s?.getMinimapState) minimap.value = s.getMinimapState()
    if (s?.getRecentActivity) ticker.value = s.getRecentActivity()
  }, 400)
})
onBeforeUnmount(() => {
  if (miniTimer) clearInterval(miniTimer)
  if (devicePollTimer) clearInterval(devicePollTimer)
  miniTimer = null
  devicePollTimer = null
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
    <div class="town-frame">
      <div
        id="town-host"
        ref="hostRef"
        class="town-host"
      />
      <div class="hud aw-stagger pointer-events-none absolute inset-0 z-10 select-none">
        <!-- 左:设备模型库(仅设备模型,可拖拽到场景实例化) -->
        <WorkshopAssetLibrary class="lib-panel" />
        <!-- 左:数字孪生侧栏(设备列表/遥测/控制) -->
        <WorkshopDeviceTwinPanel class="twin-panel" />

        <!-- 频道坞:拖拽卡片到场景放置(相同频道只能放置一个;点击不自动落点) -->
        <aside class="channel-dock">
          <div class="dock-head">
            <span class="head-dot" />
            <span class="head-title">频道坞</span>
            <span class="head-hint">拖入地图即安放</span>
          </div>
          <div class="dock-list">
            <div
              v-for="ch in dockChannels"
              :key="ch.channelId"
              class="dock-card"
              :draggable="!ch.placed"
              :class="{ placed: ch.placed, disabled: ch.placed }"
              :data-channel-id="ch.channelId"
              :title="ch.placed ? '已在场景中(不可重复放置),点击查看' : '拖拽到场景放置'"
              @dragstart="ch.placed ? undefined : onChannelDragStart($event, ch.channelId)"
              @click="onDockCardClick(ch)"
            >
              <span
                class="dock-color"
                :style="{ background: ch.color }"
              />
              <span class="dock-name">{{ ch.name }}</span>
              <span class="dock-meta">{{ ch.agentCount }} 精魂 · {{ ch.placed ? '已放置' : '未放置' }}</span>
              <span class="dock-toggle">{{ ch.placed ? '✓' : '＋' }}</span>
            </div>
          </div>
          <span
            v-if="dockHint"
            class="dock-hint"
          >{{ dockHint }}</span>
        </aside>

        <!-- 频道管理面板(边界编辑 + 成员角色模型设置) -->
        <div
          v-if="selectedChannel && boundaryDraft"
          class="boundary-panel"
        >
          <div class="bp-title">
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

          <!-- 边界 tab:领地形状/半径/朝向 -->
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
                max="700"
                step="8"
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
                max="480"
                step="8"
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
                @change="applyBoundaryDraft"
              >
              <span class="bp-val">{{ Math.round(boundaryDraft.rotationY ?? 0) }}°</span>
            </div>
          </template>

          <!-- 成员 tab:为每个成员设置 character 模型(角色模型只在频道管理中设置) -->
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
                  <span class="member-role">{{ m.role === 'lead' ? '领队' : '成员' }}</span>
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

        <!-- 场景对象属性面板(选中设备/角色:改名/换模型/旋转/缩放/删除) -->
        <div
          v-if="selected"
          class="object-panel"
        >
          <div class="scale-title">
            <span class="scale-kind">{{ selected.kind === 'agent' ? '角色' : '设备实例' }}</span>
            <span class="scale-id">{{ selected.id.slice(0, 8) }}</span>
            <button
              class="scale-close"
              @click="closeScale"
            >
              ×
            </button>
          </div>

          <!-- 名称(设备可改名 + 落库;角色只读) -->
          <div
            v-if="selected.kind === 'device'"
            class="obj-row"
          >
            <span class="obj-label">名称</span>
            <input
              v-model="objNameDraft"
              class="obj-input"
              placeholder="设备名称"
              @change="onObjNameCommit"
              @keydown.enter="onObjNameCommit"
            >
          </div>

          <!-- 模型(设备 → 设备模型下拉;角色 → character 模型下拉) -->
          <div class="obj-row">
            <span class="obj-label">模型</span>
            <select
              v-if="selected.kind === 'device'"
              class="obj-select"
              :value="scene3dRef?.getDeviceModelRef?.(selected.id) ?? ''"
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
            <select
              v-else
              class="obj-select"
              :value="(scene3dRef?.getAgentModel?.(selected.id) ?? '') || 'hero-3d'"
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

          <!-- 旋转(编辑模式;角色仅本地,设备落库) -->
          <div
            v-if="mode === 'edit'"
            class="scale-row"
          >
            <span class="scale-min">0°</span>
            <input
              class="scale-range"
              type="range"
              min="0"
              max="360"
              step="1"
              :value="selected.rotation"
              @input="onRotationInput(Number(($event.target as HTMLInputElement).value))"
              @change="onRotationCommit"
            >
            <span class="scale-max">360°</span>
          </div>
          <!-- 缩放 -->
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

          <!-- 活动范围(选中角色:框选绘制 / 形状 / 半径 / 清除;逐 Agent 独立定制) -->
          <template v-if="selected.kind === 'agent'">
            <div class="obj-sep" />
            <div class="obj-row">
              <span class="obj-label">活动范围</span>
              <span class="range-status">{{ agentRangeStatusText }}</span>
              <button
                class="obj-mini"
                :class="{ on: agentDrawingRange }"
                :title="agentDrawingRange ? '在场景中拖动框选;再次点击取消' : '在场景中拉动框选,确定该角色的移动范围'"
                @click="onToggleRangeDraw"
              >
                {{ agentDrawingRange ? '绘制中' : '框选绘制' }}
              </button>
            </div>
            <template v-if="agentRangeDraft">
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
                  max="600"
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
                  max="480"
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
              class="obj-hint"
            >
              未设置:角色沿用频道领地活动;点「框选绘制」后在场景中拖动定制
            </div>
          </template>

          <!-- 删除(仅设备实例;角色为频道成员,由频道管理面板管理) -->
          <button
            v-if="selected.kind === 'device'"
            class="obj-del"
            @click="removeSelectedDevice"
          >
            移除设备实例
          </button>
        </div>

        <!-- 编辑/浏览模式工具栏 + 布局保存 -->
        <div class="mode-bar">
          <button
            class="mode-btn"
            :class="{ active: mode === 'edit' }"
            :title="mode === 'edit' ? '编辑模式:可拖拽设备/调整角色落点' : '浏览模式:只读巡视'"
            @click="toggleMode"
          >
            {{ mode === 'edit' ? '编辑中' : '浏览' }}
          </button>
          <button
            v-if="mode === 'edit'"
            class="mode-btn"
            :class="{ active: snap }"
            title="网格吸附(拖拽落点对齐 16 单位)"
            @click="toggleSnap"
          >
            吸附{{ snap ? '开' : '关' }}
          </button>
          <button
            v-if="mode === 'edit'"
            class="mode-btn save"
            title="把全部设备的位置/朝向/缩放写入数据库"
            @click="saveLayout"
          >
            保存布局
          </button>
          <span
            v-if="mode === 'edit'"
            class="mode-hint"
          >
            <span class="mh-key">拖拽</span> 移动 ·
            <span class="mh-key">拉框</span> Agent范围 ·
            <span class="mh-key">手柄</span> 缩放/清除
          </span>
          <span
            v-if="saveState && saveState.state !== 'idle'"
            class="save-chip"
            :class="`s-${saveState.state}`"
          >
            {{ saveStateLabel }}
          </span>
        </div>

        <!-- 顶栏:标题 / 统计 / 连接 -->
        <div class="absolute top-0 left-0 right-0 flex items-start justify-between p-4">
          <div class="glass-chip">
            <span class="ch-dot" />
            <span class="hud-title">AGENTTEAM 小镇</span>
            <span class="hud-sub">Channel · {{ activeChannelName || '加载中' }}</span>
          </div>
          <div class="glass-chip">
            <span
              class="conn-dot"
              :class="conn.state === 'open' ? 'on' : 'off'"
            />
            {{ conn.state === 'open' ? '在线' : syncing ? '同步中' : '离线' }}
            <span class="hud-sep" />
            <span class="hud-mono">{{ blockCount }} 领地 · {{ agentCount }} 精魂</span>
            <span class="hud-sep" />
            <span class="hud-mono">{{ fps }} FPS</span>
          </div>
        </div>

        <!-- 事件跑马灯(最近几条"此刻谁在说话") -->
        <div
          v-if="ticker.length"
          class="ticker-box"
        >
          <div class="ticker-title">
            事件流
          </div>
          <div
            v-for="(t, i) in ticker"
            :key="`${t.agentName}-${i}`"
            class="ticker-row"
          >
            <span class="act-ava">{{ t.agentName.charAt(0).toUpperCase() }}</span>
            <span class="act-name">{{ t.agentName }}</span>
            <span class="act-text">{{ t.text }}</span>
          </div>
        </div>

        <!-- 精魂会话台:选中角色时放大展示其本人近实时消息(实时消费自己的信息) -->
        <div
          v-if="selected?.kind === 'agent' && agentChatRows.length"
          class="agent-chat"
          :data-agent-id="selected.id"
        >
          <div class="agent-chat-head">
            <span class="act-ava">{{ agentChatTitle.charAt(0).toUpperCase() }}</span>
            <span class="agent-chat-name">{{ agentChatTitle }} · 实时会话</span>
            <span class="agent-chat-live">● LIVE</span>
          </div>
          <div class="agent-chat-rows">
            <div
              v-for="(t, i) in agentChatRows"
              :key="`${t.agentName}-${i}`"
              class="agent-chat-row"
            >
              <span class="agent-chat-body">{{ t.text }}</span>
            </div>
          </div>
        </div>

        <!-- 模型落点反馈 -->
        <div
          v-if="lastDropText"
          class="drop-chip"
        >
          {{ lastDropText }}
        </div>

        <!-- 迷你地图(缩略世界;领地色点+角色+设备+视口;点击跳转/拖动平移) -->
        <div
          v-if="minimap"
          class="mini-map"
          :title="'世界 · 点击跳转 · 拖动平移'"
        >
          <svg
            :viewBox="`0 0 ${minimap.world.w} ${minimap.world.h}`"
            class="mini-svg"
            role="img"
            aria-label="世界迷你地图,点击跳转,拖动平移镜头"
            @click="onMinimapClick"
            @pointerdown="onMinimapDown"
            @pointermove="onMinimapMove"
            @pointerup="onMinimapUp"
            @pointercancel="onMinimapUp"
            @pointerleave="onMinimapUp"
          >
            <rect
              x="0"
              y="0"
              :width="minimap.world.w"
              :height="minimap.world.h"
              fill="rgba(14,21,36,0.35)"
            />
            <circle
              v-for="b in minimap.blocks"
              :key="`b-${b.name}`"
              :cx="b.x * minimap.world.w"
              :cy="b.y * minimap.world.h"
              r="70"
              :fill="`#${b.color.toString(16).padStart(6, '0')}`"
              opacity="0.45"
            />
            <circle
              v-for="a in minimap.agents"
              :key="`a-${a.x}-${a.y}`"
              :cx="a.x * minimap.world.w"
              :cy="a.y * minimap.world.h"
              :r="a.busy ? 16 : 11"
              :fill="`#${a.color.toString(16).padStart(6, '0')}`"
            />
            <!-- 数字孪生设备(四边形;状态色与场景状态环一致) -->
            <rect
              v-for="d in minimap.devices"
              :key="`d-${d.x}-${d.y}`"
              :x="d.x * minimap.world.w - 11"
              :y="d.y * minimap.world.h - 11"
              width="22"
              height="22"
              rx="4"
              :fill="`#${d.color.toString(16).padStart(6, '0')}`"
              opacity="0.92"
            />
            <rect
              :x="(minimap.player.x - 0.05) * minimap.world.w"
              :y="(minimap.player.y - 0.05) * minimap.world.h"
              :width="0.1 * minimap.world.w"
              :height="0.1 * minimap.world.h"
              fill="rgba(255,255,255,0.18)"
              stroke="#fff"
              stroke-width="4"
            />
          </svg>
          <span class="mini-label">MAP · {{ blockCount }} 领地 · {{ minimap.devices?.length ?? 0 }} 设备</span>
        </div>

        <!-- 错误态 -->
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
          <span class="loading-text">正在铺设小镇…</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ============================================================
 * 小镇控制台 Chrome —— 延续全局 Warm Editorial 设计系统
 *  舞台是暗场,家具(面板)是编辑台上可读的控制件:
 *  统一玻璃配方(glass-bg + blur + hairline + 内缘高光)、panel 圆角、
 *  kicker 头部、墨色药丸 CTA、120–320ms ease-out-quart;
 *  不引入新鲜色相,只消费 --tone/* 语义状态色。
 * ============================================================ */
.town-view {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.town-frame {
  position: relative;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: radial-gradient(1200px 700px at 50% 30%, rgba(84, 120, 150, 0.15), transparent 70%);
}
.town-host {
  position: absolute;
  inset: 0;
  display: block;
}
/* 3D 渲染器不强制 pixelated(仅 2D Phaser 像素风需要);默认抗锯齿 */
.town-host canvas { image-rendering: auto; }

.hud { font-family: var(--font-body); }

/* 通用浮动面板配方:所有控制件同一玻璃质感 */
.channel-dock,
.boundary-panel,
.object-panel,
.mode-bar,
.mini-map,
.ticker-box {
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel);
  box-shadow: var(--glass-highlight), var(--shadow-float);
}

/* 模型库面板(可交互,脱离 pointer-events-none) */
.lib-panel {
  position: absolute;
  top: 56px;
  left: 16px;
  pointer-events: auto;
  max-height: min(56vh, 420px);
  overflow: hidden auto;
}

/* 数字孪生侧栏(右侧,迷你地图上方) */
.twin-panel {
  position: absolute;
  right: 16px;
  bottom: 292px;
  pointer-events: auto;
  max-height: min(34vh, 300px);
  overflow: hidden auto;
}

/* 偏好禁用透明:玻璃退回纯 paper 面,保证可读(对齐 main.css 的 reduced-transparency) */
@media (prefers-reduced-transparency: reduce) {
  .channel-dock,
  .boundary-panel,
  .object-panel,
  .mode-bar,
  .mini-map,
  .ticker-box {
    background: var(--paper-raised);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}

/* 场景对象属性面板(选中设备/角色:改名/换模型/旋转/缩放/删除) */
.object-panel {
  position: absolute;
  bottom: 46px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 284px;
  padding: 11px 14px 12px;
  pointer-events: auto;
  border-color: color-mix(in srgb, var(--accent) 38%, transparent);
}
.scale-title { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--ink-soft); }
.scale-kind { font-weight: 650; color: var(--ink); }
.scale-id { font-family: var(--font-mono); font-size: 10px; color: var(--ink-faint); }
.scale-hint { font-size: 10px; color: var(--tone-warning-dot); margin-left: auto; }
.scale-close {
  margin-left: auto;
  width: 22px;
  height: 22px;
  font-size: 14px;
  line-height: 1;
  color: var(--ink-faint);
  background: transparent;
  border: 0;
  border-radius: var(--radius-chip);
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);
}
.scale-close:hover { color: var(--ink); background: var(--paper-deep); }
.scale-row { display: flex; gap: 8px; align-items: center; }
.scale-min, .scale-max { font-family: var(--font-mono); font-size: 9px; color: var(--ink-faint); }
.scale-range { flex: 1; accent-color: var(--accent); }
.scale-val { text-align: center; font-family: var(--font-mono); font-size: 11px; color: var(--ink); }
.obj-row { display: flex; gap: 8px; align-items: center; }
.obj-label { flex: none; width: 34px; font-size: 10px; color: var(--ink-faint); }
.obj-input {
  flex: 1; min-width: 0; font-size: 11px; padding: 4px 8px;
  border: 1px solid var(--line-strong); border-radius: var(--radius-chip);
  background: var(--paper); color: var(--ink);
  transition: border-color var(--transition-fast);
}
.obj-input:focus { outline: none; border-color: var(--accent); }
.obj-select {
  flex: 1; min-width: 0; font-size: 11px; padding: 3px 6px;
  border: 1px solid var(--line-strong); border-radius: var(--radius-chip);
  background: var(--paper); color: var(--ink);
  transition: border-color var(--transition-fast);
}
.obj-select:hover { border-color: var(--accent); }
.obj-del {
  margin-top: 3px;
  padding: 5px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--tone-danger-dot);
  background: var(--tone-danger-bg);
  border: 1px solid color-mix(in srgb, var(--tone-danger-dot) 35%, transparent);
  border-radius: var(--radius-chip);
  cursor: pointer;
  transition: filter var(--transition-fast), transform var(--transition-fast);
}
.obj-del:hover { filter: brightness(1.04); }
.obj-del:active { transform: scale(0.98); }
/* 活动范围区块(选中角色) */
.obj-sep { height: 1px; background: var(--divider-hair); margin: 3px 0; }
.range-status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; color: var(--ink-faint); }
.obj-mini {
  flex: none;
  padding: 4px 9px;
  font-size: 10px;
  font-weight: 600;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
  cursor: pointer;
  transition: border-color var(--transition-fast), color var(--transition-fast), background var(--transition-fast);
}
.obj-mini:hover { border-color: var(--accent); color: var(--ink); }
.obj-mini.on { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
.obj-mini.danger { color: var(--tone-danger-dot); margin-top: 3px; }
.obj-range { flex: 1; accent-color: var(--accent); }
.obj-hint { font-size: 9px; line-height: 1.55; color: var(--ink-faint); }

/* 编辑/浏览模式工具栏(顶栏下方右侧;药丸形态,与全局 aw-pill 一致) */
.mode-bar {
  position: absolute;
  top: 58px;
  right: 16px;
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 7px 9px;
  pointer-events: auto;
  border-radius: var(--radius-pill);
}

/* 频道坞(左,模型库旁) */
.channel-dock {
  position: absolute;
  top: 56px;
  left: 204px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 204px;
  padding: 12px 12px 13px;
  pointer-events: auto;
}
.dock-head { display: flex; gap: 7px; align-items: center; font-size: 11px; letter-spacing: 0.05em; color: var(--ink-faint); }
.head-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.head-title { font-size: 12px; font-weight: 650; letter-spacing: 0.02em; color: var(--ink); }
.head-hint { margin-left: auto; font-size: 10px; color: var(--ink-faint); white-space: nowrap; }
.dock-list { display: flex; flex-direction: column; gap: 6px; max-height: 42vh; overflow: hidden auto; padding-right: 1px; }
.dock-card {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 9px;
  cursor: grab;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm);
  transition: border-color var(--transition-base), transform var(--transition-base), box-shadow var(--transition-base);
}
.dock-card:hover { border-color: var(--line-strong); box-shadow: var(--shadow-float); transform: translateY(-1px); }
.dock-card:active { cursor: grabbing; }
.dock-card.placed { border-color: var(--line-strong); border-left: 3px solid var(--tone-success-dot); }
.dock-card.disabled { cursor: default; }
.dock-card.disabled:hover { border-color: var(--line); box-shadow: none; transform: none; }
.dock-card.disabled:active { cursor: default; }
.dock-hint {
  font-size: 10px;
  color: var(--tone-warning-dot);
  padding: 5px 8px;
  border-radius: var(--radius-chip);
  background: var(--tone-warning-bg);
  border: 1px solid color-mix(in srgb, var(--tone-warning-dot) 30%, transparent);
}
.dock-color { flex: none; width: 9px; height: 9px; border-radius: 50%; box-shadow: 0 0 0 3px color-mix(in srgb, var(--paper-deep) 85%, transparent); }
.dock-name { font-size: 11.5px; font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dock-meta { margin-left: auto; font-family: var(--font-mono); font-size: 9px; color: var(--ink-faint); white-space: nowrap; }
.dock-toggle { flex: none; font-size: 12px; font-weight: 700; color: var(--accent); }
.dock-card.placed .dock-toggle { color: var(--tone-success-dot); }

/* 频道边界编辑面板 */
.boundary-panel {
  position: absolute;
  bottom: 46px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 304px;
  padding: 12px 14px 13px;
  pointer-events: auto;
  border-color: color-mix(in srgb, var(--accent) 38%, transparent);
}
.bp-title { display: flex; gap: 8px; align-items: baseline; }
.bp-name { font-size: 14px; font-weight: 400; font-family: var(--font-display); letter-spacing: -0.01em; color: var(--ink); }
.bp-sub { font-size: 10px; color: var(--ink-faint); }
.bp-row { display: flex; gap: 8px; align-items: center; }
.bp-label { flex: none; width: 46px; font-size: 10px; color: var(--ink-faint); }
.bp-range { flex: 1; accent-color: var(--accent); }
.bp-val { flex: none; width: 40px; text-align: right; font-family: var(--font-mono); font-size: 10px; color: var(--ink); }
.bp-seg { display: flex; gap: 4px; }
.seg-btn {
  padding: 4px 11px;
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
  cursor: pointer;
  transition: border-color var(--transition-fast), color var(--transition-fast), background var(--transition-fast);
}
.seg-btn:hover { border-color: var(--line-strong); color: var(--ink); }
.seg-btn.on { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
.bp-actions { display: flex; gap: 6px; margin-top: 3px; }
.bp-btn {
  padding: 5px 11px;
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
  cursor: pointer;
  transition: border-color var(--transition-fast), color var(--transition-fast), transform var(--transition-fast);
}
.bp-btn:hover { border-color: var(--accent); color: var(--ink); }
.bp-btn:active { transform: scale(0.97); }
.bp-btn.save { color: var(--tone-success-dot); }
.bp-btn.danger { color: var(--tone-danger-dot); }

/* 频道管理面板:tabs + 成员角色模型设置 */
.bp-tabs { display: flex; gap: 4px; margin-left: auto; }
.bp-tab {
  padding: 3px 10px;
  font-size: 10px;
  font-weight: 600;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
  cursor: pointer;
  transition: border-color var(--transition-fast), color var(--transition-fast), background var(--transition-fast);
}
.bp-tab:hover { border-color: var(--line-strong); color: var(--ink); }
.bp-tab.on { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
.bp-hint { font-size: 10px; line-height: 1.55; color: var(--ink-faint); }

/* 美工:面板顶部纤细 accent 缘(仅活跃面板;玻璃基底由通用配方承载) */
.boundary-panel::before,
.object-panel::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 2px;
  border-radius: var(--radius-panel) var(--radius-panel) 0 0;
  background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 22%, transparent));
  opacity: 0.8;
}
.bp-range, .obj-range, .scale-range { transition: filter var(--transition-fast); }
.bp-range:hover, .obj-range:hover, .scale-range:hover { filter: brightness(1.12); }
.member-list { display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow: hidden auto; padding-right: 1px; }
.member-row {
  display: flex; gap: 8px; align-items: center; padding: 5px 7px;
  background: var(--paper-raised); border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm);
  transition: border-color var(--transition-fast);
}
.member-row:hover { border-color: var(--line-strong); }
.member-ava {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; flex: none; font-size: 11px; font-weight: 700;
  background: var(--paper-deep); border-radius: var(--radius-panel-sm);
}
.member-info { display: flex; flex-direction: column; min-width: 0; }
.member-name { font-size: 11px; font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.member-role { font-size: 9px; color: var(--ink-faint); }
.member-select {
  min-width: 0; flex: 1; font-size: 10px; padding: 3px 5px;
  border: 1px solid var(--line-strong); border-radius: var(--radius-chip);
  background: var(--paper); color: var(--ink);
  transition: border-color var(--transition-fast);
}
.member-select:hover { border-color: var(--accent); }

.mode-btn {
  padding: 5px 11px;
  font-size: 11px;
  font-weight: 600;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
  cursor: pointer;
  transition: border-color var(--transition-fast), color var(--transition-fast), background var(--transition-fast), transform var(--transition-fast);
}
.mode-btn:hover { border-color: var(--accent); color: var(--ink); }
.mode-btn:active { transform: scale(0.97); }
.mode-btn.active { color: var(--on-accent); background: var(--accent); border-color: var(--accent); }
.mode-btn.save { color: var(--tone-success-dot); }
.mode-hint {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 4px 10px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.04em;
  color: var(--ink-faint);
  background: var(--frost-bg);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-pill);
  white-space: nowrap;
}
.mh-key { font-weight: 700; color: var(--ink-soft); }
.save-chip {
  padding: 4px 9px;
  font-family: var(--font-mono);
  font-size: 10px;
  border-radius: var(--radius-chip);
  white-space: nowrap;
}
.save-chip.s-dirty { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.save-chip.s-saving { color: var(--ink-soft); background: var(--paper-deep); }
.save-chip.s-saved { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.save-chip.s-error { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }

/* 精魂会话台:选中角色时的大字号实时会话窗(底部左下,位于事件流上方) */
.agent-chat {
  position: absolute;
  bottom: 246px;
  left: 188px;
  width: min(46%, 480px);
  max-height: 250px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 11px 14px 12px;
  pointer-events: auto;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--glass-line));
  border-radius: var(--radius-panel);
  box-shadow: var(--glass-highlight), var(--shadow-float);
}
.agent-chat-head {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--divider-hair);
}
.agent-chat-name {
  font-size: 13px;
  font-weight: 650;
  color: var(--ink);
  letter-spacing: 0.02em;
}
.agent-chat-live {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  color: var(--tone-success-dot);
}
.agent-chat-rows {
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 172px;
  overflow: hidden auto;
}
.agent-chat-row {
  padding: 4px 6px;
  border-radius: var(--radius-chip);
  background: color-mix(in srgb, var(--paper-raised) 72%, transparent);
}
.agent-chat-body {
  display: block;
  font-size: 14.5px;
  line-height: 1.5;
  color: var(--ink-soft);
  overflow: hidden;
  word-break: break-word;
}
.agent-chat-row:first-child .agent-chat-body {
  color: var(--ink);
  font-weight: 500;
}

/* 电影感覆盖层:暗角(vignette)+ 数字孪生扫描线(仅视觉,不遮交互;位于 HUD 之下) */
.town-frame::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  background:
    radial-gradient(130% 100% at 50% 44%, transparent 58%, rgba(4, 8, 14, 0.3) 100%),
    linear-gradient(180deg, rgba(4, 8, 14, 0.14), transparent 16%, transparent 84%, rgba(4, 8, 14, 0.22));
}
.town-frame::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  background: repeating-linear-gradient(
    0deg,
    rgba(140, 190, 230, 0.028) 0 1px,
    transparent 1px 4px
  );
  mix-blend-mode: screen;
}
@media (prefers-reduced-transparency: reduce) {
  .agent-chat { background: var(--paper-raised); backdrop-filter: none; -webkit-backdrop-filter: none; }
  .town-frame::before, .town-frame::after { content: none; }
}

/* 模型落点反馈 */
.drop-chip {
  position: absolute;
  bottom: 16px;
  left: 188px;
  max-width: 60%;
  padding: 7px 13px;
  font-size: 12px;
  color: var(--ink-soft);
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: var(--radius-pill);
  box-shadow: var(--glass-highlight), var(--shadow-float);
}

.glass-chip {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--ink-soft);
  background: var(--frost-bg);
  backdrop-filter: var(--frost-blur);
  -webkit-backdrop-filter: var(--frost-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel-sm);
  box-shadow: var(--glass-highlight);
}
.hud-title {
  font-family: var(--font-display);
  font-weight: 400;
  letter-spacing: 0.06em;
  color: var(--ink);
}
.hud-sub { font-size: 11px; color: var(--ink-faint); }
.hud-mono { font-family: var(--font-mono); font-size: 11px; color: var(--ink-faint); }
.hud-sep { width: 1px; height: 12px; background: var(--line-strong); }
.ch-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tone-info-dot); }
.conn-dot { width: 8px; height: 8px; border-radius: 50%; }
.conn-dot.on { background: var(--tone-success-dot); }
.conn-dot.off { background: var(--tone-danger-dot); }

/* 迷你地图(点击跳转镜头;统一面板配方) */
.mini-map {
  position: absolute;
  bottom: 74px;
  right: 16px;
  width: 172px;
  pointer-events: auto;
  overflow: hidden;
  cursor: pointer;
  transition: border-color var(--transition-fast);
}
.mini-map:hover { border-color: color-mix(in srgb, var(--accent) 35%, var(--glass-line)); }
.mini-svg {
  display: block;
  width: 100%;
  height: auto;
}
.mini-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 9px;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  color: var(--ink-faint);
  border-top: 1px solid var(--glass-line);
}

/* 事件跑马灯(最近"谁在说话") */
.ticker-box {
  position: absolute;
  bottom: 16px;
  left: 188px;
  width: min(46%, 380px);
  max-height: 152px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 9px 11px 10px;
}
.ticker-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  color: var(--ink-faint);
  padding-bottom: 4px;
  border-bottom: 1px solid var(--divider-hair);
  margin-bottom: 2px;
}
.ticker-row {
  display: flex;
  gap: 7px;
  align-items: center;
  overflow: hidden;
  font-size: 11px;
}
.act-ava {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  font-size: 10px;
  font-weight: 600;
  color: var(--on-av);
  background: var(--av-fallback);
  border-radius: var(--radius-panel-sm);
}
.act-name { flex: none; font-weight: 600; color: var(--ink); }
.act-text { overflow: hidden; color: var(--ink-soft); text-overflow: ellipsis; white-space: nowrap; }

/* 当前说话者 */
.activity-chip {
  position: absolute;
  bottom: 44px;
  left: 188px;
  display: flex;
  gap: 8px;
  align-items: center;
  max-width: 70%;
  padding: 7px 13px;
  font-size: 12px;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-pill);
  box-shadow: var(--glass-highlight), var(--shadow-float);
}
.activity-chip .act-ava { width: 22px; height: 22px; font-size: 11px; }

/* 错误态 */
.error-chip {
  position: absolute;
  bottom: 16px;
  right: 16px;
  max-width: 60%;
  padding: 8px 13px;
  font-size: 12px;
  color: var(--tone-danger-dot);
  background: var(--tone-danger-bg);
  border: 1px solid color-mix(in srgb, var(--tone-danger-dot) 30%, transparent);
  border-radius: var(--radius-panel-sm);
}

/* ============================================================
 * RPG 2.5D UI 风格统一(覆盖层:统一玻璃质感/圆角/边框/动效)
 * ============================================================ */
.channel-dock,
.boundary-panel,
.object-panel,
.mode-bar,
.mini-map,
.ticker-box,
.agent-chat,
.lib-panel,
.scale-panel,
.twin-panel,
.device-panel {
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, var(--accent) 18%, var(--glass-line));
  box-shadow: var(--glass-highlight), 0 18px 42px rgba(8, 14, 24, 0.28);
}
.channel-dock > .dock-head,
.boundary-panel > .bp-title {
  letter-spacing: 0.06em;
}
.dock-list {
  scrollbar-width: thin;
}
/* 事件流与会话台:首尾呼吸分隔 */
.ticker-row {
  transition: background 0.18s ease, transform 0.18s ease;
}
.ticker-row:hover {
  background: color-mix(in srgb, var(--paper-raised) 86%, transparent);
  transform: translateX(2px);
}
/* 迷你地图:外发光描边 */
.mini-map {
  border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--glass-line));
  box-shadow: var(--glass-highlight), 0 14px 34px rgba(8, 14, 24, 0.3);
  cursor: grab;
  touch-action: none;
}
.mini-map:active {
  cursor: grabbing;
}
.mini-svg { display: block; width: 100%; }
/* 模式栏按钮:圆角胶囊 + 按压反馈 */
.mode-btn {
  border-radius: 10px;
  transition: background 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
}
.mode-btn:active {
  transform: translateY(1px);
}
.mode-btn.active {
  box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 38%, transparent);
}
/* 顶栏质感微调 */
.glass-chip {
  border: 1px solid color-mix(in srgb, var(--accent) 16%, var(--glass-line));
}
/* 小地图/面板内部滚条一致 */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--line-strong) 70%, transparent);
  border-radius: 99px;
}
.loading-mask {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 13px;
  align-items: center;
  justify-content: center;
  background: var(--paper);
}
.loading-spinner {
  width: 28px;
  height: 28px;
  border: 2.5px solid var(--line-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .loading-spinner { animation: none; } }
.loading-text {
  font-family: var(--font-display);
  font-size: 16px;
  letter-spacing: -0.01em;
  color: var(--ink-faint);
}
</style>
