<script setup lang="ts">
/**
 * ChatTimeline —— 人类群聊时间线(v17 主计划 §2 人类群聊 + §7 Agent 回复)。
 *
 * 与 Agent lanes / transcript 的区别:这里是**群聊语义**的消息流(chat.message),
 * 人类与 Agent 同场,必须一眼分清谁在说话:
 *  - 人类:person 图标 + 中性头像 + "用户"角色章(点 @ 用户**不跳 Agent 抽屉**);
 *  - Agent:agentHueColor 身份色头像 + lead/worker 角色章(@ 名可点 → 打开 Agent 抽屉)。
 *
 * 每条消息携带投递台账(chat.delivery.status):pending/delivered/consumed/failed/cancelled
 * 直接显示在气泡下 —— 操作者据此判断"Agent 到底收到没有",而不是靠猜。
 *
 * 引用链:replyToId → 气泡上方"↪ 回复 <发送者>";悬停出现「回复」动作 →
 * 写入 chat store 的 replyTarget,由 Composer 转成 replyToId 发出。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useChatStore } from '@/app/stores/workshop/chat'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useNotificationsStore } from '@/app/stores/workshop/notifications'
import { useComposerBus } from '@/app/composables/workshop/useComposerBus'
import { agentHueColor, mdLiteMentions, type MentionMember } from '@/app/composables/workshop/useEventBlocks'
import { parseChatReceipt } from '@/app/utils/chat-receipt'
import { formatLocalClock } from '@/app/composables/workshop/useLocalTime'
import type { AepChatDelivery, AepChatMessage, AepEnvelope } from '#shared/workshop-protocol'
import { classifyOperation, type OperationMeta } from '@/app/composables/workshop/operation-events'

const props = defineProps<{ channelId: string }>()

const { t } = useI18n()
const chat = useChatStore()
const entities = useEntitiesStore()
const notifications = useNotificationsStore()
const { draft } = useComposerBus()

/** SSR/首帧不读 WS 实体:实体由客户端建连后到达,直接渲染会造成 hydration mismatch */
const hydrated = ref(false)
const busyAgents = computed(() =>
  hydrated.value ? (entities.agents?.[props.channelId] ?? []).filter(a => a.state === 'busy').length : 0)
const pendingDeliveries = computed(() =>
  hydrated.value ? chat.deliveriesOfChannel(props.channelId).filter(d => d.status === 'pending').length : 0)

/** 空态建议卡:点击把 prompt 带入 Composer(不自动发送,仍由人确认) */
const suggestions = computed(() => [
  {
    key: 'plan',
    icon: 'i-tabler-route',
    title: t('chat.suggestionPlanTitle'),
    desc: t('chat.suggestionPlanDesc'),
    prompt: t('chat.suggestionPlanPrompt'),
  },
  {
    key: 'analyze',
    icon: 'i-tabler-chart-dots',
    title: t('chat.suggestionAnalyzeTitle'),
    desc: t('chat.suggestionAnalyzeDesc'),
    prompt: t('chat.suggestionAnalyzePrompt'),
  },
  {
    key: 'review',
    icon: 'i-tabler-shield-check',
    title: t('chat.suggestionReviewTitle'),
    desc: t('chat.suggestionReviewDesc'),
    prompt: t('chat.suggestionReviewPrompt'),
  },
])

const copyMessage = async (m: AepChatMessage): Promise<void> => {
  try {
    await navigator.clipboard.writeText(m.text)
    message.success(t('chat.copied'))
  }
  catch {
    message.error(t('chat.copyFailed'))
  }
}

/** @pill 点击 → 打开 Agent 抽屉(w/[wsId] provide;缺省安全兜底) */
const openAgent = inject<(target: { channelId: string, agentId: string }) => void>('aw:open-agent', () => {})

const messages = computed<AepChatMessage[]>(() => chat.messages[props.channelId] ?? [])
const visibleMessages = computed(() => hydrated.value ? messages.value : [])
/** 已加载过更早历史且上一页拉满 → 可能还有(按钮据此显示) */
const hasMore = computed(() => chat.hasMoreHistory[props.channelId] !== false)
const loading = computed(() => chat.loadingHistory[props.channelId] === true)

/** 正文里的 @Agent 高亮(只掩 agent 名:用户 @ 不做可点 pill,避免误跳 Agent) */
const mentionMembers = computed<MentionMember[]>(() =>
  (entities.agents[props.channelId] ?? []).map(a => ({ agentId: a.agentId, name: a.name })))

const byId = computed(() => {
  const map = new Map<string, AepChatMessage>()
  for (const m of messages.value) map.set(m.id, m)
  return map
})

function senderNameOf(m: AepChatMessage): string {
  if (m.senderType === 'agent') return entities.agentName(props.channelId, m.senderId) || m.senderName
  return m.senderName || m.senderId.slice(0, 8)
}

