<script setup lang="ts">
/**
 * Composer(底部输入区,open-tag composer 声部 + HITL 人类控制面):
 *  - 浮起输入卡(inset hairline + 柔和投影)+ 底部工具行 + 墨色药丸发送;
 *  - **群聊模式(默认,主计划 §2)**:发送走唯一入站口
 *    POST /channels/:id/chat/messages { text, mentions, replyToId, clientMessageId };
 *    路由 = 服务端重新解析文本后的 agent mention 集合 —— **没有 @Agent 就是 0 次执行**,
 *    绝不回落到"默认 Leader"(旧实现里 toAgentId 缺省即 lead,一句普通聊天会静默派单);
 *  - 任务/消息模式(owner 显式直发,保留原语义):@ 某成员 → 任务直发该成员 /
 *    消息发往该成员;无 @ 缺省 lead(任务走 lead 调度,消息发 lead);
 *  - @提及自动补全:候选同时包含 **Agent 与 active 人类成员**(稳定 ID 寻址,
 *    不靠昵称匹配 —— 昵称只在文本里给人看,mentions 数组由候选名精确回解);
 *  - 引用/回复:时间线「回复」→ 顶部"回复 <sender>"chip → replyToId;
 *  - clientMessageId 每次发送生成,重试同一份内容时保持不变(服务端据此幂等),
 *    内容变了就换新 key(否则服务端会原样返回上一条旧消息)。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'
import { useComposerBus } from '@/app/composables/workshop/useComposerBus'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useUserStore } from '@/app/stores/workshop/user'
import { useChatStore, chatErrorCode, chatErrorMessage } from '@/app/stores/workshop/chat'
import { agentHueColor } from '@/app/composables/workshop/useEventBlocks'
import type { AepChatMention } from '#shared/workshop-protocol'

const { t } = useI18n()

const props = defineProps<{ channelId: string }>()
const emit = defineEmits<{ (e: 'submitted'): void }>()
const api = useWorkshopApi()
const entities = useEntitiesStore()
const userStore = useUserStore()
const chat = useChatStore()

/** chat = 群聊(默认);task/message = 既有直发路径(owner 显式选择) */
type ComposerMode = 'chat' | 'task' | 'message'
const mode = ref<ComposerMode>('chat')
/** 用户手动选过模式后不再自动切换(避免异步权限到达把界面从手里抢走) */
const userPickedMode = ref(false)
const input = ref('')

/** 当前频道能力(服务端单一事实源;未加载时为 null) */
const perms = computed(() => chat.permissions[props.channelId] ?? null)
const canPost = computed(() => perms.value?.canPost === true)
const canManage = computed(() => perms.value?.canManage === true)
/** 我已是成员(owner 视为成员) */
const isMember = computed(() => perms.value?.isMember === true)

// ===== 频道切换:拉权限(非成员也可调用)+ 名册(非成员 403 → 静默空名册) =====
watch(() => props.channelId, (cid) => {
  if (!cid) return
  void chat.loadPermissions(cid)
  void chat.loadMembers(cid)
}, { immediate: true })

/**
 * 默认模式:群聊已开启且我有发言权 → chat;否则回落 task(遗留 Channel 行为完全不变,
 * 不会因为升级把旧界面的默认下发对象改掉)。
 */
watch(canPost, (ok) => {
  if (userPickedMode.value) return
  mode.value = ok ? 'chat' : 'task'
}, { immediate: true })

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

// ===== @提及候选(Agent ∪ active 人类成员;键 = 稳定 ID,不是昵称) =====
interface MentionCandidate {
  key: string
  type: 'agent' | 'user'
  id: string
  name: string
  role: string
  state?: 'idle' | 'busy' | 'stopped'
}

