<script setup lang="ts">
/**
 * Task 抽屉(P1):执行详情。
 *  - REST 全量详情(描述/artifacts 全文/history)
 *  - AEP 状态时间线(该任务全部 task.status/progress 事件重放)
 *  - 子任务树;操作:取消任务
 */
import { message } from 'ant-design-vue'
import { useStorage } from '@vueuse/core'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useEventsStore } from '@/app/stores/workshop/events'
import { useWorkshopApi, type TaskDto } from '@/app/composables/workshop/useWorkshopApi'
import { formatLocalClock } from '@/app/composables/workshop/useLocalTime'

const { t } = useI18n()

const props = defineProps<{
  channelId: string
  taskId: string | null
}>()
const open = defineModel<boolean>('open', { default: false })

// 抽屉宽度拖拽调节(PaneSplitter;持久化,双击复位)
const DRAWER_W_DEFAULT = 560
const drawerWidth = useStorage('aw.drawer.taskW', DRAWER_W_DEFAULT)
const resizeDrawer = (d: number): void => {
  drawerWidth.value = Math.min(960, Math.max(380, drawerWidth.value - d))
}

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
    message.success(t('taskInspectorDrawer.k1xj595a013'))
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
    message.success(t('taskInspectorDrawer.ke7bh8u014'))
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

