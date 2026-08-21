<script setup lang="ts">
/**
 * Composer(底部输入区,open-tag composer 声部):
 *  - 浮起输入卡(inset hairline + 柔和投影)+ 底部工具行 + 墨色药丸发送;
 *  - 任务模式:POST /channels/:id/tasks(title+description+mode goal/loop/pipeline);
 *  - 消息模式:POST /channels/:id/messages(toAgentId/priority/requireReply);
 *  - @提及自动补全(open-tag mention-menu 移植):输入 "@" 触发成员菜单,
 *    ↑↓/Enter 选中 → 回填 @名字 并锁定目标 agent(Esc 关闭)。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useUserStore } from '@/app/stores/workshop/user'

const props = defineProps<{ channelId: string }>()
const emit = defineEmits<{ (e: 'submitted'): void }>()
const api = useWorkshopApi()
const entities = useEntitiesStore()
const userStore = useUserStore()

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

// ===== @提及自动补全 =====
const mentionOpen = ref(false)
const mentionQuery = ref('')
const mentionHi = ref(0)
/** 光标前未闭合的 "@词"(无空格断开才算进行中) */
const detectMention = (): void => {
  if (mode.value !== 'message') {
    mentionOpen.value = false
    return
  }
  const el = document.activeElement as HTMLTextAreaElement | null
  const text = el?.value ?? input.value
  const caret = el?.selectionStart ?? text.length
  const upto = text.slice(0, caret)
  const m = /(^|\s)@([^\s@]*)$/.exec(upto)
  if (!m) {
    mentionOpen.value = false
    return
  }
  mentionQuery.value = m[2] ?? ''
  mentionOpen.value = mentionCandidates.value.length > 0
  mentionHi.value = 0
}
const mentionCandidates = computed(() => {
  const q = mentionQuery.value.toLowerCase()
  return workersAndLead.value.filter(a => !q || a.name.toLowerCase().includes(q)).slice(0, 6)
})
const pickMention = (idx: number): void => {
  const a = mentionCandidates.value[idx]
  if (!a) return
  const el = document.activeElement as HTMLTextAreaElement | null
  const text = el?.value ?? input.value
  const caret = el?.selectionStart ?? text.length
  const upto = text.slice(0, caret)
  const m = /(^|\s)@([^\s@]*)$/.exec(upto)
  const cut = m ? caret - (m[2]?.length ?? 0) : caret
  const next = `${text.slice(0, cut)}${a.name} ${text.slice(caret)}`
  input.value = next
  toAgentId.value = a.agentId
  mentionOpen.value = false
  nextTick(() => {
    const pos = cut + a.name.length + 1
    el?.setSelectionRange(pos, pos)
    el?.focus()
  })
}
const onMentionKeydown = (ev: KeyboardEvent): boolean => {
  if (!mentionOpen.value) return false
  if (ev.key === 'ArrowDown') {
    ev.preventDefault()
    mentionHi.value = Math.min(mentionHi.value + 1, mentionCandidates.value.length - 1)
    return true
  }
  if (ev.key === 'ArrowUp') {
    ev.preventDefault()
    mentionHi.value = Math.max(mentionHi.value - 1, 0)
    return true
  }
  if (ev.key === 'Enter' || ev.key === 'Tab') {
    ev.preventDefault()
    pickMention(mentionHi.value)
    return true
  }
  if (ev.key === 'Escape') {
    mentionOpen.value = false
    return true
  }
  return false
}

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
        message.warning('请选择目标 Agent(可用 @ 提及)')
        return
      }
      await api.injectMessage(props.channelId, {
        toAgentId: toAgentId.value,
        text,
        priority: priority.value,
        requireReply: requireReply.value,
        // 人类发送者名:时间线 a2a.message 以"@你 → @目标"聊天行呈现
        fromLabel: userStore.user?.name ?? undefined,
      })
      message.success(`消息已发送给 @${targetName.value}(${priority.value})`)
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
  if (onMentionKeydown(ev)) return
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault()
    void send()
  }
}

