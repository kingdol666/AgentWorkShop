<script setup lang="ts">
/**
 * 页头:标题 + 三枚运行时徽标(PYTHON / VENV / UV)。
 * 徽标状态由页面以 props 下发,组件自身不持有副本。
 */
import type { AmlEnvStatus, AmlOverview } from '../../pages/aml/types'

defineProps<{
  overview: AmlOverview | null
  env: AmlEnvStatus | null
  pythonText: string
  venvText: string
  uvText: string
}>()
</script>

<template>
  <div class="aw-page-head">
    <div>
      <p class="aw-kicker">
        AGENTWORKSHOP / AML STUDIO
      </p>
      <h1>{{ $t('aml.k1amlx001') }}</h1>
      <p class="sub">
        {{ $t('aml.k1amlx002') }}
      </p>
    </div>
    <div class="badges mono">
      <span
        class="badge"
        :class="{ bad: overview != null && !overview.runtime.python.ok }"
        :title="overview?.runtime.python.reason ?? ''"
      >PYTHON · {{ pythonText }}</span>
      <span
        class="badge"
        :class="{ bad: overview != null && !overview.runtime.venvReady }"
      >VENV · {{ venvText }}</span>
      <span
        class="badge"
        :class="{ bad: env != null && !env.uv.ok }"
        :title="env?.uv.reason ?? env?.uv.path ?? ''"
      >UV · {{ uvText }}</span>
    </div>
  </div>
</template>

<style scoped src="../../pages/aml/styles.css"></style>