/** 失败原因:FAILED 任务取历史末条非空文本(REST 全量详情含 history) */
const failureReason = computed(() => {
  const d = detail.value
  if (!d || d.state !== 'FAILED') return ''
  const history = (d as unknown as { history?: Array<{ parts?: Array<{ text?: string }> }> }).history ?? []
  for (let i = history.length - 1; i >= 0; i--) {
    const text = (history[i]?.parts ?? []).map(p => p.text ?? '').join(' ').trim()
    if (text) return text.slice(0, 500)
  }
  return d.description?.trim() ?? ''
})

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
    :width="drawerWidth"
    :title="detail?.title ?? taskView?.title ?? '任务详情'"
    class="aw-resizable-drawer"
  >
    <workshop-pane-splitter
      variant="bare"
      class="drawer-resizer"
      :label="$t('taskInspectorDrawer.k6hcbxi001')"
      @resize="resizeDrawer"
      @reset="drawerWidth = DRAWER_W_DEFAULT"
    />
    <a-spin :spinning="loading">
      <template v-if="detail || taskView">
        <div class="head">
          <a-tag
            :color="stateColor[taskView?.state ?? detail?.state ?? ''] ?? 'default'"
          >
            {{ taskView?.state ?? detail?.state }}
          </a-tag>
          <span class="meta">{{ $t('taskInspectorDrawer.k3o48o4010') }}{{ agentName(taskView?.assigneeId ?? detail?.assigneeId ?? '') }}</span>
          <span class="meta">{{ taskView?.progress ?? detail?.progress ?? 0 }}%</span>
          <div class="spacer" />
          <a-popconfirm
            v-if="(taskView?.state ?? detail?.state) === 'FAILED'"
            :title="$t('taskInspectorDrawer.kns2a6x002')"
            @confirm="retry"
          >
            <a-button
              size="small"
              :loading="retrying"
            >
              {{ $t('taskInspectorDrawer.k1lcgf2b005') }}
            </a-button>
          </a-popconfirm>
          <a-popconfirm
            :title="$t('taskInspectorDrawer.k1a7jqb9003')"
            @confirm="cancel"
          >
            <a-button
              danger
              size="small"
              :loading="cancelling"
              :disabled="['COMPLETED', 'CANCELED', 'FAILED'].includes(taskView?.state ?? detail?.state ?? '')"
            >
              {{ $t('taskInspectorDrawer.k1bs0t9b006') }}
            </a-button>
          </a-popconfirm>
        </div>

        <!-- 失败原因(FAILED 任务:历史末条错误原文,让用户知道哪里出了问题) -->
        <div
          v-if="(taskView?.state ?? detail?.state) === 'FAILED' && failureReason"
          class="failure-reason"
        >
          <span class="fr-label">失败原因</span>
          <span class="fr-text">{{ failureReason }}</span>
        </div>

        <a-descriptions
          v-if="detail?.description"
          :column="1"
          size="small"
          class="desc"
        >
          <a-descriptions-item :label="$t('taskInspectorDrawer.k40gkk004')">
            {{ detail.description }}
          </a-descriptions-item>
        </a-descriptions>

        <div
          v-if="detail?.routeReason"
          class="route-reason"
        >
          <span class="route-label">{{ $t('taskInspectorDrawer.k1knph8c007') }}</span>
          <span class="route-text">{{ detail.routeReason }}</span>
        </div>

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
              {{ $t('taskInspectorDrawer.kr3vr2x008') }}
            </div>
            <div
              v-for="e in timeline"
              :key="`${e.seq}-${e.type}`"
              class="tl-row"
            >
              <span class="tl-time">{{ formatLocalClock(e.at) }}</span>
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
              >{{ $t('taskInspectorDrawer.k485ye011') }} {{ (e.payload as { progress: number }).progress }}%</span>
            </div>
          </a-tab-pane>

          <a-tab-pane
            key="artifacts"
            :tab="$t('taskInspectorDrawer.kkp77tf015', { p0: detail?.artifacts.length ?? 0 })"
          >
            <div
              v-if="!detail?.artifacts.length"
              class="empty"
            >
              ({{ $t('taskInspectorDrawer.k401n2012') }}
            </div>
            <workshop-artifact-card
              v-for="a in detail?.artifacts ?? []"
              :key="a.artifactId"
              :artifact="a"
            />
          </a-tab-pane>

          <a-tab-pane
            key="children"
            :tab="$t('taskInspectorDrawer.khnua62016', { p0: children.length })"
          >
            <div
              v-if="children.length === 0"
              class="empty"
            >
              {{ $t('taskInspectorDrawer.k1kmqn5u009') }}
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

          <a-tab-pane
            key="raw"
            :tab="$t('taskInspectorDrawer.kxj74io017', { p0: detail?.artifacts.reduce((n, a) => n + a.parts.length, 0) ?? 0 })"
          >
            <pre class="raw">{{ JSON.stringify(detail?.artifacts, null, 2)?.slice(0, 4000) }}</pre>
          </a-tab-pane>
        </a-tabs>
      </template>
    </a-spin>
  </a-drawer>
</template>

<style scoped>
/* 抽屉左缘调宽手柄:锚定 panel 左缘(aw-resizable-drawer 提供 positioning 上下文) */
.drawer-resizer {
  position: absolute;
  inset: 0 auto 0 0;
  z-index: 8;
}
.head {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-bottom: 8px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}
.meta { font-size: 12px; font-family: var(--font-mono); opacity: 0.6; }
.spacer { flex: 1 1 auto; }
.desc { margin-top: 8px; }
/* 失败原因块(FAILED 任务:历史末条错误原文) */
.failure-reason {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-top: 10px;
  padding: 8px 10px;
  background: rgba(255, 107, 107, 0.09);
  border: 1px solid rgba(255, 107, 107, 0.35);
  border-radius: 8px;
}
.fr-label {
  flex: none;
  font-size: 11px;
  font-weight: 700;
  color: #ff8080;
}
.fr-text {
  font-size: 12px;
  line-height: 1.55;
  color: var(--tone-danger-dot, #ff8080);
  white-space: pre-wrap;
  word-break: break-all;
}
.route-reason {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-top: 6px;
  padding: 8px 10px;
  font-size: 12px;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}
.route-label {
  flex: 0 0 auto;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.route-text { color: var(--ink-soft); }
.tl-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 3px 0;
  font-size: 12px;
  font-family: var(--font-mono);
}
.tl-time { opacity: 0.45; }
.state { margin-inline-end: 0; font-size: 10px; }
.tl-progress { opacity: 0.7; }
.child-row {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 4px 6px;
  border-radius: var(--radius-chip);
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
