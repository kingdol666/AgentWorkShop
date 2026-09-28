<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEventsStore } from '@/app/stores/workshop/events'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { classifyOperation, operationPhase, type OperationKind, type OperationMeta } from '@/app/composables/workshop/operation-events'
import { formatLocalClock } from '@/app/composables/workshop/useLocalTime'
import type { AepEnvelope } from '#shared/workshop-protocol'

const props = defineProps<{ channelId: string }>()
const events = useEventsStore()
const entities = useEntitiesStore()
const filter = ref<'all' | OperationKind>('all')

const allItems = computed<AepEnvelope[]>(() => events.ring(props.channelId).items)
const operations = computed(() => allItems.value
  .map(e => ({ e, meta: classifyOperation(e) }))
  .filter((x): x is { e: AepEnvelope, meta: OperationMeta } => Boolean(x.meta))
  .reverse())
const visible = computed(() => filter.value === 'all' ? operations.value : operations.value.filter(x => x.meta.kind === filter.value))
const latest = computed(() => operations.value.slice(0, 80))
const phase = computed(() => operationPhase(allItems.value))
const stats = computed(() => {
  let dcw = 0
  let daq = 0
  let aml = 0
  let blocked = 0
  for (const x of latest.value) {
    if (x.meta.kind === 'dcw') dcw++
    if (x.meta.kind === 'daq') daq++
    if (x.meta.kind === 'aml') aml++
    if (x.meta.severity === 'critical') blocked++
  }
  return { dcw, daq, aml, blocked }
})

function agentName(e: AepEnvelope): string {
  return e.agentId ? entities.agentName(props.channelId, e.agentId) || e.agentId.slice(0, 8) : '系统'
}
function tone(meta: OperationMeta): string {
  return `${meta.kind} ${meta.severity}`
}
function phaseTone(): string {
  return phase.value.tone
}
</script>

<template>
  <section
    class="line-ops-panel"
    aria-label="产线作业面板"
  >
    <header class="lop-head">
      <div>
        <div class="lop-kicker">
          <span class="lop-live" />LINE OPERATIONS
        </div>
        <h3>产线作业</h3>
      </div>
      <span
        class="lop-phase"
        :class="phaseTone()"
      ><span class="i-tabler-radar" />{{ phase.label }}</span>
    </header>

    <div class="lop-summary">
      <div class="lop-stat dcw">
        <span>DCW</span><b>{{ stats.dcw }}</b><small>写控</small>
      </div>
      <div class="lop-stat daq">
        <span>DAQ</span><b>{{ stats.daq }}</b><small>采集</small>
      </div>
      <div class="lop-stat aml">
        <span>AML</span><b>{{ stats.aml }}</b><small>训练</small>
      </div>
      <div class="lop-stat safety">
        <span>SAFE</span><b>{{ stats.blocked }}</b><small>拦截</small>
      </div>
    </div>

    <nav
      class="lop-filters"
      aria-label="作业筛选"
    >
      <button
        :class="{ on: filter === 'all' }"
        @click="filter = 'all'"
      >
        全部
      </button>
      <button
        :class="{ on: filter === 'dcw' }"
        @click="filter = 'dcw'"
      >
        写控
      </button>
      <button
        :class="{ on: filter === 'daq' }"
        @click="filter = 'daq'"
      >
        取数
      </button>
      <button
        :class="{ on: filter === 'aml' }"
        @click="filter = 'aml'"
      >
        AML
      </button>
      <button
        :class="{ on: filter === 'twin' }"
        @click="filter = 'twin'"
      >
        孪生
      </button>
      <button
        :class="{ on: filter === 'safety' }"
        @click="filter = 'safety'"
      >
        安全
      </button>
    </nav>

    <div class="lop-timeline">
      <div
        v-if="visible.length === 0"
        class="lop-empty"
      >
        <span class="i-tabler-activity-heartbeat" />
        <span>等待产线作业事件</span>
      </div>
      <article
        v-for="item in visible.slice(0, 24)"
        :key="`${item.e.seq}:${item.e.type}`"
        class="lop-event"
        :class="tone(item.meta)"
      >
        <div class="lop-event-icon">
          <span :class="item.meta.icon" />
        </div>
        <div class="lop-event-body">
          <div class="lop-event-top">
            <strong>{{ item.meta.label }}</strong>
            <time>{{ formatLocalClock(item.e.at, false) }}</time>
          </div>
          <p>{{ item.meta.summary || '—' }}</p>
          <small>{{ agentName(item.e) }} · #{{ item.e.seq }}</small>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.line-ops-panel { display: flex; flex-direction: column; min-height: 0; padding: 14px 14px 10px; color: var(--ink); background: linear-gradient(145deg, color-mix(in srgb, var(--paper-raised) 92%, #0e2630), var(--paper-raised)); border-bottom: 1px solid var(--line-strong); }
