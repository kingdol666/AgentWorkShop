<script setup lang="ts">
/**
 * 知识网络画布（ECharts GraphChart + force layout）。
 * 只负责渲染与点击；编辑/抽屉由父组件承担。
 */
import { use } from 'echarts/core'
import { GraphChart } from 'echarts/charts'
import { CanvasRenderer } from 'echarts/renderers'
import { LegendComponent, TitleComponent, TooltipComponent } from 'echarts/components'
import { LabelLayout } from 'echarts/features'
import VChart from 'vue-echarts'
import { computed, nextTick, onMounted, ref } from 'vue'
import type { EChartsOption } from 'echarts'
import type { GraphLink, GraphNode } from '~/pages/memory/api'

use([CanvasRenderer, GraphChart, TooltipComponent, LegendComponent, TitleComponent, LabelLayout])

const props = withDefaults(defineProps<{
  nodes: GraphNode[]
  edges: GraphLink[]
  selectedNodeId?: string | null
  selectedEdgeId?: string | null
  height?: number | string
}>(), {
  selectedNodeId: null,
  selectedEdgeId: null,
  height: 560,
})

const emit = defineEmits<{
  (e: 'select-node', node: GraphNode): void
  (e: 'select-edge', edge: GraphLink): void
}>()

const { chartPalette, ink } = useChartTheme()
const { t } = useI18n()
const gkey = (k: string): string => `memoryCenter.graph.${k}`
const chartRef = ref<{ getOption?: () => unknown, resize?: () => void } | null>(null)
onMounted(() => {
  nextTick(() => {
    try {
      ;(window as unknown as { __awGraphChart?: unknown }).__awGraphChart = chartRef.value
      chartRef.value?.resize?.()
    }
    catch { /* chart 未就绪 */ }
  })
})
const FALLBACK = ['#4a6b57', '#8aa07c', '#c9a26a', '#b3714f', '#6f8296', '#8b6f9e', '#5d8a9e', '#a67c52']

const TYPE_ORDER = [
  'episode', 'concept', 'parameter', 'metric', 'device', 'node',
  'recipe', 'product', 'line', 'task', 'event', 'document', 'person',
]

