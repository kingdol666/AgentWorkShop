<script setup lang="ts">
/**
 * Workspace 主控台(Zcode 风格 Harness):
 * 顶栏(WS 状态 + seq + 视图切换)+ 左栏 Channel 会话 + 中部三视图
 * (时间线 / Agent lanes / 任务板)+ 右侧 Inspector + 底部 Composer +
 * Agent/Task 双抽屉(执行详情)。
 * 挂载 workspace 全部 channel 的 WS 订阅;聚焦 channel 驱动中部/右侧上下文。
 */
import { useWorkspacesStore } from '../../../stores/workshop/workspaces'
import { useEntitiesStore } from '../../../stores/workshop/entities'
import { useWorkshopWs } from '../../../composables/workshop/useWorkshopWs'
import { useUserStore } from '../../../stores/workshop/user'
import { useStorage } from '@vueuse/core'

const { t } = useI18n()

definePageMeta({ layout: 'default' })

const route = useRoute()
const wsId = computed(() => String(route.params.wsId))
const userStore = useUserStore()
const wsStore = useWorkspacesStore()

// 用户守卫 + workspace 服务端加载
// SSR 阶段不判登录(会话恢复是客户端插件,服务端无登录态——同步踢回会把
// 刷新/直达 URL 的已登录用户误弹回总览);客户端挂载后校验并按需加载
const authReady = ref(false)
onMounted(() => {
  if (!userStore.isLoggedIn) {
    navigateTo('/workshop')
    return
  }
  authReady.value = true
  if (!wsStore.loaded) wsStore.load().catch(() => {})
})
const entities = useEntitiesStore()
const { subscribe, unsubscribe, conn } = useWorkshopWs()

const workspace = computed(() => wsStore.workspaces.find(w => w.id === wsId.value))
// 聚焦 channel:activeChannelId 须在挂载清单内(陈旧持久化/竞态下回退首频道),
// 避免订阅死频道 → 快照永不到达 → 右栏/时间线长时间"空数据"假象
const channelId = computed(() => {
  const ws = workspace.value
  if (!ws) return undefined
  const ids = ws.channelIds
  const active = ws.activeChannelId
  return active && ids.includes(active) ? active : ids[0]
})

// 订阅生命周期:workspace 挂载的 channel 变化 → 增量 sub/unsub
watch(
  () => [wsId.value, workspace.value?.channelIds.join(',') ?? ''],
  () => {
    const mounted = new Set(workspace.value?.channelIds ?? [])
    for (const id of mounted) subscribe(id)
  },
  { immediate: true },
)
watch(
  () => workspace.value?.channelIds.join(',') ?? '',
  (_next, prev) => {
    if (prev === undefined) return
    const mounted = new Set(workspace.value?.channelIds ?? [])
    for (const prevId of prev.split(',').filter(Boolean)) {
      if (!mounted.has(prevId)) unsubscribe(prevId)
    }
  },
)
onBeforeUnmount(() => {
  for (const id of workspace.value?.channelIds ?? []) unsubscribe(id)
})

const stateColor = computed(() =>
  conn.state === 'open' ? 'var(--tone-success-dot)' : conn.state === 'connecting' ? 'var(--tone-warning-dot)' : 'var(--tone-danger-dot)',
)
const lastSeq = computed(() => (channelId.value ? conn.cursors[channelId.value] ?? 0 : 0))

