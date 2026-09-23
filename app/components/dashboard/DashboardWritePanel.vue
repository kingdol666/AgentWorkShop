<script setup lang="ts">
/**
 * 仪表盘图 4 —— 写控制成功率(gauge)。
 * 纯呈现:option 由页面(useDashboardCharts)装配下发;面板头 meta 的
 * 「写入总数 / 失败数」与 gauge 的取值同源(同一个 controller 计数)。
 */
import type { PropType } from 'vue'
import type { EChartsOption } from 'echarts'
import AwChart from '@/app/components/AwChart.vue'

/** option 用运行时声明(与 AwChart.vue 同构):EChartsOption 是复杂类型别名,
 *  类型式 defineProps 推不出运行时类型(会退化成 type: null),这里显式给 Object。 */
defineProps({
  option: { type: Object as PropType<EChartsOption>, required: true },
  writesTotal: { type: Number, required: true },
  writesFailed: { type: Number, required: true },
})

const { t } = useI18n()
</script>

<template>
  <section class="aw-bench span4">
    <header class="aw-bench-hd">
      <h3 class="aw-bench-title">
        {{ t('home.charts.writeCtl') }}
      </h3>
      <span class="aw-bench-meta">
        <span><b>{{ writesTotal }}</b> {{ t('home.writesFailed') }} {{ writesFailed }}</span>
      </span>
    </header>
    <ClientOnly>
      <AwChart
        :option="option"
        class="chart h240"
      />
    </ClientOnly>
  </section>
</template>

<style scoped>
/* ---------- 大屏图阵:本面板占 4/12 列 ----------
   ⚠️ .span4 / .chart / .h240 与其余 dashboard 面板的 scoped 块有意重复:
   scoped 样式编译成 .x[data-v-<scopeId>],必须与拥有该元素的标记同处一个组件,
   不能外移成公共 css(逐字复制,改一处同步所有面板)。 */
.span4 { grid-column: span 4; }
@media (max-width: 1100px) {
  .span8, .span4 { grid-column: span 12; }
}
.chart { width: 100%; }
.h240 { height: 240px; }
</style>
