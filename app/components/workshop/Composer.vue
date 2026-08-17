<script setup lang="ts">
/**
 * Composer(底部输入区):
 *  - 任务模式:POST /channels/:id/tasks(title+description+mode goal/loop/pipeline)
 *  - 消息模式:POST /channels/:id/messages(toAgentId/priority/requireReply)
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi } from '../../composables/workshop/useWorkshopApi'
import { useEntitiesStore } from '../../stores/workshop/entities'

const props = defineProps<{ channelId: string }>()
const emit = defineEmits<{ (e: 'submitted'): void }>()
const api = useWorkshopApi()
const entities = useEntitiesStore()

const mode = ref<'task' | 'message'>('task')
const input = ref('')
const taskMode = ref<'goal' | 'loop' | 'pipeline'>('goal')
/** loop 间隔秒(留空由下方校验拦截) */
const loopIntervalSeconds = ref<number | null>(60)
/** 留空 = 不限次数 */
const loopMaxIterations = ref<number | null>(null)
/** antd InputNumber 模型用 undefined 表示空值;内部状态统一用 null 便于校验 */
const loopIntervalModel = computed<number | undefined>({
  get: () => loopIntervalSeconds.value ?? undefined,
  set: (v) => { loopIntervalSeconds.value = v ?? null },
})
const loopMaxIterationsModel = computed<number | undefined>({
  get: () => loopMaxIterations.value ?? undefined,
  set: (v) => { loopMaxIterations.value = v ?? null },
})
const sendLoading = ref(false)

const agents = computed(() => entities.agents[props.channelId] ?? [])
const workersAndLead = computed(() => agents.value)
const toAgentId = ref<string>('')
watch(agents, (list) => {
  if (!toAgentId.value && list.length > 0) toAgentId.value = list[0]?.agentId ?? ''
}, { immediate: true })
const priority = ref<'task' | 'immediate'>('immediate')
const requireReply = ref(false)

/** 任务模式:首行=标题,其余=描述(与聊天输入习惯兼容) */
const parseTitleDesc = (): { title: string, description?: string } => {
  const [first, ...rest] = input.value.trim().split('\n')
  return { title: (first ?? '').slice(0, 120), description: rest.join('\n').trim() || undefined }
}

const send = async (): Promise<void> => {
  const text = input.value.trim()
  if (!text) return
  sendLoading.value = true
  try {
    if (mode.value === 'task') {
      const { title, description } = parseTitleDesc()
      if (!title) {
        message.warning('任务标题不能为空')
        return
      }
      // loop 参数(先校验后使用;校验通过后下方 modeConfig 才可能引用)
      const intervalSeconds = loopIntervalSeconds.value
      const maxIterations = loopMaxIterations.value
      if (taskMode.value === 'loop') {
        if (intervalSeconds === null || !Number.isFinite(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 86400) {
          message.warning('loop 间隔需设置为 1 到 86400 秒')
          return
        }
        if (maxIterations !== null && (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10000)) {
          message.warning('最大次数需设置为 1 到 10000 次，留空表示不限次数')
          return
        }
      }
      await api.submitTask(props.channelId, {
        title,
        description,
        mode: taskMode.value,
        ...(taskMode.value === 'loop'
          ? {
              modeConfig: {
                intervalMs: Math.round(intervalSeconds! * 1000),
                ...(maxIterations !== null
                  ? { maxIterations: Math.floor(maxIterations) }
                  : {}),
              },
            }
          : {}),
      })
      message.success(`任务已提交(${taskMode.value})`)
    }
    else {
      if (!toAgentId.value) {
        message.warning('请选择目标 Agent')
        return
      }
      await api.injectMessage(props.channelId, {
        toAgentId: toAgentId.value,
        text,
        priority: priority.value,
        requireReply: requireReply.value,
      })
      message.success(`消息已注入(${priority.value})`)
    }
    input.value = ''
    emit('submitted')
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : String(e))
  }
  finally {
    sendLoading.value = false
  }
}

const onKeydown = (ev: KeyboardEvent): void => {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault()
    void send()
  }
}
</script>

<template>
  <div class="composer">
    <div class="composer-toolbar">
      <a-radio-group
        v-model:value="mode"
        size="small"
        button-style="solid"
      >
        <a-radio-button value="task">
          任务
        </a-radio-button>
        <a-radio-button value="message">
          消息
        </a-radio-button>
      </a-radio-group>

      <template v-if="mode === 'task'">
        <a-segmented
          v-model:value="taskMode"
          size="small"
          :options="[{ value: 'goal', label: 'goal' }, { value: 'loop', label: 'loop' }, { value: 'pipeline', label: 'pipeline' }]"
        />
        <template v-if="taskMode === 'loop'">
          <a-input-number
            v-model:value="loopIntervalModel"
            size="small"
            :min="1"
            :max="86400"
            :step="1"
            :precision="0"
            addon-after="秒"
            class="loop-number"
          />
          <a-input-number
            v-model:value="loopMaxIterationsModel"
            size="small"
            :min="1"
            :max="10000"
            :step="1"
            :precision="0"
            placeholder="留空 = 不限次数"
            class="loop-number iterations"
          />
          <span class="hint">每次完成后等待该间隔再执行 · 次数留空 = 不限</span>
        </template>
        <span class="hint">首行 = 任务标题</span>
      </template>
      <template v-else>
        <a-select
          v-model:value="toAgentId"
          size="small"
          class="target"
          :options="workersAndLead.map(a => ({ value: a.agentId, label: a.name }))"
        />
        <a-segmented
          v-model:value="priority"
          size="small"
          :options="[{ value: 'immediate', label: '即时' }, { value: 'task', label: '排队' }]"
        />
        <a-checkbox v-model:checked="requireReply">
          要求回执
        </a-checkbox>
      </template>
    </div>

    <div class="composer-input">
      <a-textarea
        v-model:value="input"
        :auto-size="{ minRows: 1, maxRows: 6 }"
        placeholder="输入任务(首行标题)或消息…  ⌘/Ctrl+Enter 发送"
        @keydown="onKeydown"
      />
      <a-button
        type="primary"
        :loading="sendLoading"
        @click="send"
      >
        发送
      </a-button>
    </div>
  </div>
</template>

<style scoped>
.composer {
  padding: 8px 12px 10px;
  border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}
.composer-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-bottom: 6px;
  font-size: 12px;
}
.hint { opacity: 0.45; }
.loop-number { width: 112px; }
.loop-number.iterations { width: 108px; }
.target { width: 130px; }
.composer-input {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
</style>
