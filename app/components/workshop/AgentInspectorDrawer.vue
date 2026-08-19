<script setup lang="ts">
/**
 * Agent 抽屉:单成员的独立作业视图 + 成员管理操作。
 *  - 独立 transcript(该 agent 的事件流,与主时间线同卡片体系)
 *  - 任务队列(assignee 视角:执行中/待执行/已完成)
 *  - 记忆页签(身份锁定本成员,token 自动装配)
 *  - 操作:聚焦主时间线 / 发消息(注入即时消息)/ 启停(PATCH)/ 移除(DELETE)
 * lead 成员不提供启停与移除(移除 lead 会使 channel 失去调度,须走 channel 删除)。
 */
import { message } from 'ant-design-vue'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useEventsStore } from '@/app/stores/workshop/events'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'
import { useClusteredBlocks } from '@/app/composables/workshop/useClusteredBlocks'
import type { AepEnvelope } from '@/shared/workshop-protocol'

const props = defineProps<{
  channelId: string
  agentId: string | null
}>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ (e: 'removed', agentId: string): void }>()

const entities = useEntitiesStore()
const events = useEventsStore()
const api = useWorkshopApi()

const agent = computed(() =>
  props.agentId ? entities.agentById(props.channelId, props.agentId) : undefined,
)

const tab = ref<'stream' | 'queue' | 'memory'>('stream')

/** 启用/禁用(worker;enabled 来自快照/agent.member 事件,变更经事件回流) */
const toggling = ref(false)
const toggleEnabled = async (checked: string | number | boolean): Promise<void> => {
  if (!props.agentId) return
  toggling.value = true
  try {
    await api.updateChannelAgent(props.channelId, props.agentId, {
      enabled: checked === true ? 1 : 0,
      reason: checked === true ? '重新启用(接收新任务)' : '停用(暂停接收新任务)',
    })
    message.success(checked === true ? '已启用' : '已停用(其排队任务由调度回收)')
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    toggling.value = false
  }
}

/** 移除成员(worker;排队任务自动重派) */
const removing = ref(false)
const removeMember = async (): Promise<void> => {
  if (!props.agentId) return
  removing.value = true
  try {
    await api.removeChannelAgent(props.channelId, props.agentId)
    message.success('成员已移除')
    open.value = false
    emit('removed', props.agentId)
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    removing.value = false
  }
}

/** 该 agent 的独立事件流:聚类块视图(忽略全局过滤,只按 agentId;重复内容折合) */
const { blocks: stream } = useClusteredBlocks(() => props.channelId, {
  predicate: () => (e: AepEnvelope) => e.agentId === props.agentId,
  resetKey: () => props.agentId,
})

const assignedTasks = computed(() => {
  const tasks = entities.tasks[props.channelId] ?? []
  const own = props.agentId ? tasks.filter(t => t.assigneeId === props.agentId) : []
  return {
    working: own.filter(t => ['WORKING', 'ASSIGNED'].includes(t.state)),
    queued: own.filter(t => t.state === 'SUBMITTED'),
    done: own.filter(t => ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state)),
  }
})

/** 当前执行任务标题(头部署上下文) */
const currentTitle = computed(() =>
  agent.value?.currentTaskId ? entities.taskTitle(props.channelId, agent.value.currentTaskId) : '',
)

const focusActive = computed(() =>
  props.agentId && (events.focusAgents[props.channelId] ?? null) === props.agentId,
)
const toggleFocus = (): void => {
  if (!props.agentId) return
  events.setFocusAgent(props.channelId, focusActive.value ? null : props.agentId)
  message.success(focusActive.value ? '已取消聚焦' : '主时间线已聚焦该 agent')
}

const sendText = ref('')
const priority = ref<'immediate' | 'task'>('immediate')
const requireReply = ref(false)
const sending = ref(false)
const send = async (): Promise<void> => {
  if (!props.agentId || !sendText.value.trim()) return
  sending.value = true
  try {
    await api.injectMessage(props.channelId, {
      toAgentId: props.agentId,
      text: sendText.value.trim(),
      priority: priority.value,
      requireReply: requireReply.value,
    })
    message.success('消息已注入')
    sendText.value = ''
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    sending.value = false
  }
}

