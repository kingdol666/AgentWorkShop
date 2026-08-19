<script setup lang="ts">
/**
 * 左栏 Channel 会话列表(Zcode session 栏):workspace 内挂载的 channel,
 * 实时状态徽标(忙碌成员数/活跃任务数),点击聚焦;挂载/移出操作。
 */
import { message } from 'ant-design-vue'
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'

const props = defineProps<{ wsId: string }>()
const wsStore = useWorkspacesStore()
const entities = useEntitiesStore()
const api = useWorkshopApi()

const workspace = computed(() => wsStore.workspaces.find(w => w.id === props.wsId))

const channels = ref<Array<{ id: string, name: string, workspace?: string }>>([])
const refreshChannels = async (): Promise<void> => {
  // SSR 守卫:axios 相对 baseURL 仅客户端有效(服务端拉取会 Invalid URL)
  if (typeof window === 'undefined') return
  const res = await api.listChannels()
  channels.value = (res as unknown as { data?: Array<{ id: string, name: string, workspace?: string }> })?.data ?? []
}
void refreshChannels()

const mountedChannels = computed(() =>
  (workspace.value?.channelIds ?? [])
    .map(id => ({ id, meta: channels.value.find(c => c.id === id), entity: entities.channels[id] }))
    .map(({ id, meta, entity }) => ({
      id,
      name: entity?.name ?? meta?.name ?? id.slice(0, 8),
      busy: entities.busyCount(id),
      agents: entities.agents[id]?.length ?? 0,
      activeTasks: (entities.tasks[id] ?? []).filter(t => !['COMPLETED', 'CANCELED', 'FAILED'].includes(t.state)).length,
      workspace: meta?.workspace ?? '',
    })),
)

const select = (channelId: string): void => {
  wsStore.setActiveChannel(props.wsId, channelId)
}

const mountModal = ref(false)
const mountForm = reactive({ name: '', description: '', workspace: '' })
const mountSubmitting = ref(false)
/** FileSelector 弹窗(选择服务器目录作为 workspace) */
const fileSelectorOpen = ref(false)
const createAndMount = async (): Promise<void> => {
  if (!mountForm.name.trim()) {
    message.warning('Channel 名称必填')
    return
  }
  mountSubmitting.value = true
  try {
    const res = await api.createChannel({
      name: mountForm.name.trim(),
      description: mountForm.description || undefined,
      // 工作目录:留空 → 服务端默认 data/workspaces/<channelId>;自定义(绝对/相对)不存在时自动创建
      workspace: mountForm.workspace.trim() || undefined,
    })
    const created = (res as unknown as { data?: { channelId?: string } })?.data
    const channelId = created?.channelId
    if (!channelId) throw new Error('创建失败')
    await wsStore.mountChannel(props.wsId, channelId)
    mountModal.value = false
    mountForm.name = ''
    mountForm.description = ''
    mountForm.workspace = ''
    void refreshChannels()
    message.success('Channel 已创建(空团队;进入后通过「添加成员」装配 lead / worker)')
  }
  catch (e) {
    message.error(`创建失败:${e instanceof Error ? e.message : String(e)}`)
  }
  finally {
    mountSubmitting.value = false
  }
}

const existingMountId = ref<string | undefined>()
const mountExisting = (): void => {
  if (!existingMountId.value) return
  wsStore.mountChannel(props.wsId, existingMountId.value)
    .catch((e: { data?: { message?: string }, message?: string }) => { message.error(e?.data?.message ?? e?.message ?? '挂载失败') })
  existingMountId.value = undefined
}

const unmount = (channelId: string): void => {
  wsStore.unmountChannel(props.wsId, channelId)
    .catch((e: { data?: { message?: string }, message?: string }) => { message.error(e?.data?.message ?? e?.message ?? '移出失败') })
}
</script>

