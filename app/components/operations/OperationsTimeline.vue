<script setup lang="ts">
/**
 * 统一操作流水:分类统计条 + 垂直时间线(新→旧)。
 *
 * 每条 = 分类色轨 + 图标 + 摘要 + 操作者徽章(Agent/用户/系统)+ 时间;
 * 写控行带结构化变更(prevValue → eng),行内可展开完整详情 JSON。
 * 数据由页面传入(REST 快照 + WS 实时帧合并后的同一数组)。
 */
import { ref } from 'vue'
import { classifyOpsRow, CATEGORY_ICONS, diffOf, type OperationCategory } from '@/app/pages/operations/composables/useOperationsFeed'
import type { OpsLogRow } from '@/app/composables/workshop/useOpsLog'
import { formatLocalClock } from '@/app/composables/workshop/useLocalTime'

const props = defineProps<{
  rows: OpsLogRow[]
  loading: boolean
  error: string
}>()

const expandedId = ref<number | null>(null)

function toggle(row: OpsLogRow): void {
  expandedId.value = expandedId.value === row.id ? null : row.id
}

function catOf(row: OpsLogRow): OperationCategory {
  return classifyOpsRow(row)
}

function detailOf(row: OpsLogRow): string {
  if (!row.detailJson) return ''
  try {
    return JSON.stringify(JSON.parse(row.detailJson), null, 2)
  }
  catch {
    return row.detailJson
  }
}

const CAT_ORDER: OperationCategory[] = ['write', 'daq', 'aml', 'recipe', 'rollback', 'alarm', 'line', 'manual', 'system']
function statsPairs(): Array<{ key: OperationCategory, count: number }> {
  const out: Record<string, number> = {}
  for (const r of props.rows) {
    const c = catOf(r)
    out[c] = (out[c] ?? 0) + 1
  }
  return CAT_ORDER.filter(c => out[c]).map(c => ({ key: c, count: out[c] ?? 0 }))
}
</script>

