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
import { KIND_META, buildStreamText, blockTier, agentHueColor, type EventBlock } from '@/app/composables/workshop/useEventBlocks'
import { formatLocalClock } from '@/app/composables/workshop/useLocalTime'
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
  /** 进场编排(open-tag motion):实时新块带 60ms burst stagger;历史/重建块直接显示 */
  enterStage?: { enter: boolean, delay: number }
}>()

const entities = useEntitiesStore()
const { quote } = useComposerBus()
const cid = computed(() => props.block.events[0]?.channelId ?? '')

const time = computed(() => formatLocalClock(props.block.firstAt))
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

/** 身份色(agentId 哈希 → 稳定色相;与泳道头/提及卡同一来源,全站不再另造配色) */
const avColor = computed(() =>
  props.block.agentId ? agentHueColor(props.block.agentId) : undefined,
)

const meta = computed(() => KIND_META[props.block.kind])

/** 头像点击 → 打开 Agent 抽屉(与 @pill 同入口) */
const openAgent = inject<(target: { channelId: string, agentId: string }) => void>(
  'aw:open-agent',
  () => {},
)
const onAvatarClick = (): void => {
  if (props.block.agentId) openAgent({ channelId: cid.value, agentId: props.block.agentId })
}

/** 发送方身份字幕(open-tag msg-role):lead/worker · harness,agent 行的身份描述 */
const roleLabel = computed(() => {
  const id = props.block.agentId
  if (!id) return ''
  const a = (entities.agents[cid.value] ?? []).find(x => x.agentId === id)
  if (!a) return 'agent'
  const role = a.role === 'lead' ? 'lead' : 'worker'
  const harness = a.harness ?? ''
  return harness ? `${role} · ${harness}` : role
})

/**
 * 注意力档位(open-tag deliveryTier 移植):terminal(终局产出)= 成功色左缘 +
 * 加重名字;attention(等待回应/错误)= 琥珀左缘 + 脉搏点;silent(过程噪声)=
 * 轻微收敛。视觉层级随"该不该打断人"伸缩,状态不只靠颜色(chip 文本仍在)。
 */
const tier = computed(() => blockTier(props.block.events))

/** 头像状态 pip(open-tag av-status 移植):agent 实时状态叠层(busy 暖橙呼吸/idle 静灰) */
const agentState = computed(() => {
  const id = props.block.agentId
  if (!id) return null as 'idle' | 'busy' | 'stopped' | null
  const a = (entities.agents[cid.value] ?? []).find(x => x.agentId === id)
  return (a?.state ?? null) as 'idle' | 'busy' | 'stopped' | null
})

