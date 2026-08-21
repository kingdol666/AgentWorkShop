<script setup lang="ts">
/**
 * 事件聚合块 — open-tag 聊天行声部(.msg 网格:头像列 + 内容列):
 *  - 头部:26px 头像 + 名字 + 类别小标 + 计数/时间;正文落在内容列(块体组件复用);
 *  - 连续同发送者块 compact 分组:隐藏头像与名字(Slack 消息分组),保留左列对齐;
 *  - 悬停工具条(open-tag msg-toolbar):流/消息块可复制全文 / 引用到输入框(经 Composer 总线);
 *  - 各行渲染按 kind 分发到隔离组件 —— 流式更新只触发命中 kind 的组件。
 */
import { computed } from 'vue'
import type { Component } from 'vue'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useComposerBus } from '@/app/composables/workshop/useComposerBus'
import { KIND_META, buildStreamText, type EventBlock } from '@/app/composables/workshop/useEventBlocks'
import ClusterStream from '@/app/components/workshop/blocks/ClusterStream.vue'
import ClusterTool from '@/app/components/workshop/blocks/ClusterTool.vue'
import ClusterStatus from '@/app/components/workshop/blocks/ClusterStatus.vue'
import ClusterLife from '@/app/components/workshop/blocks/ClusterLife.vue'
import ClusterRoute from '@/app/components/workshop/blocks/ClusterRoute.vue'
import ClusterTask from '@/app/components/workshop/blocks/ClusterTask.vue'
import ClusterArtifact from '@/app/components/workshop/blocks/ClusterArtifact.vue'
import ClusterMember from '@/app/components/workshop/blocks/ClusterMember.vue'
import ClusterMemory from '@/app/components/workshop/blocks/ClusterMemory.vue'
import ClusterError from '@/app/components/workshop/blocks/ClusterError.vue'
import ClusterOther from '@/app/components/workshop/blocks/ClusterOther.vue'

const props = defineProps<{
  block: EventBlock
  turnStart?: boolean
  /** 连续同发送者紧凑分组(隐藏头像/名字,Slack 式) */
  compact?: boolean
}>()

const entities = useEntitiesStore()
const { quote } = useComposerBus()
const cid = computed(() => props.block.events[0]?.channelId ?? '')

const time = computed(() => props.block.firstAt.slice(11, 19))
const agentLabel = computed(() => {
  const id = props.block.agentId
  if (!id) return 'system'
  return entities.agentName(cid.value, id)
})
/**
 * 人类发送者名(a2a.message 且 from 空 + x-aw-from-label):
 * 头部以"用户章"呈现 —— Slack 声部里人也是会话一方。
 */
const humanLabel = computed(() => {
  if (props.block.agentId) return null
  const e = props.block.events[0]
  if (!e || e.type !== 'a2a.message') return null
  const meta = (e.payload as { metadata?: Record<string, unknown> }).metadata ?? {}
  const label = meta['x-aw-from-label']
  return typeof label === 'string' && label ? label : null
})
/** 头像章首字母(名字或 id 首字符;system 用 cpu 图标) */
const agentInitial = computed(() => {
  const id = props.block.agentId
  if (!id) return ''
  const name = entities.agentName(cid.value, id)
  return (name || id).charAt(0).toUpperCase()
})

const meta = computed(() => KIND_META[props.block.kind])

/** kind → tone 色点(koda tone 系统) */
const KIND_TONE: Record<string, string> = {
  stream: 'var(--tone-info-dot)',
  tool: 'var(--tone-neutral-dot)',
  status: 'var(--tone-neutral-dot)',
  life: 'var(--tone-success-dot)',
  route: 'var(--tone-info-dot)',
  task: 'var(--tone-info-dot)',
  artifact: 'var(--tone-success-dot)',
  member: 'var(--tone-retry-dot)',
  memory: 'var(--tone-warning-dot)',
  error: 'var(--tone-danger-dot)',
  other: 'var(--tone-neutral-dot)',
}
const kindTone = computed(() => KIND_TONE[props.block.kind] ?? 'var(--tone-neutral-dot)')