<template>
  <section class="ops-stream">
    <!-- 分类统计:当前流水的构成(点击即按该分类筛选语义留待后续;此处只读) -->
    <div
      v-if="rows.length > 0"
      class="stream-stats"
    >
      <div
        v-for="s in statsPairs()"
        :key="s.key"
        class="stream-stat"
        :class="s.key"
      >
        <span :class="CATEGORY_ICONS[s.key]" />
        <b class="mono">{{ s.count }}</b>
        <small>{{ $t(`operations.cat.${s.key}`) }}</small>
      </div>
    </div>

    <div
      v-if="error"
      class="stream-state error"
    >
      <span class="i-tabler-alert-circle" />
      {{ error }}
    </div>
    <div
      v-else-if="loading && rows.length === 0"
      class="stream-state"
    >
      <span class="i-tabler-loader-2 spin" />
      {{ $t('operations.loading') }}
    </div>
    <div
      v-else-if="rows.length === 0"
      class="stream-state"
    >
      <span class="i-tabler-activity-heartbeat" />
      {{ $t('operations.empty') }}
    </div>

    <ol
      v-else
      class="stream-list"
    >
      <li
        v-for="row in rows"
        :key="`${row.id}-${row.at}-${row.action}`"
        class="op-row"
        :class="[catOf(row), { open: expandedId === row.id }]"
      >
        <button
          class="op-main"
          :disabled="!row.detailJson"
          @click="toggle(row)"
        >
          <span class="op-icon">
            <span :class="CATEGORY_ICONS[catOf(row)]" />
          </span>
          <span class="op-body">
            <span class="op-top">
              <span class="op-cat">{{ $t(`operations.cat.${catOf(row)}`) }}</span>
              <span class="op-summary">{{ row.summary || row.action }}</span>
            </span>
            <span class="op-sub">
              <span
                class="op-actor"
                :class="row.actorKind"
              >{{ row.actorKind === 'agent' ? $t('operations.actorAgent') : row.actorKind === 'user' ? $t('operations.actorUser') : $t('operations.actorSystem') }} · {{ row.actorName }}</span>
              <template v-if="diffOf(row)">
                <span class="op-diff mono">
                  <del v-if="diffOf(row)!.prev != null">{{ diffOf(row)!.prev }}</del>
                  <template v-if="diffOf(row)!.prev != null"> → </template>
                  <ins>{{ diffOf(row)!.next }}</ins>
                  <span
                    v-if="!diffOf(row)!.ok"
                    class="op-diff-bad"
                  >✕</span>
                </span>
              </template>
              <span class="op-action mono">{{ row.action }}</span>
            </span>
          </span>
          <time class="op-time mono">{{ formatLocalClock(row.at, true) }}</time>
        </button>
        <pre
          v-if="expandedId === row.id && row.detailJson"
          class="op-detail mono"
        >{{ detailOf(row) || $t('operations.noDetail') }}</pre>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.ops-stream {
  padding: 12px 14px;
  background: var(--surface-glass);
  border: 1px solid var(--glass-line);
  border-radius: 10px;
  backdrop-filter: var(--aurora-blur) saturate(1.15);
}
.stream-stats { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.stream-stat {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 9px; font-size: 11px; color: var(--ink-soft);
  background: color-mix(in srgb, var(--paper-deep) 72%, transparent);
  border: 1px solid var(--glass-line); border-radius: 999px;
}
.stream-stat b { font-size: 12.5px; color: var(--ink); }
.stream-stat small { font-size: 10px; color: var(--ink-faint); }
.stream-stat.write span:first-child { color: #c98922; }
.stream-stat.daq span:first-child { color: #159f9a; }
.stream-stat.aml span:first-child { color: #7657ad; }
.stream-stat.alarm span:first-child { color: var(--tone-danger-dot); }
.stream-stat.rollback span:first-child { color: #d4756b; }
.stream-stat.recipe span:first-child { color: #3978b8; }

.stream-state { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 120px; font-size: 12px; color: var(--ink-faint); }
.stream-state.error { color: var(--tone-danger-dot); }
.spin { animation: opsSpin 1.1s linear infinite; }
@keyframes opsSpin { to { transform: rotate(360deg); } }

.stream-list { list-style: none; margin: 0; padding: 0; }
.op-row { border-left: 2px solid var(--line-strong); margin: 0 0 4px; border-radius: 6px; background: color-mix(in srgb, var(--paper-deep) 40%, transparent); }
.op-row.write { border-left-color: #c98922; }
.op-row.daq { border-left-color: #159f9a; }
.op-row.aml { border-left-color: #7657ad; }
.op-row.recipe { border-left-color: #3978b8; }
.op-row.rollback { border-left-color: #d4756b; }
.op-row.alarm { border-left-color: var(--tone-danger-dot); background: color-mix(in srgb, var(--tone-danger-dot) 7%, transparent); }

.op-main { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; gap: 8px; align-items: center; width: 100%; padding: 8px 10px; color: inherit; text-align: left; background: transparent; border: 0; cursor: default; }
.op-main:not(:disabled) { cursor: pointer; }
.op-main:not(:disabled):hover { background: var(--hover-tint); }
.op-icon { display: grid; place-items: center; width: 22px; height: 22px; font-size: 14px; color: var(--ink-faint); }
.op-row.write .op-icon { color: #c98922; }
.op-row.daq .op-icon { color: #159f9a; }
.op-row.aml .op-icon { color: #7657ad; }
.op-row.recipe .op-icon { color: #3978b8; }
.op-row.rollback .op-icon { color: #d4756b; }
.op-row.alarm .op-icon { color: var(--tone-danger-dot); }

.op-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.op-top { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.op-cat { flex: none; padding: 1px 7px; font: 9.5px var(--font-mono); letter-spacing: .06em; color: var(--ink-soft); background: color-mix(in srgb, var(--ink) 7%, transparent); border-radius: 999px; }
.op-summary { overflow: hidden; font-size: 12.5px; color: var(--ink); text-overflow: ellipsis; white-space: nowrap; }
.op-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 10.5px; color: var(--ink-faint); }
.op-actor.agent { color: #4da3c9; }
.op-actor.user { color: var(--ink-soft); }
.op-diff { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; }
.op-diff del { color: var(--ink-faint); }
.op-diff ins { color: #35e0a0; text-decoration: none; }
.op-diff-bad { color: var(--tone-danger-dot); }
.op-action { overflow: hidden; max-width: 260px; text-overflow: ellipsis; white-space: nowrap; }
.op-time { flex: none; font-size: 10px; color: var(--ink-faint); }

.op-detail { overflow: auto; max-height: 220px; margin: 0 10px 10px 44px; padding: 8px 10px; font-size: 10.5px; line-height: 1.5; color: var(--ink-soft); background: color-mix(in srgb, var(--paper-deep) 85%, transparent); border: 1px solid var(--glass-line); border-radius: 7px; }

@media (max-width: 640px) {
  .op-main { grid-template-columns: 22px minmax(0, 1fr); }
  .op-time { display: none; }
  .op-detail { margin-left: 10px; }
}
</style>
