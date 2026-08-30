<script setup lang="ts">
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, GaugeChart, LineChart, PieChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components'
import VChart from 'vue-echarts'
import type { PropType } from 'vue'
import type { EChartsOption } from 'echarts'

// 按需注册 ECharts 模块(必须在 <ClientOnly> 内使用:canvas 仅客户端可渲染)
use([
  CanvasRenderer,
  BarChart,
  LineChart,
  PieChart,
  GaugeChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
])

defineProps({
  option: {
    type: Object as PropType<EChartsOption>,
    required: true,
  },
})
</script>

<template>
  <VChart
    v-bind="$attrs"
    :option="option"
    autoresize
  />
</template>
