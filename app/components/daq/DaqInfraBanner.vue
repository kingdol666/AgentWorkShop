<script setup lang="ts">
/**
 * 基础设施降级横幅(MQTT/Timescale 不可达:在线采集停用 + 一键重连)。
 * 状态与重连动作(含在飞标志)由页面下发。
 */
import type { DaqInfraState } from '@/app/composables/workshop/useDaqStream'

defineProps<{
  infra: DaqInfraState | undefined
  reconnecting: boolean
}>()

const emit = defineEmits<{ reconnect: [] }>()
</script>

<template>
  <div
    v-if="infra?.degraded"
    class="infra-banner"
  >
    <span class="i-tabler-alert-triangle" />
    <span class="txt">{{ infra.warning }}</span>
    <button
      class="pill-btn"
      :disabled="reconnecting"
      @click="emit('reconnect')"
    >
      {{ reconnecting ? $t('daq.k1ld43ur094') : $t('daq.kzg9805110') }}
    </button>
  </div>
</template>
