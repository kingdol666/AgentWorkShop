<script setup lang="ts">
/**
 * Agent 优化记录面板(调控闭环:设定历史 / 判定 / 窗口数采;序列为客户端渲染 SVG)。
 * 面板状态与数据加载都在 useDaqOptimizations;组件只做呈现。
 */
import type { LineView, OptimizationRecord, RecipeView } from '#shared/dcw-protocol'
import type { OptimizationSeries } from '../../pages/daq/composables/useDaqOptimizations'

defineProps<{
  optimizations: OptimizationRecord[]
  lines: LineView[]
  open: boolean
  mounted: boolean
  filterLine: string
  filterRecipe: string
  recipeOptions: RecipeView[]
  seriesOf: OptimizationSeries
  seriesLoading: string
  statusKey: (status: string) => string
  seriesPath: (points: Array<{ at: number, value?: number, avg?: number }>) => string
  fmtPoint: (v: number | null | undefined) => string
}>()

const emit = defineEmits<{
  'toggle': []
  'selectLine': [value: string]
  'selectRecipe': [value: string]
  'line-change': []
  'filter': []
  'series': [id: string]
  'rollback': [id: string]
}>()

/** 产线下拉变化:先写筛选值再走级联(与原 @change="onOptLineChange" 同步执行一致) */
function onFilterLine(e: Event): void {
  emit('selectLine', (e.target as HTMLSelectElement).value)
  emit('line-change')
}

/** Recipe 下拉变化:先写筛选值再重新拉取 */
function onFilterRecipe(e: Event): void {
  emit('selectRecipe', (e.target as HTMLSelectElement).value)
  emit('filter')
}
</script>

<template>
  <section class="aw-tile opt-card">
    <button
      class="opt-head"
      @click="emit('toggle')"
    >
      <span class="i-tabler-flask" />
      <b>{{ $t('daq.k1optt001') }}</b>
      <span class="opt-count mono">{{ optimizations.length }}</span>
      <span
        class="opt-chevron"
        :class="{ open }"
      />
    </button>
    <div
      class="opt-body"
      :class="{ open }"
    >
      <template v-if="mounted">
        <div class="opt-filters">
          <select
            :value="filterLine"
            class="inp-sel"
            @change="onFilterLine"
          >
            <option value="">
              {{ $t('daq.k1optf001') }}
            </option>
            <option
              v-for="l in lines"
              :key="l.id"
              :value="l.id"
            >
              {{ l.name }}
            </option>
          </select>
          <select
            :value="filterRecipe"
            class="inp-sel"
            @change="onFilterRecipe"
          >
            <option value="">
              {{ $t('daq.k1optf004') }}
            </option>
            <option
              v-for="r in recipeOptions"
              :key="r.id"
              :value="r.id"
            >
              {{ r.name }}
            </option>
          </select>
          <button
            class="mini-act"
            @click="emit('filter')"
          >
            {{ $t('daq.k1optf002') }}
          </button>
        </div>
        <p
          v-if="optimizations.length === 0"
          class="opt-empty"
        >
          {{ $t('daq.k1opte001') }}
        </p>
        <ul class="opt-list">
          <li
            v-for="r in optimizations.slice(0, 30)"
            :key="r.id"
            class="opt-row"
            :class="r.status"
          >
            <div class="opt-line1">
              <span
                class="opt-status"
                :class="r.status"
              >{{ $t(statusKey(r.status)) }}</span>
              <b class="opt-node">{{ r.nodeName }}</b>
              <span class="mono opt-params">{{ r.params[0]?.from ?? '?' }} → {{ r.params[0]?.to }}</span>
              <span class="mono opt-time">{{ r.setAt.slice(5, 16).replace('T', ' ') }}</span>
              <button
                v-if="!seriesOf[r.id]"
                class="mini-act"
                :disabled="seriesLoading === r.id"
                @click="emit('series', r.id)"
              >
                {{ $t('daq.k1opta001') }}
              </button>
              <button
                v-if="r.status === 'open'"
                class="mini-act danger"
                @click="emit('rollback', r.id)"
              >
                {{ $t('daq.k1opta002') }}
              </button>
            </div>
            <div class="opt-line2 mono">
              <span
                v-if="r.judge"
                class="opt-judge"
                :class="r.judge.verdict"
              >{{ r.judge.verdict }}({{ r.judge.by }}): {{ r.judge.reason.slice(0, 70) }}</span>
              <span
                v-else-if="r.status === 'open'"
                class="opt-open-hint"
              >{{ $t('daq.k1opto001') }}</span>
              <span
                v-if="r.aggPending"
                class="opt-agg"
              >{{ $t('daq.k1optw001') }}</span>
              <span
                v-else-if="r.windowAgg && r.windowAgg.channels.length"
                class="opt-agg"
              >
                <template
                  v-for="c in r.windowAgg.channels"
                  :key="c.daqNodeId"
                >{{ c.ch }} {{ fmtPoint(c.min) }}~{{ fmtPoint(c.max) }}({{ $t('daq.k1optw002') }}{{ c.breaches < 0 ? '-' : c.breaches }}) </template>
              </span>
            </div>
            <div
              v-if="seriesOf[r.id]"
              class="opt-series"
            >
              <div
                v-for="ch in (seriesOf[r.id]?.channels ?? [])"
                :key="ch.nodeId"
                class="opt-ch"
              >
                <svg
                  class="opt-spark"
                  viewBox="0 0 240 36"
                  preserveAspectRatio="none"
                >
                  <polyline :points="seriesPath(ch.points)" />
                </svg>
                <span class="mono">{{ ch.ch }} {{ fmtPoint(ch.points.at(-1)?.value ?? ch.points.at(-1)?.avg) }}{{ ch.unit }}</span>
              </div>
              <p
                v-if="(seriesOf[r.id]?.channels.length ?? 0) === 0"
                class="opt-empty"
              >
                {{ $t('daq.k1opte002') }}
              </p>
            </div>
          </li>
        </ul>
      </template>
    </div>
  </section>
</template>
