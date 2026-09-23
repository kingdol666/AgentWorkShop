<script setup lang="ts">
/**
 * 仪表盘图 1 —— 实时工况趋势(多通道量程归一化)。
 * 纯呈现:option 由页面(useDashboardCharts)装配下发;空态判据同理由页面给定。
 */
import type { PropType } from 'vue'
import type { EChartsOption } from 'echarts'
import AwChart from '@/app/components/AwChart.vue'

/** option 用运行时声明(与 AwChart.vue 同构):EChartsOption 是复杂类型别名,
 *  类型式 defineProps 推不出运行时类型(会退化成 type: null),这里显式给 Object。 */
defineProps({
  option: { type: Object as PropType<EChartsOption>, required: true },
  /** 趋势是否真有数值可画(采样被活动批次门控时缓冲里只有 null 占位) */
  hasData: { type: Boolean, required: true },
})

const { t } = useI18n()
</script>

<template>
  <section class="aw-bench span8">
    <header class="aw-bench-hd">
      <h3 class="aw-bench-title">
        {{ t('home.charts.trend') }}
      </h3>
      <small class="aw-bench-sub">{{ t('home.charts.trendSub') }}</small>
      <span class="aw-bench-meta">
        <span>{{ t('home.trendY') }}</span>
      </span>
    </header>
    <ClientOnly>
      <!-- 空态判据必须看「有没有**数值**」,而不是「缓冲里有没有点」:
            采样由活动批次门控(无开跑产线时不采样),此时缓冲里可能有携带 null 的
            占位点 —— 旧写法据此判为"有数据",于是跳过 graphic 提示,
            渲染出一张只有坐标系+图例、X 轴回落到 00:00~24:00 的空图。
            那比一句明确的空态更难理解(实测被评审直接判为"趋势面全是空的")。 -->
      <AwChart
        v-if="hasData"
        :option="option"
        class="chart h280"
      />
      <div
        v-else
        class="aw-empty chart h280"
      >
        <p class="aw-empty-title">
          {{ t('home.trendWaiting') }}
        </p>
        <p class="aw-empty-sub">
          {{ t('home.trendNeedRun') }}
        </p>
      </div>
    </ClientOnly>
  </section>
</template>

<style scoped>
/* ---------- 大屏图阵:本面板占 8/12 列 ----------
   ⚠️ .span8 / .chart / .h280 与其余 dashboard 面板的 scoped 块有意重复:
   scoped 样式编译成 .x[data-v-<scopeId>],必须与拥有该元素的标记同处一个组件,
   不能外移成公共 css(逐字复制,改一处同步所有面板)。 */
.span8 { grid-column: span 8; }
@media (max-width: 1100px) {
  .span8, .span4 { grid-column: span 12; }
}
.chart { width: 100%; }
.h280 { height: 280px; }

/* 面板题注:一句话说明这张图在看什么;窄屏让位给读数本身
   ⚠️ 与 DashboardHarnessPanel / DashboardFleetPanel 的 scoped 块有意重复(同上)。 */
.aw-bench-sub {
  overflow: hidden;
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 1500px) {
  .aw-bench-sub { display: none; }
}
</style>
