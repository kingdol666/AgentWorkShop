<script setup lang="ts">
/**
 * 左栏会话侧栏(ChatGPT 声部):workspace 名 + 「新建频道」主按钮 + 搜索(⌘K)
 * + 「频道」分组(挂载的 channel,实时状态点)+「会话」分组(聚焦频道的会话清单)
 * + 模板挂载 + 底部工作区路径。
 *
 * v10 模板化:
 *  - 「从模板挂载」:选择 Channel 模板 → 实例化 + 挂载一步完成(替代"挂载已有 Channel");
 *  - 「设置」:热修改当前 Channel 实例的场景描述与工作目录(成员运行时自动回收重装配);
 *  - 「保存为模板」:把当前 Channel 实例捕获为可复用模板(场景/目录/团队快照)。
 *
 * 2026-11-07 控制台 ChatGPT 化:行样式从「描边卡片」改为「填充态行」(hover/active
 * 灰阶填充、无边框),新增会话分组与搜索入口;全部既有操作与模态不变。
 */
import { message } from 'ant-design-vue'
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import { useWorkshopApi, type ChannelDto } from '@/app/composables/workshop/useWorkshopApi'
import { useChannelList } from '@/app/composables/workshop/useChannelList'
import MountChannelModal from '@/app/components/workshop/session-list/MountChannelModal.vue'
import ChannelSettingsModal from '@/app/components/workshop/session-list/ChannelSettingsModal.vue'
import SaveTemplateModal from '@/app/components/workshop/session-list/SaveTemplateModal.vue'

const { t } = useI18n()

const props = defineProps<{
  wsId: string
  /** 聚焦 channel(会话分组的数据作用域;undefined = 未聚焦) */
  channelId?: string
}>()

const emit = defineEmits<{
  (e: 'openAgent', target: { channelId: string, agentId: string }): void
  (e: 'openPalette'): void
  (e: 'openSession', sessionId: string): void
}>()

const wsStore = useWorkspacesStore()
const api = useWorkshopApi()

/** 列表数据与行级操作(workspace/channels/模板/选中/路径展示)统一由 composable 持有 */
const {
  workspace,
  channels,
  channelTemplates,
  refreshChannels,
  mountedChannels,
  select,
  copyWorkspace,
  displayWorkspace,
} = useChannelList(toRef(props, 'wsId'))

// ===== 新建 Channel 并挂载(空团队) =====
const mountModal = ref(false)

// ===== 从 Channel 模板挂载(实例化 + mount 一步) =====
const templateMountId = ref<string | undefined>()
const templateMounting = ref(false)
const mountFromTemplate = async (): Promise<void> => {
  if (!templateMountId.value) return
  templateMounting.value = true
  try {
    const res = await api.mountChannelTemplate(props.wsId, templateMountId.value)
    const data = (res as unknown as { data?: { agentCount?: number, channelId?: string } })?.data
    message.success(t('channelSessionList.kai50qc042', { p0: data?.agentCount ?? 0 }))
    templateMountId.value = undefined
    void refreshChannels()
    // 一步挂载端点只返回 channelId,不会走 wsStore.mountChannel 的本地清单维护 ——
    // 必须在这里补上 workspace.channelIds 本地更新并选中新频道,
    // 否则列表要等下一次全量 load 才出现新频道(实测踩坑:刚挂载的频道"消失")
    if (data?.channelId) {
      const ws = wsStore.workspaces.find(w => w.id === props.wsId)
      if (ws && !ws.channelIds.includes(data.channelId)) ws.channelIds.push(data.channelId)
      wsStore.setActiveChannel(props.wsId, data.channelId)
    }
  }
  catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    message.error(apiErrorMessage(err, t('channelSessionList.k97xi7u029')))
  }
  finally {
    templateMounting.value = false
  }
}

const unmount = (channelId: string): void => {
  wsStore.unmountChannel(props.wsId, channelId)
    .catch((e: { data?: { message?: string }, message?: string }) => { message.error(apiErrorMessage(e, t('channelSessionList.k1hgfvdc030'))) })
}

// ===== Channel 实例设置(场景/工作目录热更新)+ 保存为模板 =====
const settingsOpen = ref(false)
const settingsChannelId = ref<string>('')
const settingsChannelMeta = ref<ChannelDto | undefined>()
const openSettings = (channelId: string): void => {
  const meta = channels.value.find(c => c.id === channelId)
  settingsChannelId.value = channelId
  settingsChannelMeta.value = meta
  settingsOpen.value = true
}

