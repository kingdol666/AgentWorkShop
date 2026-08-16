<script setup lang="ts">
/**
 * Workspace 总览:会话卡片墙(创建/进入/删除/重命名),
 * 卡片显示挂载的 Channel 与实时聚合状态(来自 WS entities)。
 */
import { message } from 'ant-design-vue'
import { useWorkspacesStore } from '../../stores/workshop/workspaces'
import { useEntitiesStore } from '../../stores/workshop/entities'
import { useWorkshopWs } from '../../composables/workshop/useWorkshopWs'

definePageMeta({ layout: 'default' })

const wsStore = useWorkspacesStore()
const entities = useEntitiesStore()
const { subscribe } = useWorkshopWs()

// 已有 workspace 的 channel 订阅(总览页也保持事件流活跃,状态徽标实时)
watch(
  () => wsStore.workspaces.map(w => w.channelIds.join(',')).join('|'),
  () => {
    for (const ws of wsStore.workspaces) {
      for (const id of ws.channelIds) subscribe(id)
    }
  },
  { immediate: true },
)

const createOpen = ref(false)
const createName = ref('')
const create = (): void => {
  const name = createName.value.trim()
  if (!name) {
    message.warning('Workspace 名称必填')
    return
  }
  const ws = wsStore.create(name)
  createOpen.value = false
  createName.value = ''
  navigateTo(`/workshop/w/${ws.id}`)
}

const remove = (id: string): void => {
  wsStore.remove(id)
  message.success('已删除')
}

const channelSummary = (channelIds: string[]) => channelIds.map((id) => {
  const meta = entities.channels[id]
  const agents = entities.agents[id] ?? []
  return {
    id,
    name: meta?.name ?? id.slice(0, 8),
    agents: agents.length,
    busy: agents.filter(a => a.state === 'busy').length,
    activeTasks: (entities.tasks[id] ?? []).filter(t => !['COMPLETED', 'CANCELED', 'FAILED'].includes(t.state)).length,
  }
})

useHead({ title: 'Workshop · Agent Harness' })
</script>

<template>
  <div class="page">
    <div class="head">
      <div>
        <h2>Workshop 工作区</h2>
        <p class="sub">
          Workspace = 会话隔离层;每个 Workspace 挂载自己的 Channel,互不干扰。
        </p>
      </div>
      <a-button
        type="primary"
        @click="createOpen = true"
      >
        <span class="i-tabler-plus" />
        新建 Workspace
      </a-button>
    </div>

    <div class="grid">
      <div
        v-for="ws in wsStore.workspaces"
        :key="ws.id"
        class="card"
      >
        <div class="card-head">
          <span class="i-tabler-box" />
          <span class="name">{{ ws.name }}</span>
          <a-dropdown>
            <span class="i-tabler-dots op" />
            <template #overlay>
              <a-menu>
                <a-menu-item @click="navigateTo(`/workshop/w/${ws.id}`)">
                  进入
                </a-menu-item>
                <a-menu-item
                  danger
                  @click="remove(ws.id)"
                >
                  删除
                </a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
        </div>
        <div class="card-body">
          <div
            v-for="ch in channelSummary(ws.channelIds)"
            :key="ch.id"
            class="ch-row"
            @click="navigateTo(`/workshop/w/${ws.id}`)"
          >
            <span
              class="dot"
              :class="{ live: ch.activeTasks > 0 }"
            />
            <span class="ch-name">{{ ch.name }}</span>
            <span class="ch-meta">{{ ch.agents }} agent · {{ ch.busy }} 忙 · {{ ch.activeTasks }} 任务</span>
          </div>
          <div
            v-if="ws.channelIds.length === 0"
            class="empty"
          >
            未挂载 Channel(进入后从左栏挂载)
          </div>
        </div>
        <a-button
          block
          type="primary"
          ghost
          @click="navigateTo(`/workshop/w/${ws.id}`)"
        >
          进入控制台
        </a-button>
      </div>

      <div
        v-if="wsStore.workspaces.length === 0"
        class="card placeholder"
        @click="createOpen = true"
      >
        <span class="i-tabler-plus big" />
        <span>新建第一个 Workspace</span>
      </div>
    </div>

    <a-modal
      v-model:open="createOpen"
      title="新建 Workspace"
      ok-text="创建并进入"
      cancel-text="取消"
      @ok="create"
    >
      <a-input
        v-model:value="createName"
        placeholder="Workspace 名称,如:支付网关重构"
        @keydown.enter="create"
      />
    </a-modal>
  </div>
</template>

<style scoped>
.page { padding: 4px; }
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
h2 { margin: 0 0 4px; }
.sub { margin: 0; font-size: 12px; opacity: 0.55; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  border-radius: 12px;
}
.card.placeholder {
  align-items: center;
  justify-content: center;
  min-height: 160px;
  font-size: 13px;
  opacity: 0.55;
  cursor: pointer;
  border-style: dashed;
}
.big { font-size: 28px; }
.card-head {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 15px;
}
.name { flex: 1 1 auto; font-weight: 700; }
.op { cursor: pointer; opacity: 0.4; }
.op:hover { opacity: 1; }
.card-body { flex: 1 1 auto; min-height: 40px; }
.ch-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 6px;
  margin: 2px 0;
  font-size: 12px;
  cursor: pointer;
  border-radius: 6px;
}
.ch-row:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  background: #52c41a66;
  border-radius: 50%;
}
.dot.live { background: #52c41a; box-shadow: 0 0 6px #52c41a; }
.ch-name { flex: 0 0 auto; font-weight: 600; }
.ch-meta { flex: 1 1 auto; overflow: hidden; font-family: ui-monospace, Consolas, monospace; font-size: 11px; opacity: 0.5; text-overflow: ellipsis; white-space: nowrap; }
.empty { padding: 12px 6px; font-size: 12px; opacity: 0.4; }
</style>
