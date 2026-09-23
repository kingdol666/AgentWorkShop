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
import { useChatStore } from '@/app/stores/workshop/chat'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useNotificationsStore } from '@/app/stores/workshop/notifications'
import { agentHueColor, mdLiteMentions, type MentionMember } from '@/app/composables/workshop/useEventBlocks'
import { formatLocalClock } from '@/app/composables/workshop/useLocalTime'
import type { AepChatDelivery, AepChatMessage } from '#shared/workshop-protocol'

const props = defineProps<{ channelId: string }>()

const chat = useChatStore()
const entities = useEntitiesStore()
const notifications = useNotificationsStore()

/** @pill 点击 → 打开 Agent 抽屉(w/[wsId] provide;缺省安全兜底) */
const openAgent = inject<(target: { channelId: string, agentId: string }) => void>('aw:open-agent', () => {})

const messages = computed<AepChatMessage[]>(() => chat.messages[props.channelId] ?? [])
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
  return '人'
}

function renderText(m: AepChatMessage): string {
  return mdLiteMentions(m.text, mentionMembers.value)
}

/** 引用锚点的发送者名(锚点不在已加载窗口内 → 显示"更早的消息") */
function replyAnchorName(m: AepChatMessage): string {
  const anchor = m.replyToId ? byId.value.get(m.replyToId) : undefined
  return anchor ? senderNameOf(anchor) : '更早的消息'
}

function deliveriesOf(m: AepChatMessage): AepChatDelivery[] {
  return chat.deliveriesOf(props.channelId, m.id)
}

