<script setup lang="ts">
/**
 * 左栏 Channel 会话列表(Zcode session 栏):workspace 内挂载的 channel,
 * 实时状态徽标(忙碌成员数/活跃任务数),点击聚焦;挂载/移出/设置操作。
 * v10 模板化:
 *  - 「从模板挂载」:选择 Channel 模板 → 实例化 + 挂载一步完成(替代"挂载已有 Channel");
 *  - 「设置」:热修改当前 Channel 实例的场景描述与工作目录(成员运行时自动回收重装配);
 *  - 「保存为模板」:把当前 Channel 实例捕获为可复用模板(场景/目录/团队快照)。
 */
import { message } from 'ant-design-vue'
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import { useWorkshopApi, type ChannelDto } from '@/app/composables/workshop/useWorkshopApi'
import { useChannelList } from '@/app/composables/workshop/useChannelList'
import MountChannelModal from '@/app/components/workshop/session-list/MountChannelModal.vue'
import ChannelSettingsModal from '@/app/components/workshop/session-list/ChannelSettingsModal.vue'
import SaveTemplateModal from '@/app/components/workshop/session-list/SaveTemplateModal.vue'

const { t } = useI18n()

const props = defineProps<{ wsId: string }>()
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
</script>

<template>
  <div class="channel-list">
    <div class="list-head">
      <span class="title">Channels</span>
      <span class="head-actions">
        <button
          class="head-op im"
          type="button"
          :title="$t('channelSessionList.tplCenterTitle')"
          @click="navigateTo('/workshop/channel-templates')"
        >
          <span class="i-tabler-layout-grid-add im-pop" />
        </button>
        <button
          class="head-op im"
          type="button"
          :title="$t('channelSessionList.newChannelTitle')"
          @click="mountModal = true"
        >
          <span class="i-tabler-plus im-pop" />
        </button>
      </span>
    </div>

    <!-- 频道列表主体:数据源(REST channels + WS entities)均为客户端态,
         SSR 首帧为空 → 硬刷新水合时结构与客户端首渲染不一致,节点会错配到
         相邻 antd Select 的 DOM 上(行内 .row1 布局丢失、按钮错位)。
         ClientOnly 隔离:SSR 输出空壳,客户端一次性渲染,无水合配对。 -->
    <ClientOnly>
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
          >{{ ch.agents }} {{ $t('channelSessionList.k1ggoa45025') }} {{ ch.busy }} / {{ $t('channelSessionList.k3wcox034') }} {{ ch.activeTasks }}</span>
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
    </ClientOnly>

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
  padding: 12px 10px 8px;
}
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 8px;
}
.title {
  font-family: var(--font-display);
  font-size: 16px;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.head-actions { display: inline-flex; gap: 2px; }
.head-op {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  font-size: 14px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-chip);
  transition: background var(--transition-fast), color var(--transition-fast);
}
.head-op:hover { color: var(--ink); background: var(--paper-deep); }
.empty {
  padding: 14px 10px;
  font-size: 12px;
  color: var(--ink-faint);
}
.channel-item {
  padding: 7px 9px;
  margin: 1px 0;
  cursor: pointer;
  border-radius: var(--radius-panel-sm);
  transition: background var(--transition-fast);
}
.channel-item:hover { background: var(--paper-deep); }
.channel-item.active { background: var(--paper-deep); box-shadow: inset 2px 0 0 var(--accent); }
.row1 {
  display: flex;
  gap: 7px;
  align-items: center;
  font-size: 13px;
  color: var(--ink-soft);
}
.channel-item.active .row1 { color: var(--ink); font-weight: 500; }
.dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  background: var(--tone-neutral-dot);
  opacity: 0.55;
  border-radius: 50%;
}
.dot.live {
  background: var(--tone-success-dot);
  opacity: 1;
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
  font-size: 10px;
  line-height: 16px;
  color: var(--accent, var(--ink-soft));
  border: 1px solid color-mix(in srgb, var(--accent, var(--ink-soft)) 45%, transparent);
  border-radius: var(--radius-chip);
}
.sched-n { font-family: var(--font-mono); font-size: 9.5px; }
.op {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  font-size: 13px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-chip);
  /* 常显(低透明度):不再 hover-only——行级操作入口不应时隐时现 */
  opacity: 0.55;
  transition: opacity var(--transition-fast), color var(--transition-fast), background var(--transition-fast);
}
.channel-item:hover .op,
.channel-item.active .op { opacity: 0.9; }
.op:hover { opacity: 1; color: var(--ink); background: var(--paper-deep); }
.op:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.row2 { padding-left: 14px; font-size: 11px; color: var(--ink-faint); }
.meta.syncing { font-style: italic; opacity: 0.6; }
.row2.ws {
  display: flex;
  gap: 4px;
  align-items: center;
  overflow: hidden;
  max-width: 100%;
  padding: 0 2px 0 14px;
  font-family: var(--font-mono);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-faint);
  text-align: left;
  cursor: copy; /* 点击复制完整路径(title 提示) */
  background: transparent;
  border: 0;
  border-radius: var(--radius-chip);
  transition: color var(--transition-fast), background var(--transition-fast);
}
.row2.ws:hover { color: var(--ink-soft); background: color-mix(in srgb, currentColor 6%, transparent); }
.row2.ws:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.mount-template { padding: 12px 6px 6px; border-top: 1px solid var(--line); margin-top: 10px; }
.select { width: 100%; }
.tpl-hint {
  padding: 5px 2px 0;
  font-size: 10.5px;
  color: var(--ink-faint);
}
.ws-hint { font-size: 11px; color: var(--ink-faint); }
</style>
