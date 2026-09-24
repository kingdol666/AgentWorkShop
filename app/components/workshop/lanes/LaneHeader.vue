<script setup lang="ts">
/**
 * 泳道列头 —— 第一行身份(头像章/名称/徽标),第二行状态摘要 + 操作簇。
 * 纯呈现 + 事件上抛:中断/移除的 loading 态由父级(AgentLanesView)持有,
 * 终端会话按 agentId 从父级解析后经 terminal prop 传入。
 */
import type { TerminalSessionDto } from '@/app/composables/workshop/useWorkshopApi'
import { laneHue, laneInitial, TERM_DOT, termBadge } from '@/app/composables/workshop/useChannelTerminals'
import type { AgentView } from '@/app/stores/workshop/entities'

const props = defineProps<{
  agent: AgentView
  terminal: TerminalSessionDto | undefined
  stopping: string | null
  removing: string | null
}>()

const emit = defineEmits<{
  'open-terminal': [agent: AgentView]
  'edit': [agent: AgentView]
  'stop': [agentId: string, name: string]
  'remove': [agentId: string, name: string]
}>()

const agent = computed(() => props.agent)

/**
 * §8 监督/watchdog 徽标:
 *  - `watchdog N`:监督回合已触发 watchdog(观察信号,不是取消);
 *  - `决策 <kind>`:Lead 最后决策(wait/guide/reassign/cancel/complete)。
 * 试图从 state='IDLE' 但 lastDecisionKind 仍存在推断"已落定"的历史决策。
 */
const supervisionBadge = computed(() => {
  const s = agent.value?.supervision
  if (!s) return null
  const live = s.state === 'RUNNING' || s.state === 'WATCHDOG_SIGNALED' || s.state === 'WAITING_FOR_RESULT'
  if (s.watchdogCount > 0 || s.state === 'WATCHDOG_SIGNALED') {
    return { kind: 'watchdog' as const, text: `watchdog ${s.watchdogCount}`, title: `监督观察阈值已触发(${s.watchdogAt ?? '-'});这是观察信号,不是取消` }
  }
  if (live) return { kind: 'running' as const, text: 'supervising', title: `监督回合进行中(attempt=${s.attemptId?.slice(0, 8) ?? '-'},tick=${s.snapshotRevision ?? '-'})` }
  if (s.lastDecisionKind) return { kind: 'decision' as const, text: `决策 ${s.lastDecisionKind}`, title: `Lead 最后决策:${s.lastDecisionKind}(${s.completedAt ?? '-'})` }
  return null
})

/**
 * §8 Harness 连续性徽标:
 *  - persistent harness 显示复用回合数与 pid/session;
 *  - 发生过重建时显示 last restart reason(§6.2)。
 */
const continuityBadge = computed(() => {
  const c = agent.value?.continuity
  if (!c) return null
  const parts: string[] = [c.continuityMode === 'persistent' ? 'persistent' : 'per_turn']
  if (c.pid) parts.push(`pid ${c.pid}`)
  if (c.reuseCount > 0) parts.push(`reuse ${c.reuseCount}`)
  const title = [
    `continuity=${c.continuityMode}`,
    c.pid ? `pid=${c.pid}` : 'pid=-',
    c.sessionId ? `session=${c.sessionId}` : 'session=-',
    `reuse=${c.reuseCount}`,
    c.lastRestartReason ? `last restart=${c.lastRestartReason}${c.lastRestartAt ? ` @${c.lastRestartAt}` : ''}` : 'last restart=-',
    `restarts=${c.restartCount}`,
  ].join(' · ')
  return { text: parts.join(' · '), restart: c.lastRestartReason, title, error: !!c.lastRestartReason }
})
</script>