/** 消费完整性观测:块首事件 seq + 块内事件数(浏览器测试对账用) */
const firstSeq = computed(() => props.block.events[0]?.seq ?? 0)

const KIND_COMPONENT: Record<string, Component> = {
  stream: ClusterStream,
  tool: ClusterTool,
  status: ClusterStatus,
  life: ClusterLife,
  route: ClusterRoute,
  task: ClusterTask,
  artifact: ClusterArtifact,
  member: ClusterMember,
  memory: ClusterMemory,
  error: ClusterError,
  other: ClusterOther,
}
const body = computed(() => KIND_COMPONENT[props.block.kind] ?? ClusterOther)

/** 工具条可用正文:流块取累计文本;路由块取消息 parts(供复制/引用) */
const toolbarText = computed(() => {
  if (props.block.kind === 'stream') {
    const t = buildStreamText(props.block).trim()
    return t || null
  }
  if (props.block.kind === 'route') {
    const t = props.block.events
      .map((e) => {
        const parts = (e.payload as { parts?: Array<{ text?: string }> }).parts ?? []
        return parts.map(p => p.text ?? '').join('\n').trim()
      })
      .filter(Boolean)
      .join('\n')
    return t || null
  }
  return null
})

const copied = ref(false)
const copyAll = async (): Promise<void> => {
  const t = toolbarText.value
  if (!t) return
  try {
    await navigator.clipboard.writeText(t)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1400)
  }
  catch { /* 剪贴板不可用时静默 */ }
}

/** 引用到 Composer:块正文以 `> ` 前缀注入输入框 */
const quoteToComposer = (): void => {
  const t = toolbarText.value
  if (t) quote(t)
}
</script>

<template>
  <section
    class="event-block"
    :class="{ 'turn-start': turnStart, compact }"
    :data-kind="block.kind"
    :data-settled="block.settled ? 'true' : 'false'"
    :data-covered="block.coveredBy ? 'true' : 'false'"
    :data-seq="firstSeq"
    :data-events="block.events.length"
    :data-folded="block.folded"
  >
    <span
      class="agent-avatar"
      :class="{ 'is-agent': !!block.agentId, 'is-human': !!humanLabel }"
      :title="humanLabel ?? agentLabel"
    >
      <span
        v-if="humanLabel"
        class="i-tabler-user system-icon"
      />
      <span
        v-else-if="!block.agentId"
        class="i-tabler-cpu system-icon"
      />
      <template v-else>{{ agentInitial }}</template>
    </span>

    <div class="eb-main">
      <header
        v-show="!compact"
        class="block-head"
      >
        <span class="agent-name">{{ humanLabel ?? agentLabel }}</span>
        <span class="kind">
          <span
            class="kind-dot"
            :style="{ background: kindTone }"
          />{{ meta.label }}
        </span>
        <span class="head-right">
          <span
            v-if="block.folded > 0"
            class="folded"
            title="与 delta 增量重复的内容已合并为一段"
          >去重 {{ block.folded }}</span>
          <span
            v-if="block.events.length > 1"
            class="merged"
          >×{{ block.events.length }}</span>
          <span class="time">{{ time }}</span>
        </span>
        <!-- 悬停工具条:复制全文 / 引用到输入框(open-tag msg-toolbar) -->
        <span
          v-if="toolbarText"
          class="eb-toolbar"
        >
          <button
            type="button"
            class="eb-tool"
            :title="copied ? '已复制' : '复制全文'"
            @click="copyAll"
          >
            <span :class="copied ? 'i-tabler-check' : 'i-tabler-copy'" />
          </button>
          <button
            type="button"
            class="eb-tool"
            title="引用到输入框"
            @click="quoteToComposer"
          >
            <span class="i-tabler-quote" />
          </button>
        </span>
      </header>

      <component
        :is="body"
        :block="block"
        class="eb-body"
      />
    </div>
  </section>