const DELIVERY_META: Record<AepChatDelivery['status'], { label: string, tone: string }> = {
  pending: { label: '待投递', tone: 'pending' },
  delivered: { label: '已入信箱', tone: 'delivered' },
  consumed: { label: '已被消费', tone: 'consumed' },
  failed: { label: '投递失败', tone: 'failed' },
  cancelled: { label: '已取消', tone: 'cancelled' },
}

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
    <div class="ct-head">
      <span class="i-tabler-messages ct-icon" />
      <span class="ct-title">群聊</span>
      <span class="ct-count">{{ messages.length }} 条</span>
      <span class="ct-spacer" />
      <span
        v-if="!atBottom"
        class="ct-jump"
        role="button"
        tabindex="0"
        title="回到最新"
        @click="scrollToBottom(); atBottom = true"
        @keydown.enter="scrollToBottom(); atBottom = true"
      >
        <span class="i-tabler-arrow-down" /> 最新
      </span>
    </div>

    <div
      ref="scroller"
      class="ct-scroll"
      @scroll.passive="onScroll"
    >
      <button
        v-if="hasMore && messages.length > 0"
        type="button"
        class="ct-earlier"
        :disabled="loading"
        @click="loadEarlier"
      >
        {{ loading ? '加载中…' : '加载更早的消息' }}
      </button>

      <div
        v-if="messages.length === 0"
        class="ct-empty"
      >
        <span class="i-tabler-message-2 ct-empty-icon" />
        <div>还没有群聊消息</div>
        <div class="ct-empty-sub">
          直接发言只进群聊(0 次 Agent 执行);输入 @ 提及 Agent 才会触发执行,@ 成员只发定向通知。
        </div>
      </div>

      <div
        v-for="m in messages"
        :key="m.id"
        class="ct-row"
        :class="m.senderType"
      >
        <span
          class="aw-avatar ct-ava"
          :class="{ 'is-agent': m.senderType === 'agent' }"
          :style="m.senderType === 'agent' ? { '--av': agentHueColor(m.senderId) } : {}"
        >{{ avatarText(m) }}</span>

        <div class="ct-body">
          <div class="ct-meta">
            <span class="ct-sender">{{ senderNameOf(m) }}</span>
            <span
              class="ct-role"
              :class="m.senderType"
            >
              <span
                v-if="m.senderType === 'user'"
                class="i-tabler-user"
              />
              <span
                v-else-if="m.senderType === 'agent'"
                class="i-tabler-robot"
              />
              {{ m.senderType === 'agent' ? (entities.agents[channelId]?.find(a => a.agentId === m.senderId)?.role ?? 'agent') : (m.senderType === 'user' ? '用户' : '系统') }}
            </span>
            <span class="ct-time">{{ formatLocalClock(m.createdAt, false) }}</span>
            <button
              type="button"
              class="ct-reply-btn"
              title="引用这条消息回复"
              @click="setReply(m)"
            >
              <span class="i-tabler-arrow-back-up" /> 回复
            </button>
          </div>

          <div
            v-if="m.replyToId"
            class="ct-replyto"
          >
            <span class="i-tabler-corner-down-right" />
            回复 <b>{{ replyAnchorName(m) }}</b>
          </div>

          <!-- eslint-disable vue/no-v-html -- mdLite 先 escapeHtml 再注入受控标记,与既有时间线同源 -->
          <div
            class="ct-text"
            @click="onTextClick"
            v-html="renderText(m)"
          />
          <!-- eslint-enable vue/no-v-html -->

          <!-- @提及 chips:agent 可点(开抽屉),用户 chip 不可点(不误跳 Agent) -->
          <div
            v-if="m.mentions.length > 0"
            class="ct-mentions"
          >
            <span
              v-for="mm in m.mentions"
              :key="`${mm.type}:${mm.id}`"
              class="ct-mention-chip"
              :class="mm.type"
              :data-agent-id="mm.type === 'agent' ? mm.id : undefined"
              :title="mm.type === 'agent' ? '点击查看该 Agent' : '被 @ 的成员(不触发 Agent)'"
              @click="mm.type === 'agent' && openAgent({ channelId, agentId: mm.id })"
            >
              <span :class="mm.type === 'agent' ? 'i-tabler-robot' : 'i-tabler-user'" />
              @{{ mm.label || (mm.type === 'agent' ? entities.agentName(channelId, mm.id) : mm.id.slice(0, 8)) }}
            </span>
          </div>

          <!-- 投递台账:这条消息到每个 Agent 的实际送达状态 -->
          <div
            v-if="deliveriesOf(m).length > 0"
            class="ct-deliveries"
          >
            <span
              v-for="d in deliveriesOf(m)"
              :key="d.deliveryId"
              class="ct-delivery"
              :data-tone="DELIVERY_META[d.status]?.tone ?? 'pending'"
              :title="d.error || `deliveryId: ${d.deliveryId}`"
            >
              <span class="cd-dot" />@{{ entities.agentName(channelId, d.targetAgentId) }} · {{ DELIVERY_META[d.status]?.label ?? d.status }}
            </span>
          </div>

          <!-- Agent 回复的来源链:回到被回答的那条提问 -->
          <div
            v-if="m.senderType === 'agent' && m.sourceChatMessageId"
            class="ct-source"
          >
            <span class="i-tabler-link" />
            回答自 {{ m.sourceChatMessageId.slice(0, 8) }}
            <template v-if="m.requesterUserId">
              · 提问者 {{ m.requesterUserId.slice(0, 8) }}
            </template>
          </div>
        </div>
      </div>
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
  background: var(--paper);
}

.ct-head {
  display: flex;
  flex: none;
  gap: 8px;
  align-items: center;
  padding: 8px 14px;
  font-size: 12px;
  color: var(--ink-faint);
  background: var(--paper-raised);
  border-bottom: 1px solid var(--line);
}
.ct-icon { font-size: 14px; }
.ct-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}
.ct-count { font-family: var(--font-mono); font-size: 10.5px; }
.ct-spacer { flex: 1 1 auto; }
.ct-jump {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 2px 8px;
  color: var(--ink-soft);
  cursor: pointer;
  background: var(--paper-deep);
  border-radius: var(--radius-pill);
}
.ct-jump:hover { color: var(--ink); }

.ct-scroll {
  flex: 1 1 auto;
  min-height: 0;
  padding: 10px 14px 16px;
  overflow-y: auto;
}

.ct-earlier {
  display: block;
  margin: 0 auto 10px;
  padding: 4px 12px;
  font-family: var(--font-body);
  font-size: 12px;
  color: var(--ink-faint);
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
}
.ct-earlier:hover { color: var(--ink); border-color: var(--line-strong); }
.ct-earlier:disabled { opacity: 0.5; cursor: default; }