function avatarText(m: AepChatMessage): string {
  if (m.senderType === 'agent') return senderNameOf(m).charAt(0).toUpperCase()
  return t('chat.avatarHuman')
}

/** 智能体消息的 harness 标识(omp/dsh/codex…) —— 与 AgentBlock 的 harness 字段同源 */
function harnessOf(m: AepChatMessage): string {
  if (m.senderType !== 'agent') return ''
  return entities.agents[props.channelId]?.find(a => a.agentId === m.senderId)?.harness ?? ''
}

/**
 * 连续同发送者消息折叠(5 分钟窗口内、无引用/操作事件):
 * 只在轮次首条显示头像与 sender/harness/role,后续消息直接续写正文 ——
 * 这是 ChatGPT 的阅读节奏,避免每条消息重复一遍元信息。
 */
const GROUP_WINDOW_MS = 5 * 60 * 1000
function isGrouped(m: AepChatMessage, index: number): boolean {
  if (index <= 0) return false
  const prev = visibleMessages.value[index - 1]
  if (!prev || prev.senderType !== m.senderType || prev.senderId !== m.senderId) return false
  if (m.replyToId || prev.replyToId) return false
  if (operationOf(m) || operationOf(prev)) return false
  const delta = new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime()
  return Number.isFinite(delta) && delta >= 0 && delta < GROUP_WINDOW_MS
}

function renderText(m: AepChatMessage): string {
  return mdLiteMentions(m.text, mentionMembers.value)
}

/** mock/Agent 回执:每条消息只解析一次(模板内会多次读取) */
const receipts = computed(() => {
  const map = new Map<string, ReturnType<typeof parseChatReceipt>>()
  for (const m of messages.value) map.set(m.id, m.senderType === 'agent' ? parseChatReceipt(m.text) : null)
  return map
})
/** 只有命中专属签名才折叠;真实回答渲染路径完全不变 */
function receiptOf(m: AepChatMessage) {
  return receipts.value.get(m.id) ?? null
}

/** 回执关联的“提问者/来源消息”用成员显示名,不再给用户看 8 位 uuid */
function memberName(userId: string): string {
  const list = chat.members?.[props.channelId] ?? []
  return list.find(x => x.userId === userId)?.displayName ?? ''
}

function sourceSenderName(m: AepChatMessage): string {
  if (!m.sourceChatMessageId) return ''
  const src = byId.value.get(m.sourceChatMessageId)
  return src ? senderNameOf(src) : ''
}

function operationOf(m: AepChatMessage): OperationMeta | null {
  return classifyOperation({ v: 1, type: 'agent.message', seq: 0, at: m.createdAt, channelId: props.channelId, agentId: m.senderType === 'agent' ? m.senderId : undefined, payload: { parts: [{ text: m.text }] } as unknown as AepEnvelope['payload'] })
}

/** 引用锚点的发送者名(锚点不在已加载窗口内 → 显示"更早的消息") */
function replyAnchorName(m: AepChatMessage): string {
  const anchor = m.replyToId ? byId.value.get(m.replyToId) : undefined
  return anchor ? senderNameOf(anchor) : t('chat.earlierMessage')
}

/**
 * 投递台账按 messageId 建一次索引。
 *
 * 原先模板里 `deliveriesOf(m)` 被调用两次(v-if + v-for),而 store 的 `deliveriesOf`
 * 每次都要 `Object.values(...).filter(...)` 全量扫描并新分配数组 —— 未做虚拟滚动,
 * 500 条消息 × 2 次 ≈ 每帧上千次数组分配,滚动明显掉帧。这里一次 computed 收敛。
 */
const deliveriesByMessage = computed<Map<string, AepChatDelivery[]>>(() => {
  const out = new Map<string, AepChatDelivery[]>()
  for (const d of chat.deliveriesOfChannel(props.channelId)) {
    const list = out.get(d.chatMessageId)
    if (list) list.push(d)
    else out.set(d.chatMessageId, [d])
  }
  return out
})
const deliveriesOf = (m: AepChatMessage): AepChatDelivery[] => deliveriesByMessage.value.get(m.id) ?? []

const DELIVERY_TONE: Record<AepChatDelivery['status'], string> = {
  pending: 'pending',
  delivered: 'delivered',
  consumed: 'consumed',
  failed: 'failed',
  cancelled: 'cancelled',
}

const deliveryLabels = computed<Record<AepChatDelivery['status'], string>>(() => ({
  pending: t('chat.deliveryPending'),
  delivered: t('chat.deliveryDelivered'),
  consumed: t('chat.deliveryConsumed'),
  failed: t('chat.deliveryFailed'),
  cancelled: t('chat.deliveryCancelled'),
}))