/** 流式运行指示(open-tag msg-agent-state 移植):未落定流块 + agent busy → "运行中" */
const runningNow = computed(() =>
  props.block.kind === 'stream'
  && !props.block.settled
  && agentState.value === 'busy')

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
    :class="{ 'turn-start': turnStart, compact, 'enter': enterStage?.enter }"
    :style="enterStage?.enter ? { '--d': `${enterStage.delay}ms` } : undefined"
    :data-kind="block.kind"
    :data-tier="tier"
    :data-settled="block.settled ? 'true' : 'false'"
    :data-covered="block.coveredBy ? 'true' : 'false'"
    :data-seq="firstSeq"
    :data-events="block.events.length"
    :data-folded="block.folded"
  >
    <button
      type="button"
      class="agent-avatar"
      :class="{ 'is-agent': !!block.agentId, 'is-human': !!humanLabel, 'clickable': !!block.agentId }"
      :title="humanLabel ?? `${agentLabel}${roleLabel ? ` · ${roleLabel}` : ''}`"
      :style="avColor ? { '--av': avColor } : undefined"
      @click="onAvatarClick"
    >
      <span
        v-if="humanLabel"
        class="i-tabler-user system-icon"
      />
      <span
        v-else-if="!block.agentId"
        class="i-tabler-cpu system-icon"
      />
      <template v-else>
        {{ agentInitial }}
      </template>
      <!-- 状态 pip:busy 呼吸圈 / idle 静点(open-tag av-status) -->
      <span
        v-if="block.agentId && agentState"
        class="av-status"
        :class="agentState"
        :title="agentState === 'busy' ? '运行中' : agentState === 'stopped' ? '已停止' : '空闲'"
      />
    </button>

    <div class="eb-main">
      <header
        v-show="!compact"
        class="block-head"
      >
        <span class="agent-name">{{ humanLabel ?? agentLabel }}</span>
        <span
          v-if="roleLabel"
          class="role-label"
        >{{ roleLabel }}</span>
        <span
          v-if="tier === 'attention'"
          class="tier-attention"
          :title="$t('eventBlock.kc918hn001')"
        ><span class="i-tabler-alert-circle" />{{ $t('eventBlock.k3wmcv4004') }}</span>
        <span class="head-right">
          <!-- 流式运行指示(open-tag msg-agent-state):当前 agent 正在产出 -->
          <span
            v-if="runningNow"
            class="running-chip"
          ><span class="running-dot" />{{ $t('eventBlock.k3vp67i005') }}</span>
          <span
            v-if="block.folded > 0"
            class="folded"
            :title="$t('eventBlock.kcugdph002')"
          >{{ $t('eventBlock.k3xk4t006') }} {{ block.folded }}</span>
          <span
            v-if="block.events.length > 1"
            class="merged"
          >×{{ block.events.length }}</span>
          <span class="kind-chip">{{ meta.label }}</span>
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
            :title="$t('eventBlock.kknq700003')"
            @click="quoteToComposer"
          >
            <span class="i-tabler-quote" />
          </button>
        </span>
      </header>

      <!-- 紧凑态副作用:紧凑态隐藏头部后,悬停显示抹去的时间(chat 侧厢时间轴) -->
      <span
        v-if="compact"
        class="ghost-time"
      >{{ time.slice(0, 5) }}</span>

      <component
        :is="body"
        :block="block"
        class="eb-body"
      />
    </div>
  </section>
</template>

<style scoped>
/* Slack 聊天行:行跨度经头像列成组;默认无左缘,仅终局/注意级/流式/错误插色缘 */
.event-block {
  position: relative;
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  column-gap: 11px;
  padding: 5px 10px 4px 12px;
  margin: 0;
  transition: background 0.15s ease;
}

.event-block:hover {
  background: var(--hover-tint);
  border-radius: 4px;
}

/* 进场编排(open-tag motion charter):仅实时新块,60ms burst stagger;
 * 历史/过滤重建直接显示(reduced-motion 直显) */
.event-block.enter {
  animation: block-in 0.32s var(--ease-out-quart) backwards;
  animation-delay: var(--d, 0ms);
}
@media (prefers-reduced-motion: reduce) {
  .event-block.enter { animation: none; }
}

/* turn 边界:不同 agent 的新回合 → 加大间距 + 顶部 hairline(角色回合切换) */
.event-block.turn-start {
  margin-top: 13px;
  padding-top: 9px;
  border-top: 1px solid var(--line);
}
.event-block.turn-start.compact {
  margin-top: 0;
  padding-top: 5px;
  border-top: 0;
}

.event-block[data-kind='stream']:not([data-settled='true']) {
  background: color-mix(in srgb, var(--ink) 2.5%, transparent);
  border-radius: 4px;
}
/* 仅注意/错误级接入色缘(兑色低饱和度;终局不加彩色缘,靠名字加粗表意) */
.event-block[data-tier='attention'] {
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--tone-warning-dot) 55%, transparent);
}
.event-block[data-kind='error'] {
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--tone-danger-dot) 70%, transparent);
}
.event-block[data-covered='true'] { opacity: 0.72; }

.event-block[data-tier='terminal'] .agent-name { font-weight: 700; }
.event-block[data-tier='silent'] { opacity: 0.88; }
.event-block[data-tier='silent']:hover { opacity: 1; }