.ct-empty {
  padding: 48px 16px;
  font-size: 13px;
  color: var(--ink-faint);
  text-align: center;
}
.ct-empty-icon { font-size: 26px; }
.ct-empty-sub {
  max-width: 460px;
  margin: 6px auto 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ink-fainter);
}

/* 消息行:头像 + 正文(Slack 声部;人类/Agent 靠头像与角色章区分,不只靠颜色) */
.ct-row {
  display: flex;
  gap: 10px;
  padding: 6px 6px 7px;
  border-radius: var(--radius-panel-sm);
  transition: background var(--transition-fast);
}
.ct-row:hover { background: var(--paper-deep); }
.ct-row.system { opacity: 0.75; }

.ct-ava {
  width: 26px;
  height: 26px;
  margin-top: 1px;
  font-size: 11px;
}

.ct-body {
  flex: 1 1 auto;
  min-width: 0;
}

.ct-meta {
  display: flex;
  gap: 7px;
  align-items: baseline;
  min-width: 0;
}
.ct-sender {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
}
.ct-role {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  padding: 0 5px;
  font-size: 9.5px;
  letter-spacing: 0.06em;
  color: var(--ink-faint);
  text-transform: uppercase;
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}
.ct-role.user { color: var(--ink-soft); }
.ct-role.agent { color: var(--tone-info-dot); border-color: color-mix(in srgb, var(--tone-info-dot) 35%, transparent); }
.ct-time {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-fainter);
}
.ct-reply-btn {
  margin-left: auto;
  padding: 1px 6px;
  font-family: var(--font-body);
  font-size: 11px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-chip);
  opacity: 0;
  transition: opacity var(--transition-fast), color var(--transition-fast);
}
.ct-row:hover .ct-reply-btn { opacity: 1; }
.ct-reply-btn:hover { color: var(--ink); background: var(--paper-raised); }

.ct-replyto {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  margin: 3px 0 0;
  padding: 1px 7px;
  font-size: 11px;
  color: var(--ink-faint);
  background: var(--paper-deep);
  border-left: 2px solid var(--ink-fainter);
  border-radius: var(--radius-chip);
}
.ct-replyto b { color: var(--ink-soft); }

.ct-text {
  margin-top: 2px;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--ink);
  overflow-wrap: anywhere;
  word-break: break-word;
}

.ct-mentions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 4px;
}
.ct-mention-chip {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 1px 7px;
  font-size: 11.5px;
  font-weight: 600;
  border-radius: var(--radius-chip);
}
.ct-mention-chip.agent {
  color: var(--mention-ink, var(--ink));
  cursor: pointer;
  background: var(--mention, var(--paper-deep));
}
.ct-mention-chip.user {
  color: var(--ink-soft);
  cursor: default;
  background: var(--paper-deep);
  border: 1px solid var(--line);
}

/* 投递台账 chip:待投递/已入信箱/已消费/失败/取消 —— 文字与颜色双通道 */
.ct-deliveries {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 4px;
}
.ct-delivery {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 1px 7px;
  font-size: 10.5px;
  border-radius: var(--radius-chip);
  background: var(--paper-deep);
}
.ct-delivery .cd-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.ct-delivery[data-tone='pending'] { color: var(--tone-warning-dot); }
.ct-delivery[data-tone='delivered'] { color: var(--tone-info-dot); }
.ct-delivery[data-tone='consumed'] { color: var(--tone-success-dot); }
.ct-delivery[data-tone='failed'] { color: var(--tone-danger-dot); }
.ct-delivery[data-tone='cancelled'] { color: var(--ink-faint); }

.ct-source {
  display: flex;
  gap: 5px;
  align-items: center;
  margin-top: 3px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-fainter);
}

@media (max-width: 1023.98px) {
  .ct-sender { font-size: 13.5px; }
  .ct-text { font-size: 15px; }
  .ct-reply-btn { opacity: 1; min-height: 32px; }
}
</style>