.lop-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.lop-kicker { display: flex; align-items: center; gap: 6px; font: 10px var(--font-mono); letter-spacing: .11em; color: var(--ink-faint); }
.lop-live { width: 6px; height: 6px; background: #25b39d; border-radius: 50%; box-shadow: 0 0 0 3px color-mix(in srgb, #25b39d 15%, transparent); }
.lop-head h3 { margin: 5px 0 0; font-size: 17px; letter-spacing: -.02em; }
.lop-phase { display: inline-flex; align-items: center; gap: 5px; padding: 5px 8px; font: 10px var(--font-mono); color: var(--ink-soft); background: color-mix(in srgb, var(--ink) 5%, transparent); border: 1px solid var(--line-strong); border-radius: 999px; }
.lop-phase.attention { color: #b8791e; border-color: color-mix(in srgb, #b8791e 35%, transparent); background: color-mix(in srgb, #b8791e 9%, transparent); }
.lop-phase.critical { color: var(--tone-danger-dot); }
.lop-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; margin-bottom: 10px; }
.lop-stat { min-width: 0; padding: 7px 7px 6px; background: color-mix(in srgb, var(--paper-deep) 80%, transparent); border: 1px solid var(--line); border-radius: 7px; }
.lop-stat span, .lop-stat small { display: block; font: 9px var(--font-mono); color: var(--ink-faint); }
.lop-stat b { display: block; margin: 1px 0; font: 17px var(--font-mono); color: var(--ink); }
.lop-stat.dcw b { color: #b8791e; }.lop-stat.daq b { color: #158f8a; }.lop-stat.aml b { color: #7657ad; }.lop-stat.safety b { color: var(--tone-danger-dot); }
.lop-filters { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.lop-filters button { padding: 4px 7px; font-size: 10px; color: var(--ink-faint); background: transparent; border: 1px solid transparent; border-radius: 5px; cursor: pointer; }
.lop-filters button:hover { color: var(--ink); background: var(--hover-tint); }.lop-filters button.on { color: var(--ink); background: var(--paper-deep); border-color: var(--line-strong); }
.lop-timeline { min-height: 0; max-height: 274px; overflow: auto; padding-right: 2px; }
.lop-event { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 7px; padding: 7px 6px; margin: 3px 0; border-left: 2px solid var(--line-strong); border-radius: 5px; background: color-mix(in srgb, var(--paper-deep) 42%, transparent); }
.lop-event.dcw { border-left-color: #c98922; }.lop-event.daq { border-left-color: #159f9a; }.lop-event.aml { border-left-color: #7657ad; }.lop-event.twin { border-left-color: #3978b8; }.lop-event.safety { border-left-color: var(--tone-danger-dot); }
.lop-event.critical { background: color-mix(in srgb, var(--tone-danger-dot) 8%, transparent); }
.lop-event-icon { display: grid; place-items: center; width: 20px; height: 20px; color: var(--ink-faint); font-size: 13px; }
.lop-event.dcw .lop-event-icon { color: #b8791e; }.lop-event.daq .lop-event-icon { color: #159f9a; }.lop-event.aml .lop-event-icon { color: #7657ad; }.lop-event.twin .lop-event-icon { color: #3978b8; }.lop-event.safety .lop-event-icon { color: var(--tone-danger-dot); }
.lop-event-top { display: flex; justify-content: space-between; gap: 6px; align-items: baseline; }.lop-event-top strong { font-size: 11px; }.lop-event-top time { flex: none; font: 9px var(--font-mono); color: var(--ink-faint); }
.lop-event p { margin: 2px 0; overflow: hidden; font-size: 10.5px; line-height: 1.35; color: var(--ink-soft); text-overflow: ellipsis; white-space: nowrap; }.lop-event small { font: 9px var(--font-mono); color: var(--ink-faint); }
.lop-empty { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 70px; color: var(--ink-faint); font-size: 11px; }
@media (max-width: 1023.98px) { .lop-timeline { max-height: 220px; } }
</style>
