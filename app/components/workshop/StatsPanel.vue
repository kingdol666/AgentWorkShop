<script setup lang="ts">
/**
 * 可观测统计面板(P2):事件吞吐(每秒事件数,60s 滚动窗口)+
 * 类型分布 + seq/连接概览。AppChart(ECharts)折线渲染,客户端 only。
 */
import { useEventsStore } from '@/app/stores/workshop/events'
import { useWsConnectionStore } from '@/app/stores/workshop/connection'

const props = defineProps<{ channelId: string }>()
const events = useEventsStore()
const conn = useWsConnectionStore()

const WINDOW = 60

/** 每秒事件数(60 桶;ring 时间戳分桶) */
const buckets = computed(() => {
  const items = events.ring(props.channelId).items
  const now = Date.now()
  const counts: number[] = new Array<number>(WINDOW).fill(0)
  for (const e of items) {
    const t = Date.parse(e.at)
    if (Number.isNaN(t)) continue
    const age = Math.floor((now - t) / 1000)
    const slot = age >= 0 && age < WINDOW ? WINDOW - 1 - age : -1
    if (slot >= 0) counts[slot] = (counts[slot] ?? 0) + 1
  }
  return counts
})

const typeCounts = computed(() => {
  const map = new Map<string, number>()
  for (const e of events.ring(props.channelId).items) {
    map.set(e.type, (map.get(e.type) ?? 0) + 1)
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1])
})

const chartOption = computed(() => ({
  grid: { left: 36, right: 8, top: 12, bottom: 20 },
  xAxis: { type: 'category' as const, data: buckets.value.map((_, i) => String(i - WINDOW + 1)) },
  yAxis: { type: 'value' as const, minInterval: 1 },
  tooltip: { trigger: 'axis' as const },
  series: [{
    type: 'line' as const,
    data: buckets.value,
    smooth: true,
    showSymbol: false,
    areaStyle: { opacity: 0.15 },
    lineStyle: { width: 1.5 },
  }],
}))

const total = computed(() => events.ring(props.channelId).items.length)
const rate = computed(() => buckets.value.slice(-10).reduce((a, b) => a + b, 0) / 10)
</script>

<template>
  <div class="stats">
    <div class="kpis">
      <div class="kpi">
        <div class="kpi-num">
          {{ total }}
        </div>
        <div class="kpi-label">
          {{ $t('statsPanel.k1i88c0b001') }}
        </div>
      </div>
      <div class="kpi">
        <div class="kpi-num">
          {{ rate.toFixed(1) }}/s
        </div>
        <div class="kpi-label">
          {{ $t('statsPanel.kfplawo002') }}
        </div>
      </div>
      <div class="kpi">
        <div class="kpi-num">
          {{ events.lastSeq(channelId) }}
        </div>
        <div class="kpi-label">
          seq / {{ conn.state }}
        </div>
      </div>
    </div>

    <div class="chart">
      <app-chart
        :option="chartOption"
        class="app-chart"
        autoresize
      />
    </div>

    <div class="types">
      <div class="types-title">
        {{ $t('statsPanel.kzcd51003') }}
      </div>
      <div
        v-for="[type, n] in typeCounts"
        :key="type"
        class="type-row"
      >
        <span class="t-name">{{ type }}</span>
        <div class="t-bar-wrap">
          <div
            class="t-bar"
            :style="{ width: `${Math.round(n / (typeCounts[0]?.[1] ?? 1) * 100)}%` }"
          />
        </div>
        <span class="t-n">{{ n }}</span>
      </div>
      <div
        v-if="typeCounts.length === 0"
        class="empty"
      >
        {{ $t('statsPanel.k1pevwxl004') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.stats {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
}
.kpis {
  display: flex;
  gap: 8px;
}
.kpi {
  flex: 1 1 0;
  padding: 8px;
  text-align: center;
  border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  border-radius: var(--radius-panel-sm);
}
.kpi-num { font-size: 16px; font-weight: 700; font-family: var(--font-mono); }
.kpi-label { margin-top: 2px; font-size: 11px; opacity: 0.55; }
.chart {
  height: 140px;
  border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  border-radius: var(--radius-panel-sm);
}
.app-chart { height: 100%; }
.types-title { padding: 4px 0; font-weight: 600; opacity: 0.7; }
.type-row {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 1px 0;
  font-family: var(--font-mono);
  font-size: 11px;
}
.t-name { flex: 0 0 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t-bar-wrap {
  flex: 1 1 auto;
  height: 8px;
  overflow: hidden;
  background: color-mix(in srgb, currentColor 8%, transparent);
  border-radius: var(--radius-pill);
}
.t-bar { height: 100%; background: var(--color-primary); }
.t-n { flex: 0 0 36px; text-align: right; opacity: 0.6; }
.empty { padding: 8px 0; opacity: 0.4; }
</style>