.tier-attention {
  display: inline-flex;
  gap: 3px;
  align-items: center;
  padding: 0 5px;
  font-size: 9px;
  color: var(--tone-warning-dot);
  background: color-mix(in srgb, var(--tone-warning-dot) 13%, transparent);
  border-radius: var(--radius-chip);
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

/* 头像列:agent = 身份色(agentId 哈希 → --av,同源色相,白字首字母);
   human/system = surface(open-tag av 尺寸档 36/28) */
.agent-avatar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  min-width: 30px;
  margin-top: 0;
  padding: 0;
  font-family: var(--font-body);
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
  background: var(--paper-deep);
  border: 0;
  border-radius: 50%;
}
.agent-avatar.clickable {
  cursor: pointer;
  transition: transform var(--transition-fast) var(--im-spring), box-shadow var(--transition-fast);
}
.agent-avatar.clickable:hover {
  transform: scale(1.06);
  box-shadow: 0 0 0 var(--radius-chip) transparent, 0 3px 10px rgb(12 10 9 / 16%);
}
.agent-avatar.is-agent {
  color: var(--on-av);
  background: var(--av, var(--av-fallback));
}
.agent-avatar.is-human {
  color: var(--ink-soft);
  background: var(--paper-deep);
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.agent-avatar .system-icon {
  font-size: 15px;
  line-height: 1;
}

/* 状态 pip:头像右下 8px 叠层(open-tag av-status);busy 呼吸,stopped 灰,idle 淡 */
.av-status {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 8px;
  height: 8px;
  background: var(--ink-fainter);
  border: 1.5px solid var(--paper-raised);
  border-radius: 50%;
}
.av-status.busy {
  background: var(--tone-live-dot);
  animation: av-breathe 1.9s ease-in-out infinite;
}
.av-status.stopped { background: var(--tone-danger-dot); }
@keyframes av-breathe {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .av-status.busy { animation: none; opacity: 0.9; }
}

/* 紧凑分组:隐藏头像与头部,保留列对齐(Slack 连续消息;ghost 时间月台悬浮显) */
.event-block.compact .agent-avatar {
  visibility: hidden;
  height: 0;
  margin-top: 0;
}
.event-block.compact {
  padding-top: 2px;
  padding-bottom: 2px;
}
.event-block.compact + .event-block.compact {
  margin-top: -2px;
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
  max-width: 220px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 身份字幕(open-tag msg-role):lead/worker · harness,灰调不与之争关注 */
.role-label {
  overflow: hidden;
  font-family: var(--font-body);
  font-size: 10.5px;
  color: var(--ink-fainter);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 类别小标:中性等宽纯文本(无边框/无彩色点 —— 类别是元语不是状态,
   彩色语义只留给 attention/error 边缘) */
.kind-chip {
  display: inline-flex;
  align-items: center;
  padding: 0 2px;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.06em;
  line-height: 14px;
  color: var(--ink-fainter);
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
  color: var(--ink-faint);
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  border-radius: var(--radius-chip);
}
.merged {
  padding: 0 4px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  border-radius: var(--radius-chip);
}
.time {
  flex: 0 0 auto;
  width: 60px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* 紧凑态月台时间:悬停行时右侧浮现(Slack 紧凑组的时间轴补偿;仅住行头) */
.ghost-time {
  position: absolute;
  top: 3px;
  right: 10px;
  z-index: 2;
  padding: 0 5px;
  font-family: var(--font-mono);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-fainter);
  pointer-events: none;
  opacity: 0;
  background: var(--paper-raised);
  border-radius: var(--radius-chip);
  transition: opacity var(--transition-fast);
}
.event-block.compact:hover .ghost-time {
  opacity: 1;
}

/* 流式运行指示(open-tag msg-agent-state):暖橙呼吸点 + 词 */
.running-chip {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  color: var(--ink-faint);
}
.running-chip .running-dot {
  width: 6px;
  height: 6px;
  background: var(--tone-live-dot);
  border-radius: 50%;
  animation: av-breathe 1.9s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .running-chip .running-dot { animation: none; opacity: 0.9; }
}

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
  border-radius: var(--radius-chip);
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