// 视图切换(P1 三视图 + P2 多通道同屏 + P5 RPG 小镇)
// 深链:?view=lanes/board/split/town 直达指定视图(可分享/收藏)
type CenterView = 'timeline' | 'lanes' | 'board' | 'split' | 'town'
const VIEW_KEYS: Record<string, CenterView> = {
  1: 'timeline',
  2: 'lanes',
  3: 'board',
  4: 'split',
  5: 'town',
}
const VIEW_VALUES = new Set(['timeline', 'lanes', 'board', 'split', 'town'])
const initView = route.query.view
const view = ref<CenterView>(
  typeof initView === 'string' && VIEW_VALUES.has(initView) ? initView as CenterView : 'timeline',
)
const viewOptions = [
  { value: 'timeline', label: t('wsView.k3otu32010') },
  { value: 'lanes', label: 'Agent lanes' },
  { value: 'board', label: t('wsView.k3ko7a8011') },
  { value: 'split', label: t('wsView.k3xbmo012') },
  { value: 'town', label: t('wsView.k1cz0pbw013') },
]
// 数字快捷键 1-5 直切视图(非输入焦点时;控制台型键盘操作与 ⌘K 面板同一取向)
const onViewKey = (ev: KeyboardEvent): void => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return
  const t = ev.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  const next = VIEW_KEYS[ev.key]
  if (!next || !channelId.value) return
  ev.preventDefault()
  view.value = next
}
onMounted(() => window.addEventListener('keydown', onViewKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onViewKey))

// 侧栏折叠(现代 harness 布局:左会话栏 / 右检查器可按需收起)
const leftOpen = ref(true)
const rightOpen = ref(true)

// 侧栏宽度拖拽调节(PaneSplitter;localStorage 持久化,双击复位到默认值)
const LEFT_W_DEFAULT = 248
const RIGHT_W_DEFAULT = 300
const leftWidth = useStorage('aw.harness.leftW', LEFT_W_DEFAULT)
const rightWidth = useStorage('aw.harness.rightW', RIGHT_W_DEFAULT)
const resizeLeft = (d: number): void => {
  leftWidth.value = Math.min(460, Math.max(220, leftWidth.value + d))
}
const resizeRight = (d: number): void => {
  rightWidth.value = Math.min(560, Math.max(240, rightWidth.value - d))
}
// 初始化消毒:陈旧持久化值(超出合法范围/异常类型)夹取回默认邻域,防布局被历史脏数据撑坏
resizeLeft(0)
resizeRight(0)

// 抽屉状态(P1)
const agentDrawerOpen = ref(false)
const agentDrawerId = ref<string | null>(null)
const openAgent = (id: string): void => {
  agentDrawerId.value = id
  agentDrawerOpen.value = true
}
/** 活动条入口:跨 channel 的 busy 成员 → 先聚焦其 channel 再开抽屉 */
const openAgentInChannel = (target: { channelId: string, agentId: string }): void => {
  wsStore.setActiveChannel(wsId.value, target.channelId)
  openAgent(target.agentId)
}
/** @提及 pill 点击入口(ClusterRoute/ClusterStream inject;时间线与 lanes 全树可用) */
provide('aw:open-agent', openAgentInChannel)
const taskDrawerOpen = ref(false)
const taskDrawerId = ref<string | null>(null)
const openTask = (id: string): void => {
  taskDrawerId.value = id
  taskDrawerOpen.value = true
}

// ⌘K 命令面板 + A2A 调试器(P2)
const paletteOpen = ref(false)
const a2aDebugOpen = ref(false)
const composerBox = ref<HTMLElement | null>(null)
const focusComposer = (): void => {
  composerBox.value?.querySelector('textarea')?.focus()
}

useHead({ title: () => `${workspace.value?.name ?? 'Workspace'} · AgentWorkShop` })
</script>