<template>
  <div class="lane-head">
    <!-- 第一行:身份(头像章 + 名称 + 中性徽标);名称为弹性吸收项,任意宽度截断不遮挡 -->
    <div class="head-top">
      <span class="lane-ava">
        <span :style="{ '--av': laneHue(agent.agentId) }">{{ laneInitial(agent.name) }}</span>
        <span
          class="lane-state"
          :class="agent.state"
        />
      </span>
      <span
        class="lane-name"
        :title="agent.name"
      >{{ agent.name }}</span>
      <span
        v-if="agent.config?.systemPromptPrefix"
        class="lane-chip"
        :title="$t('agentLanesView.k107s4am001')"
      >
        {{ $t('agentLanesView.k3xycu022') }}
      </span>
      <span
        class="lane-role"
        :class="agent.role"
      >
        {{ agent.role }}
      </span>
      <span
        v-if="termBadge(terminal)"
        class="term-badge"
        :title="$t('agentLanesView.k1wn2vmt036', { p0: terminal?.pid })"
      >
        <span
          class="term-dot"
          :style="{ background: TERM_DOT[termBadge(terminal)!.color] ?? 'var(--tone-neutral-dot)' }"
        />
        {{ termBadge(terminal)!.text }}
      </span>
      <!-- §8:Harness 连续性(continuity mode / pid / reuse / last restart reason) -->
      <span
        v-if="continuityBadge"
        class="cont-badge"
        :class="{ restart: continuityBadge.error }"
        :title="continuityBadge.title"
      >
        {{ continuityBadge.text }}
      </span>
      <!-- §8:监督 watchdog / Lead 最后决策 -->
      <span
        v-if="supervisionBadge"
        class="sup-badge"
        :class="supervisionBadge.kind"
        :title="supervisionBadge.title"
      >
        {{ supervisionBadge.text }}
      </span>
    </div>
    <!-- 第二行:状态摘要 + 操作簇(常驻可见;hairline 分隔破坏性操作) -->
    <div class="head-sub">
      <span class="lane-meta">
        <template v-if="agent.state === 'busy' && agent.currentTaskTitle">
          {{ agent.currentTaskTitle }}
          <span
            v-if="agent.currentTaskProgress != null"
            class="lane-progress"
          >{{ agent.currentTaskProgress }}%</span>
        </template>
        <template v-else>{{ agent.state }} · Q{{ agent.queued ?? 0 }}</template>
      </span>
      <div class="lane-actions">
        <a-button
          v-if="agent.harness === 'omp'"
          size="small"
          type="primary"
          ghost
          class="lane-term"
          :title="$t('agentLanesView.k1884q17002')"
          @click="emit('open-terminal', agent)"
        >
          <span class="i-tabler-terminal-2" />
          <span class="term-label">{{ $t('agentLanesView.k4588s023') }}</span>
        </a-button>
        <a-button
          size="small"
          type="text"
          class="lane-edit"
          :title="$t('agentLanesView.k1pgd3tf003')"
          @click="emit('edit', agent)"
        >
          <span class="i-tabler-edit" />
        </a-button>
        <span class="actions-divider" />
        <a-popconfirm
          :title="$t('agentLanesView.k1l029kf037', { p0: agent.name })"
          :ok-text="$t('common.stop')"
          :cancel-text="$t('common.cancel')"
          @confirm="emit('stop', agent.agentId, agent.name)"
        >
          <a-button
            size="small"
            type="text"
            class="lane-stop"
            :loading="stopping === agent.agentId"
            :title="$t('agentLanesView.hitlStopTitle')"
          >
            <span class="i-tabler-player-stop" />
          </a-button>
        </a-popconfirm>
        <a-popconfirm
          :title="$t('agentLanesView.kt3n27m038', { p0: agent.name })"
          :ok-text="$t('common.remove')"
          :cancel-text="$t('common.cancel')"
          @confirm="emit('remove', agent.agentId, agent.name)"
        >
          <a-button
            size="small"
            type="text"
            danger
            class="lane-remove"
            :loading="removing === agent.agentId"
          >
            <span class="i-tabler-x" />
          </a-button>
        </a-popconfirm>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 双层头部:第一行身份(头像/名/徽标),第二行状态摘要 + 操作簇 ——
   单行方案在 320px 列内固定元素 ~360px 必然挤压遮挡,分层后各行均有余量 */
