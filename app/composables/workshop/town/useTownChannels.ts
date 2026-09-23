/**
 * 小镇视图 — 频道坞 + 频道边界编辑(频道级状态与落库动作)
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持):
 *   - 频道坞列表(所有挂载频道 + 已放置标记)、拖起载荷;
 *   - 频道边界编辑草稿(拖拽/手柄调整 → 草稿 → 落库)、成员换装;
 *   - 实体基线 buildTownInput(场景实例化的唯一输入来源)。
 */
import { computed, ref } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import type { useEntitiesStore } from '@/app/stores/workshop/entities'
import type { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import type { useSceneLayouts } from '@/app/composables/workshop/useSceneLayouts'
import type { useCharacterAssets } from '@/app/composables/workshop/useCharacterAssets'
import type { AgentRangeLayout, ChannelLayout, TownScene3D } from '@/app/components/workshop/town/TownScene3D'
import type { TownEntityInput } from '@/app/components/workshop/town/TownScene'
import { channelColorCss } from '#shared/town-scene-math'

export function useTownChannels(params: {
  props: { channelId: string, allChannels?: boolean }
  entities: ReturnType<typeof useEntitiesStore>
  wsStore: ReturnType<typeof useWorkspacesStore>
  sceneLayouts: ReturnType<typeof useSceneLayouts>
  characterAssets: ReturnType<typeof useCharacterAssets>
  scene3dRef: ShallowRef<TownScene3D | null>
  errorText: Ref<string>
  saveState: Ref<{ state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error', at: number } | null>
}) {
  const { props, entities, wsStore, sceneLayouts, characterAssets, scene3dRef, errorText, saveState } = params
  const { t } = useI18n()

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
      errorText.value = apiErrorMessage(err)
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
      errorText.value = apiErrorMessage(err)
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
    dockHint.value = t('townView.k7rvbts159')
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
      dockHint.value = t('townView.kcyn0191', { p0: name })
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
      errorText.value = apiErrorMessage(err)
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

  return { selectedChannel, boundaryDraft, onSelectChannel, saveChannelLayout, removeChannelFromScene, applyBoundaryDraft, dockHint, onDockCardClick, dropChannelAt, channelPanelTab, channelMembers, bindMemberModel, openChannelTab, dockRev, dockChannels, hashColor, onChannelDragStart, buildTownInput }
}