/** 当前目标成员(状态行 chip 与提及回显) */
const targetAgent = computed(() => workersAndLead.value.find(a => a.agentId === toAgentId.value))
const targetName = computed(() => targetAgent.value?.name ?? '')

const placeholder = computed(() =>
  mode.value === 'task'
    ? '输入任务(首行标题)…  ⌘/Ctrl+Enter 提交'
    : '输入消息,@ 提及成员选择目标…  ⌘/Ctrl+Enter 发送',
)
</script>

<template>
  <div class="composer">
    <div class="composer-box">
      <!-- @提及菜单(输入卡上方) -->
      <div
        v-if="mentionOpen"
        class="mention-menu"
      >
        <div class="mention-title">
          发送给…
        </div>
        <button
          v-for="(a, i) in mentionCandidates"
          :key="a.agentId"
          type="button"
          class="mention-opt"
          :class="{ sel: i === mentionHi }"
          @mousedown.prevent="pickMention(i)"
          @mouseenter="mentionHi = i"
        >
          <span class="aw-avatar is-agent mention-ava">{{ a.name.charAt(0).toUpperCase() }}</span>
          <span class="mention-name">@{{ a.name }}</span>
          <span class="mention-role">{{ a.role }}</span>
          <span
            class="mention-state"
            :class="a.state"
            :title="a.state"
          />
        </button>
      </div>

      <div class="composer-status-chip">
        <template v-if="mode === 'task'">
          <span class="chip-key">任务</span>
          <span>{{ taskMode }}</span>
          <span v-if="taskMode === 'loop'">
            · 间隔 {{ loopIntervalSeconds ?? '—' }}s
          </span>
          <span class="chip-hint">首行 = 标题</span>
        </template>
        <template v-else>
          <span class="chip-key">消息</span>
          <span v-if="targetName">@{{ targetName }}</span>
          <span>{{ priority === 'immediate' ? '即时注入' : '排队' }}</span>
          <span class="chip-hint">输入 @ 提及成员 · ⌘/Ctrl+Enter 发送</span>
        </template>
      </div>

      <textarea
        v-model="input"
        class="composer-input"
        rows="1"
        :placeholder="placeholder"
        @input="detectMention"
        @keydown="onKeydown"
        @blur="mentionOpen = false"
      />

      <div class="composer-bar">
        <div class="cb-left">
          <div class="aw-seg">
            <button
              type="button"
              :class="{ on: mode === 'task' }"
              @click="mode = 'task'"
            >
              任务
            </button>
            <button
              type="button"
              :class="{ on: mode === 'message' }"
              @click="mode = 'message'"
            >
              消息
            </button>
          </div>

          <template v-if="mode === 'task'">
            <div class="aw-seg">
              <button
                v-for="m in ['goal', 'loop', 'pipeline'] as const"
                :key="m"
                type="button"
                :class="{ on: taskMode === m }"
                @click="taskMode = m"
              >
                {{ m }}
              </button>
            </div>
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
                placeholder="不限次数"
                class="loop-number iterations"
              />
            </template>
          </template>
          <template v-else>
            <a-select
              v-model:value="toAgentId"
              size="small"
              class="target"
              :options="workersAndLead.map(a => ({ value: a.agentId, label: `@ ${a.name}` }))"
            />
            <div class="aw-seg">
              <button
                type="button"
                :class="{ on: priority === 'immediate' }"
                @click="priority = 'immediate'"
              >
                即时
              </button>
              <button
                type="button"
                :class="{ on: priority === 'task' }"
                @click="priority = 'task'"
              >
                排队
              </button>
            </div>
            <button
              type="button"
              class="chip-toggle"
              :class="{ on: requireReply }"
              title="要求对方回执"
              @click="requireReply = !requireReply"
            >
              <span class="i-tabler-mail-forward" />
              回执
            </button>
          </template>
        </div>

        <div class="cb-right">
          <button
            type="button"
            class="send-btn im"
            :disabled="sendLoading || !input.trim()"
            title="发送(⌘/Ctrl+Enter)"
            @click="send"
          >
            <span class="i-tabler-send im-nudge-up" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer {
  padding: 10px 16px 12px;
  background: var(--paper-raised);
  border-top: 1px solid var(--line);
}

