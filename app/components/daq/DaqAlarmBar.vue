<script setup lang="ts">
/**
 * 未确认报警条(S5)—— 边缘触发产生 / 轮询收敛,确认后立即消失。
 * 报警列表与确认动作由页面(store + ackOne)下发。
 */
import type { DaqAlarmRow } from '@/app/composables/workshop/useDaqStream'

defineProps<{ alarms: DaqAlarmRow[] }>()

const emit = defineEmits<{ ack: [id: string] }>()
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
    <div class="alarm-scroll">
      <span
        v-for="a in alarms"
        :key="a.id"
        class="alarm-item"
        :title="$t('daq.k1esc143', { p0: a.escalation })"
      >
        <b>{{ a.nodeName }}</b>
        <span class="mono dim">{{ a.metric }}</span>
        <span class="mono">{{ a.value }} {{ a.rule === 'lt-min' ? '<' : '>' }} {{ a.threshold }}</span>
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