<template>
  <div class="harness">
    <!-- @提及悬停信息卡(文档级委托;时间线/lanes 全树生效) -->
    <workshop-mention-hover-card />
    <!-- 顶栏 -->
    <div class="topbar">
      <div
        class="left"
        tabindex="-1"
        @keydown="onViewKey"
      >
        <span class="topbar-mark i-tabler-box" />
        <span class="ws-name">{{ workspace?.name ?? '未知 Workspace' }}</span>
        <span
          v-if="channelId"
          class="chan-chip"
          :title="channelId"
        >
          <span class="chan-hash">#</span>{{ entities.channels[channelId]?.name ?? channelId.slice(0, 8) }}
        </span>
        <a-segmented
          v-if="channelId"
          v-model:value="view"
          size="small"
          :options="viewOptions"
          class="view-switch"
          :title="$t('wsView.kqwckjr001')"
          @keydown="onViewKey"
        />
      </div>
      <div class="right">
        <button
          class="pane-toggle im"
          :class="{ off: !leftOpen }"
          :title="$t('wsView.k1tsy2e4002')"
          @click="leftOpen = !leftOpen"
        >
          <span class="i-tabler-layout-sidebar-left-collapse im-pop" />
        </button>
        <button
          class="pane-toggle im"
          :class="{ off: !rightOpen }"
          :title="$t('wsView.k1tx0ppf003')"
          @click="rightOpen = !rightOpen"
        >
          <span class="i-tabler-layout-sidebar-right-collapse im-pop" />
        </button>
        <button
          class="pane-toggle im"
          title="A2A RPC/SSE 调试器"
          @click="a2aDebugOpen = true"
        >
          <span class="i-tabler-terminal-2 im-pop" />
        </button>
        <button
          class="pane-toggle im"
          :title="$t('wsView.k1cvg8sb004')"
          @click="paletteOpen = true"
        >
          <span class="i-tabler-command im-pop" />
        </button>
        <span
          class="dot"
          :style="{ background: stateColor }"
        />
        <span
          class="ws-state"
          :data-state="conn.state"
        >{{ conn.state }}</span>
        <span class="seq">seq {{ lastSeq }}</span>
      </div>
    </div>

    <!-- 主体三栏(左/右侧栏可折叠 + 拖拽调宽;分隔条 hairline 即面板边界) -->
    <div class="main">
      <div
        v-if="leftOpen"
        class="left-pane"
        :style="{ flexBasis: `${leftWidth}px` }"
      >
        <div class="left-scroll">
          <workshop-channel-session-list :ws-id="wsId" />
        </div>
        <workshop-live-agent-bar
          :ws-id="wsId"
          @open-agent="openAgentInChannel"
        />
      </div>
      <workshop-pane-splitter
        v-if="leftOpen"
        :label="$t('wsView.k1fkfvra005')"
        @resize="resizeLeft"
        @reset="leftWidth = LEFT_W_DEFAULT"
      />
      <div class="center-pane">
        <template v-if="channelId">
          <workshop-transcript-timeline
            v-if="view === 'timeline'"
            :channel-id="channelId"
          />
          <workshop-agent-lanes-view
            v-else-if="view === 'lanes'"
            :channel-id="channelId"
          />
          <workshop-task-board-view
            v-else-if="view === 'board'"
            :channel-id="channelId"
            @open-task="openTask"
          />
          <workshop-multi-channel-view
            v-else-if="view === 'split'"
            :ws-id="wsId"
            @open-task="openTask"
          />
          <workshop-town-view
            v-else-if="view === 'town'"
            :channel-id="channelId"
          />
        </template>
        <div
          v-else
          class="pane-empty"
        >
          <span class="pe-icon i-tabler-messages" />
          <div class="pe-title">
            {{ $t('wsView.klzbtyp007') }} <span class="aw-serif-accent-italic">Channel</span> {{ $t('wsView.k3zaj4008') }}
          </div>
          <div class="pe-sub">
            {{ $t('wsView.k1us0cxy009') }}
          </div>
        </div>
      </div>
      <workshop-pane-splitter
        v-if="rightOpen"
        :label="$t('wsView.kwqb0st006')"
        @resize="resizeRight"
        @reset="rightWidth = RIGHT_W_DEFAULT"
      />
      <div
        v-if="rightOpen"
        class="right-pane"
        :class="{ empty: wsStore.loaded && !channelId }"
        :style="{ flexBasis: `${rightWidth}px` }"
      >
        <workshop-inspector-panel
          v-if="channelId"
          :channel-id="channelId"
          @open-agent="openAgent"
          @open-task="openTask"
        />
        <!-- 加载中/无频道的诚实降级态(workspace 列表未返回前不误判为"空") -->
        <div
          v-else-if="!wsStore.loaded"
          class="pane-loading"
        >
          正在加载 Workspace…
        </div>
      </div>
    </div>

    <!-- Composer -->
    <div
      v-if="channelId"
      ref="composerBox"
      class="composer-pane"
    >
      <workshop-composer :channel-id="channelId" />

      <!-- 抽屉 -->
      <workshop-agent-inspector-drawer
        v-model:open="agentDrawerOpen"
        :channel-id="channelId ?? ''"
        :agent-id="agentDrawerId"
      />
      <workshop-task-inspector-drawer
        v-model:open="taskDrawerOpen"
        :channel-id="channelId ?? ''"
        :task-id="taskDrawerId"
      />
      <workshop-a2a-rpc-debugger
        v-model:open="a2aDebugOpen"
        :channel-id="channelId ?? ''"
      />

      <!-- ⌘K 命令面板 -->
      <workshop-command-palette
        v-model:open="paletteOpen"
        :ws-id="wsId"
        @set-view="view = $event"
        @open-a2a-debug="a2aDebugOpen = true"
        @compose="focusComposer"
      />
    </div>
  </div>
