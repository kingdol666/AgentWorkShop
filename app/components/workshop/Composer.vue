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
 * 结构:菜单/回复 chip/状态行/工具行已拆到 workshop/composer/* 子组件,
 * @提及状态机拆到 composables/workshop/useComposerMentions.ts —— 这里仍是唯一状态持有者。
 */
import { message } from 'ant-design-vue'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'
import { useComposerBus } from '@/app/composables/workshop/useComposerBus'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useUserStore } from '@/app/stores/workshop/user'
import { useChatStore, chatErrorCode, chatErrorMessage } from '@/app/stores/workshop/chat'
import { useComposerMentions, type ComposerMode, type MentionCandidate } from '@/app/composables/workshop/useComposerMentions'
import ComposerToolbar from '@/app/components/workshop/composer/ComposerToolbar.vue'
import MentionMenu from '@/app/components/workshop/composer/MentionMenu.vue'
import ReplyChip from '@/app/components/workshop/composer/ReplyChip.vue'
import StatusChip from '@/app/components/workshop/composer/StatusChip.vue'
import type { AepChatMention } from '#shared/workshop-protocol'

const { t } = useI18n()

const props = defineProps<{ channelId: string }>()
const emit = defineEmits<{ (e: 'submitted'): void }>()
const api = useWorkshopApi()
const entities = useEntitiesStore()
const userStore = useUserStore()
const chat = useChatStore()

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

/** 工具行模式按钮:切换模式并锁定(不再被 canPost 自动改写) */
const pickMode = (m: ComposerMode): void => {
  mode.value = m
  userPickedMode.value = true
}

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

// @提及自动补全(状态机 + 候选过滤)见 useComposerMentions;此处只注入依赖
const {
  mentionOpen,
  mentionHi,
  mentionFiltered,
  detectMention,
  pickMention,
  onMentionKeydown,
  parseMentions,
} = useComposerMentions({ input, mentionCandidates, mode, toAgentId })

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
  // 重入闸:按钮的 :disabled 拦不住 Enter/⌘+Enter(它们直接调 send()),
  // 两次并发 POST 携带同一个 clientMessageId → 服务端去重不掉行,但用户会看到两条成功提示
  if (sendLoading.value) return
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
      <MentionMenu
        v-if="mentionOpen"
        :candidates="mentionFiltered"
        :highlighted="mentionHi"
        @pick="pickMention"
        @hover="mentionHi = $event"
      />

      <!-- 回复目标 chip(引用链:replyToId) -->
      <ReplyChip
        v-if="replyTarget"
        :sender-name="replyTarget.senderName"
        :excerpt="replyTarget.excerpt"
        @cancel="chat.clearReplyTarget()"
      />

      <StatusChip
        :mode="mode"
        :draft-agent-mentions="draftAgentMentions"
        :draft-user-mentions="draftUserMentions"
        :task-mode="taskMode"
        :loop-interval-seconds="loopIntervalSeconds"
        :target-name="targetName"
        :is-default-lead="isDefaultLead"
        :reach-hint="reachHint"
        :priority="priority"
      />

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

      <ComposerToolbar
        v-model:mode="mode"
        v-model:to-agent-id="toAgentId"
        v-model:task-mode="taskMode"
        v-model:loop-interval-model="loopIntervalModel"
        v-model:loop-max-iterations-model="loopMaxIterationsModel"
        v-model:priority="priority"
        v-model:require-reply="requireReply"
        :can-post="canPost"
        :can-manage="canManage"
        :perms="perms"
        :workers-and-lead="workersAndLead"
        :send-loading="sendLoading"
        :input="input"
        @pick="pickMode"
        @send="send"
      />
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

/* 群聊不可发言时的诚实提示(不渲染必然失败的发送) */
.composer-block-hint {
  display: flex;
  gap: 6px;
  align-items: center;
  margin: 0 0 4px 2px;
  font-size: 11.5px;
  color: var(--tone-warning-dot);
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
.composer-input::placeholder { color: var(--ink-faint); }

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

  /* 16px 是 iOS 不缩放输入框的下限(小于它聚焦时整页被放大) */
  .composer-input {
    min-height: 42px;
    max-height: 30dvh;
    font-size: 16px;
  }
}
</style>