const stateDot: Record<string, string> = {
  idle: '#52c41a',
  busy: '#1677ff',
  stopped: '#8c8c8c',
}
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
    :width="520"
    :title="agent ? `${agent.name}(${agent.role})` : 'Agent'"
    class="agent-drawer"
  >
    <template v-if="agent">
      <div class="head">
        <span
          class="dot"
          :style="{ background: stateDot[agent.state] ?? '#8c8c8c' }"
        />
        <span class="state-text">{{ agent.state }}</span>
        <a-tag>{{ agent.harness }}</a-tag>
        <span class="queue-meta">队列{{ agent.queued ?? 0 }} · 完成{{ agent.completed ?? 0 }}</span>
        <a-button
          size="small"
          :type="focusActive ? 'primary' : 'default'"
          @click="toggleFocus"
        >
          {{ focusActive ? '取消聚焦' : '聚焦主时间线' }}
        </a-button>
      </div>
      <div
        v-if="currentTitle"
        class="current-task"
      >
        执行中:「{{ currentTitle }}」
      </div>

      <a-tabs
        v-model:active-key="tab"
        size="small"
      >
        <a-tab-pane
          key="stream"
          tab="独立输出流"
        >
          <div class="stream">
            <div
              v-if="stream.length === 0"
              class="empty"
            >
              该 agent 暂无事件(连接后产生)
            </div>
            <workshop-event-block
              v-for="b in stream"
              :key="b.id"
              :block="b"
            />
          </div>
        </a-tab-pane>

        <a-tab-pane key="queue">
          <template #tab>
            任务队列
            <a-badge
              :count="assignedTasks.working.length"
              :number-style="{ backgroundColor: '#1677ff' }"
              size="small"
            />
          </template>
          <div
            v-for="group in [['执行中', assignedTasks.working], ['待执行', assignedTasks.queued], ['已完成', assignedTasks.done]]"
            :key="group[0]"
            class="queue-group"
          >
            <div class="group-title">
              {{ group[0] }}({{ (group[1] as typeof assignedTasks.working).length }})
            </div>
            <div
              v-for="t in group[1]"
              :key="t.id"
              class="queue-task"
            >
              <a-tag
                :color="stateColor[t.state] ?? 'default'"
                class="state"
              >
                {{ t.state }}
              </a-tag>
              <span class="qt-title">{{ t.title }}</span>
              <span class="qt-meta">{{ t.progress }}%</span>
            </div>
            <div
              v-if="(group[1] as typeof assignedTasks.working).length === 0"
              class="empty"
            >
              (空)
            </div>
          </div>
        </a-tab-pane>

        <a-tab-pane
          key="memory"
          tab="记忆"
        >
          <workshop-memory-panel
            :channel-id="channelId"
            :agent-id="agentId ?? undefined"
          />
        </a-tab-pane>
      </a-tabs>

      <div class="footer">
        <div
          v-if="agent.role === 'worker'"
          class="member-ops"
        >
          <span class="op-label">成员管理:</span>
          <a-switch
            :checked="(agent.enabled ?? 1) === 1"
            :loading="toggling"
            checked-children="启用"
            un-checked-children="停用"
            size="small"
            @change="toggleEnabled"
          />
          <a-popconfirm
            title="移除该成员?其排队任务将自动重派给剩余成员"
            ok-text="移除"
            cancel-text="取消"
            @confirm="removeMember"
          >
            <a-button
              size="small"
              danger
              type="text"
              :loading="removing"
            >
              移除成员
            </a-button>
          </a-popconfirm>
        </div>
        <div class="send-box">
          <a-textarea
            v-model:value="sendText"
            :auto-size="{ minRows: 1, maxRows: 3 }"
            placeholder="向该 agent 注入消息…"
            @keydown.enter.ctrl.prevent="send"
          />
          <div class="send-ops">
            <a-segmented
              v-model:value="priority"
              size="small"
              :options="[{ value: 'immediate', label: '即时' }, { value: 'task', label: '排队' }]"
            />
            <a-checkbox v-model:checked="requireReply">
              要求回执
            </a-checkbox>
            <a-button
              type="primary"
              size="small"
              :loading="sending"
              @click="send"
            >
              发送
            </a-button>
          </div>
        </div>
      </div>
    </template>
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
.dot { width: 9px; height: 9px; border-radius: 50%; }
.state-text { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
.queue-meta { flex: 1 1 auto; font-size: 11px; opacity: 0.55; }
.current-task {
  padding: 6px 0;
  font-size: 12px;
  color: #1677ff;
  border-bottom: 1px dashed color-mix(in srgb, currentColor 10%, transparent);
}
.stream {
  max-height: 100%;
  overflow-y: auto;
  font-size: 12px;
}
.empty { padding: 12px 4px; font-size: 12px; opacity: 0.4; }
.queue-group { margin-bottom: 10px; }
.group-title { padding: 4px 0; font-size: 12px; font-weight: 600; opacity: 0.7; }
.queue-task {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 4px 6px;
  border-radius: 6px;
}
.queue-task:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.state { margin-inline-end: 0; font-size: 10px; }
.qt-title {
  flex: 1 1 auto;
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qt-meta { font-family: ui-monospace, Consolas, monospace; font-size: 11px; opacity: 0.5; }
.footer {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  padding: 8px 16px 10px;
  background: var(--app-bg-container, inherit);
  border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}
.member-ops {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
  font-size: 11px;
}
.op-label { opacity: 0.6; }
.send-ops {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 6px;
}
</style>
