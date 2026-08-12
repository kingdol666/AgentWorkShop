<script setup lang="ts">
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
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

// 按需注册 ECharts 模块（.client 组件：仅客户端执行，SSR 端被 Nuxt stub 替换）
use([
  CanvasRenderer,
  BarChart,
  LineChart,
  PieChart,
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
