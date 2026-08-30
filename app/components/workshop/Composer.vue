<script setup lang="ts">
/**
 * Composer(底部输入区,open-tag composer 声部 + HITL 人类控制面):
 *  - 浮起输入卡(inset hairline + 柔和投影)+ 底部工具行 + 墨色药丸发送;
 *  - 统一 @ 寻址(任务/消息两模式共用):@ 某成员 → 任务直发该成员(HITL 调度)/
 *    消息发往该成员;无 @ 缺省 lead(任务走 lead 调度,消息发 lead);
 *  - 任务模式:POST /channels/:id/tasks(title+description+mode goal/loop/pipeline+assigneeId);
 *  - 消息模式:POST /channels/:id/messages(toAgentId/priority/requireReply),
 *    immediate = 实时注入(HITL steer:目标 busy 时注入运行中的回合);
 *  - @提及自动补全(open-tag mention-menu 移植):输入 "@" 触发成员菜单,
 *    ↑↓/Enter 选中 → 回填 @名字 并锁定目标 agent(Esc 关闭);
 *  - 人类发送者 = 登录用户名(fromLabel):时间线以"用户章"渲染我方消息。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'
import { useComposerBus } from '@/app/composables/workshop/useComposerBus'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useUserStore } from '@/app/stores/workshop/user'
import { agentHueColor } from '@/app/composables/workshop/useEventBlocks'

const { t } = useI18n()

const props = defineProps<{ channelId: string }>()
const emit = defineEmits<{ (e: 'submitted'): void }>()
const api = useWorkshopApi()
const entities = useEntitiesStore()
const userStore = useUserStore()

const mode = ref<'task' | 'message'>('task')
const input = ref('')

// ===== 引用总线:块工具条「引用到输入框」→ 以 `> ` 前缀注入并聚焦 =====
const { quoteText } = useComposerBus()
const taEl = ref<HTMLTextAreaElement | null>(null)
watch(quoteText, (t) => {
  if (!t) return
  const quoted = t.trim().split('\n').map(l => `> ${l}`).join('\n')
  input.value = input.value ? `${input.value}\n\n${quoted}\n\n` : `${quoted}\n\n`
  quoteText.value = null
  nextTick(() => taEl.value?.focus())
})
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
/** 统一 HITL 目标(任务/消息共用):缺省 lead;@ 提及或下拉选择切换 */
const leadAgentId = computed(() =>
  agents.value.find(a => a.role === 'lead')?.agentId ?? agents.value[0]?.agentId ?? '')
const toAgentId = ref<string>('')
watch([agents, leadAgentId], ([list]) => {
  if (list.length === 0) return
  // 目标未设置,或频道切换后原目标不在本频道 → 回落 lead
  if (!toAgentId.value || !list.some(a => a.agentId === toAgentId.value)) {
    toAgentId.value = leadAgentId.value || (list[0]?.agentId ?? '')
  }
}, { immediate: true })
const priority = ref<'task' | 'immediate'>('immediate')
const requireReply = ref(false)

/** 发送成功后目标回落缺省 lead(下一条不会静默发给上一位成员) */
const resetTarget = (): void => {
  toAgentId.value = leadAgentId.value
}

// ===== @提及自动补全(任务/消息双模式通用) =====
const mentionOpen = ref(false)
const mentionQuery = ref('')
const mentionHi = ref(0)
/** 光标前未闭合的 "@词"(无空格断开才算进行中) */
const detectMention = (): void => {
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
        message.warning(t('composer.kqdhdlq014'))
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
          message.warning(t('composer.k1l36qf9015'))
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
        // HITL:@ 指定成员 → 任务直发(人类此刻即调度者);缺省 lead 自动调度
        assigneeId: toAgentId.value || undefined,
        // 人类发送者登录名:assign 消息以此盖章,时间线渲染"用户章"
        fromLabel: userStore.user?.name ?? undefined,
        // 任务全文随 assign 消息进时间线(人类提交内容在聊天界面可见)
        parts: [{ text: input.value.trim() }],
      })
      const routedTo = targetName.value || 'lead'
      message.success(t('composer.k1d2idgj035', { p0: routedTo, p1: taskMode.value }))
    }
    else {
      if (!toAgentId.value) {
        message.warning(t('composer.k1bw65is016'))
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
      message.success(t('composer.k1wk4bf036', { p0: targetName.value, p1: priority.value === 'immediate' ? t('composer.k1cxjc4m034') : t('composer.k40g8m009') }))
    }
    input.value = ''
    resetTarget()
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
  // IME 组合中不拦截按键(中文输入法选词确认的 Enter/方向键不做快捷处理)
  if (ev.isComposing) return
  if (onMentionKeydown(ev)) return
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault()
    void send()
  }
}

