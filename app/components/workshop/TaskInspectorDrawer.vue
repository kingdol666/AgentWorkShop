<script setup lang="ts">
/**
 * Task 抽屉(P1):执行详情。
 *  - REST 全量详情(描述/artifacts 全文/history)
 *  - AEP 状态时间线(该任务全部 task.status/progress 事件重放)
 *  - 子任务树;操作:取消任务
 */
import { message } from 'ant-design-vue'
import { useEntitiesStore } from '../../stores/workshop/entities'
import { useEventsStore } from '../../stores/workshop/events'
import { useWorkshopApi, type TaskDto } from '../../composables/workshop/useWorkshopApi'

const props = defineProps<{
  channelId: string
  taskId: string | null
}>()
const open = defineModel<boolean>('open', { default: false })

const entities = useEntitiesStore()
const events = useEventsStore()
const api = useWorkshopApi()

const detail = ref<TaskDto | null>(null)
const loading = ref(false)
const load = async (): Promise<void> => {
  if (!props.taskId) return
  loading.value = true
  try {
    const res = await api.getTask(props.taskId)
    detail.value = (res as unknown as { data?: TaskDto }).data ?? null
  }
  finally {
    loading.value = false
  }
}
watch(() => [open.value, props.taskId], () => {
  if (open.value && props.taskId) void load()
})

const taskView = computed(() =>
  props.taskId ? entities.taskById(props.channelId, props.taskId) : undefined,
)
const children = computed(() =>
  props.taskId ? (entities.tasks[props.channelId] ?? []).filter(t => t.parentId === props.taskId) : [],
)

/** AEP 状态时间线重放 */
const timeline = computed(() => {
  if (!props.taskId) return []
  return events.ring(props.channelId).items.filter(e =>
    e.taskId === props.taskId && (e.type === 'task.status' || e.type === 'task.progress'))
})

const cancelling = ref(false)
const cancel = async (): Promise<void> => {
  if (!props.taskId) return
  cancelling.value = true
  try {
    await api.cancelTask(props.taskId)
    message.success('已请求取消')
    void load()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    cancelling.value = false
  }
}

/** HITL:重试 FAILED 任务(lead/worker 任务均可;优先原 assignee,否则最短队列 worker) */
const retrying = ref(false)
const retry = async (): Promise<void> => {
  if (!props.taskId) return
  retrying.value = true
  try {
    await api.retryTask(props.taskId)
    message.success('已重新投递执行')
    void load()
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    retrying.value = false
  }
}

const agentName = (id: string): string =>
  entities.agentById(props.channelId, id)?.name ?? id.slice(0, 8)

const stateColor: Record<string, string> = {
  SUBMITTED: 'default',
  ASSIGNED: 'processing',
  WORKING: 'processing',
  WAITING: 'warning',
  COMPLETED: 'success',
  FAILED: 'error',
  CANCELED: 'default',
}
</script>

<template>
  <a-drawer
    v-model:open="open"
    placement="right"
    :width="560"
    :title="detail?.title ?? taskView?.title ?? '任务详情'"
  >
    <a-spin :spinning="loading">
      <template v-if="detail || taskView">
        <div class="head">
          <a-tag
            :color="stateColor[taskView?.state ?? detail?.state ?? ''] ?? 'default'"
          >
            {{ taskView?.state ?? detail?.state }}
          </a-tag>
          <span class="meta">指派:{{ agentName(taskView?.assigneeId ?? detail?.assigneeId ?? '') }}</span>
          <span class="meta">{{ taskView?.progress ?? detail?.progress ?? 0 }}%</span>
          <div class="spacer" />
          <a-popconfirm
            v-if="(taskView?.state ?? detail?.state) === 'FAILED'"
            title="确认重试该任务?"
            @confirm="retry"
          >
            <a-button
              size="small"
              :loading="retrying"
            >
              重试任务
            </a-button>
          </a-popconfirm>
          <a-popconfirm
            title="确认取消该任务?"
            @confirm="cancel"
          >
            <a-button
              danger
              size="small"
              :loading="cancelling"
              :disabled="['COMPLETED', 'CANCELED', 'FAILED'].includes(taskView?.state ?? detail?.state ?? '')"
            >
              取消任务
            </a-button>
          </a-popconfirm>
        </div>

        <a-descriptions
          v-if="detail?.description"
          :column="1"
          size="small"
          class="desc"
        >
          <a-descriptions-item label="描述">
            {{ detail.description }}
          </a-descriptions-item>
        </a-descriptions>

        <a-tabs
          size="small"
          default-active-key="timeline"
        >
          <a-tab-pane
            key="timeline"
            tab="状态时间线"
          >
            <div
              v-if="timeline.length === 0"
              class="empty"
            >
              暂无事件(连接前发生)
            </div>
            <div
              v-for="e in timeline"
              :key="`${e.seq}-${e.type}`"
              class="tl-row"
            >
              <span class="tl-time">{{ e.at.slice(11, 19) }}</span>
              <a-tag
                v-if="e.type === 'task.status'"
                :color="stateColor[(e.payload as { state: string }).state] ?? 'default'"
                class="state"
              >
                {{ (e.payload as { state: string }).state }}
              </a-tag>
              <span
                v-else
                class="tl-progress"
              >进度 {{ (e.payload as { progress: number }).progress }}%</span>
            </div>
          </a-tab-pane>

          <a-tab-pane :tab="`交付物(${detail?.artifacts.length ?? 0})`">
            <div
              v-if="!detail?.artifacts.length"
              class="empty"
            >
              (无)
            </div>
            <workshop-artifact-card
              v-for="a in detail?.artifacts ?? []"
              :key="a.artifactId"
              :artifact="a"
            />
          </a-tab-pane>

          <a-tab-pane :tab="`子任务(${children.length})`">
            <div
              v-if="children.length === 0"
              class="empty"
            >
              (无子任务)
            </div>
            <div
              v-for="c in children"
              :key="c.id"
              class="child-row"
            >
              <a-tag
                :color="stateColor[c.state] ?? 'default'"
                class="state"
              >
                {{ c.state }}
              </a-tag>
              <span class="child-title">{{ c.title }}</span>
              <span class="child-meta">{{ agentName(c.assigneeId) }} · {{ c.progress }}%</span>
            </div>
          </a-tab-pane>

          <a-tab-pane :tab="`原始内容(${detail?.artifacts.reduce((n, a) => n + a.parts.length, 0) ?? 0} parts)`">
            <pre class="raw">{{ JSON.stringify(detail?.artifacts, null, 2)?.slice(0, 4000) }}</pre>
          </a-tab-pane>
        </a-tabs>
      </template>
    </a-spin>
  </a-drawer>
</template>

<style scoped>
.head {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-bottom: 8px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}
.meta { font-size: 12px; font-family: ui-monospace, Consolas, monospace; opacity: 0.6; }
.spacer { flex: 1 1 auto; }
.desc { margin-top: 8px; }
.tl-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 3px 0;
  font-size: 12px;
  font-family: ui-monospace, Consolas, monospace;
}
.tl-time { opacity: 0.45; }
.state { margin-inline-end: 0; font-size: 10px; }
.tl-progress { opacity: 0.7; }
.child-row {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 4px 6px;
  border-radius: 6px;
}
.child-row:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.child-title {
  flex: 1 1 auto;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.child-meta { font-size: 11px; opacity: 0.5; }
.empty { padding: 12px 4px; font-size: 12px; opacity: 0.4; }
.raw {
  max-height: 300px;
  overflow: auto;
  font-size: 11px;
}
</style>