function setReply(m: AepChatMessage): void {
  chat.setReplyTarget({
    channelId: props.channelId,
    messageId: m.id,
    senderName: senderNameOf(m),
    excerpt: m.text.replace(/\s+/g, ' ').slice(0, 60),
  })
}

/** 正文/提及 pill 点击:只对 agent pill 生效(用户 @ 不跳 Agent 抽屉) */
function onTextClick(ev: MouseEvent): void {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('.md-mention')
  const agentId = el?.dataset.agentId
  if (agentId) openAgent({ channelId: props.channelId, agentId })
}

// ===== 自动吸底:只有原本就在底部时才跟随新消息(否则用户在翻历史会被拽走) =====
const scroller = ref<HTMLElement | null>(null)
const atBottom = ref(true)

function scrollToBottom(): void {
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

function onScroll(): void {
  const el = scroller.value
  if (!el) return
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}

watch(() => messages.value.length, async (n, prev) => {
  if (prev !== undefined && n <= prev) return
  if (!atBottom.value) return
  await nextTick()
  scrollToBottom()
  // 正在看群聊 → 该频道未读收敛为已读(服务端按 recipient 记,不接受他人 userId)
  void markChannelRead()
})

/** 打开群聊即把本频道内我的定向通知收敛已读 */
async function markChannelRead(): Promise<void> {
  const hasUnread = notifications.items.some(n => n.channelId === props.channelId && !n.readAt)
  if (!hasUnread) return
  try {
    await notifications.markRead({ channelId: props.channelId })
  }
  catch { /* 已读失败不影响阅读 */ }
}

/** 加载更早一页(锚定滚动位置,不让视口跳走) */
async function loadEarlier(): Promise<void> {
  const el = scroller.value
  const before = el ? el.scrollHeight - el.scrollTop : 0
  const oldest = messages.value[0]?.id
  try {
    await chat.loadHistory(props.channelId, { before: oldest })
  }
  catch { /* 失败保持原状(按钮可重试) */ }
  await nextTick()
  if (el) el.scrollTop = el.scrollHeight - before
}

onMounted(async () => {
  hydrated.value = true
  try {
    await chat.loadHistory(props.channelId)
  }
  catch { /* 历史失败不阻塞实时帧 */ }
  await nextTick()
  scrollToBottom()
  await markChannelRead()
})

// 频道切换:重置到底部
watch(() => props.channelId, async () => {
  atBottom.value = true
  await nextTick()
  scrollToBottom()
})
</script>

<template>
  <div class="chat-timeline">
    <!-- 2026-11-07 ChatGPT 化:内嵌大头部(orb+标题)撤除 —— 频道名上移中央列
         标题条(console/Topbar),对话流像 ChatGPT 一样从内容直接开始。 -->
    <div
      ref="scroller"
      class="ct-scroll"
      @scroll.passive="onScroll"
    >
      <div class="ct-thread">
        <button
          v-if="hasMore && visibleMessages.length > 0"
          type="button"
          class="ct-earlier"
          :disabled="loading"
          @click="loadEarlier"
        >
          {{ loading ? $t('chat.loading') : $t('chat.loadEarlier') }}
        </button>

        <div
          v-if="visibleMessages.length === 0"
          class="ct-empty"
        >
          <div class="ct-empty-eyebrow">
            {{ $t('chat.newConversation') }}
          </div>
          <h2 class="ct-empty-title">
            {{ $t('chat.heroTitle') }}
          </h2>
          <p class="ct-empty-hint">
            {{ $t('chat.heroHint') }}
          </p>
          <div class="ct-suggestions">
            <button
              v-for="s in suggestions"
              :key="s.key"
              type="button"
              class="ct-suggestion"
              @click="draft(s.prompt)"
            >
              <span
                class="ct-suggestion-icon"
                :class="s.icon"
              />
              <span class="ct-suggestion-copy">
                <strong>{{ s.title }}</strong>
                <span>{{ s.desc }}</span>
              </span>
              <span class="ct-suggestion-arrow i-tabler-arrow-up-right" />
            </button>
          </div>
          <div class="ct-empty-foot">
            <span class="i-tabler-at" /> {{ $t('chat.emptyHint') }}
          </div>
        </div>

        <div
          class="ct-log"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          :aria-label="$t('chat.title')"
        >
          <div
            v-for="(m, i) in visibleMessages"
            :key="m.id"
            class="ct-row"
            :class="[m.senderType, { 'ct-grouped': isGrouped(m, i) }, operationOf(m) ? 'op-' + operationOf(m)!.kind : '']"
            :data-operation="operationOf(m)?.kind"
            :data-operation-severity="operationOf(m)?.severity"
          >
            <template v-if="m.senderType === 'system'">
              <div class="ct-system">
                {{ m.text }}
              </div>
            </template>

            <template v-else-if="m.senderType === 'user'">
              <div class="ct-user-wrap">
                <div
                  v-if="m.replyToId"
                  class="ct-replyto"
                >
                  <span class="i-tabler-corner-down-right" />
                  {{ $t('chat.reply') }} <b>{{ replyAnchorName(m) }}</b>
                </div>
                <div
                  v-if="operationOf(m)"
                  class="ct-operation-badge"
                  :class="operationOf(m)!.kind"
                >
                  <span :class="operationOf(m)!.icon" />
                  {{ operationOf(m)!.label }}
                </div>
                <!-- eslint-disable vue/no-v-html -- mdLite escapes first -->
                <div
                  class="ct-user-bubble"
                  @click="onTextClick"
                  v-html="renderText(m)"
                />
                <!-- eslint-enable vue/no-v-html -->
                <div
                  v-if="!isGrouped(m, i)"
                  class="ct-user-meta"
                >
                  <span class="ct-user-label">{{ $t('chat.you') }}</span>
                  <span class="ct-time">{{ formatLocalClock(m.createdAt, false) }}</span>
                  <button
                    type="button"
                    class="ct-action"
                    :aria-label="$t('chat.replyTitle')"
                    :title="$t('chat.replyTitle')"
                    @click="setReply(m)"
                  >
                    <span class="i-tabler-arrow-back-up" />
                  </button>
                  <button
                    type="button"
                    class="ct-action"
                    :aria-label="$t('chat.copy')"
                    :title="$t('chat.copy')"
                    @click="copyMessage(m)"
                  >
                    <span class="i-tabler-copy" />
                  </button>
                </div>
                <div
                  v-if="m.mentions.length > 0"
                  class="ct-mentions"
                >
                  <component
                    :is="mm.type === 'agent' ? 'button' : 'span'"
                    v-for="mm in m.mentions"
                    :key="`${mm.type}:${mm.id}`"
                    class="ct-mention-chip"
                    :class="mm.type"
                    :type="mm.type === 'agent' ? 'button' : undefined"
                    :data-agent-id="mm.type === 'agent' ? mm.id : undefined"
                    :aria-label="mm.type === 'agent' ? $t('chat.mentionAgentTitle') : undefined"
                    :title="mm.type === 'agent' ? $t('chat.mentionAgentTitle') : $t('chat.mentionMemberTitle')"
                    @click="mm.type === 'agent' && openAgent({ channelId, agentId: mm.id })"
                  >
                    <span :class="mm.type === 'agent' ? 'i-tabler-robot' : 'i-tabler-user'" />
                    @{{ mm.label || (mm.type === 'agent' ? entities.agentName(channelId, mm.id) : mm.id.slice(0, 8)) }}
                  </component>
                </div>
                <div
                  v-if="deliveriesOf(m).length > 0"
                  class="ct-deliveries"
                >
                  <span
                    v-for="d in deliveriesOf(m)"
                    :key="d.deliveryId"
                    class="ct-delivery"
                    :data-tone="DELIVERY_TONE[d.status] ?? 'pending'"
                    :title="d.error || `deliveryId: ${d.deliveryId}`"
                  >
                    <span class="cd-dot" />@{{ entities.agentName(channelId, d.targetAgentId) }} · {{ deliveryLabels[d.status] ?? d.status }}
                  </span>
                </div>
              </div>
            </template>

            <template v-else>
              <span
                v-if="!isGrouped(m, i)"
                class="aw-avatar ct-ava is-agent"
                :style="{ '--av': agentHueColor(m.senderId) }"
              >{{ avatarText(m) }}</span>
              <div class="ct-body">
                <div
                  v-if="!isGrouped(m, i)"
                  class="ct-meta"
                >
                  <span class="ct-sender">{{ senderNameOf(m) }}</span>
                  <span
                    v-if="harnessOf(m)"
                    class="ct-harness"
                  >{{ harnessOf(m) }}</span>
                  <span class="ct-role">
                    {{ entities.agents[channelId]?.find(a => a.agentId === m.senderId)?.role ?? 'agent' }}
                  </span>
                  <span class="ct-time">{{ formatLocalClock(m.createdAt, false) }}</span>
                  <span class="ct-actions">
                    <button
                      type="button"
                      class="ct-action"
                      :aria-label="$t('chat.replyTitle')"
                      :title="$t('chat.replyTitle')"
                      @click="setReply(m)"
                    >
                      <span class="i-tabler-arrow-back-up" />
                    </button>
                    <button
                      type="button"
                      class="ct-action"
                      :aria-label="$t('chat.copy')"
                      :title="$t('chat.copy')"
                      @click="copyMessage(m)"
                    >
                      <span class="i-tabler-copy" />
                    </button>
                  </span>
                </div>

                <div
                  v-if="m.replyToId"
                  class="ct-replyto"
                >
                  <span class="i-tabler-corner-down-right" />
                  {{ $t('chat.reply') }} <b>{{ replyAnchorName(m) }}</b>
                </div>

                <div
                  v-if="operationOf(m)"
                  class="ct-operation-badge"
                  :class="operationOf(m)!.kind"
                >
                  <span :class="operationOf(m)!.icon" />
                  {{ operationOf(m)!.label }}
                </div>

                <!-- 回执卡:mock/Agent 的内部执行信封不再作为正文外露 -->
                <div
                  v-if="receiptOf(m)"
                  class="ct-receipt"
                  data-testid="chat-receipt"
                  :title="receiptOf(m)!.correlation"
                >
                  <div class="cr-head">
                    <span class="i-tabler-receipt cr-icon" />
                    <b>{{ $t('chat.receiptTitle') }}</b>
                    <span class="cr-agent">@{{ senderNameOf(m) }}</span>
                    <span class="cr-badge">mock</span>
                  </div>
                  <p
                    v-if="receiptOf(m)!.question"
                    class="cr-q"
                  >
                    {{ receiptOf(m)!.question }}
                  </p>
                  <p
                    v-else
                    class="cr-q cr-digest"
                  >
                    {{ $t('chat.receiptDigest') }}
                  </p>
                  <details
                    v-if="receiptOf(m)!.instruction"
                    class="cr-sys"
                  >
                    <summary>{{ $t('chat.receiptSystem') }}</summary>
                    <pre>{{ receiptOf(m)!.instruction }}</pre>
                  </details>
                </div>

                <!-- eslint-disable vue/no-v-html -- mdLite escapes first -->
                <div
                  v-else
                  class="ct-text"
                  @click="onTextClick"
                  v-html="renderText(m)"
                />
                <!-- eslint-enable vue/no-v-html -->

                <div
                  v-if="m.mentions.length > 0"
                  class="ct-mentions"
                >
                  <component
                    :is="mm.type === 'agent' ? 'button' : 'span'"
                    v-for="mm in m.mentions"
                    :key="`${mm.type}:${mm.id}`"
                    class="ct-mention-chip"
                    :class="mm.type"
                    :type="mm.type === 'agent' ? 'button' : undefined"
                    :data-agent-id="mm.type === 'agent' ? mm.id : undefined"
                    :aria-label="mm.type === 'agent' ? $t('chat.mentionAgentTitle') : undefined"
                    :title="mm.type === 'agent' ? $t('chat.mentionAgentTitle') : $t('chat.mentionMemberTitle')"
                    @click="mm.type === 'agent' && openAgent({ channelId, agentId: mm.id })"
                  >
                    <span :class="mm.type === 'agent' ? 'i-tabler-robot' : 'i-tabler-user'" />
                    @{{ mm.label || (mm.type === 'agent' ? entities.agentName(channelId, mm.id) : mm.id.slice(0, 8)) }}
                  </component>
                </div>

                <div
                  v-if="deliveriesOf(m).length > 0"
                  class="ct-deliveries"
                >
                  <span
                    v-for="d in deliveriesOf(m)"
                    :key="d.deliveryId"
                    class="ct-delivery"
                    :data-tone="DELIVERY_TONE[d.status] ?? 'pending'"
                    :title="d.error || `deliveryId: ${d.deliveryId}`"
                  >
                    <span class="cd-dot" />@{{ entities.agentName(channelId, d.targetAgentId) }} · {{ deliveryLabels[d.status] ?? d.status }}
                  </span>
                </div>

                <div
                  v-if="m.senderType === 'agent' && (sourceSenderName(m) || memberName(m.requesterUserId ?? ''))"
                  class="ct-source"
                  :title="m.sourceChatMessageId ?? ''"
                >
                  <span class="i-tabler-link" />
                  <template v-if="sourceSenderName(m)">
                    {{ $t('chat.answeredFrom', { p0: sourceSenderName(m) }) }}
                  </template>
                  <template v-if="memberName(m.requesterUserId ?? '')">
                    {{ $t('chat.askedBy', { p0: memberName(m.requesterUserId ?? '') }) }}
                  </template>
                </div>
              </div>
            </template>
          </div>
        </div>

        <div
          v-if="pendingDeliveries > 0 || busyAgents > 0"
          class="ct-thinking"
        >
          <span class="ct-thinking-dots"><i /><i /><i /></span>
          <span>{{ busyAgents > 0 ? $t('chat.thinkingAgents', { p0: busyAgents }) : $t('chat.thinking') }}</span>
        </div>
      </div>

      <button
        v-if="!atBottom"
        type="button"
        class="ct-scroll-fab"
        @click="scrollToBottom(); atBottom = true"
      >
        <span class="i-tabler-arrow-down" /> {{ $t('chat.jumpLatest') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat-timeline {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  color: var(--chat-ink);
  background: var(--chat-canvas);
}

/* ── 阅读列:白画布;内容居中,行宽克制(ChatGPT 阅读列同宽) ─────────────── */
.ct-scroll {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--chat-glow), var(--chat-canvas);
  scroll-behavior: smooth;
}
.ct-thread {
  width: min(800px, calc(100% - 64px));
  padding: 26px 0 120px;
  margin: 0 auto;
}
.ct-earlier {
  display: block;
  margin: 0 auto 18px;
  padding: 5px 14px;
  font-family: var(--font-body);
  font-size: 11.5px;
  color: var(--chat-ink-faint);
  cursor: pointer;
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
  border-radius: var(--radius-pill);
  transition: color var(--transition-fast), border-color var(--transition-fast);
}
.ct-earlier:hover { color: var(--chat-ink); border-color: var(--chat-line-strong); }
.ct-earlier:disabled { opacity: 0.5; cursor: default; }

/* ── 空态:不是"没有消息",而是一个可行动的开始 ────────────────── */
.ct-empty {
  padding: 9vh 8px 40px;
  text-align: center;
}
.ct-empty-eyebrow {
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  letter-spacing: 0.2em;
  color: var(--chat-ink-faint);
  text-transform: uppercase;
}
.ct-empty-title {
  max-width: 560px;
  margin: 12px auto 0;
  font-family: var(--font-display);
  font-size: clamp(26px, 3vw, 34px);
  font-weight: 400;
  line-height: 1.08;
  letter-spacing: -0.035em;
  color: var(--chat-ink);
}
.ct-empty-hint {
  max-width: 540px;
  margin: 14px auto 0;
  font-size: 13.5px;
  line-height: 1.75;
  color: var(--chat-ink-soft);
}
.ct-suggestions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
  max-width: 760px;
  margin: 32px auto 0;
  text-align: left;
}
.ct-suggestion {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 14px;
  font-family: var(--font-body);
  text-align: left;
  cursor: pointer;
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
  border-radius: 16px;
  box-shadow: 0 1px 2px rgb(41 37 36 / 3%);
  transition: transform var(--transition-base), border-color var(--transition-base), box-shadow var(--transition-base);
}
.ct-suggestion:hover {
  border-color: color-mix(in srgb, var(--chat-accent) 38%, var(--chat-line));
  box-shadow: 0 14px 32px rgb(41 37 36 / 8%);
  transform: translateY(-2px);
}
.ct-suggestion:active { transform: translateY(0); }
.ct-suggestion-icon {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 30px;
  height: 30px;
  font-size: 15px;
  color: var(--chat-accent);
  background: var(--chat-accent-soft);
  border-radius: 9px;
}
.ct-suggestion-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.ct-suggestion-copy strong {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--chat-ink);
}
.ct-suggestion-copy span {
  font-size: 11px;
  line-height: 1.5;
  color: var(--chat-ink-faint);
}
.ct-suggestion-arrow {
  flex: 0 0 auto;
  margin-left: auto;
  font-size: 13px;
  color: var(--chat-ink-faint);
  opacity: 0;
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}
.ct-suggestion:hover .ct-suggestion-arrow {
  opacity: 1;
  transform: translate(2px, -2px);
}
.ct-empty-foot {
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: center;
  margin-top: 24px;
  font-size: 11px;
  color: var(--chat-ink-faint);
}