</template>

<style scoped>
.event-block {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  column-gap: 10px;
  padding: 2px 8px 2px 0;
  margin: 0 8px 3px 6px;
  border-left: 2px solid color-mix(in srgb, var(--ink) 9%, transparent);
  transition: border-color 0.15s ease, background 0.15s ease;
  animation: block-in 0.22s cubic-bezier(0.2, 0.6, 0.3, 1);
}

/* turn 边界:不同 agent 的新回合开始 → 加大间距 + 顶部 hairline */
.event-block.turn-start {
  margin-top: 12px;
  border-top: 1px solid var(--divider-hair);
  padding-top: 7px;
}
@keyframes block-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.event-block:hover {
  border-left-color: color-mix(in srgb, var(--g-sky) 80%, transparent);
  background: var(--hover-tint);
}
.event-block[data-kind='stream']:not([data-settled='true']) {
  border-left-color: color-mix(in srgb, var(--g-sky) 55%, transparent);
}
.event-block[data-kind='error'] { border-left-color: var(--tone-danger-dot); }
.event-block[data-covered='true'] { opacity: 0.72; }

/* 头像列:agent = 粉彩径向渐变,human/system = surface */
.agent-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-top: 1px;
  font-family: var(--font-body);
  font-size: 11px;
  font-weight: 600;
  color: var(--ink);
  background: var(--paper-deep);
  border-radius: 50%;
}
.agent-avatar.is-agent {
  color: var(--ink);
  background: radial-gradient(circle at 30% 28%, var(--g-mint), var(--g-lav) 70%, var(--g-sky));
}
.agent-avatar.is-human {
  color: var(--ink-soft);
  background: var(--paper-deep);
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.agent-avatar .system-icon {
  font-size: 13px;
  line-height: 1;
}

/* 紧凑分组:隐藏头像与头部,保留列对齐(Slack 连续消息) */
.event-block.compact .agent-avatar {
  visibility: hidden;
  height: 0;
  margin-top: 0;
}
.event-block.compact {
  margin-top: -1px;
}

.eb-main {
  min-width: 0;
}

.block-head {
  position: relative;
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 20px;
  padding-bottom: 1px;
  font-family: var(--font-body);
}

.agent-name {
  overflow: hidden;
  max-width: 180px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kind-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-right: 4px;
  vertical-align: 1px;
  border-radius: 50%;
}
.kind {
  font-size: 9.5px;
  letter-spacing: 0.1em;
  color: var(--ink-faint);
}
.head-right {
  display: flex;
  flex: 1 1 auto;
  gap: 6px;
  align-items: center;
  justify-content: flex-end;
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-faint);
}
.folded {
  padding: 0 4px;
  color: var(--tone-success-dot);
  background: color-mix(in srgb, var(--tone-success-dot) 12%, transparent);
  border-radius: var(--radius-chip);
}
.merged {
  padding: 0 4px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  border-radius: var(--radius-chip);
}
.time { flex: 0 0 auto; width: 50px; text-align: right; }

/* 悬停工具条:头部右侧浮出(复制/引用) */
.eb-toolbar {
  position: absolute;
  top: -4px;
  right: 56px;
  z-index: 5;
  display: inline-flex;
  gap: 2px;
  padding: 1px;
  opacity: 0;
  pointer-events: none;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
  transition: opacity var(--transition-fast);
}
.event-block:hover .eb-toolbar {
  opacity: 1;
  pointer-events: auto;
}
.eb-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  font-size: 12px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 4px;
  transition: color var(--transition-fast), background var(--transition-fast);
}
.eb-tool:hover {
  color: var(--ink);
  background: var(--paper-deep);
}

/* 块体组件统一缩进归零(布局由本壳层的头像列接管;子组件自带 padding-left 归拢到内容列起点) */
.eb-body {
  padding-left: 2px !important;
  margin-top: 1px;
}
</style>