const mentionCandidates = computed<MentionCandidate[]>(() => {
  const out: MentionCandidate[] = []
  for (const a of workersAndLead.value) {
    out.push({ key: `agent:${a.agentId}`, type: 'agent', id: a.agentId, name: a.name, role: a.role, state: a.state })
  }
  const selfId = userStore.user?.id
  for (const m of chat.members[props.channelId] ?? []) {
    if (m.status !== 'active') continue
    if (selfId && m.userId === selfId) continue // 不给自己 @(服务端也不会给自己发通知)
    out.push({
      key: `user:${m.userId}`,
      type: 'user',
      id: m.userId,
      name: m.displayName || m.userId.slice(0, 8),
      role: m.role === 'owner' ? 'owner' : 'member',
    })
  }
  return out
})

// ===== @提及自动补全(任务/消息/群聊三模式通用) =====
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
  mentionOpen.value = mentionFiltered.value.length > 0
  mentionHi.value = 0
}
const mentionFiltered = computed(() => {
  const q = mentionQuery.value.toLowerCase()
  return mentionCandidates.value.filter(c => !q || c.name.toLowerCase().includes(q)).slice(0, 8)
})
const pickMention = (idx: number): void => {
  const c = mentionFiltered.value[idx]
  if (!c) return
  const el = document.activeElement as HTMLTextAreaElement | null
  const text = el?.value ?? input.value
  const caret = el?.selectionStart ?? text.length
  const upto = text.slice(0, caret)
  const m = /(^|\s)@([^\s@]*)$/.exec(upto)
  const cut = m ? caret - (m[2]?.length ?? 0) : caret
  const next = `${text.slice(0, cut)}${c.name} ${text.slice(caret)}`
  input.value = next
  // 仅直发模式改写目标;群聊模式**不设默认目标**(路由完全由文本里的 @ 决定)
  if (c.type === 'agent' && mode.value !== 'chat') toAgentId.value = c.id
  mentionOpen.value = false
  nextTick(() => {
    const pos = cut + c.name.length + 1
    el?.setSelectionRange(pos, pos)
    el?.focus()
  })
}
const onMentionKeydown = (ev: KeyboardEvent): boolean => {
  if (!mentionOpen.value) return false
  if (ev.key === 'ArrowDown') {
    ev.preventDefault()
    mentionHi.value = Math.min(mentionHi.value + 1, mentionFiltered.value.length - 1)
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

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 文本 → mentions(稳定 ID)。服务端会**重新解析**文本,这里只是意图提示:
 *  - 只认候选名单里的名字,最长名优先(@worker10 不会被 @worker1 抢先命中);
 *  - '@' 前必须是行首/空白,后必须是行尾/空白/标点,避免 @alice 命中 @alice2。
 */
const parseMentions = (text: string): AepChatMention[] => {
  const out: AepChatMention[] = []
  const seen = new Set<string>()
  const sorted = [...mentionCandidates.value].sort((a, b) => b.name.length - a.name.length)
  for (const c of sorted) {
    const re = new RegExp(`(^|[\\s(])@${escapeRegExp(c.name)}(?=$|[\\s,.。,:;!?)\\]])`, 'm')
    if (!re.test(text)) continue
    const key = `${c.type}:${c.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ type: c.type, id: c.id, label: c.name })
  }
  return out
}

/** 当前文本将要触发的 Agent(0 = 纯群聊,无任何 Agent 执行) */
const draftAgentMentions = computed(() => (mode.value === 'chat' ? parseMentions(input.value).filter(m => m.type === 'agent') : []))
const draftUserMentions = computed(() => (mode.value === 'chat' ? parseMentions(input.value).filter(m => m.type === 'user') : []))

// ===== 回复目标(ChatTimeline「回复」→ chat store → 此处 chip) =====
const replyTarget = computed(() =>
  chat.replyTarget && chat.replyTarget.channelId === props.channelId ? chat.replyTarget : null)
watch(replyTarget, (r) => {
  if (!r) return
  // 回复群聊消息 = 群聊语义:自动切到群聊模式(引用链只有群聊入站口支持)
  if (canPost.value) mode.value = 'chat'
  nextTick(() => taEl.value?.focus())
})

// ===== clientMessageId:同一份内容重试保持同一个 key =====
interface PendingSend { clientMessageId: string, fingerprint: string }
const pendingSend = ref<PendingSend | null>(null)
const newClientMessageId = (): string => {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
const fingerprintOf = (text: string, replyToId: string | null, mentions: AepChatMention[]): string =>
  JSON.stringify([text, replyToId, mentions.map(m => `${m.type}:${m.id}`).sort()])

// 频道切换:幂等键不得跨频道复用;用户手选的模式也回到"按新频道能力推导"
watch(() => props.channelId, () => {
  pendingSend.value = null
  userPickedMode.value = false
  mode.value = canPost.value ? 'chat' : 'task'
})

/** 任务模式:首行=标题,其余=描述(与聊天输入习惯兼容) */
const parseTitleDesc = (): { title: string, description?: string } => {
  const [first, ...rest] = input.value.trim().split('\n')
  return { title: (first ?? '').slice(0, 120), description: rest.join('\n').trim() || undefined }
}

/** 群聊发送(唯一入站口;deliveries = 实际投递到几个 Agent) */
const sendChat = async (text: string): Promise<void> => {
  const mentions = parseMentions(text)
  const replyToId = replyTarget.value?.messageId ?? null
  const fp = fingerprintOf(text, replyToId, mentions)
  if (!pendingSend.value || pendingSend.value.fingerprint !== fp) {
    pendingSend.value = { clientMessageId: newClientMessageId(), fingerprint: fp }
  }
  const res = await chat.send({
    channelId: props.channelId,
    text,
    mentions,
    replyToId,
    clientMessageId: pendingSend.value.clientMessageId,
  })
  // 成功才换 key;重试同一份内容仍用同一个 clientMessageId(服务端据此不重复投递)
  pendingSend.value = null
  chat.clearReplyTarget()
  if (res.unresolvedMentions?.length) {
    // 服务端逐目标校验归属:名单外的 @ 不会被投递,必须让人看见
    message.warning(`未识别的 @: ${res.unresolvedMentions.join('、')}(不在本群成员内,未投递)`)
  }
  const n = res.deliveries?.length ?? 0
  if (n > 0) message.success(`已发到群聊 · ${n} 个 Agent 已收到投递`)
  else message.success('已发到群聊(未 @Agent,无 Agent 执行)')
}

const send = async (): Promise<void> => {
  const text = input.value.trim()
  if (!text) return
  sendLoading.value = true
  try {
    if (mode.value === 'chat') {
      await sendChat(text)
    }
    else if (mode.value === 'task') {
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
          message.warning(t('composer.loopIntervalRange'))
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
      resetTarget()
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
      resetTarget()
    }
    input.value = ''
    emit('submitted')
  }
  catch (e) {
    const code = chatErrorCode(e)
    if (mode.value === 'chat' && code === 'CHAT_DISABLED') {
      message.warning('该 Channel 未开启群聊 —— 请 owner 在右侧成员面板开启后重试')
    }
    else if (mode.value === 'chat' && (code === 'NOT_CHANNEL_MEMBER' || code === 'FORBIDDEN_LEGACY')) {
      message.warning('你还不是该 Channel 的群成员 —— 请在右侧成员面板加入群聊')
    }
    else {
      message.error(chatErrorMessage(e))
    }
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
    return
  }
  // 群聊模式按聊天软件习惯:Enter 发送,Shift+Enter 换行(菜单展开时上面已拦走 Enter)
  if (ev.key === 'Enter' && !ev.shiftKey && mode.value === 'chat') {
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

const placeholder = computed(() => {
  if (mode.value === 'chat') return '发送到群聊…  @ 提及 Agent(触发执行)或成员(仅通知)'
  return mode.value === 'task'
    ? t('composer.k2h5jwc030')
    : t('composer.k15mwzt7031')
})
</script>

<template>
  <div class="composer">
    <div class="composer-box">
      <!-- @提及菜单(输入卡上方;候选 = Agent ∪ active 人类成员) -->
      <div
        v-if="mentionOpen"
        class="mention-menu"
      >
        <div class="mention-title">
          {{ $t('composer.k1bxvc46004') }}
        </div>
        <button
          v-for="(c, i) in mentionFiltered"
          :key="c.key"
          type="button"
          class="mention-opt"
          :class="{ sel: i === mentionHi }"
          @mousedown.prevent="pickMention(i)"
          @mouseenter="mentionHi = i"
        >
          <span
            class="aw-avatar mention-ava"
            :class="c.type === 'agent' ? 'is-agent' : 'is-user'"
            :style="{ '--av': c.type === 'agent' ? agentHueColor(c.id) : 'var(--ink-faint)' }"
          >{{ c.type === 'agent' ? 'A' : '人' }}</span>
          <span class="mention-name">@{{ c.name }}</span>
          <span class="mention-role">{{ c.role }}</span>
          <span
            v-if="c.type === 'agent'"
            class="mention-state"
            :class="c.state"
            :title="c.state"
          />
        </button>
      </div>

      <!-- 回复目标 chip(引用链:replyToId) -->
      <div
        v-if="replyTarget"
        class="reply-chip"
      >
        <span class="i-tabler-arrow-back-up" />
        <span class="reply-label">回复 <b>{{ replyTarget.senderName }}</b></span>
        <span class="reply-excerpt">{{ replyTarget.excerpt }}</span>
        <button
          type="button"
          class="reply-cancel"
          title="取消回复"
          @click="chat.clearReplyTarget()"
        >
          <span class="i-tabler-x" />
        </button>
      </div>

      <div class="composer-status-chip">
        <template v-if="mode === 'chat'">
          <span class="chip-key">群聊</span>
          <span
            v-if="draftAgentMentions.length > 0"
            class="reach-chip"
            data-tone="info"
            :title="'仅显式 @Agent 触发执行'"
          >
            <span
              class="reach-dot"
              aria-hidden="true"
            />@{{ draftAgentMentions.map(m => m.label).join(' @') }} · 将触发 {{ draftAgentMentions.length }} 次 Agent 执行
          </span>
          <span
            v-else
            class="reach-chip"
            data-tone="ok"
            title="未 @Agent:消息只进群聊,不触发任何 Agent"
          >
            <span
              class="reach-dot"
              aria-hidden="true"
            />仅群聊 · 0 次 Agent 执行
          </span>
          <span
            v-if="draftUserMentions.length > 0"
            class="chip-hint"
          >@{{ draftUserMentions.map(m => m.label).join(' @') }} 将收到定向通知</span>
          <span
            v-else
            class="chip-hint"
          >输入 @ 提及成员 · Enter 发送</span>
        </template>
        <template v-else-if="mode === 'task'">
          <span class="chip-key">{{ $t('composer.k3wcox005') }}</span>
          <span>{{ taskMode }}</span>
          <span v-if="taskMode === 'loop'">
            {{ $t('composer.k49kr1011') }} {{ loopIntervalSeconds ?? '-' }}s
          </span>
          <span
            class="chip-target"
            :title="isDefaultLead ? $t('composer.defaultLeadTitle') : $t('composer.kl3604i033', { p0: targetName })"
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
          <span class="chip-hint">{{ $t('composer.chipHint') }}</span>
        </template>
      </div>

      <!-- 未开启群聊 / 未加入的诚实提示(不提供必然失败的按钮) -->
      <div
        v-if="mode === 'chat' && perms && !canPost"
        class="composer-block-hint"
      >
        <span class="i-tabler-lock" />
        {{ isMember ? '该 Channel 未开启群聊(owner 可在右侧成员面板开启)' : '你还不是群成员 —— 请在右侧成员面板加入群聊后发言' }}
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
            <!-- 群聊入口只在真的能发言时提供(否则是死按钮) -->
            <button
              v-if="canPost || !perms"
              type="button"
              :class="{ on: mode === 'chat' }"
              title="群聊:仅显式 @Agent 才触发执行"
              @click="mode = 'chat'; userPickedMode = true"
            >
              群聊
            </button>
            <button
              v-if="canManage || !perms || !canPost"
              type="button"
              :class="{ on: mode === 'task' }"
              @click="mode = 'task'; userPickedMode = true"
            >
              {{ $t('composer.k3wcox005') }}
            </button>
            <button
              v-if="canManage || !perms || !canPost"
              type="button"
              :class="{ on: mode === 'message' }"
              @click="mode = 'message'; userPickedMode = true"
            >
              {{ $t('composer.k41ykc007') }}
            </button>
          </div>

          <!-- HITL 目标选择(仅直发模式:群聊模式的路由由文本 @ 决定,没有"默认目标") -->
          <a-select
            v-if="mode !== 'chat'"
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
                :addon-after="$t('composer.seconds')"
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
          <template v-else-if="mode === 'message'">
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
            :disabled="sendLoading || !input.trim() || (mode === 'chat' && perms !== null && !canPost)"
            :title="$t('composer.sendTitle')"
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
  color: var(--ink-faint);
}

/* 群聊不可发言时的诚实提示(不渲染必然失败的发送) */
.composer-block-hint {
  display: flex;
  gap: 6px;
  align-items: center;
  margin: 0 0 4px 2px;
  font-size: 11.5px;
  color: var(--tone-warning-dot);
}

/* 回复目标 chip(引用链) */
.reply-chip {
  display: flex;
  gap: 6px;
  align-items: center;
  margin: 2px 0 4px;
  padding: 3px 8px;
  font-size: 11.5px;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border-left: 2px solid var(--ink-fainter);
  border-radius: var(--radius-chip);
}
.reply-label b { color: var(--ink); }
.reply-excerpt {
  max-width: 46%;
  overflow: hidden;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reply-cancel {
  display: inline-flex;
  align-items: center;
  padding: 0 2px;
  font-size: 12px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
}
.reply-cancel:hover { color: var(--ink); }

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
.composer-input::placeholder { color: var(--ink-faint); }

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
.mention-ava.is-user { color: var(--on-accent); background: var(--ink-faint); }
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
  color: var(--ink-faint);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.mention-title {
  padding: 5px 12px 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-faint);
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

/* ── 窄屏(≤1023):输入区是手持设备的"主操作面",键盘弹出时它必须还在 ──
   桌面工具栏是「一行左簇右钮」;390px 下这行会折成一列竖排字,
   所以窄屏改为「模式行 → 目标行 → 发送行」三段堆叠,发送占满一行且 ≥44px。 */
@media (max-width: 1023.98px) {
  .composer {
    padding: 8px 10px calc(10px + env(safe-area-inset-bottom));
  }

  .composer-box {
    padding: 8px 10px;
  }

  /* 状态 chip:桌面宽度自适应内容,窄屏必须允许折行,否则顶破输入卡 */
  .composer-status-chip {
    width: auto;
    flex-wrap: wrap;
    row-gap: 2px;
    font-size: 11.5px;
    line-height: 1.45;
  }

  .chip-hint {
    flex: 1 1 100%;
    padding-left: 0;
    margin-left: 0;
  }

  .reach-chip,
  .mention-role,
  .mention-title {
    font-size: 11.5px;
  }

  /* 16px 是 iOS 不缩放输入框的下限(小于它聚焦时整页被放大) */
  .composer-input {
    min-height: 42px;
    max-height: 30dvh;
    font-size: 16px;
  }

  .composer-bar {
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }

  .cb-left {
    flex: 1 1 100%;
    row-gap: 8px;
  }

  .cb-right {
    flex: 1 1 100%;
  }

  /* 主操作:整行墨色药丸(触摸目标 44px) */
  .send-btn {
    width: 100%;
    height: 44px;
    font-size: 18px;
  }

  .aw-seg button {
    min-height: 40px;
    padding: 0 12px;
  }

  .chip-toggle {
    min-height: 40px;
  }

  .target {
    flex: 1 1 130px;
    width: auto;
  }

  .composer-bar :deep(.ant-select-selector) {
    min-height: 40px;
    align-items: center;
  }

  .loop-number,
  .loop-number.iterations {
    flex: 1 1 96px;
    width: auto;
  }

  .composer-bar :deep(.ant-input-number) {
    min-height: 40px;
  }

  .mention-opt {
    min-height: 44px;
  }
}
</style>
