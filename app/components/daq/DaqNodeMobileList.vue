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

const props = defineProps<{
  nodes: DaqNodeLive[]
  lines: LineView[]
  loaded: boolean
}>()

const { t } = useI18n()

/** 34 张卡 ≈ 4000px;先给 10 张,其余按需展开 */
const showAll = ref(false)
const shown = computed(() => showAll.value ? props.nodes : props.nodes.slice(0, 10))

function lineName(id: string | null | undefined): string {
  if (!id) return t('daq.k3ootr6053')
  return props.lines.find(l => l.id === id)?.name ?? id.slice(0, 8)
}

function stateOf(n: DaqNodeLive): { key: string, label: string } {
  if (!n.enabled) return { key: 'disabled', label: t('daq.k1disabl130') }
  const labels: Record<string, string> = {
    ok: t('daq.k41k5c062'),
    warn: t('daq.k49z8v063'),
    alarm: t('daq.k3xmid064'),
    offline: t('daq.k44c2n065'),
  }
  return { key: n.state, label: labels[n.state] ?? n.state }
}

function valueOf(n: DaqNodeLive): string {
  return n.value == null || !Number.isFinite(n.value) ? '--' : n.value.toFixed(n.decimals)
}

function deviceOf(n: DaqNodeLive): string {
  const ids = n.deviceIds ?? (n.deviceBindingId ? [n.deviceBindingId] : [])
  return ids.length > 0 ? `${ids.length}` : '—'
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
            class="dn-state"
            :data-state="stateOf(n).key"
          >{{ stateOf(n).label }}</span>
        </div>
        <div class="dn-value mono">
          <b>{{ valueOf(n) }}</b>
          <small>{{ n.unit }}</small>
          <span class="dn-interval">{{ n.intervalMs == null ? '跟随' : `${n.intervalMs}ms` }}</span>
        </div>
        <div class="dn-meta">
          <span>{{ lineName(n.lineId) }}</span>
          <span>设备 {{ deviceOf(n) }}</span>
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

.dn-state {
  flex: 0 0 auto;
  padding: 1px 7px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
}

.dn-state[data-state='ok'] { color: var(--tone-success-dot); background: var(--tone-success-bg); border-color: transparent; }
.dn-state[data-state='warn'] { color: var(--tone-warning-dot); background: var(--tone-warning-bg); border-color: transparent; }
.dn-state[data-state='alarm'] { color: var(--tone-danger-dot); background: var(--tone-danger-bg); border-color: transparent; }
.dn-state[data-state='offline'] { color: var(--tone-neutral-dot); background: var(--tone-neutral-bg); border-color: transparent; }
.dn-state[data-state='disabled'] { color: var(--ink-faint); }

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
  gap: 10px;
  align-items: center;
  font-size: 10.5px;
  color: var(--ink-faint);
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
