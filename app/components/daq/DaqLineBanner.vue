<script setup lang="ts">
/**
 * 产线门控横幅 —— 筛选到具体产线 → 展示该产线运行态/产品/Recipe(待机可直达产线管理);
 * 未筛选具体产线 → 全局门控提示。文案与链接目标全部由页面下发。
 */
import type { LineRunState, LineView } from '#shared/dcw-protocol'

defineProps<{
  loaded: boolean
  /** 筛选命中的产线(未筛选到具体产线时 null → 回退全局门控提示) */
  filteredLine: LineView | null
  filteredLineState: LineRunState | null
  /** 是否存在任意运行中的产线(全局提示判定) */
  anyLineActive: boolean
}>()
</script>

<template>
  <div
    v-if="loaded && filteredLine && filteredLineState"
    class="infra-banner"
    :class="{ good: filteredLineState.active }"
  >
    <span :class="filteredLineState.active ? 'i-tabler-circle-check' : 'i-tabler-info-circle'" />
    <span class="txt">
      <template v-if="filteredLineState.active">
        {{ $t('daq.k3ktxbr085') }}{{ filteredLine.name }}」{{ $t('daq.k15lvw0o105') }}<b>{{ filteredLineState.productName }}</b> · Recipe:<b>{{ filteredLineState.recipeName }}</b>
        <small class="mono">{{ $t('daq.k400lb086') }} {{ filteredLineState.runId?.slice(0, 8) }} · {{ $t('daq.k3zkt2106') }} {{ filteredLineState.startedAt?.slice(11, 19) }} {{ $t('daq.k69vag8108') }} {{ filteredLineState.taggedSamples }} {{ $t('daq.k4118o092') }}</small>
      </template>
      <template v-else>
        {{ $t('daq.k3ktxbr085') }}{{ filteredLine.name }}」{{ $t('daq.k12uge2o107') }}</template>
    </span>
    <NuxtLink
      class="pill-btn"
      :to="`/dcw/${filteredLine.id}`"
    >
      {{ filteredLineState.active ? $t('daq.k1ukoy0v093') : $t('daq.k1cg78i8109') }}
    </NuxtLink>
  </div>
  <div
    v-else-if="loaded && !anyLineActive"
    class="infra-banner"
  >
    <span class="i-tabler-info-circle" />
    <span class="txt">{{ $t('daq.k19onw5w013') }}<NuxtLink to="/dcw">{{ $t('daq.k1b2tk5c014') }}</NuxtLink>{{ $t('daq.k1u9wnlg015') }}</span>
  </div>
</template>