/* ── 消息:Agent 全宽阅读块;用户右侧暖灰气泡(ChatGPT 声部) ────── */
.ct-row {
  display: flex;
  gap: 13px;
  padding: 18px 0;
}
.ct-row.agent { align-items: flex-start; }
.ct-row.user { align-items: flex-end; justify-content: flex-end; }
.ct-row.system { justify-content: center; padding: 8px 0; }
/* 连续同发送者:续写正文,不再重复头像/元信息(轮次语义) */
.ct-row.ct-grouped { padding-top: 2px; }
.ct-row.ct-grouped.agent .ct-body { margin-left: 41px; }
.ct-system {
  max-width: 82%;
  padding: 5px 12px;
  font-size: var(--fs-micro);
  color: var(--chat-ink-faint);
  background: var(--chat-surface-raised);
  border: 1px solid var(--chat-line);
  border-radius: var(--radius-pill);
}
.ct-ava {
  width: 28px;
  height: 28px;
  margin-top: 1px;
  font-size: 10.5px;
  border: 1px solid var(--chat-line);
  box-shadow: 0 1px 3px rgb(41 37 36 / 4%);
}
.ct-ava.is-user {
  color: var(--chat-user-ink);
  background: var(--chat-user-bubble);
}
.ct-body {
  flex: 1 1 auto;
  min-width: 0;
  max-width: calc(100% - 41px);
}
.ct-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  min-width: 0;
}
.ct-sender {
  font-size: 13px;
  font-weight: 650;
  color: var(--chat-ink);
}
.ct-role {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  padding: 0 5px;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: 15px;
  letter-spacing: 0.04em;
  color: var(--chat-ink-faint);
  text-transform: lowercase;
  border: 1px solid var(--chat-line);
  border-radius: 4px;
}
/* harness 标识:与 AgentBlock 的 harness 字段同源,等宽轻 chip */
.ct-harness {
  padding: 0 4px;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  line-height: 15px;
  color: var(--chat-ink-faint);
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
  border-radius: 4px;
}
.ct-time {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--chat-ink-faint);
}
.ct-actions {
  display: inline-flex;
  gap: 2px;
  margin-left: 2px;
  opacity: 0;
  transition: opacity var(--transition-fast);
}
.ct-row:hover .ct-actions,
.ct-row:focus-within .ct-actions { opacity: 1; }
/* 触控没有 hover:操作按钮常显,否则复制/回复不可达 */
@media (hover: none), (pointer: coarse) {
  .ct-actions,
  .ct-user-wrap .ct-actions { opacity: 1; }
}
.ct-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  font-size: 13px;
  color: var(--chat-ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 8px;
  transition: color var(--transition-fast), background var(--transition-fast);
}
.ct-action:hover {
  color: var(--chat-ink);
  background: var(--chat-surface);
}
.ct-text {
  margin-top: 6px;
  font-size: 15.5px;
  line-height: 1.75;
  color: var(--chat-ink);
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* 执行回执:群聊里的“系统信封”折叠成一张可扫读的卡片 */
.ct-receipt {
  max-width: 660px;
  padding: 10px 12px;
  margin-top: 6px;
  background: var(--chat-surface-raised);
  border: 1px solid var(--chat-line);
  border-left: 2px solid var(--chat-accent);
  border-radius: 10px;
}

.cr-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
}