// 保存为模板(捕获当前 channel 的场景/目录/团队)
const saveTplOpen = ref(false)
const saveTplName = ref('')
const onSaveTemplate = (name: string): void => {
  saveTplName.value = name
  saveTplOpen.value = true
}

/** 频道行副标题:只展示有信息量的计数(全 0 时仅成员数) */
const channelMeta = (ch: { agents: number, busy: number, activeTasks: number }): string => {
  const parts = [`${ch.agents} 成员`]
  if (ch.busy > 0) parts.push(`忙 ${ch.busy}`)
  if (ch.activeTasks > 0) parts.push(`任务 ${ch.activeTasks}`)
  return parts.join(' · ')
}

const goTemplates = (): void => {
  navigateTo('/workshop/channel-templates')
}
</script>

<template>
  <div class="channel-list">
    <!-- 侧栏头:workspace 名(回总览)+ 模板中心 + 新建 -->
    <div class="side-head">
      <button
        class="ws-link"
        type="button"
        :title="$t('menu.workshop')"
        @click="navigateTo('/workshop')"
      >
        <span class="ws-mark i-tabler-box" />
        <span class="ws-name">{{ workspace?.name ?? $t('wsView.unknownWs') }}</span>
      </button>
      <button
        class="head-op im"
        type="button"
        :title="$t('channelSessionList.tplCenterTitle')"
        @click="goTemplates"
      >
        <span class="i-tabler-layout-grid-add im-pop" />
      </button>
    </div>

    <!-- 主操作:「新建频道」(ChatGPT New chat 同位)+ 搜索(⌘K) -->
    <div class="side-actions">
      <button
        class="new-channel"
        type="button"
        :title="$t('channelSessionList.newChannelTitle')"
        @click="mountModal = true"
      >
        <span class="i-tabler-plus" />
        <span>{{ $t('channelSessionList.newChannelTitle') }}</span>
      </button>
      <button
        class="search-btn"
        type="button"
        @click="emit('openPalette')"
      >
        <span class="i-tabler-search" />
        <span>{{ $t('common.search') }}</span>
        <kbd>⌘K</kbd>
      </button>
    </div>

    <!-- 频道列表主体:数据源(REST channels + WS entities)均为客户端态,
         SSR 首帧为空 → 硬刷新水合时结构与客户端首渲染不一致,节点会错配到
         相邻 antd Select 的 DOM 上(行内 .row1 布局丢失、按钮错位)。
         ClientOnly 隔离:SSR 输出空壳,客户端一次性渲染,无水合配对。 -->
    <ClientOnly>
      <div class="side-section">
        <div class="side-label">
          {{ $t('wsView.channelListTitle') }} · {{ mountedChannels.length }}
        </div>
        <div
          v-if="mountedChannels.length === 0"
          class="empty"
        >
          {{ $t('channelSessionList.kkv789s014') }}
        </div>

        <div
          v-for="ch in mountedChannels"
          :key="ch.id"
          class="channel-item"
          :class="{ active: workspace?.activeChannelId === ch.id }"
          :aria-current="workspace?.activeChannelId === ch.id ? 'true' : undefined"
          @click="select(ch.id)"
        >
          <div class="row1">
            <span
              class="dot"
              :class="{ live: ch.activeTasks > 0 }"
            />
            <span class="ch-name">{{ ch.name }}</span>
            <!-- v16 定时标志:该 channel 绑定了启用的定时计划 -->
            <span
              v-if="ch.scheduled > 0"
              class="sched-tag"
              :title="$t('channelSessionList.schedTagTip', { p0: ch.scheduled })"
            >
              <span class="i-tabler-clock-bolt" />
              <span class="sched-n">{{ ch.scheduled }}</span>
            </span>
            <button
              class="op im"
              type="button"
              :title="$t('channelSessionList.kne35ug001')"
              :aria-label="$t('channelSessionList.kjmldih035', { p0: ch.name })"
              @click.stop="openSettings(ch.id)"
            >
              <span class="i-tabler-settings2 im-pop" />
            </button>
            <button
              class="op im"
              type="button"
              :title="$t('channelSessionList.unmountTitle')"
              :aria-label="$t('channelSessionList.k1yurooi036', { p0: ch.name })"
              @click.stop="unmount(ch.id)"
            >
              <span class="i-tabler-x im-pop" />
            </button>
          </div>
          <div class="row2">
            <!-- 快照未到达:计数不可信,显示同步占位(不呈现误导性的"0 成员") -->
            <span
              v-if="!ch.synced"
              class="meta syncing"
            >{{ $t('channelSessionList.k1bst7s9015') }}</span>
            <span
              v-else
              class="meta"
            >{{ channelMeta(ch) }}</span>
          </div>
          <button
            v-if="displayWorkspace(ch.workspace)"
            class="row2 ws im"
            type="button"
            :title="$t('channelSessionList.kfe4pzq037', { p0: ch.workspace })"
            @click.stop="copyWorkspace(ch.workspace)"
          >
            <span class="i-tabler-folder" /> {{ displayWorkspace(ch.workspace) }}
          </button>
        </div>
      </div>

      <!-- 会话分组(聚焦频道;ChatGPT「历史会话」同位):点击切到多会话视图 -->
      <div
        v-if="channelId"
        class="side-section"
      >
        <div class="side-label">
          {{ $t('sessionManage.title') }}
        </div>
        <workshop-console-session-mini-list
          :channel-id="channelId"
          @open="emit('openSession', $event)"
        />
      </div>

      <div class="mount-template">
        <a-select
          v-model:value="templateMountId"
          size="small"
          :placeholder="$t('channelSessionList.mountFromTpl')"
          class="select"
          :loading="templateMounting"
          :options="channelTemplates.map(t => ({
            value: t.id,
            label: $t('channelSessionList.k1oes209038', { p0: t.isBuiltin ? $t('channelSessionList.pfxBuiltin') : t.visibility === 'public' ? $t('channelSessionList.pfxPublic') : '', p1: t.name, p2: (t.lead ? 1 : 0) + t.members.length }),
          }))"
          @change="mountFromTemplate"
        />
        <div class="tpl-hint">
          {{ $t('channelSessionList.k18ppu31016') }}
        </div>
      </div>
    </ClientOnly>

    <mount-channel-modal
      v-model:open="mountModal"
      :ws-id="wsId"
      @mounted="refreshChannels"
    />

    <channel-settings-modal
      v-model:open="settingsOpen"
      :channel-id="settingsChannelId"
      :channel-meta="settingsChannelMeta"
      @saved="refreshChannels"
      @save-template="onSaveTemplate"
    />

    <save-template-modal
      v-model:open="saveTplOpen"
      :channel-id="settingsChannelId"
      :channel-name="saveTplName"
      @saved="refreshChannels"
    />
  </div>
