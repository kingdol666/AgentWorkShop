<script setup lang="ts">
/**
 * 控制台中部画布:按 view 挂载六个视图之一(时间线 / 群聊 / Agent lanes / 任务板 /
 * 多通道同屏 / RPG 小镇),窄屏另有第 4 区「检查器」并入切换条;无频道时给诚实空态。
 * 各视图组件自带数据流,本层只负责选路与把 open-task / open-agent 上抛。
 */
import type { CenterView } from '@/app/pages/workshop/composables/useWorkspaceShell'

type TaskTarget = { channelId: string, taskId: string }

defineProps<{
  /** 路由作用域(多通道同屏视图按 workspace 取挂载清单) */
  wsId: string
  /** 聚焦 channel;undefined = 无挂载频道(空态) */
  channelId?: string
  view: CenterView
  /** 窄屏档(≤1023):检查器不占右侧栏,作为中部独立一区出现 */
  narrow: boolean
}>()

const emit = defineEmits<{
  (e: 'openTask', target: TaskTarget): void
  (e: 'openAgent', id: string): void
}>()
</script>

<template>
  <div class="center-pane">
    <template v-if="channelId">
      <workshop-transcript-timeline
        v-if="view === 'timeline'"
        :channel-id="channelId"
      />
      <!-- v17 人类群聊时间线(chat.message 频道流;人类与 Agent 同场,投递台账可见) -->
      <workshop-chat-timeline
        v-else-if="view === 'chat'"
        :channel-id="channelId"
      />
      <workshop-agent-lanes-view
        v-else-if="view === 'lanes'"
        :channel-id="channelId"
      />
      <workshop-task-board-view
        v-else-if="view === 'board'"
        :channel-id="channelId"
        @open-task="emit('openTask', { channelId, taskId: $event })"
      />
      <workshop-multi-channel-view
        v-else-if="view === 'split'"
        :ws-id="wsId"
        @open-task="emit('openTask', $event)"
      />
      <workshop-town-view
        v-else-if="view === 'town'"
        :channel-id="channelId"
      />
      <!-- 窄屏第 4 区:检查器并入切换条(桌面仍是右侧常驻栏) -->
      <workshop-inspector-panel
        v-else-if="view === 'inspector' && narrow"
        :channel-id="channelId"
        @open-agent="emit('openAgent', $event)"
        @open-task="emit('openTask', { channelId, taskId: $event })"
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
</template>

<style scoped>
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
</style>