.cr-icon { font-size: 14px; color: var(--chat-accent-strong); }

.cr-head b {
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.04em;
  color: var(--chat-ink);
  text-transform: uppercase;
}

.cr-agent {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--chat-ink-soft);
}

.cr-badge {
  padding: 0 5px;
  font-family: var(--font-mono);
  font-size: 9px;
  line-height: 1.6;
  color: var(--chat-ink-faint);
  border: 1px solid var(--chat-line);
  border-radius: 4px;
}

.cr-q {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--chat-ink);
  overflow-wrap: anywhere;
}

.cr-sys {
  margin-top: 7px;
  font-size: 11px;
  color: var(--chat-ink-soft);
}

.cr-sys summary {
  cursor: pointer;
  user-select: none;
}

.cr-sys pre {
  max-height: 160px;
  padding: 8px;
  margin: 6px 0 0;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--chat-canvas);
  border: 1px solid var(--chat-line);
  border-radius: 6px;
}
.ct-text :deep(p) { margin: 0 0 8px; }
.ct-text :deep(p:last-child) { margin-bottom: 0; }
.ct-text :deep(ul),
.ct-text :deep(ol) { padding-left: 1.35em; margin: 6px 0 10px; }
.ct-text :deep(li) { margin: 3px 0; }
.ct-text :deep(a) {
  color: var(--chat-accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.ct-text :deep(code) {
  padding: 1px 5px;
  font-family: var(--font-mono);
  font-size: 0.86em;
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
  border-radius: 5px;
}
.ct-text :deep(pre) {
  padding: 12px 14px;
  margin: 10px 0;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
  border-radius: 12px;
}
.ct-text :deep(blockquote) {
  padding-left: 12px;
  margin: 8px 0;
  color: var(--chat-ink-soft);
  border-left: 2px solid var(--chat-line-strong);
}

.ct-user-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  max-width: min(76%, 640px);
  min-width: 0;
}
.ct-user-bubble {
  padding: 10px 15px;
  font-size: 14px;
  line-height: 1.68;
  color: var(--chat-user-ink);
  background: var(--chat-user-bubble);
  border: 1px solid transparent;
  border-radius: 16px 16px 4px 16px;
  box-shadow: 0 1px 2px rgb(41 37 36 / 4%);
  overflow-wrap: anywhere;
  word-break: break-word;
}
.ct-user-bubble :deep(p) { margin: 0 0 6px; }
.ct-user-bubble :deep(p:last-child) { margin-bottom: 0; }
.ct-user-bubble :deep(a) { color: var(--chat-accent); }
.ct-user-meta {
  display: flex;
  gap: 7px;
  align-items: center;
  justify-content: flex-end;
  margin-top: 5px;
  font-size: var(--fs-micro);
  color: var(--chat-ink-faint);
}
.ct-user-label {
  font-weight: 650;
  color: var(--chat-ink-soft);
}
.ct-user-wrap .ct-actions { opacity: 0; }
.ct-row.user:hover .ct-actions { opacity: 1; }
.ct-user-wrap .ct-mentions,
.ct-user-wrap .ct-deliveries { justify-content: flex-end; }

.ct-replyto {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  margin: 3px 0 5px;
  padding: 3px 8px;
  font-size: var(--fs-micro);
  color: var(--chat-ink-faint);
  background: var(--chat-surface);
  border-left: 2px solid var(--chat-accent);
  border-radius: 0 6px 6px 0;
}
.ct-replyto b { color: var(--chat-ink-soft); }
.ct-operation-badge {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  padding: 3px 8px;
  margin: 4px 0 6px;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  border-radius: var(--radius-pill);
}
.ct-operation-badge.dcw { color: #a56d17; background: color-mix(in srgb, #c98922 11%, transparent); }
.ct-operation-badge.daq { color: #148681; background: color-mix(in srgb, #159f9a 10%, transparent); }
.ct-operation-badge.aml { color: #7657ad; background: color-mix(in srgb, #7657ad 10%, transparent); }
.ct-operation-badge.twin { color: #3978b8; background: color-mix(in srgb, #3978b8 10%, transparent); }
.ct-operation-badge.safety { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
/* 操作事件只保留 badge,不再给整行叠 3–5% 底色:
 * 底色会让每次工具调用看起来像"另一张卡",破坏 ChatGPT 的连续阅读。 */
.ct-row[data-operation] { background: transparent; }

.ct-mentions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 7px;
}
.ct-mention-chip {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 1px 7px;
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  border: 0;
  border-radius: var(--radius-pill);
}
.ct-mention-chip.agent {
  color: var(--chat-accent);
  cursor: pointer;
  background: var(--chat-accent-soft);
}
.ct-mention-chip.user {
  color: var(--chat-ink-soft);
  cursor: default;
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
}

.ct-deliveries {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 6px;
}
.ct-delivery {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 1px 7px;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--chat-ink-faint);
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
  border-radius: var(--radius-pill);
}
.ct-delivery .cd-dot {
  width: 5px;
  height: 5px;
  background: currentColor;
  border-radius: 50%;
}
.ct-delivery[data-tone='pending'] { color: var(--tone-warning-dot); }
.ct-delivery[data-tone='delivered'] { color: var(--tone-info-dot); }
.ct-delivery[data-tone='consumed'] { color: var(--tone-success-dot); }
.ct-delivery[data-tone='failed'] { color: var(--tone-danger-dot); }
.ct-delivery[data-tone='cancelled'] { color: var(--chat-ink-faint); }

.ct-source {
  display: flex;
  gap: 5px;
  align-items: center;
  margin-top: 6px;
  font-family: var(--font-mono);
  font-size: var(--fs-micro);
  color: var(--chat-ink-faint);
}

/* ── 思考中:Agent 运行/投递待处理的实时脉搏 ────────────────────── */
.ct-thinking {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 20px 0 8px;
  font-size: 12px;
  color: var(--chat-ink-faint);
}
.ct-thinking-dots {
  display: inline-flex;
  gap: 3px;
  align-items: center;
}
.ct-thinking-dots i {
  width: 5px;
  height: 5px;
  background: var(--chat-accent);
  border-radius: 50%;
  animation: ct-blink 1.2s ease-in-out infinite;
}
.ct-thinking-dots i:nth-child(2) { animation-delay: 0.16s; }
.ct-thinking-dots i:nth-child(3) { animation-delay: 0.32s; }

.ct-scroll-fab {
  position: sticky;
  bottom: 18px;
  display: flex;
  gap: 6px;
  align-items: center;
  float: right;
  padding: 8px 14px;
  margin-right: 22px;
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--chat-ink-soft);
  cursor: pointer;
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
  border-radius: var(--radius-pill);
  box-shadow: var(--chat-shadow);
  transition: transform var(--transition-fast), border-color var(--transition-fast);
}
.ct-scroll-fab:hover { border-color: var(--chat-line-strong); transform: translateY(-1px); }

@keyframes ct-rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
@keyframes ct-blink {
  0%, 80%, 100% { opacity: 0.25; transform: translateY(0); }
  40% { opacity: 1; transform: translateY(-2px); }
}

@media (max-width: 1023.98px) {
  .ct-thread {
    width: calc(100% - 24px);
    padding: 16px 0 100px;
  }
  .ct-empty { padding: 6vh 2px 24px; }
  .ct-suggestions {
    grid-template-columns: 1fr;
    margin-top: 24px;
  }
  .ct-actions { opacity: 1; }
  .ct-user-wrap { max-width: 86%; }
  .ct-text { font-size: 15.5px; }
  .ct-user-bubble { font-size: 15px; }
  .ct-row { padding: 12px 0; }
  .ct-scroll-fab { bottom: 12px; margin-right: 12px; }
}

@media (prefers-reduced-motion: reduce) {
  .ct-row,
  .ct-thinking-dots i {
    animation: none;
  }
  .ct-scroll { scroll-behavior: auto; }
}
</style>