<template>
  <div class="channel-list">
    <div class="list-head">
      <span class="title">Channels</span>
      <a-button
        size="small"
        type="text"
        @click="mountModal = true"
      >
        <span class="i-tabler-plus" />
      </a-button>
    </div>

    <div
      v-if="mountedChannels.length === 0"
      class="empty"
    >
      尚未挂载 Channel
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
        <span
          class="i-tabler-x op"
          title="移出 workspace"
          @click.stop="unmount(ch.id)"
        />
      </div>
      <div class="row2">
        <span class="meta">{{ ch.agents }} agent · {{ ch.busy }} 忙 · {{ ch.activeTasks }} 活跃任务</span>
      </div>
      <div
        v-if="ch.workspace"
        class="row2 ws"
        :title="`工作目录:${ch.workspace}(Agent 作业 cwd)`"
      >
        📂 {{ ch.workspace }}
      </div>
    </div>

    <div class="mount-existing">
      <a-select
        v-model:value="existingMountId"
        size="small"
        :placeholder="'挂载已有 Channel'"
        class="select"
        :options="channels.filter(c => !workspace?.channelIds.includes(c.id)).map(c => ({ value: c.id, label: c.name }))"
        @change="mountExisting"
      />
    </div>

    <a-modal
      v-model:open="mountModal"
      title="新建 Channel 并挂载"
      :confirm-loading="mountSubmitting"
      ok-text="创建"
      cancel-text="取消"
      @ok="createAndMount"
    >
      <a-form layout="vertical">
        <a-form-item label="Channel 名称">
          <a-input v-model:value="mountForm.name" />
        </a-form-item>
        <a-form-item label="描述">
          <a-input v-model:value="mountForm.description" />
        </a-form-item>
        <a-form-item label="工作目录(团队作业挂载点)">
          <a-input-group compact>
            <a-input
              v-model:value="mountForm.workspace"
              style="width: 70%"
              placeholder="留空 = data/workspaces/<channelId>"
              allow-clear
              @press-enter="createAndMount"
            />
            <a-button
              style="width: 30%"
              @click="fileSelectorOpen = true"
            >
              📂 浏览…
            </a-button>
          </a-input-group>
          <template #extra>
            <span class="ws-hint">执行任务时该目录注入各 Agent harness 的作业 cwd(omp 子进程工作目录);不存在自动创建</span>
          </template>
        </a-form-item>
        <a-form-item>
          <span class="ws-hint">Channel 创建后为空团队,无任何 Agent;进入后通过「添加成员」选择角色(lead/worker)与场景提示词完成装配</span>
        </a-form-item>
      </a-form>
    </a-modal>

    <!-- FileSelector:服务器目录选择 -> 回填工作目录 -->
    <workshop-file-selector-modal
      v-model:open="fileSelectorOpen"
      title="选择团队工作目录"
      :initial-path="mountForm.workspace || undefined"
      @select="(p) => { mountForm.workspace = p }"
    />
  </div>
</template>

<style scoped>
.channel-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 8px 6px;
  overflow-y: auto;
}
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 6px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.55;
}
.empty {
  padding: 16px 8px;
  font-size: 12px;
  opacity: 0.4;
}
.channel-item {
  padding: 6px 8px;
  margin: 2px 0;
  cursor: pointer;
  border-radius: 6px;
}
.channel-item:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.channel-item.active { background: color-mix(in srgb, var(--color-primary) 18%, transparent); }
.row1 {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
}
.dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  background: #52c41a66;
  border-radius: 50%;
}
.dot.live { background: #52c41a; box-shadow: 0 0 6px #52c41a; }
.ch-name {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.op { flex: 0 0 auto; font-size: 13px; opacity: 0.4; }
.op:hover { opacity: 1; }
.row2 { padding-left: 13px; font-size: 11px; opacity: 0.5; }
.row2.ws {
  overflow: hidden;
  max-width: 100%;
  font-family: ui-monospace, Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.4;
}
.mount-existing { padding: 10px 6px 4px; }
.select { width: 100%; }
.ws-hint { font-size: 11px; opacity: 0.55; }
</style>
