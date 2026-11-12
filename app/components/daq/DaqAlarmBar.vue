<script setup lang="ts">
/**
 * 未确认报警条(S5)—— 边缘触发产生 / 轮询收敛,确认后立即消失。
 * 报警列表与确认动作由页面(store + ackOne)下发。
 *
 * 第二轮 E7:这里曾显示 `演示·…(HTTP)·CodOut temp-tc 318.6 > 300`,
 * 与仪表盘的人读化告警行割裂。改为 设备 + 通道 + 规则句,metric 代码只进 title。
 */
import type { DaqAlarmRow } from '@/app/composables/workshop/useDaqStream'
import { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import { alarmAge, alarmRuleView, splitAlarmNode } from '@/app/utils/alarm-presentation'

defineProps<{ alarms: DaqAlarmRow[], acking?: boolean }>()

const emit = defineEmits<{ ack: [id: string], ackAll: [] }>()

const { t } = useI18n()
const daq = useDaqStream()
const now = ref(Date.now())
const ageTimer = setInterval(() => {
  now.value = Date.now()
}, 30_000)
onBeforeUnmount(() => clearInterval(ageTimer))

function unitOf(a: DaqAlarmRow): string {
  const u = daq.nodes.find(n => n.id === a.nodeId)?.unit ?? ''
  return u ? ` ${u}` : ''
}

function nodeOf(a: DaqAlarmRow): { device: string, channel: string } {
  return splitAlarmNode(a.nodeName)
}

function ruleText(a: DaqAlarmRow): string {
  const v = alarmRuleView(a.rule, a.value, a.threshold)
  const u = unitOf(a)
  const rel = v.relation === 'high' ? t('home.alarm.high') : v.relation === 'low' ? t('home.alarm.low') : a.rule
  return `${rel} ${v.threshold}${u}`
}

function ageText(a: DaqAlarmRow): string {
  const age = alarmAge(a.createdAt, now.value)
  if (age.unit === 'now') return t('home.alarm.now')
  if (age.unit === 'minute') return t('home.alarm.minutes', { p0: age.n })
  if (age.unit === 'hour') return t('home.alarm.hours', { p0: age.n })
  if (age.unit === 'day') return t('home.alarm.days', { p0: age.n })
  return ''
}
</script>

<template>
  <div
    v-if="alarms.length"
    class="alarm-bar"
  >
    <span class="bar-label">
      <span class="i-tabler-bell-ringing bell" />
      {{ $t('daq.k1alarm141') }}
      <b class="mono">{{ alarms.length }}</b>
    </span>
    <!-- 批量确认:报警风暴时逐条点击成本线性(交互宪法 §2-6) -->
    <button
      class="mini-btn ack-all"
      :disabled="acking"
      :title="$t('daq.ackAllTip')"
      @click="emit('ackAll')"
    >
      <span class="i-tabler-checks" />
      {{ $t('daq.ackAll') }}
    </button>
    <div class="alarm-scroll">
      <span
        v-for="a in alarms"
        :key="a.id"
        class="alarm-item"
        :title="`#${a.id} · ${a.metric} · ${a.nodeName}`"
      >
        <b>{{ nodeOf(a).device }}</b>
        <span
          v-if="nodeOf(a).channel"
          class="alarm-ch mono"
        >{{ nodeOf(a).channel }}</span>
        <span class="mono val">{{ alarmRuleView(a.rule, a.value, a.threshold).value }}{{ unitOf(a) }}</span>
        <span class="alarm-rule">{{ ruleText(a) }}</span>
        <small class="alarm-age">{{ ageText(a) }}</small>
        <small
          v-if="a.escalation > 0"
          class="esc mono"
        >+{{ a.escalation }}</small>
        <button
          class="mini-btn ack"
          @click="emit('ack', a.id)"
        >
          {{ $t('daq.k1ack142') }}
        </button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.ack-all {
  display: inline-flex;
  flex: none;
  gap: 4px;
  align-items: center;
}

@media (max-width: 900px) {
  /* 批量确认是次要动作:保持内容宽度,不占满整条报警带 */
  .ack-all {
    align-self: flex-start;
    width: auto;
    min-height: 40px;
  }
}

.alarm-ch {
  padding: 0 4px;
  font-size: 9.5px;
  color: var(--ink-soft);
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: 4px;
}

.alarm-rule {
  font-size: 10.5px;
  color: var(--ink-soft);
}

.alarm-age {
  font-size: 9.5px;
  color: var(--ink-faint);
}

.val {
  font-size: 12px;
  font-weight: 600;
  color: var(--tone-danger-dot);
}
</style>