/* 浮起输入卡:inset hairline + 柔和投影(open-tag composer-box) */
.composer-box {
  position: relative;
  max-width: 900px;
  padding: 8px 12px 8px;
  margin: 0 auto;
  background: var(--paper-raised);
  border-radius: 12px;
  box-shadow:
    inset 0 0 0 0.5px color-mix(in srgb, var(--ink) 16%, transparent),
    0 6px 22px rgb(12 10 9 / 5%);
  transition: box-shadow var(--transition-slow);
}
.composer-box:focus-within {
  box-shadow:
    inset 0 0 0 0.5px color-mix(in srgb, var(--ink) 26%, transparent),
    0 8px 26px rgb(12 10 9 / 6%);
}

/* 状态行:轻 chip 说明当前模式参数 */
.composer-status-chip {
  display: flex;
  gap: 6px;
  align-items: center;
  width: max-content;
  max-width: 100%;
  margin: 0 0 4px 2px;
  padding: 2px 8px;
  font-size: 11.5px;
  color: var(--ink-faint);
  background: var(--paper-deep);
  border-radius: var(--radius-chip);
}
.chip-key {
  font-weight: 600;
  color: var(--ink-soft);
}
.chip-hint {
  margin-left: auto;
  padding-left: 8px;
  color: var(--ink-fainter);
}

.composer-input {
  display: block;
  width: 100%;
  max-height: 160px;
  min-height: 26px;
  padding: 3px 2px;
  overflow-y: auto;
  font-family: var(--font-body);
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--ink);
  resize: none;
  background: transparent;
  border: 0;
  outline: none;
}
.composer-input::placeholder { color: var(--ink-fainter); }

.composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 30px;
  margin-top: 6px;
}
.cb-left {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.cb-right {
  display: flex;
  flex: none;
  gap: 8px;
  align-items: center;
}

/* 回执切换 chip */
.chip-toggle {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  padding: 3px 10px;
  font-family: var(--font-body);
  font-size: 12px;
  color: var(--ink-faint);
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  transition: color var(--transition-fast), background var(--transition-fast), border-color var(--transition-fast);
}
.chip-toggle:hover { color: var(--ink); }
.chip-toggle.on {
  font-weight: 600;
  color: var(--ink);
  background: var(--paper-deep);
  border-color: var(--ink);
}

/* 发送:墨色药丸圆钮 */
.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  font-size: 15px;
  color: var(--on-accent);
  cursor: pointer;
  background: var(--accent);
  border: 0;
  border-radius: var(--radius-pill);
  transition: background var(--transition-fast), transform var(--transition-fast), opacity var(--transition-fast);
}
.send-btn:hover:not(:disabled) { background: var(--accent-strong); }
.send-btn:disabled { opacity: 0.3; cursor: default; }

.loop-number { width: 104px; }
.loop-number.iterations { width: 104px; }
.target { width: 138px; }

/* @提及菜单(open-tag mention-menu) */
.mention-menu {
  position: absolute;
  right: 12px;
  bottom: 100%;
  left: 12px;
  z-index: 20;
  max-height: 264px;
  margin-bottom: 8px;
  overflow: auto;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  box-shadow: var(--shadow-float);
}
.mention-opt {
  display: flex;
  gap: 9px;
  align-items: center;
  width: 100%;
  padding: 7px 12px;
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--ink-soft);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
}
.mention-opt:hover,
.mention-opt.sel { background: var(--paper-deep); }
.mention-ava { width: 20px; height: 20px; font-size: 10px; }
.mention-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
}
.mention-role {
  flex: none;
  font-size: 10.5px;
  color: var(--ink-fainter);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.mention-title {
  padding: 5px 12px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-fainter);
}

/* 成员状态点:busy = 暖橙脉冲,idle = 静灰 */
.mention-state {
  flex: none;
  width: 7px;
  height: 7px;
  background: var(--ink-fainter);
  border-radius: 50%;
  opacity: 0.7;
}

.mention-state.busy {
  background: hsl(46 66% 50%);
  opacity: 1;
}
</style>
