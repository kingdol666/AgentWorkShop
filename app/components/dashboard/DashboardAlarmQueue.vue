<script setup lang="ts">
/**
 * 仪表盘告警队列 —— 只读展示 + 确认动作上抛。
 * 数据来自 DAQ 未确认告警(daq.alarms);确认必须走服务端 ackAlarm,
 * 本组件不做本地删除,避免"界面消警、服务端还在"的假闭环。
 *
 * 第二轮 E1:卡片不再外露 UUID / metric 代码 / 规则代码 ——
 * 设备·通道拆开显示,规则句按 i18n 组装,相对时间一眼判断新旧。
 */
import type { DaqAlarmRow } from '@/app/composables/workshop/useDaqStream'
import { alarmAge, alarmRuleView, splitAlarmNode } from '@/app/utils/alarm-presentation'

const props = defineProps<{
  alarms: DaqAlarmRow[]
  /** nodeId → 工程单位(节点清单同源;告警行本身不带 unit) */
  units?: Record<string, string>
}>()
const emit = defineEmits<{ (e: 'ack', id: string): void }>()

const { t } = useI18n()
/** 相对时间每 30s 重算,避免“5 分钟前”停住不动 */
const now = ref(Date.now())
const ageTimer = setInterval(() => {
  now.value = Date.now()
}, 30_000)
onBeforeUnmount(() => clearInterval(ageTimer))
const visible = computed(() => props.alarms.slice(0, 4))
const overflow = computed(() => Math.max(props.alarms.length - visible.value.length, 0))

function unitOf(a: DaqAlarmRow): string {
  const u = props.units?.[a.nodeId] ?? ''
  return u ? ` ${u}` : ''
}

function severe(a: DaqAlarmRow): boolean {
  if (a.value == null || a.threshold == null) return false
  const base = Math.max(Math.abs(a.threshold), 1)
  return Math.abs(a.value - a.threshold) / base > 0.1
}

function nodeOf(a: DaqAlarmRow): { device: string, channel: string } {
  return splitAlarmNode(a.nodeName)
}

function ruleText(a: DaqAlarmRow): string {
  const v = alarmRuleView(a.rule, a.value, a.threshold)
  const u = unitOf(a)
  if (v.relation === 'high') return `${t('home.alarm.high')} ${v.threshold}${u}`
  if (v.relation === 'low') return `${t('home.alarm.low')} ${v.threshold}${u}`
  return `${v.value}${u} · ${a.rule}`
}

function ageText(a: DaqAlarmRow): string {
  const age = alarmAge(a.createdAt, now.value)
  if (age.unit === 'now') return t('home.alarm.now')
  if (age.unit === 'minute') return t('home.alarm.minutes', { p0: age.n })
  if (age.unit === 'hour') return t('home.alarm.hours', { p0: age.n })
  if (age.unit === 'day') return t('home.alarm.days', { p0: age.n })
  return ''
}

function fullTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}
</script>

<template>
  <section class="aq aw-bench">
    <header class="aw-bench-hd">
      <h2 class="aw-bench-title">
        {{ t('home.shift.queue') }}
      </h2>
      <small class="aw-bench-sub">{{ t('home.shift.queueSub') }}</small>
      <span class="aw-bench-meta">
        <b
          role="status"
          aria-live="polite"
        >{{ alarms.length }}</b>
        <NuxtLink
          v-if="alarms.length > 0"
          class="aq-all"
          to="/daq"
        >{{ t('home.shift.more') }}</NuxtLink>
      </span>
    </header>

    <div
      v-if="visible.length > 0"
      class="aq-list"
    >
      <article
        v-for="a in visible"
        :key="a.id"
        class="aq-item"
        :class="{ severe: severe(a) }"
        :title="`#${a.id} · ${a.metric}${a.escalation > 0 ? ` · +${a.escalation}` : ''}`"
      >
        <div class="aq-ident">
          <i
            class="aq-dot"
            aria-hidden="true"
          />
          <div class="aq-copy">
            <div class="aq-title">
              <b class="aq-device">{{ nodeOf(a).device }}</b>
              <span
                v-if="nodeOf(a).channel"
                class="aq-channel"
              >{{ nodeOf(a).channel }}</span>
              <time
                class="aq-time mono"
                :datetime="a.createdAt"
                :title="fullTime(a.createdAt)"
              >{{ ageText(a) }}</time>
            </div>
            <div class="aq-rule">
              {{ ruleText(a) }}
            </div>
          </div>
        </div>
        <div class="aq-reading">
          <b class="mono">{{ alarmRuleView(a.rule, a.value, a.threshold).value }}</b>
          <span
            v-if="unitOf(a)"
            class="aq-unit"
          >{{ unitOf(a).trim() }}</span>
        </div>
        <span
          v-if="a.escalation > 0"
          class="aq-esc"
        >{{ t('home.alarm.escalated', { p0: a.escalation }) }}</span>
        <button
          type="button"
          class="aq-ack"
          data-testid="alarm-ack"
          @click="emit('ack', a.id)"
        >
          {{ t('home.shift.ack') }}
        </button>
      </article>

      <NuxtLink
        v-if="overflow > 0"
        class="aq-more"
        to="/daq"
      >
        <span class="mono">+{{ overflow }}</span>
        <span>{{ t('home.shift.more') }}</span>
        <span class="i-tabler-arrow-right" />
      </NuxtLink>
    </div>

    <div
      v-else
      class="aq-empty"
      role="status"
      aria-live="polite"
    >
      <span
        class="i-tabler-circle-check aq-ok"
        aria-hidden="true"
      />
      <b>{{ t('home.shift.empty') }}</b>
      <span>{{ t('home.shift.emptySub') }}</span>
    </div>
  </section>