</template>

<style scoped>
.channel-list {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding: 14px 12px 10px;
  background: var(--chat-surface-raised);
}

/* 侧栏头:workspace 名(可点回总览;ChatGPT 侧栏顶部工作区语义) */
.side-head {
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: space-between;
  padding: 0 6px 10px;
}
.ws-link {
  display: inline-flex;
  flex: 1 1 auto;
  gap: 8px;
  align-items: center;
  min-width: 0;
  padding: 5px 8px;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 10px;
  transition: background var(--transition-fast);
}
.ws-link:hover { background: color-mix(in srgb, var(--chat-ink) 6%, transparent); }
.ws-mark {
  flex: 0 0 auto;
  font-size: 15px;
  color: var(--chat-accent);
}
.ws-name {
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--chat-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.head-op {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  font-size: 14px;
  color: var(--chat-ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 8px;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.head-op:hover {
  color: var(--chat-ink);
  background: color-mix(in srgb, var(--chat-ink) 6%, transparent);
}

/* 主操作区:新建频道(黑底主钮)+ 搜索(幽灵钮)—— ChatGPT New chat/Search 同位 */
.side-actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 2px 6px;
}
.new-channel {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  /* ChatGPT New chat 同位:surface + 发丝边,不再用整块反色压过会话列表 */
  color: var(--chat-accent-strong);
  cursor: pointer;
  background: var(--chat-accent-soft);
  border: 1px solid color-mix(in srgb, var(--chat-accent) 28%, transparent);
  border-radius: 10px;
  transition: background var(--transition-fast), border-color var(--transition-fast), transform var(--transition-fast);
}
.new-channel:hover {
  background: color-mix(in srgb, var(--chat-accent-soft) 70%, var(--chat-surface));
  border-color: color-mix(in srgb, var(--chat-accent) 45%, transparent);
}
.new-channel:active { transform: scale(0.99); }
.search-btn {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  width: 100%;
  padding: 7px 12px;
  font-size: 13px;
  color: var(--chat-ink-faint);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--chat-line);
  border-radius: 10px;
  transition: color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
}
.search-btn:hover {
  color: var(--chat-ink-soft);
  border-color: var(--chat-line-strong);
}
.search-btn kbd {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--chat-ink-faint);
}

