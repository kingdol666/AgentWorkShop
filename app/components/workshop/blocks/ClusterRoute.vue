<script setup lang="ts">
/**
 * 消息路由块 — Slack/open-tag 聊天声部:
 *  - 每条 a2a.message 渲染为一条聊天行:@目标 pill(可点击打开 Agent 抽屉)+
 *    类型徽章(任务派发/实时注入/协作消息…)+ 时间 + 正文(mdLite + @提及高亮);
 *  - 人类发送(from 空 + x-aw-from-label)→ 头部显示发送者名,行内带用户章;
 *  - agent↔agent 协作、lead→worker 任务派发共用同一渲染面(@ 语义统一)。
 */
import { computed, ref } from 'vue'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { mdLiteMentions, type EventBlock, type MentionMember } from '@/app/composables/workshop/useEventBlocks'

const props = defineProps<{ block: EventBlock }>()
const entities = useEntitiesStore()

/** @pill 点击 → 控制台打开 Agent 抽屉(w/[wsId] provide;缺省安全兜底) */
const openAgent = inject<(target: { channelId: string, agentId: string }) => void>(
  'aw:open-agent',
  () => {},
)

interface RouteRow {
  seq: number
  i: number
  channelId: string
  from: string
  fromLabel: string
  to: string
  kind: { icon: string, label: string, tone: string }
  text: string
  time: string
  /** 回执语义(open-tag action receipt 移植):需对方回复 / 是对某消息的回复 */
  requireReply: boolean
  inReplyTo: string
}

const rows = computed<RouteRow[]>(() =>
  props.block.events.map((e, i) => {
    const meta = (e.payload as { metadata?: Record<string, unknown> }).metadata ?? {}
    const fromId = typeof meta['x-aw-from-agent'] === 'string' ? meta['x-aw-from-agent'] as string : ''
    const fromLabel = typeof meta['x-aw-from-label'] === 'string' ? meta['x-aw-from-label'] as string : ''
    const toId = typeof meta['x-aw-target-agent'] === 'string' ? meta['x-aw-target-agent'] as string : ''
    const priority = meta['x-aw-msg-priority'] === 'immediate' ? 'immediate' : 'task'
    const taskKind = typeof meta['x-aw-task-kind'] === 'string' ? meta['x-aw-task-kind'] as string : ''
    const kind = taskKind === 'assign'
      ? { icon: 'i-tabler-send', label: '任务派发', tone: 'assign' }
      : taskKind === 'cancel'
        ? { icon: 'i-tabler-circle-x', label: '取消通知', tone: 'notice' }
        : taskKind === 'child-completed'
          ? { icon: 'i-tabler-circle-check', label: '子任务完成', tone: 'notice' }
          : priority === 'immediate'
            ? { icon: 'i-tabler-bolt', label: '实时注入', tone: 'immediate' }
            : { icon: 'i-tabler-message', label: '协作消息', tone: 'peer' }
    const parts = (e.payload as { parts?: Array<{ text?: string }> }).parts ?? []
    const replyRaw = meta['x-aw-in-reply-to']
    return {
      seq: e.seq,
      i,
      channelId: e.channelId,
      from: fromId,
      fromLabel,
      to: toId,
      kind,
      text: parts.map(p => p.text ?? '').join('\n').trim(),
      time: e.at.slice(11, 19),
      requireReply: meta['x-aw-require-reply'] === 'true',
      inReplyTo: typeof replyRaw === 'string' ? replyRaw : '',
    }
  }),
)

const channelId = computed(() => props.block.events[0]?.channelId ?? '')

/** 本 channel 成员表(@提及高亮 + pill 名称解析) */
const members = computed<MentionMember[]>(() =>
  (entities.agents[channelId.value] ?? []).map(a => ({ agentId: a.agentId, name: a.name })),
)

const nameOf = (id: string): string =>
  id ? entities.agentName(channelId.value, id) : ''

const initials = (name: string) => name.trim().charAt(0).toUpperCase()

const rendered = computed(() => rows.value.map(r => mdLiteMentions(r.text, members.value)))

/** @pill / 正文内提及点击(事件委托) */
const onBodyClick = (ev: MouseEvent): void => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('.md-mention, .who-pill')
  if (!el) return
  const agentId = el.dataset.agentId
  if (agentId) openAgent({ channelId: channelId.value, agentId })
}

const expanded = ref(false)
const MAX = 4
const shown = computed(() => (expanded.value ? rows.value : rows.value.slice(0, MAX)))
const shownRendered = computed(() => (expanded.value ? rendered.value : rendered.value.slice(0, MAX)))
const hasMore = computed(() => rows.value.length > MAX)
</script>

