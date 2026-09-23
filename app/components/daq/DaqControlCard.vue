<script setup lang="ts">
/**
 * 控制器总控条 —— 第一行 控制/指标/操作,第二行 产线状态带。
 * 控制器与 meta 是 useDaqStream 的全局单例(直接引用,不复制);
 * 启停/周期下发与面板开合回抛页面。
 */
import type { DaqInfraState } from '@/app/composables/workshop/useDaqStream'
import type { LineView } from '#shared/dcw-protocol'

/** 控制器状态(useDaqStream 内部结构;此处按消费面收窄) */
interface DaqControllerState {
  running: boolean
  defaultIntervalMs: number
  defaultPublishIntervalMs: number
  nodesTotal: number
  nodesOnline: number
}

/** 后端能力自描述(控制器条只消费指标与基础设施态) */
interface DaqMetaState {
  tsdb: string
  queue: string
  produced: number
  consumed: number
  dropped: number
  samplesStored: number
  infra?: DaqInfraState
}

defineProps<{
  meta: DaqMetaState
  /** 产线清单(状态带逐线一 pill;运行态走 lineStateOf 回调) */
  lines: LineView[]
  lineStateOf: (lineId: string) => { active: boolean, productName: string | null, recipeName: string | null }
}>()

const emit = defineEmits<{
  'action': [action: 'start' | 'stop' | 'pause' | 'resume', intervalMs?: number]
  'config': [intervalMs: number, publishIntervalMs: number]
  'open-add': []
  'open-templates': []
}>()

/** 控制器状态经 v-model 传入(与页面同一 reactive 对象;周期输入就地编辑) */
const controller = defineModel<DaqControllerState>('controller', { required: true })
</script>

<template>
  <section class="aw-tile ctrl-card">
    <div class="ctrl-row">
      <div class="ctrl-left">
        <button
          class="aw-pill"
          :class="{ running: controller.running }"
          :title="$t('daq.k1snap145')"
          @click="emit('action', controller.running ? 'pause' : 'resume')"
        >
          <span :class="controller.running ? 'i-tabler-player-pause' : 'i-tabler-player-play'" />
          {{ controller.running ? $t('daq.kpui00095') : $t('daq.knxpdpt111') }}
        </button>
        <label class="cycle mono">
          {{ $t('daq.k1ifahxj016') }}
          <input
            v-model.number="controller.defaultIntervalMs"
            type="number"
            min="200"
            max="60000"
            step="100"
            @change="emit('config', controller.defaultIntervalMs, controller.defaultPublishIntervalMs)"
          >ms
        </label>
        <label
          class="cycle mono"
          :title="$t('daq.k1e8lcoo001')"
        >
          {{ $t('daq.k1if98n0017') }}
          <input
            v-model.number="controller.defaultPublishIntervalMs"
            type="number"
            min="0"
            max="60000"
            step="100"
            @change="emit('config', controller.defaultIntervalMs, controller.defaultPublishIntervalMs)"
          >ms
        </label>
      </div>
      <div class="ctrl-right">
        <span class="ctrl-metrics mono">
          <span>{{ $t('daq.k45uio067') }} {{ controller.nodesOnline }}/{{ controller.nodesTotal }}</span>
          <span class="sep">·</span>
          <span :title="$t('daq.k1yztsu4002')">{{ $t('daq.k3xagp087') }} {{ meta.produced }}</span>
          <span class="sep">·</span>
          <span :title="$t('daq.ko09iha003')">{{ $t('daq.k427eu088') }} {{ meta.consumed }}</span>
          <span class="sep">·</span>
          <span
            :class="{ warn: (meta.dropped ?? 0) > 0 }"
            :title="$t('daq.k1droptip135')"
          >{{ $t('daq.k3w8go089') }} {{ meta.dropped }}</span>
          <span class="sep">·</span>
          <span :title="$t('daq.kj1jbmw004')">{{ $t('daq.k3wusd090') }} {{ meta.samplesStored }}</span>
        </span>
        <button
          class="aw-pill outline add-btn"
          @click="emit('open-templates')"
        >
          <span class="i-tabler-adjustments-horizontal" />
          {{ $t('daq.k1f5cv0s018') }}
        </button>
        <button
          class="aw-pill add-btn"
          @click="emit('open-add')"
        >
          <span class="i-tabler-plus" />
          {{ $t('daq.k1fn0ukb019') }}
        </button>
      </div>
    </div>
    <!-- 产线状态带:单行横向滚动,每产线一枚 pill(空心点=待机 / 实心呼吸点=运行中) -->
    <div class="line-strip">
      <span class="strip-label">
        <span class="i-tabler-route" />
        {{ $t('daq.k1b2o3b6020') }}<small class="mono">{{ lines.length }}</small>
      </span>
      <div class="strip-scroll">
        <NuxtLink
          v-for="l in lines"
          :key="l.id"
          class="line-pill"
          :class="{ on: lineStateOf(l.id).active }"
          :style="{ '--lc': l.color }"
          :to="`/dcw/${l.id}`"
          :title="lineStateOf(l.id).active
            ? $t('daq.k3v957u120', { p0: l.name, p1: lineStateOf(l.id).productName, p2: lineStateOf(l.id).recipeName })
            : $t('daq.k1x7jnru121', { p0: l.name })"
        >
          <span class="lp-dot" />
          <b>{{ l.name }}</b>
          <small
            v-if="lineStateOf(l.id).active"
            class="lp-run"
          >{{ lineStateOf(l.id).recipeName ?? $t('daq.k3vp67i096') }}</small>
          <small
            v-else
            class="lp-idle"
          >{{ $t('daq.k3zgkk021') }}</small>
        </NuxtLink>
        <NuxtLink
          v-if="lines.length === 0"
          class="line-pill"
          to="/dcw"
        >
          <span class="lp-dot" />
          <b>{{ $t('daq.k1el12b1022') }}</b>
          <small class="lp-idle">{{ $t('daq.k8jxxe8023') }}</small>
        </NuxtLink>
      </div>
    </div>
  </section>
</template>
