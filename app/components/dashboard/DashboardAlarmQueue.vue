<script setup lang="ts">
/**
 * 仪表盘告警队列 —— 只读展示 + 确认动作上抛。
 * 数据来自 DAQ 未确认告警(daq.alarms);确认必须走服务端 ackAlarm,
 * 本组件不做本地删除,避免"界面消警、服务端还在"的假闭环。
 */
import type { DaqAlarmRow } from '@/app/composables/workshop/useDaqStream'

const props = defineProps<{ alarms: DaqAlarmRow[] }>()
const emit = defineEmits<{ (e: 'ack', id: string): void }>()

const { t, locale } = useI18n()
const visible = computed(() => props.alarms.slice(0, 4))
const overflow = computed(() => Math.max(props.alarms.length - visible.value.length, 0))

const timeFmt = computed(() => new Intl.DateTimeFormat(locale.value || 'zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
}))
function timeOf(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : timeFmt.value.format(d)
}

function num(v: number | null): string {
  return v == null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(1)
}

function severe(a: DaqAlarmRow): boolean {
  if (a.value == null || a.threshold == null) return false
  const base = Math.max(Math.abs(a.threshold), 1)
  return Math.abs(a.value - a.threshold) / base > 0.1
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
      </span>
    </header>

    <div
      v-if="visible.length > 0"
      class="aq-grid"
    >
      <article
        v-for="a in visible"
        :key="a.id"
        class="aq-card"
        :class="{ severe: severe(a) }"
      >
        <div class="aq-top">
          <i
            class="aq-dot"
            aria-hidden="true"
          />
          <b class="aq-node">{{ a.nodeName }}</b>
          <time class="aq-time mono">{{ timeOf(a.createdAt) }}</time>
        </div>
        <div class="aq-metric">
          <span>{{ a.metric }}</span>
          <b class="mono">{{ num(a.value) }}</b>
          <span class="aq-threshold mono">/ {{ num(a.threshold) }}</span>
        </div>
        <div
          class="aq-rule"
          :title="a.rule"
        >
          {{ a.rule }}
        </div>
        <div class="aq-foot">
          <span class="aq-id mono">#{{ a.id.slice(0, 6) }}</span>
          <button
            type="button"
            class="aq-ack"
            @click="emit('ack', a.id)"
          >
            {{ t('home.shift.ack') }}
          </button>
        </div>
      </article>

      <NuxtLink
        v-if="overflow > 0"
        class="aq-more"
        to="/daq"
      >
        <b class="mono">+{{ overflow }}</b>
        <span>{{ t('home.shift.more') }}</span>
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

.aq-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  padding: 12px;
}

.aq-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 10px 11px 9px;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-left: 3px solid var(--tone-warning-dot);
  border-radius: var(--radius-panel-sm);
}

.aq-card.severe { border-left-color: var(--tone-danger-dot); }

.aq-top {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}

.aq-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  background: var(--tone-warning-dot);
  border-radius: 50%;
}

.aq-card.severe .aq-dot { background: var(--tone-danger-dot); }

.aq-node {
  overflow: hidden;
  font-size: 12px;
  font-weight: 650;
  color: var(--ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.aq-time {
  margin-left: auto;
  font-size: 9.5px;
  color: var(--ink-faint);
}

.aq-metric {
  display: flex;
  gap: 6px;
  align-items: baseline;
  margin-top: 7px;
  font-size: 11px;
  color: var(--ink-soft);
}

.aq-metric b {
  font-size: 19px;
  font-weight: 600;
  line-height: 1;
  color: var(--tone-warning-dot);
}

.aq-card.severe .aq-metric b { color: var(--tone-danger-dot); }

.aq-threshold {
  font-size: 9.5px;
  color: var(--ink-faint);
}

.aq-rule {
  display: -webkit-box;
  margin-top: 4px;
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 9.5px;
  line-height: 1.45;
  color: var(--ink-faint);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.aq-foot {
  display: flex;
  align-items: center;
  margin-top: 8px;
}

.aq-id {
  font-size: 8.5px;
  color: var(--ink-fainter);
}

.aq-ack {
  height: 26px;
  padding: 0 9px;
  margin-left: auto;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--tone-warning-dot);
  cursor: pointer;
  background: var(--tone-warning-bg);
  border: 1px solid color-mix(in srgb, var(--tone-warning-dot) 30%, transparent);
  border-radius: var(--radius-control);
  transition: background var(--transition-fast), border-color var(--transition-fast);
}

.aq-ack:hover {
  background: color-mix(in srgb, var(--tone-warning-bg) 70%, var(--paper-raised));
  border-color: var(--tone-warning-dot);
}

.aq-more {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  font-size: 10.5px;
  color: var(--ink-faint);
  text-decoration: none;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-panel-sm);
}

.aq-more b {
  font-size: 18px;
  color: var(--ink-soft);
}

.aq-more:hover { border-color: var(--ink-faint); color: var(--ink); }

.aq-empty {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 12px 14px;
  font-size: 12px;
  color: var(--ink-soft);
}

.aq-empty b { font-weight: 600; color: var(--ink); }
.aq-empty span:last-child { color: var(--ink-faint); }
.aq-ok { font-size: 16px; color: var(--tone-success-dot); }

@media (max-width: 1200px) {
  .aq-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 640px) {
  .aq-grid { grid-template-columns: 1fr; }
  .aq-empty { flex-wrap: wrap; }
}
</style>