const palette = computed<string[]>(() => (chartPalette.value.length ? chartPalette.value : FALLBACK))
const categories = computed(() => TYPE_ORDER.map(t => ({ name: t })))
const colorOfType = computed(() => {
  const map = new Map<string, string>()
  TYPE_ORDER.forEach((t, i) => map.set(t, palette.value[i % palette.value.length]!))
  return map
})

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const option = computed<EChartsOption>(() => {
  const nodeIds = new Set(props.nodes.map(n => n.id))
  const nameCounts = new Map<string, number>()
  for (const n of props.nodes) nameCounts.set(n.canonicalName, (nameCounts.get(n.canonicalName) ?? 0) + 1)
  const labelOf = (n: GraphNode): string => {
    const base = (nameCounts.get(n.canonicalName) ?? 0) > 1 ? `${n.canonicalName}·${n.scopeKind}` : n.canonicalName
    return base.length > 14 ? `${base.slice(0, 14)}…` : base
  }
  const nodes = props.nodes.map((n) => {
    const color = colorOfType.value.get(n.entityType) ?? palette.value[0]
    const degree = n.degree ?? 0
    const selected = n.id === props.selectedNodeId
    return {
      id: n.id,
      name: n.canonicalName,
      category: Math.max(0, TYPE_ORDER.indexOf(n.entityType)),
      value: degree,
      symbolSize: 12 + Math.min(18, degree * 2),
      itemStyle: {
        color,
        opacity: n.status === 'provisional' ? 0.72 : 1,
        borderColor: selected ? '#111' : 'transparent',
        borderWidth: selected ? 2 : 0,
      },
      label: {
        // 默认全部显示：仅给高度节点显示会让小图只剩无标签的点（实测 8 实体/3 关系完全不可读）。
        // 大图由 series.labelLayout.hideOverlap 自动避让。
        show: true,
        position: 'right' as const,
        distance: 4,
        fontSize: 11,
        color: ink.value || undefined,
        formatter: () => labelOf(n),
      },
    }
  })
  const edges = props.edges
    .filter(e => nodeIds.has(e.srcId) && nodeIds.has(e.dstId))
    .map((e) => {
      const selected = e.id === props.selectedEdgeId
      const color = e.relation === 'contradicts'
        ? palette.value[3] ?? '#b3714f'
        : e.relation === 'supports' || e.relation === 'affects' || e.relation === 'causes'
          ? palette.value[0] ?? '#4a6b57'
          : palette.value[4] ?? '#6f8296'
      return {
        id: e.id,
        source: e.srcId,
        target: e.dstId,
        lineStyle: {
          color: selected ? '#111' : color,
          width: selected ? 2.4 : 1.2,
          opacity: e.status === 'provisional' ? 0.55 : 0.85,
          type: e.status === 'provisional' ? 'dashed' as const : 'solid' as const,
          curveness: 0.08,
        },
        label: { show: false },
      }
    })
  return {
    animation: true,
    animationDuration: 300,
    title: {
      text: t(gkey('canvasTitle'), { n: props.nodes.length, m: props.edges.length }),
      left: 12,
      top: 8,
      textStyle: { fontSize: 12, color: palette.value[4] ?? '#6f8296', fontWeight: 'normal' },
    },
    tooltip: {
      trigger: 'item',
      formatter: (raw: unknown) => {
        const p = raw as { dataType?: string, data?: { id?: string } }
        if (p.dataType === 'edge') {
          const e = props.edges.find(x => x.id === p.data?.id)
          if (!e) return ''
          const src = props.nodes.find(n => n.id === e.srcId)?.canonicalName ?? e.srcId
          const dst = props.nodes.find(n => n.id === e.dstId)?.canonicalName ?? e.dstId
          return `<b>${esc(src)} → ${esc(dst)}</b><br/>${esc(e.relation)}${e.fact ? `<br/>${esc(e.fact)}` : ''}<br/>${esc(e.status)} · ${t(gkey('colConfidence'))} ${e.confidence.toFixed(2)}`
        }
        const n = props.nodes.find(x => x.id === p.data?.id)
        if (!n) return ''
        return `<b>${esc(n.canonicalName)}</b><br/>${esc(n.entityType)} · ${esc(n.status)} · ${esc(n.scopeKind)}${n.scopeKey ? `:${esc(n.scopeKey)}` : ''}<br/>${t(gkey('relationsCount'), { n: n.degree ?? 0 })} · ${n.locked ? t(gkey('lockedLabel')) : t(gkey('editable'))}`
      },
    },
    legend: [{ data: TYPE_ORDER.slice(0, 8), bottom: 0, textStyle: { fontSize: 10 } }],
    series: [{
      type: 'graph',
      layout: 'force',
      roam: true,
      draggable: true,
      symbol: 'circle',
      categories: categories.value,
      data: nodes,
      links: edges,
      force: { repulsion: 180, edgeLength: [60, 160], gravity: 0.08, layoutAnimation: true },
      emphasis: { focus: 'adjacency', label: { show: true } },
      labelLayout: { hideOverlap: true },
      lineStyle: { color: 'source', curveness: 0.08 },
      edgeSymbol: ['none', 'arrow'],
      edgeSymbolSize: 6,
    }],
  }
})

function onClick(raw: unknown): void {
  const params = raw as { dataType?: string, data?: { id?: string } }
  if (params.dataType === 'node') {
    const node = props.nodes.find(n => n.id === params.data?.id)
    if (node) emit('select-node', node)
  }
  else if (params.dataType === 'edge') {
    const edge = props.edges.find(e => e.id === params.data?.id)
    if (edge) emit('select-edge', edge)
  }
}
</script>

<template>
  <ClientOnly>
    <VChart
      ref="chartRef"
      class="memory-graph-canvas"
      :option="option"
      :style="{ height: typeof height === 'number' ? `${height}px` : height, width: '100%' }"
      autoresize
      data-testid="memory-graph"
      @click="onClick"
    />
    <template #fallback>
      <div
        class="graph-placeholder"
        :style="{ height: typeof height === 'number' ? `${height}px` : height }"
      >
        {{ $t('memoryCenter.graph.rendering') }}
      </div>
    </template>
  </ClientOnly>
</template>

<style scoped>
.memory-graph-canvas {
  width: 100%;
  min-height: 320px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--paper-raised);
}
.graph-placeholder {
  display: grid;
  place-items: center;
  border: 1px dashed var(--line);
  border-radius: 10px;
  color: var(--ink-faint);
  font-size: 12px;
}
</style>
