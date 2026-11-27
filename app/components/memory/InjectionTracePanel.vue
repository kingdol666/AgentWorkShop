<script setup lang="ts">
/**
 * 注入追踪（M34）：按 taskId/频道查 memory_injection_log，展示本轮引用的记忆/块/图谱节点。
 * 只展示 refs 与标题，不复制正文。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { apiFetch } from '~/composables/workshop/apiClient'
import { apiErrorMessage } from '@/app/utils/api-error'

interface RefItem {
  id: string
  kind: string
  source?: string
  scopeKind?: string
  scopeKey?: string
  label: string
  subtitle?: string
}
interface InjectionItem {
  id: string
  channelId: string
  channelName: string
  agentId: string
  sessionId: string
  taskId: string
  createdAt: string
  refs: RefItem[]
}

const props = defineProps<{
  channels?: Array<{ id: string, name: string }>
  initialChannelId?: string
}>()

const emit = defineEmits<{
  (e: 'open-memory', id: string): void
}>()

const { t } = useI18n()
const gkey = (k: string): string => `memoryCenter.graph.${k}`
const injectColumns = computed(() => [
  { title: t(gkey('colTime')), dataIndex: 'createdAt', key: 'createdAt', width: 170 },
  { title: t(gkey('colChannel')), dataIndex: 'channelName', key: 'channelName', width: 140 },
  { title: t(gkey('colTask')), dataIndex: 'taskId', key: 'taskId', width: 170 },
  { title: t(gkey('colRefs')), key: 'refs' },
])

const channelId = ref(props.initialChannelId ?? '')
const channelOptions = ref<Array<{ id: string, name: string }>>(props.channels ?? [])
const taskId = ref('')
const items = ref<InjectionItem[]>([])
const loading = ref(false)

async function loadChannels(): Promise<void> {
  if (props.channels?.length) {
    channelOptions.value = props.channels
  }
  else {
    try {
      const list = await apiFetch<Array<{ id: string, name: string }>>({ base: '', path: '/api/workshop/channels' })
      channelOptions.value = Array.isArray(list) ? list : []
    }
    catch { /* 频道列表失败仍可查全部 */ }
  }
  if (!channelId.value) channelId.value = channelOptions.value[0]?.id ?? ''
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const query = new URLSearchParams()
    if (taskId.value.trim()) query.set('taskId', taskId.value.trim())
    if (channelId.value) query.set('channelId', channelId.value)
    query.set('limit', '50')
    const res = await apiFetch<{ items: InjectionItem[] }>({
      base: '', path: `/api/workshop/memory/injections?${query.toString()}`,
    })
    items.value = res.items ?? []
  }
  catch (err) {
    message.error(apiErrorMessage(err))
  }
  finally {
    loading.value = false
  }
}

function formatTime(value: string): string {
  try {
    return new Date(value).toLocaleString()
  }
  catch {
    return value
  }
}

function openRef(item: RefItem): void {
  if (item.kind.startsWith('graph-')) return
  emit('open-memory', item.id)
}

watch(channelId, () => {
  void load()
})
onMounted(() => {
  void (async () => {
    await loadChannels()
    await load()
  })()
})
</script>

<template>
  <section
    class="injection-panel"
    data-testid="memory-injection-panel"
  >
    <div class="toolbar">
      <a-select
        v-model:value="channelId"
        show-search
        allow-clear
        :placeholder="t(gkey('allChannels'))"
        style="width: 240px"
        :options="channelOptions.map(c => ({ value: c.id, label: c.name }))"
        :filter-option="(input: string, option: any) => String(option.label).toLowerCase().includes(input.toLowerCase())"
      />
      <a-input-search
        v-model:value="taskId"
        :placeholder="t(gkey('taskFilter'))"
        style="width: 260px"
        @search="load"
      />
      <a-button
        size="small"
        :loading="loading"
        @click="load"
      >
        {{ t(gkey('refresh')) }}
      </a-button>
    </div>

    <a-spin :spinning="loading">
      <a-empty
        v-if="items.length === 0"
        :description="t(gkey('noInjections'))"
      />
      <a-table
        v-else
        size="small"
        :data-source="items"
        row-key="id"
        :pagination="{ pageSize: 10 }"
        :columns="injectColumns"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'createdAt'">
            {{ formatTime(record.createdAt) }}
          </template>
          <template v-else-if="column.key === 'taskId'">
            <span class="mono">{{ record.taskId ? String(record.taskId).slice(0, 12) : '—' }}</span>
          </template>
          <template v-else-if="column.key === 'refs'">
            <a-space
              wrap
              size="small"
            >
              <a-tag
                v-for="item in record.refs"
                :key="`${record.id}-${item.kind}-${item.id}`"
                :color="item.source === 'graph' ? 'blue' : item.source === 'curated' ? 'green' : undefined"
                class="ref-tag"
                @click="openRef(item)"
              >
                {{ item.label }}
                <span
                  v-if="item.subtitle"
                  class="sub"
                >{{ item.subtitle }}</span>
              </a-tag>
              <span
                v-if="(record.refs as RefItem[]).length === 0"
                class="muted"
              >—</span>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-spin>
    <p class="hint">
      {{ t(gkey('refsHint')) }}
    </p>
  </section>
</template>

<style scoped>
.injection-panel { display: flex; flex-direction: column; gap: 12px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.ref-tag { cursor: pointer; }
.ref-tag .sub { color: var(--ink-faint); font-size: 10px; margin-left: 4px; }
.mono { font-family: var(--font-mono); font-size: 12px; }
.muted { color: var(--ink-faint); font-size: 12px; }
.hint { color: var(--ink-faint); font-size: 12px; margin: 0; }
</style>
