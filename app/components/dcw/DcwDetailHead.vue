<script setup lang="ts">
/**
 * 产线控制台页头 —— 产线色片 / 名称 / 描述 + 节点·产品·配方三枚计数徽章。
 * 计数由页面派生后下发(本组件不复制任何 store 状态)。
 */
import type { LineView } from '#shared/dcw-protocol'

defineProps<{
  line: LineView | undefined
  lineId: string
  nodesCount: number
  productsCount: number
  recipesCount: number
}>()
</script>

<template>
  <div class="aw-page-head">
    <div>
      <p class="aw-kicker">
        <span
          class="line-chip"
          :style="{ background: line?.color ?? '#3aa0ff' }"
        />AGENTWORKSHOP / LINE / {{ line?.name ?? lineId }}
      </p>
      <h1>{{ line?.name ?? $t('dcwDetail.k1b2snna151') }} · {{ $t('dcwDetail.k1l0iow1137') }}</h1>
      <p class="sub">
        {{ line?.description || $t('dcwDetail.kzcbfki152') }}
      </p>
    </div>
    <div class="badges mono">
      <span class="badge">{{ $t('dcwDetail.k45uio082') }} {{ nodesCount }}</span>
      <span class="badge">{{ $t('dcwDetail.k3waz1025') }} {{ productsCount }}</span>
      <span class="badge">{{ $t('dcwDetail.k48grv027') }} {{ recipesCount }}</span>
    </div>
  </div>
</template>

<style scoped>
/* 共享工具类随标记搬入本组件:scoped 的 data-v 归属不跨组件,
   凡在多组件出现的规则(.mono/.dim/.inp/.mini-btn/.modal-mask/.banner/.nodes-table/.sec-label/.st-pill 等)
   在此各持一份逐字相同的副本,以保证每个元素命中的声明集与拆分前一致,同时不引入任何全局选择器。 */

.line-chip {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 8px;
  vertical-align: -1px;
  border-radius: 3px;
  box-shadow: 0 0 10px currentColor;
}

h1 { margin: 2px 0 4px; font-size: 30px; font-weight: 400; letter-spacing: -0.015em; }

.sub { margin: 0; font-size: 12.5px; opacity: 0.6; }
.mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

.badges { display: flex; gap: 8px; }
.badge { padding: 3px 10px; font-size: 11.5px; letter-spacing: 0.05em; color: var(--ink-soft); border: 1px solid var(--line-strong); border-radius: var(--radius-chip); }

@media (max-width: 640px) {
  h1 { font-size: 22px; }
}
</style>
