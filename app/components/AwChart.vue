<script setup lang="ts">
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, GaugeChart, LineChart, PieChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components'
import VChart from 'vue-echarts'
import { computed } from 'vue'
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
  // 冷启动"等待首帧"文字挂在 graphic 上;不注册会静默丢图并打控制台错误
  GraphicComponent,
])

/** Warm Editorial 图表色序(替代 ECharts 默认荧光绿/蓝;与 main.css --chart-* 同源) */
const EDITORIAL_PALETTE = ['#4a6b57', '#8aa07c', '#c9a26a', '#b3714f', '#6f8296', '#4e4e4e']

const props = defineProps({
  option: {
    type: Object as PropType<EChartsOption>,
    required: true,
  },
})

// 未显式给 color 的图表统一走编辑色板;给了的尊重页面意图
const merged = computed<EChartsOption>(() => ({
  color: EDITORIAL_PALETTE,
  ...props.option,
}))
</script>

<template>
  <VChart
    v-bind="$attrs"
    :option="merged"
    autoresize
  />
</template>
