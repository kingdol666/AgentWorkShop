<script setup lang="ts">
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, GaugeChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
} from 'echarts/components'
import VChart from 'vue-echarts'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { PropType } from 'vue'
import type { EChartsOption } from 'echarts'
import type { SetOptionOpts } from 'echarts/core'

// 按需注册 ECharts 模块(必须在 <ClientOnly> 内使用:canvas 仅客户端可渲染)
use([
  CanvasRenderer,
  BarChart,
  LineChart,
  PieChart,
  GaugeChart,
  ScatterChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  DataZoomComponent,
  // 冷启动"等待首帧"文字挂在 graphic 上;不注册会静默丢图并打控制台错误
  GraphicComponent,
  // 参考线/阈值线(data-studio 参考线井、SPC 控制限);不注册 markLine 静默丢失
  MarkLineComponent,
  // 工具箱(saveAsImage 像素导出等;/studio 零成本三件套之一)
  ToolboxComponent,
])

/** Warm Editorial 图表色序(替代 ECharts 默认荧光绿/蓝;与 main.css --chart-* 同源) */
const EDITORIAL_PALETTE = ['#4a6b57', '#8aa07c', '#c9a26a', '#b3714f', '#6f8296', '#4e4e4e']

const props = defineProps({
  option: {
    type: Object as PropType<EChartsOption>,
    required: true,
  },
  /** 图表高度(px 数字或 CSS 长度);此前经 $attrs 落到 DOM 属性上不生效,导致容器高 0 */
  height: {
    type: [Number, String],
    default: null,
  },
})

const chartStyle = computed(() => {
  if (props.height == null) return undefined
  return {
    width: '100%',
    height: typeof props.height === 'number' ? `${props.height}px` : props.height,
  }
})

// 未显式给 color 的图表统一走编辑色板;给了的尊重页面意图
const merged = computed<EChartsOption>(() => ({
  color: EDITORIAL_PALETTE,
  ...props.option,
}))

/**
 * 更新语义 —— 决定"改数据"是增量合并还是整图重建。
 *
 * 问题:本组件的 merged 每次求值都是**新对象**,而 vue-echarts 7 把「引用变了」直接判为
 * 全量替换(`notMerge: option !== oldOption`)。于是每次读数合批(≈2 次/秒)都会丢弃并重建
 * series/axis/legend —— 当前数据量下只是 1-3ms,但代价随点数线性放大,且白白丢掉 ECharts
 * 的过渡动画(重建 = 从零开始画,不是数据平滑移动)。
 *
 * 修法:
 *  - `notMerge: false` → 走增量合并,数据变化有过渡、组件实例复用;
 *  - `replaceMerge: ['series']` → 单独对 series 做「替换式合并」,补上 notMerge:false 的短板:
 *    series 数量**减少**时(如筛选后趋势线变少),旧 series 必须被移除,否则会残留幽灵曲线;
 *  - `lazyUpdate: true` → 同一 tick 内多次 setOption 合并到下一帧渲染,避免重复绘制。
 *
 * lazyUpdate 的边界(2026-10-22 看板卡片不渲染 bug):lazy 更新靠 rAF 落笔 —— 标签页
 * 隐藏/后台时 rAF 停摆,绘制永不发生(canvas 层甚至不创建)。「先挂空 option、数据到达
 * 后经 watcher 更新」的消费者(看板卡)对此零兜底;而「数据就绪才 v-if 挂载」的页面
 * (/data、/studio)靠 mount 时的同步 resize 掩盖了问题。所以 lazyUpdate 必须随可见性
 * 收敛:可见才懒,不可见同步画(2026-10-22-eda-ui-fix-plan F1a)。
 */
const isVisible = ref(typeof document === 'undefined' || document.visibilityState === 'visible')

function onVisibilityChange(): void {
  isVisible.value = document.visibilityState === 'visible'
}

onMounted(() => document.addEventListener('visibilitychange', onVisibilityChange))
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVisibilityChange))

const updateOptions = computed<SetOptionOpts>(() => ({
  notMerge: false,
  replaceMerge: ['series'],
  lazyUpdate: isVisible.value,
}))
</script>

<template>
  <VChart
    v-bind="$attrs"
    :style="chartStyle"
    :option="merged"
    :update-options="updateOptions"
    autoresize
  />
</template>