.lane-head {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 9px;
  font-size: 13px;
  border-bottom: 1px solid var(--line);
}
.head-top {
  display: flex;
  gap: 7px;
  min-width: 0;
  align-items: center;
}
/* 身份头像章:稳定身份色 + 白首字母;右下状态 pip(busy 呼吸 / stopped 红 / idle 静灰) */
.lane-ava {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  font-size: 11px;
  font-weight: 600;
  color: var(--on-av);
  border-radius: var(--radius-panel-sm);
}
.lane-ava > span:first-child {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: var(--av, var(--av-fallback));
  border-radius: var(--radius-panel-sm);
}
.lane-state {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 8px;
  height: 8px;
  background: var(--ink-fainter);
  border: 1.5px solid var(--paper-raised);
  border-radius: 50%;
}
.lane-state.busy {
  background: var(--tone-live-dot);
  animation: lane-breathe 1.9s ease-in-out infinite;
}
.lane-state.stopped { background: var(--tone-danger-dot); }
@keyframes lane-breathe {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .lane-state.busy { animation: none; opacity: 0.9; }
}
.lane-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 中性小徽标:场景/角色/终端 —— 发丝线 chip 或墨色填充,不再叠 antd 多色 tag */
.lane-chip {
  flex: 0 0 auto;
  padding: 0 6px;
  font-size: 9.5px;
  letter-spacing: 0.04em;
  line-height: 15px;
  color: var(--ink-faint);
  background: transparent;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
}
.lane-role {
  flex: 0 0 auto;
  padding: 0 7px;
  font-size: 9.5px;
  letter-spacing: 0.05em;
  line-height: 16px;
  text-transform: uppercase;
  border-radius: var(--radius-pill);
}
.lane-role.lead {
  color: var(--on-accent);
  background: var(--accent);
}
.lane-role.worker {
  color: var(--ink-soft);
  border: 1px solid var(--line-strong);
}
.term-badge {
  display: inline-flex;
  gap: 4px;
  flex: 0 0 auto;
  align-items: center;
  padding: 0 6px;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 15px;
  color: var(--ink-faint);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
}
.term-badge .term-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}
/* §8 连续性/监督徽标(与终端徽标同构;restart/watchdog 用警示色提示但不打断) */
.cont-badge,
.sup-badge {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  max-width: 140px;
  padding: 0 6px;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 9.5px;
  line-height: 15px;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
}
.cont-badge.restart { color: var(--tone-danger-dot); border-color: color-mix(in srgb, var(--tone-danger-dot) 40%, transparent); }
.sup-badge.watchdog { color: var(--tone-warn-dot, var(--tone-info-dot)); border-color: color-mix(in srgb, var(--tone-info-dot) 40%, transparent); }
.sup-badge.decision { color: var(--ink-soft); }
.sup-badge.running { color: var(--tone-live-dot); border-color: color-mix(in srgb, var(--tone-live-dot) 40%, transparent); }
.head-sub {
  display: flex;
  gap: 8px;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
}
.lane-meta {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 10.5px;
  font-family: var(--font-mono);
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 执行中进度:busy 时展示当前任务标题 + 进度 %(leader 对 worker 推进的实时可见性) */
.lane-progress {
  display: inline-flex;
  align-items: center;
  padding: 0 5px;
  margin-left: 4px;
  color: var(--tone-info-dot);
  background: color-mix(in srgb, var(--tone-info-dot) 10%, transparent);
  border-radius: var(--radius-pill);
}
/* 操作簇:统一浅底胶囊分组,常驻可见(hover 提亮);hairline 分隔破坏性操作 */
.lane-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 5px;
  align-items: center;
  padding: 2px;
  background: var(--hover-tint);
  border-radius: var(--radius-chip);
}
.lane-actions .ant-btn {
  font-size: 12px;
  opacity: 0.78;
  transition: opacity 0.15s ease;
}
.lane-head:hover .lane-actions .ant-btn { opacity: 1; }
.actions-divider {
  flex: 0 0 auto;
  width: 1px;
  height: 14px;
  margin-inline: 2px;
  background: color-mix(in srgb, currentColor 16%, transparent);
}
.lane-term { padding-inline: 7px; }
.lane-edit,
.lane-stop,
.lane-remove { padding-inline: 5px; }
.term-label {
  display: none;
  margin-inline-start: 5px;
}
/* 窄泳道渐进披露(<300px 场景徽标让位;<260px 终端徽标让位;操作簇永不隐藏) */
@container (min-width: 380px) {
  .term-label { display: inline; }
}
@container (max-width: 300px) {
  .lane-chip { display: none; }
}
@container (max-width: 260px) {
  .term-badge { display: none; }
}

/* ── 窄屏(≤1023):泳道从"并排仪表"改为"一次一泳道"的横向卡片流 ──
   桌面 min-width 240px 的泳道在 390px 下并排 = 每列都被压到极限;
   改为 88% 宽 + scroll-snap:一屏一路信号,横扫切换成员。 */
@media (max-width: 1023.98px) {
  .lane-meta {
    font-size: 11.5px;
  }

  .lane-name {
    font-size: 14px;
  }

  .lane-chip,
  .lane-role,
  .term-badge {
    font-size: 11.5px;
    line-height: 18px;
  }

  .lane-actions .ant-btn {
    min-width: 40px;
    min-height: 40px;
  }
}
</style>