// ===== 输入框自适应高度(open-tag composer auto-resize) =====
watch(input, async () => {
  await nextTick()
  const el = taEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`
})

/** 当前目标成员(状态行 chip 与提及回显) */
const targetAgent = computed(() => workersAndLead.value.find(a => a.agentId === toAgentId.value))
const targetName = computed(() => targetAgent.value?.name ?? '')
/** 目标是否为缺省路由(lead)——chip 提示"@ 可切换" */
const isDefaultLead = computed(() => !!leadAgentId.value && toAgentId.value === leadAgentId.value)

/**
 * 可达性提示(open-tag reach hint 移植 + HITL 送达语义):直接回答
 * "我发的东西对方以何种方式收到"。任务模式 = 排队进信箱;消息模式即时 =
 * busy 时实时注入运行中的回合(HITL steer)。
 */
type Reach = { tone: 'ok' | 'info' | 'warn', text: string, title: string }
const reachHint = computed<Reach | null>(() => {
  if (!targetAgent.value) return null
  const st = targetAgent.value.state
  if (mode.value === 'task') {
    if (st === 'busy') {
      return {
        tone: 'info',
        text: t('composer.k1ww0ftm017'),
        title: t('composer.k9eq10w018'),
      }
    }
    if (st === 'stopped') {
      return {
        tone: 'warn',
        text: t('composer.kbhz1rp019'),
        title: t('composer.kophjf5020'),
      }
    }
    return { tone: 'ok', text: t('composer.k4qgtiw021'), title: t('composer.kfmjwas022') }
  }
  if (st === 'busy') {
    return {
      tone: 'info',
      text: priority.value === 'immediate' ? t('composer.kwg68t0023') : t('composer.k7w1etd024'),
      title: t('composer.k9m6p7u025'),
    }
  }
  if (st === 'stopped') {
    return {
      tone: 'warn',
      text: t('composer.kj1ngpo026'),
      title: t('composer.kmf7lcc027'),
    }
  }
  return { tone: 'ok', text: t('composer.k1tet5df028'), title: t('composer.kn600in029') }
})

const placeholder = computed(() =>
  mode.value === 'task'
    ? t('composer.k2h5jwc030')
    : t('composer.k15mwzt7031'),
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
          {{ $t('composer.k1bxvc46004') }}
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
          <span
            class="aw-avatar is-agent mention-ava"
            :style="{ '--av': agentHueColor(a.agentId) }"
          >{{ a.name.charAt(0).toUpperCase() }}</span>
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
          <span class="chip-key">{{ $t('composer.k3wcox005') }}</span>
          <span>{{ taskMode }}</span>
          <span v-if="taskMode === 'loop'">
            {{ $t('composer.k49kr1011') }} {{ loopIntervalSeconds ?? '-' }}s
          </span>
          <span
            class="chip-target"
            :title="isDefaultLead ? '未 @ 指定:任务自动路由 lead 调度;@ 某成员可直发' : $t('composer.kl3604i033', { p0: targetName })"
          >→ {{ targetName ? `@${targetName}` : 'lead' }}{{ isDefaultLead ? $t('composer.k2z7yuw012') : $t('composer.k2z0fsx032') }}</span>
          <!-- HITL 送达语义提示 -->
          <span
            v-if="reachHint"
            class="reach-chip"
            :data-tone="reachHint.tone"
            :title="reachHint.title"
          >
            <span
              class="reach-dot"
              aria-hidden="true"
            />{{ reachHint.text }}
          </span>
          <span class="chip-hint">{{ $t('composer.k17u6q77006') }}</span>
        </template>
        <template v-else>
          <span class="chip-key">{{ $t('composer.k41ykc007') }}</span>
          <span v-if="targetName">@{{ targetName }}{{ isDefaultLead ? $t('composer.k2z7yuw012') : '' }}</span>
          <span>{{ priority === 'immediate' ? $t('composer.k1bosqfv013') : $t('composer.k40g8m009') }}</span>
          <!-- 可达性提示(open-tag reach hint):对方能否收到、将以何种方式送达 -->
          <span
            v-if="reachHint"
            class="reach-chip"
            :data-tone="reachHint.tone"
            :title="reachHint.title"
          >
            <span
              class="reach-dot"
              aria-hidden="true"
            />{{ reachHint.text }}
          </span>
          <span class="chip-hint">输入 @ 提及成员 · ⌘/Ctrl+Enter 发送</span>
        </template>
      </div>

      <textarea
        ref="taEl"
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
              {{ $t('composer.k3wcox005') }}
            </button>
            <button
              type="button"
              :class="{ on: mode === 'message' }"
              @click="mode = 'message'"
            >
              {{ $t('composer.k41ykc007') }}
            </button>
          </div>

          <!-- HITL 目标选择(任务/消息共用):缺省 lead;@ 提及或下拉切换直发对象 -->
          <a-select
            v-model:value="toAgentId"
            size="small"
            class="target"
            :options="workersAndLead.map(a => ({ value: a.agentId, label: `@ ${a.name}${a.role === 'lead' ? ' · lead' : ''}` }))"
          />

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
                :placeholder="$t('composer.k1b38y2b001')"
                class="loop-number iterations"
              />
            </template>
          </template>
          <template v-else>
            <div class="aw-seg">
              <button
                type="button"
                :class="{ on: priority === 'immediate' }"
                :title="$t('composer.k1jqqvhe002')"
                @click="priority = 'immediate'"
              >
                {{ $t('composer.k3x9n2008') }}
              </button>
              <button
                type="button"
                :class="{ on: priority === 'task' }"
                @click="priority = 'task'"
              >
                {{ $t('composer.k40g8m009') }}
              </button>
            </div>
            <button
              type="button"
              class="chip-toggle"
              :class="{ on: requireReply }"
              :title="$t('composer.k195594v003')"
              @click="requireReply = !requireReply"
            >
              <span class="i-tabler-mail-forward" />
              {{ $t('composer.k3xv7u010') }}
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
  position: relative;
  padding: 10px 16px 12px;
  overflow: hidden;
  background: var(--paper-raised);
  border-top: 1px solid var(--line);
}

/* 输入卡(Slack 声部):纯白面 + 发丝线 + 12px 圆角;聚焦时墨色内缘加深。
 * 去掉了光斑/水印装饰层 — 输入区是作业面,不是品牌海报。 */
.composer-box {
  position: relative;
  max-width: 900px;
  padding: 8px 12px 8px;
  margin: 0 auto;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  box-shadow: inset 0 1px 0 color-mix(in srgb, white 30%, transparent), var(--bubble-shadow);
  transition: border-color var(--transition-slow), box-shadow var(--transition-slow);
}
.composer-box:focus-within {
  border-color: var(--ink-fainter);
  box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--ink) 18%, transparent), 0 6px 22px rgb(12 10 9 / 5%);
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
.chip-target {
  font-weight: 600;
  color: var(--ink);
}
.chip-hint {
  margin-left: auto;
  padding-left: 8px;
  color: var(--ink-fainter);
}

/* 可达性提示 chip:ok 绿 / info 蓝 / warn 琥珀 —— 状态不只靠颜色(附文字) */
.reach-chip {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  padding: 0 6px;
  font-size: 10.5px;
  border-radius: var(--radius-chip);
}
.reach-chip .reach-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.reach-chip[data-tone='ok'] { color: var(--tone-success-dot); background: color-mix(in srgb, var(--tone-success-dot) 10%, transparent); }
.reach-chip[data-tone='info'] { color: var(--tone-info-dot); background: color-mix(in srgb, var(--tone-info-dot) 10%, transparent); }
.reach-chip[data-tone='warn'] { color: var(--tone-warning-dot); background: color-mix(in srgb, var(--tone-warning-dot) 13%, transparent); }

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
.send-btn:active:not(:disabled) { transform: scale(0.96); }
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
  border-radius: var(--radius-panel);
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
  background: var(--tone-live-dot);
  opacity: 1;
}
</style>
