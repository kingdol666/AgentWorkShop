<script setup lang="ts">
/**
 * Python 运行时不可用横幅(与 daq 基础设施横幅同语)。
 * 独立成一个单根组件:它在 DOM 上位于概览条之前、页头之后,不属于任何一块。
 */
import type { AmlOverview } from '../../pages/aml/types'

defineProps<{
  overview: AmlOverview | null
}>()
</script>

<template>
  <div
    v-if="overview != null && !overview.runtime.python.ok"
    class="infra-banner"
  >
    <span class="i-tabler-alert-triangle" />
    <span class="txt">{{ $t('aml.k1amlx014') }}<b class="mono">{{ overview.runtime.python.reason ?? '' }}</b></span>
  </div>
</template>

<style scoped src="../../pages/aml/styles.css"></style>