<template>
  <div
    class="route-cluster"
    @click="onBodyClick"
  >
    <div
      v-for="(r, ri) in shown"
      :key="r.seq"
      class="chat-row"
    >
      <!-- 元行:发送者 → @目标 + 类型徽章 + 时间 -->
      <div class="chat-meta">
        <span
          v-if="r.fromLabel && !r.from"
          class="human-chip"
          :title="`人类发送者:${r.fromLabel}`"
        >
          <span class="i-tabler-user" />
          {{ r.fromLabel }}
        </span>
        <button
          v-if="r.from"
          type="button"
          class="who-pill from"
          :data-agent-id="r.from"
          :title="`查看 ${nameOf(r.from)}`"
        >
          <span class="aw-avatar is-agent who-ava">{{ initials(nameOf(r.from)) }}</span>
          @{{ nameOf(r.from) }}
        </button>
        <span
          v-if="r.to"
          class="to-arrow"
          aria-hidden="true"
        >→</span>
        <button
          v-if="r.to"
          type="button"
          class="who-pill"
          :data-agent-id="r.to"
          :title="`查看 ${nameOf(r.to)}`"
        >
          @{{ nameOf(r.to) }}
        </button>
        <span
          v-else
          class="who-broadcast"
        >(广播)</span>
        <span
          class="route-badge"
          :data-tone="r.kind.tone"
        ><span :class="r.kind.icon" />{{ r.kind.label }}</span>
        <!-- 回执徽章(open-tag action receipt):需回复 = 等待对方响应;回执 = 对某消息的回复关联 -->
        <span
          v-if="r.requireReply"
          class="route-badge receipt"
          title="发送方要求回复:接收方须回执执行结果"
        ><span class="i-tabler-message-reply" />需回复</span>
        <span
          v-if="r.inReplyTo"
          class="route-badge reply-link aw-mono"
          :title="`回复关联消息 ${r.inReplyTo}`"
        >↩ {{ r.inReplyTo.slice(0, 8) }}</span>
        <span class="chat-time aw-mono">{{ r.time }}</span>
      </div>
      <!-- 正文:markdown-lite + @提及 pill -->
      <div
        v-if="r.text"
        class="chat-body prose"
        v-html="shownRendered[ri]"
      />
    </div>
    <button
      v-if="hasMore"
      class="more-btn"
      @click="expanded = !expanded"
    >
      {{ expanded ? '收起' : `全部 ${rows.length} 条` }}
    </button>
  </div>
</template>

<style scoped>
.route-cluster {
  padding: 1px 0 5px;
}

.chat-row {
  margin-bottom: 6px;
  padding: 7px 12px 8px;
  background: color-mix(in srgb, var(--paper-deep) 42%, transparent);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm);
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.chat-row:hover {
  background: color-mix(in srgb, var(--paper-deep) 62%, transparent);
  border-color: var(--line-strong);
}

.chat-row:last-of-type {
  margin-bottom: 0;
}

/* 元行:@pill / 徽章 / 时间 */
.chat-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-bottom: 4px;
}

.who-pill {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  padding: 1px 8px 1px 3px;
  font-family: var(--font-body);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--mention-ink);
  cursor: pointer;
  background: var(--mention);
  border: 0;
  border-radius: var(--radius-pill);
  transition: background var(--transition-fast);
}

.who-pill:hover {
  background: color-mix(in srgb, var(--mention) 70%, var(--g-peach));
}

.who-ava {
  width: 18px;
  height: 18px;
  font-size: 9px;
}

.to-arrow {
  font-size: 11px;
  color: var(--ink-fainter);
}

.who-broadcast {
  font-size: 11px;
  color: var(--ink-faint);
}

.human-chip {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  padding: 0 7px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border-radius: var(--radius-chip);
}

.route-badge {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 0 6px;
  font-size: 9.5px;
  border-radius: var(--radius-chip);
}

.route-badge[data-tone='assign'] { color: var(--tone-info-dot); background: color-mix(in srgb, var(--tone-info-dot) 12%, transparent); }
.route-badge[data-tone='immediate'] { color: var(--tone-warning-dot); background: color-mix(in srgb, var(--tone-warning-dot) 15%, transparent); }
.route-badge[data-tone='notice'] { color: var(--tone-success-dot); background: color-mix(in srgb, var(--tone-success-dot) 12%, transparent); }
.route-badge[data-tone='peer'] { color: var(--tone-retry-dot); background: color-mix(in srgb, var(--tone-retry-dot) 14%, transparent); }

/* 回执徽章:需回复(琥珀,注意级)/ 回复关联(低视觉权重,等宽短 id 可对账) */
.route-badge.receipt {
  color: var(--tone-warning-dot);
  background: color-mix(in srgb, var(--tone-warning-dot) 14%, transparent);
}
.route-badge.reply-link {
  font-size: 9.5px;
  color: var(--ink-fainter);
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}

.chat-time {
  margin-left: auto;
  font-size: 9.5px;
  color: var(--ink-fainter);
}

/* 正文:聊天正文排版(无高度封顶,消息流自然展开) */
.chat-body {
  padding: 1px 0 0 2px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink);
  white-space: normal;
  word-break: break-word;
}

.prose :deep(p) { margin: 0 0 6px; }
.prose :deep(p:last-child) { margin-bottom: 0; }
.prose :deep(code) {
  padding: 0.5px 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--paper-deep);
  border-radius: var(--radius-chip);
}
.prose :deep(pre) {
  max-width: 100%;
  margin: 4px 0;
  padding: 6px 9px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--paper-deep);
  border-radius: var(--radius-chip);
}
.prose :deep(b) { font-weight: 600; }

.more-btn {
  margin-top: 4px;
  padding: 1px 10px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
  transition: color var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
}

.more-btn:hover {
  color: var(--ink);
  background: var(--hover-tint);
  border-color: var(--ink-fainter);
}
</style>