/* 分组:小写字距标签(ChatGPT「Chats/Recents」同位) */
.side-section { margin-top: 10px; }
.side-label {
  padding: 0 10px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--chat-ink-faint);
}
.empty {
  padding: 10px;
  font-size: 12px;
  color: var(--chat-ink-faint);
}

/* 频道行:填充态行(无边框卡;hover/active 灰阶) */
.channel-item {
  padding: 7px 9px;
  margin: 1px 0;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 10px;
  transition: background var(--transition-fast);
}
.channel-item:hover { background: color-mix(in srgb, var(--chat-ink) 5%, transparent); }
.channel-item.active { background: color-mix(in srgb, var(--chat-ink) 9%, transparent); }
.channel-item.active .ch-name {
  color: var(--chat-ink);
  font-weight: 600;
}
.row1 {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 13px;
  color: var(--chat-ink-soft);
}
.dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  background: var(--chat-line-strong);
  border-radius: 50%;
}
.dot.live {
  background: var(--chat-accent);
  box-shadow: 0 0 0 3px var(--chat-accent-soft);
}
.ch-name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* v16 定时标签:hairline chip + 时钟图标(不与忙碌点/活跃任务语义混淆) */
.sched-tag {
  display: inline-flex;
  flex: 0 0 auto;
  gap: 2px;
  align-items: center;
  padding: 0 5px;
  font-size: var(--fs-micro);
  line-height: 16px;
  color: var(--accent, var(--ink-soft));
  border: 1px solid color-mix(in srgb, var(--accent, var(--ink-soft)) 45%, transparent);
  border-radius: var(--radius-chip);
}
.sched-n { font-family: var(--font-mono); font-size: var(--fs-micro); }
.op {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  font-size: 13px;
  color: var(--chat-ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 6px;
  /* 常显(低透明度):不再 hover-only——行级操作入口不应时隐时现 */
  opacity: 0.28;
  transition: opacity var(--transition-fast), color var(--transition-fast), background var(--transition-fast);
}
.channel-item:hover .op,
.channel-item:focus-within .op,
.channel-item.active .op { opacity: 0.9; }
.op:hover {
  opacity: 1;
  color: var(--chat-ink);
  background: color-mix(in srgb, var(--chat-ink) 8%, transparent);
}
.op:focus-visible {
  outline: 2px solid var(--chat-accent);
  outline-offset: 1px;
}
.row2 { padding-left: 15px; font-size: 10.5px; color: var(--chat-ink-faint); }
.meta.syncing { font-style: italic; opacity: 0.6; }
.row2.ws {
  display: flex;
  gap: 4px;
  align-items: center;
  overflow: hidden;
  max-width: 100%;
  padding: 0 2px 0 15px;
  font-family: var(--font-mono);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--chat-ink-faint);
  text-align: left;
  cursor: copy; /* 点击复制完整路径(title 提示) */
  background: transparent;
  border: 0;
  border-radius: 6px;
  transition: color var(--transition-fast), background var(--transition-fast);
}
.row2.ws:hover {
  color: var(--chat-ink-soft);
  background: color-mix(in srgb, currentColor 6%, transparent);
}
.row2.ws:focus-visible {
  outline: 2px solid var(--chat-accent);
  outline-offset: 1px;
}

/* 模板挂载:发丝线分隔 + 紧凑选择器 */
.mount-template {
  padding: 10px 4px 4px;
  margin-top: 8px;
  border-top: 1px solid var(--chat-line);
}
.select { width: 100%; }
.tpl-hint {
  padding: 4px 2px 0;
  font-size: 10px;
  color: var(--chat-ink-faint);
}
</style>