</template>

<style scoped>
.harness {
  display: flex;
  flex-direction: column;
  height: calc(100dvh - var(--app-header-h, 56px) - var(--app-footer-h, 46px) - 16px);
  min-height: 0;
  margin: 0;
  border: 1px solid var(--line);
  border-radius: var(--radius-shell);
  overflow: hidden;
  background: var(--paper-raised);
  box-shadow: var(--shadow-card);
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  font-size: 13px;
  background: var(--paper-raised);
  border-bottom: 1px solid var(--line);
}
.left,
.right {
  display: flex;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.topbar-mark {
  font-size: 15px;
  color: var(--ink-faint);
}
.ws-name {
  max-width: 260px;
  overflow: hidden;
  font-family: var(--font-display);
  font-weight: 400;
  font-size: 17px;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* channel 胶囊:hairline chip + serif # */
.chan-chip {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  max-width: 200px;
  padding: 1px 10px;
  overflow: hidden;
  font-size: 12px;
  color: var(--ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
}
.chan-hash {
  font-family: var(--font-display);
  color: var(--ink-faint);
}
.view-switch { margin-left: 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.ws-state {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}
.ws-state[data-state='open'] { color: var(--tone-success-dot); border-color: color-mix(in srgb, var(--tone-success-dot) 45%, transparent); }
.ws-state[data-state='connecting'] { color: var(--tone-warning-dot); border-color: color-mix(in srgb, var(--tone-warning-dot) 45%, transparent); }
.ws-state[data-state='closed'] { color: var(--tone-danger-dot); border-color: color-mix(in srgb, var(--tone-danger-dot) 45%, transparent); }
.seq {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  color: var(--ink-faint);
}

/* 侧栏折叠开关:幽灵图标钮 */
.pane-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  font-size: 14px;
  color: var(--ink-soft);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-panel-sm);
  transition: color var(--transition-fast), background var(--transition-fast), opacity var(--transition-fast);
}
.pane-toggle:hover {
  color: var(--ink);
  background: var(--paper-deep);
}
.pane-toggle.off {
  opacity: 0.4;
}
.pane-toggle.off:hover {
  opacity: 1;
}
.main {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}
.left-pane {
  display: flex;
  flex: 0 0 auto; /* 宽度由拖拽分隔条驱动(inline flexBasis) */
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--paper);
}
.left-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden auto;
}
.center-pane {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  max-width: 100%;
  overflow: hidden;
  background: var(--paper); /* 灰画布:消息气泡/白色面板在此浮出(Slack 式分层) */
}
.center-pane > * {
  min-width: 0;
  max-width: 100%;
}
.right-pane {
  flex: 0 0 auto; /* 宽度由拖拽分隔条驱动(inline flexBasis) */
  min-height: 0;
  overflow: hidden;
  background: var(--paper);
}
.right-pane.empty { opacity: 0.35; }
/* workspace 列表加载中的诚实降级态(不算"空",不淡化整栏) */
.pane-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 12px;
  color: var(--ink-faint);
}
.composer-pane { flex: 0 0 auto; }
</style>
