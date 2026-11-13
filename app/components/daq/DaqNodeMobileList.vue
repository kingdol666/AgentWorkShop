<script setup lang="ts">
/**
 * 数采节点手机卡列表(第二轮 E6)。
 *
 * 桌面表 12 列、最小 1154px;390 档塞进 332px 容器后只能看到第一列。
 * 手机上改为只读卡:名称/状态/实时值/产线/绑定设备 + 进入单节点详情,
 * 行内编辑仍在桌面表与 /daq/[id] 专业控制台完成(不复制写路径)。
 */
import type { DaqNodeLive } from '@/app/composables/workshop/useDaqStream'
import type { LineView } from '#shared/dcw-protocol'
import { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'

const props = defineProps<{
  nodes: DaqNodeLive[]
  lines: LineView[]
  loaded: boolean
}>()

const { t } = useI18n()
const deviceTwins = useDeviceTwins()

/** 34 张卡 ≈ 4000px;先给 10 张,其余按需展开 */
const showAll = ref(false)
const shown = computed(() => showAll.value ? props.nodes : props.nodes.slice(0, 10))

function lineName(id: string | null | undefined): string {
  if (!id) return t('daq.k3ootr6053')
  return props.lines.find(l => l.id === id)?.name ?? t('daq.unassignedLine')
}

function qualityLabel(n: DaqNodeLive): string {
  const labels: Record<string, string> = {
    good: t('daq.qualityGood'),
    uncertain: t('daq.qualityUncertain'),
    bad: t('daq.qualityBad'),
    stale: t('daq.qualityStale'),
    offline: t('daq.qualityOffline'),
  }
  return labels[n.quality] ?? labels.uncertain ?? t('daq.qualityUncertain')
}

function valueOf(n: DaqNodeLive): string {
  return n.value == null || !Number.isFinite(n.value) ? '--' : n.value.toFixed(n.decimals)
}

function deviceOf(n: DaqNodeLive): string {
  const ids = n.deviceIds ?? (n.deviceBindingId ? [n.deviceBindingId] : [])
  const names = ids
    .map(id => deviceTwins.twins.find(x => x.id === id)?.name)
    .filter((x): x is string => !!x)
  return names.length > 0 ? names.join(' / ') : '—'
}
</script>

<template>
  <div class="dn-list">
    <template v-if="nodes.length > 0">
      <NuxtLink
        v-for="n in shown"
        :key="n.id"
        class="dn-card"
        data-testid="daq-node-mobile-card"
        :to="`/daq/${n.id}`"
        :title="n.name"
      >
        <div class="dn-top">
          <b class="dn-name">{{ n.name }}</b>
          <span
            class="dn-quality"
            :data-quality="n.quality"
          >{{ qualityLabel(n) }}</span>
        </div>
        <div class="dn-value mono">
          <b>{{ valueOf(n) }}</b>
          <small>{{ n.unit }}</small>
          <span class="dn-interval">{{ n.intervalMs == null ? $t('daq.followGlobal') : `${n.intervalMs}ms` }}</span>
        </div>
        <div class="dn-meta">
          <span>{{ lineName(n.lineId) }}</span>
          <span>{{ $t('daq.boundDevices') }} {{ deviceOf(n) }}</span>
          <span class="i-tabler-chevron-right dn-go" />
        </div>
      </NuxtLink>
      <button
        v-if="nodes.length > 10"
        type="button"
        class="dn-more"
        @click="showAll = !showAll"
      >
        {{ showAll ? $t('daq.collapseNodes') : $t('daq.showAllNodes', { p0: nodes.length }) }}
      </button>
    </template>
    <p
      v-else-if="loaded"
      class="dn-empty"
    >
      {{ t('daq.k1w20qew076') }}
    </p>
  </div>
</template>

<style scoped>
.dn-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
}

.dn-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 11px 12px;
  text-decoration: none;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-left: 2px solid var(--line-strong);
  border-radius: var(--radius-panel-sm);
}

.dn-card:active { transform: scale(0.995); }

.dn-top {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  min-width: 0;
}

.dn-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 12.5px;
  font-weight: 650;
  line-height: 1.4;
  color: var(--ink);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.dn-quality { color: var(--ink-soft); background: var(--paper-deep); border: 1px solid var(--line); border-radius: var(--radius-pill); padding: 1px 7px; font-family: var(--font-mono); font-size: 10px; }
.dn-quality[data-quality='good'] { color: var(--tone-success-dot); background: var(--tone-success-bg); border-color: transparent; }
.dn-quality[data-quality='stale'], .dn-quality[data-quality='uncertain'] { color: var(--tone-warning-dot); background: var(--tone-warning-bg); border-color: transparent; }
.dn-quality[data-quality='bad'] { color: var(--tone-danger-dot); background: var(--tone-danger-bg); border-color: transparent; }
.dn-quality[data-quality='offline'] { color: var(--tone-neutral-dot); background: var(--tone-neutral-bg); border-color: transparent; }

.dn-value {
  display: flex;
  gap: 3px;
  align-items: baseline;
}

.dn-value b {
  font-size: 22px;
  font-weight: 600;
  line-height: 1;
  color: var(--ink);
}

.dn-value small { font-size: 10.5px; color: var(--ink-soft); }

.dn-interval {
  margin-left: auto;
  font-size: 10px;
  color: var(--ink-faint);
}

.dn-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  align-items: center;
  font-size: 10.5px;
  color: var(--ink-faint);
}

.dn-meta span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dn-go { margin-left: auto; }

.dn-more {
  min-height: 44px;
  font-size: 12px;
  color: var(--ink-soft);
  cursor: pointer;
  background: var(--paper-deep);
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-panel-sm);
}

.dn-more:hover { color: var(--ink); border-color: var(--ink-faint); }

.dn-empty {
  padding: 16px;
  font-size: 12px;
  color: var(--ink-faint);
  text-align: center;
}
</style>
