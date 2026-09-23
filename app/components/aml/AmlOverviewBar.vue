<script setup lang="ts">
/**
 * 概览条:运行时可用性 + 队列/运行中 + 数据集/模型/生产模型计数 + 全量刷新。
 * 只呈现,数据与动作来自页面。
 */
import type { AmlOverview } from '../../pages/aml/types'

defineProps<{
  overview: AmlOverview | null
  overviewError: string
  pythonText: string
  venvText: string
}>()

defineEmits<{
  reload: []
}>()
</script>

<template>
  <section
    v-if="overview"
    class="aw-tile ov-card"
  >
    <div class="ov-row mono">
      <span
        class="ov-item"
        :class="overview.runtime.python.ok ? 'ok' : 'bad'"
      >
        <span :class="overview.runtime.python.ok ? 'i-tabler-circle-check' : 'i-tabler-alert-triangle'" />
        {{ $t('aml.k1amlx003') }} · {{ pythonText }}
      </span>
      <span
        class="ov-item"
        :class="{ ok: overview.runtime.venvReady }"
      >{{ $t('aml.k1amlx006') }} · {{ venvText }}</span>
      <span class="ov-item">{{ $t('aml.k1amlx009') }} <b>{{ overview.runtime.queued }}</b></span>
      <span class="ov-item">{{ $t('aml.k1amlx010') }} <b>{{ overview.runtime.running }}</b></span>
      <span class="sep">·</span>
      <span class="ov-item">{{ $t('aml.k1amlx011') }} <b>{{ overview.counts.datasets }}</b></span>
      <span class="ov-item">{{ $t('aml.k1amlx012') }} <b>{{ overview.counts.models }}</b></span>
      <span
        class="ov-item accent"
        :title="$t('aml.k1amlx013')"
      >{{ $t('aml.k1amlx013') }} <b>{{ overview.counts.productions }}</b></span>
      <button
        class="mini-btn reload"
        @click="$emit('reload')"
      >
        {{ $t('aml.k1amlx017') }}
      </button>
    </div>
  </section>
  <p
    v-else-if="overviewError"
    class="err"
  >
    {{ $t('aml.k1amlx015') }}:{{ overviewError }}
  </p>
</template>

<style scoped src="../../pages/aml/styles.css"></style>
