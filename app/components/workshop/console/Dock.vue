<script setup lang="ts">
/**
 * 控制台底部区:Composer + 全部覆盖层(Agent/Task 抽屉、A2A 调试器、⌘K 命令面板)。
 *
 * 覆盖层与 Composer 同处一棵子树:抽屉宽度拖拽、⌘K 的「写消息」聚焦都依赖这层关系,
 * 故整块一起搬进本组件 —— composerBox 引用与 focusComposer 随之归位于此(聚焦目标
 * 仍是这棵子树里的第一个 textarea,与原页面 DOM 顺序一致)。
 *
 * 开关状态仍由页面持有(活动条、中部画布、右栏都要驱动抽屉),这里经 v-model
 * 读写同一份状态,不产生第二副本。
 */
import type { CenterView } from '@/app/pages/workshop/composables/useWorkspaceShell'

defineProps<{
  wsId: string
  /** 聚焦 channel(页面已确认存在,本组件只在其挂载时渲染) */
  channelId: string
}>()

const view = defineModel<CenterView>('view', { required: true })
const agentOpen = defineModel<boolean>('agentOpen', { required: true })
const agentId = defineModel<string | null>('agentId', { required: true })
const taskOpen = defineModel<boolean>('taskOpen', { required: true })
const taskId = defineModel<string | null>('taskId', { required: true })
const paletteOpen = defineModel<boolean>('paletteOpen', { required: true })
const a2aOpen = defineModel<boolean>('a2aOpen', { required: true })

/** 底部区根节点:⌘K「写消息」按 DOM 顺序取其中第一个 textarea 聚焦 */
const composerBox = ref<HTMLElement | null>(null)
const focusComposer = (): void => {
  composerBox.value?.querySelector('textarea')?.focus()
}
</script>

<template>
  <div
    ref="composerBox"
    class="composer-pane"
  >
    <workshop-composer :channel-id="channelId" />

    <!-- 抽屉 -->
    <workshop-agent-inspector-drawer
      v-model:open="agentOpen"
      :channel-id="channelId"
      :agent-id="agentId"
    />
    <workshop-task-inspector-drawer
      v-model:open="taskOpen"
      :channel-id="channelId"
      :task-id="taskId"
    />
    <workshop-a2a-rpc-debugger
      v-model:open="a2aOpen"
      :channel-id="channelId"
    />

    <!-- ⌘K 命令面板 -->
    <workshop-command-palette
      v-model:open="paletteOpen"
      :ws-id="wsId"
      @set-view="view = $event"
      @open-a2a-debug="a2aOpen = true"
      @compose="focusComposer"
    />
  </div>
</template>

<style scoped>
.composer-pane { flex: 0 0 auto; }
</style>
