<script setup lang="ts">
/**
 * 左栏 Channel 会话列表(Zcode session 栏):workspace 内挂载的 channel,
 * 实时状态徽标(忙碌成员数/活跃任务数),点击聚焦;挂载/移出操作。
 */
import { message } from 'ant-design-vue'
import { useWorkspacesStore } from '../../stores/workshop/workspaces'
import { useEntitiesStore } from '../../stores/workshop/entities'
import { useWorkshopApi } from '../../composables/workshop/useWorkshopApi'

const props = defineProps<{ wsId: string }>()
const wsStore = useWorkspacesStore()
const entities = useEntitiesStore()
const api = useWorkshopApi()

const workspace = computed(() => wsStore.workspaces.find(w => w.id === props.wsId))

const channels = ref<Array<{ id: string, name: string }>>([])
const refreshChannels = async (): Promise<void> => {
  const res = await api.listChannels()
  channels.value = ((res as unknown as { data: ChannelListResp })?.data ?? [])
}
interface ChannelListResp { data?: Array<{ id: string, name: string }> }
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
    })),
)

const select = (channelId: string): void => {
  wsStore.setActiveChannel(props.wsId, channelId)
}

const mountModal = ref(false)
const mountForm = reactive({ name: '', description: '', leadName: 'lead', leadHarness: 'mock', workerCount: 1 })
const mountSubmitting = ref(false)
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
      leadAgent: { name: mountForm.leadName || 'lead', harness: mountForm.leadHarness },
    })
    const created = (res as unknown as { data?: { channelId?: string } })?.data
    const channelId = created?.channelId
    if (!channelId) throw new Error('创建失败')
    for (let i = 0; i < mountForm.workerCount; i++) {
      await api.addChannelAgent(channelId, { name: `w${i + 1}`, harness: 'mock', role: 'worker' })
    }
    wsStore.mountChannel(props.wsId, channelId)
    mountModal.value = false
    mountForm.name = ''
    mountForm.description = ''
    message.success('Channel 已创建并挂载')
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
  existingMountId.value = undefined
}

const unmount = (channelId: string): void => {
  wsStore.unmountChannel(props.wsId, channelId)
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
        <a-form-item label="Lead 名称 / harness">
          <a-input-group compact>
            <a-input
              v-model:value="mountForm.leadName"
              style="width: 50%"
            />
            <a-select
              v-model:value="mountForm.leadHarness"
              style="width: 50%"
              :options="[{ value: 'mock', label: 'mock' }, { value: 'omp', label: 'omp' }]"
            />
          </a-input-group>
        </a-form-item>
        <a-form-item label="Worker 数量(mock)">
          <a-input-number
            v-model:value="mountForm.workerCount"
            :min="0"
            :max="8"
          />
        </a-form-item>
      </a-form>
    </a-modal>
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
.mount-existing { padding: 10px 6px 4px; }
.select { width: 100%; }
</style>