</template>

<style scoped>
.aq {
  margin-bottom: var(--gap-block);
}

/* 队列是“待办清单”而不是卡片画廊:一行一条,读值右对齐,操作固定在行尾。
   一条告警时也不会留下整块空白。 */
.aq-list {
  padding: 2px 0;
}

.aq-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  gap: 8px 14px;
  align-items: center;
  padding: 10px 16px;
  border-bottom: 1px solid var(--divider-hair);
}

.aq-item:last-child { border-bottom: 0; }

.aq-item.severe {
  background: linear-gradient(90deg, color-mix(in srgb, var(--tone-danger-bg) 55%, transparent), transparent 60%);
}

.aq-ident {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  min-width: 0;
}

.aq-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  margin-top: 6px;
  background: var(--tone-warning-dot);
  border-radius: 50%;
}

.aq-item.severe .aq-dot { background: var(--tone-danger-dot); }

.aq-copy { min-width: 0; }

.aq-title {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 7px;
  align-items: center;
}

.aq-device {
  font-size: 13px;
  font-weight: 650;
  color: var(--ink);
}

.aq-channel {
  padding: 0 5px;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.6;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: 4px;
}

.aq-time {
  font-size: 10.5px;
  color: var(--ink-faint);
}

.aq-rule {
  margin-top: 2px;
  overflow: hidden;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ink-soft);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aq-reading {
  display: flex;
  gap: 3px;
  align-items: baseline;
  font-variant-numeric: tabular-nums;
}

.aq-reading b {
  font-size: 19px;
  font-weight: 600;
  line-height: 1;
  color: var(--tone-warning-dot);
}

.aq-item.severe .aq-reading b { color: var(--tone-danger-dot); }

.aq-unit {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--ink-soft);
}

.aq-esc {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--tone-warning-dot);
}

.aq-ack {
  min-width: 56px;
  min-height: 32px;
  padding: 0 11px;
  font-size: 11px;
  font-weight: 600;
  color: var(--tone-warning-dot);
  cursor: pointer;
  background: var(--tone-warning-bg);
  border: 1px solid color-mix(in srgb, var(--tone-warning-dot) 30%, transparent);
  border-radius: var(--radius-control);
  transition: background var(--transition-fast), border-color var(--transition-fast), transform 120ms var(--ease-out);
}

.aq-ack:hover {
  background: color-mix(in srgb, var(--tone-warning-bg) 70%, var(--paper-raised));
  border-color: var(--tone-warning-dot);
}

.aq-ack:active { transform: scale(0.97); }

.aq-ack:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.aq-all {
  margin-left: 8px;
  font-size: 10.5px;
  color: var(--ink-faint);
  text-decoration: none;
}

.aq-all:hover { color: var(--ink); text-decoration: underline; }

.aq-more {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 9px 16px;
  font-size: 11px;
  color: var(--ink-faint);
  text-decoration: none;
  border-top: 1px solid var(--divider-hair);
}

.aq-more .mono { font-size: 12px; color: var(--ink-soft); }
.aq-more:hover { color: var(--ink); background: var(--paper-deep); }

.aq-empty {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 12px 16px;
  font-size: 12px;
  color: var(--ink-soft);
}

.aq-empty b { font-weight: 600; color: var(--ink); }
.aq-empty span:last-child { color: var(--ink-faint); }
.aq-ok { font-size: 16px; color: var(--tone-success-dot); }

@media (max-width: 640px) {
  .aq-item {
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px 10px;
    padding: 11px 12px;
  }

  .aq-ident { grid-column: 1; grid-row: 1; }
  .aq-reading { grid-row: 2; grid-column: 1; margin-left: 15px; }
  .aq-ack { grid-row: 1 / 3; grid-column: 2; min-height: 44px; }
  .aq-esc { display: none; }
  .aq-rule { white-space: normal; }
  .aq-empty { flex-wrap: wrap; }
}
</style>
