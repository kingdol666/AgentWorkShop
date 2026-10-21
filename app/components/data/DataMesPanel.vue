<template>
  <div class="mesp">
    <!-- 点位目录 -->
    <div class="card">
      <div class="row">
        <h3 class="sec">
          {{ $t('data.mes.points') }}
        </h3>
        <input
          v-model="filter"
          class="input"
          :placeholder="$t('data.mes.filter')"
        >
        <span class="hint">{{ points.length }}</span>
      </div>
      <div
        class="points"
        data-test="mes-points"
      >
        <button
          v-for="p in filtered"
          :key="p.id"
          class="ptCard"
          :class="{ on: p.id === picked }"
          @click="pick(p)"
        >
          <span class="ptName">{{ p.name }}</span>
          <span class="ptMeta">{{ p.lineId }} · {{ p.format }}<template v-if="p.unit"> · {{ p.unit }}</template></span>
          <span
            class="ptCap"
            :class="{ off: !p.hasHistory }"
          >{{ p.hasHistory ? $t('data.mes.hasHistory') : $t('data.mes.noHistory') }}</span>
        </button>
        <p
          v-if="!filtered.length"
          class="empty"
        >
          {{ $t('data.mes.empty') }}
        </p>
      </div>
    </div>

    <!-- req → res 调试台 -->
    <div
      v-if="picked"
      class="card"
    >
      <h3 class="sec">
        {{ $t('data.mes.console', { name: pickedName }) }}
      </h3>
      <div class="row">
        <label class="lbl">{{ $t('data.mes.from') }}</label>
        <input
          v-model="fromText"
          type="datetime-local"
          class="input"
        >
        <label class="lbl">{{ $t('data.mes.to') }}</label>
        <input
          v-model="toText"
          type="datetime-local"
          class="input"
        >
        <label class="lbl">{{ $t('data.mes.rows') }}</label>
        <input
          v-model="maxRows"
          type="number"
          min="1"
          max="5000"
          class="input numIn"
        >
        <button
          class="pill-btn primary"
          data-test="mes-preview"
          :disabled="busy"
          @click="doPreview"
        >
          {{ busy ? $t('data.mes.previewing') : $t('data.mes.preview') }}
        </button>
      </div>
      <p class="hint">
        {{ $t('data.mes.guards') }}
      </p>
      <p
        v-if="error"
        class="err"
        data-test="mes-error"
      >
        {{ error }}
      </p>

      <template v-if="result">
        <!-- req 回显(脱敏) -->
        <div
          class="blk"
          data-test="mes-req"
        >
          <h4 class="sub">
            {{ $t('data.mes.reqEcho') }}
          </h4>
          <p class="mono req">
            {{ result.requestEcho.method }} {{ result.requestEcho.path }}
          </p>
          <p
            v-for="(v, k) in result.requestEcho.headers"
            :key="k"
            class="mono req"
          >
            {{ k }}: {{ v }}
          </p>
          <p
            v-for="(v, k) in result.requestEcho.query"
            :key="'q' + k"
            class="mono req"
          >
            {{ k }}={{ v }}
          </p>
        </div>
        <!-- 统计 + 采样 -->
        <div class="blk">
          <h4 class="sub">
            {{ $t('data.mes.stats') }}
          </h4>
          <p class="mono">
            {{ $t('data.mes.rowsGot', { n: result.totalRows }) }}<template v-if="result.stats.mean != null">
              · min {{ fmt(result.stats.min) }} / max {{ fmt(result.stats.max) }} / mean {{ fmt(result.stats.mean) }} / std {{ fmt(result.stats.std) }}
            </template>
            <template v-if="!result.complete">
              · {{ $t('data.mes.truncated') }}
            </template>
          </p>
          <p
            v-for="(s, i) in result.sample"
            :key="i"
            class="mono"
          >
            {{ s }}
          </p>
        </div>
        <!-- 字段字典 -->
        <div class="blk">
          <h4 class="sub">
            {{ $t('data.mes.dict') }}
          </h4>
          <p
            v-if="!result.dictionary.length"
            class="hint"
          >
            {{ $t('data.mes.dictEmpty') }}
          </p>
          <p
            v-for="d in result.dictionary"
            :key="d.field"
            class="mono"
          >
            - {{ d.field }}<template v-if="d.label">
              [{{ d.label }}]
            </template><template v-if="d.unit">
              ({{ d.unit }})
            </template><template v-if="d.description">
              — {{ d.description }}
            </template>
          </p>
        </div>
      </template>
    </div>
    <p
      v-else
      class="empty big"
    >
      {{ $t('data.mes.pickPoint') }}
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * 数据管理台 · MES 接口面板(plan1 M1):
 * 点位目录(可读产线上的 mes-rest 节点)→ req 构造(from/to/max_rows)→
 * 结构化 res 面板(统计+≤3 行采样+字段字典+脱敏 req 回显)。护栏在服务端。
 */
import { computed, onMounted, ref } from 'vue'
import { apiFetch } from '@/app/composables/workshop/apiClient'
import { apiErrorMessage } from '@/app/utils/api-error'

interface MesPoint { id: string, name: string, lineId: string, unit: string, hasHistory: boolean, format: string }
interface Preview {
  nodeName: string
  format: string
  totalRows: number
  complete: boolean
  stats: { min: number | null, max: number | null, mean: number | null, std: number | null }
  sample: string[]
  dictionary: Array<{ field: string, label?: string, unit?: string, description?: string }>
  requestEcho: { method: string, path: string, query: Record<string, string>, headers: Record<string, string> }
}

const points = ref<MesPoint[]>([])
const filter = ref('')
const picked = ref('')
const fromText = ref('')
const toText = ref('')
const maxRows = ref<number | string>(1000)
const busy = ref(false)
const error = ref('')
const result = ref<Preview | null>(null)

const filtered = computed(() => {
  const f = filter.value.trim().toLowerCase()
  return f ? points.value.filter(p => `${p.name} ${p.lineId} ${p.format}`.toLowerCase().includes(f)) : points.value
})
const pickedName = computed(() => points.value.find(p => p.id === picked.value)?.name ?? picked.value)

const fmt = (v: number | null): string => (v == null || !Number.isFinite(v) ? '-' : String(Number(v.toFixed(4))))

function pick(p: MesPoint): void {
  picked.value = p.id
  result.value = null
  error.value = ''
  const now = Date.now()
  fromText.value = new Date(now - 3600_000).toISOString().slice(0, 16)
  toText.value = new Date(now).toISOString().slice(0, 16)
}

async function doPreview(): Promise<void> {
  busy.value = true
  error.value = ''
  result.value = null
  try {
    const fromIso = fromText.value ? new Date(fromText.value).toISOString() : new Date(Date.now() - 3600_000).toISOString()
    const toIso = toText.value ? new Date(toText.value).toISOString() : new Date().toISOString()
    result.value = await apiFetch<Preview>({
      base: '/api/workshop/mes/preview',
      init: { method: 'POST', body: JSON.stringify({ node_id: picked.value, from: fromIso, to: toIso, max_rows: Number(maxRows.value) || 1000 }) },
    })
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
  finally {
    busy.value = false
  }
}

onMounted(async () => {
  try {
    const r = await apiFetch<{ points: MesPoint[] }>({ base: '/api/workshop/mes/points', retries: 1 })
    points.value = r.points ?? []
  }
  catch (e) {
    error.value = apiErrorMessage(e)
  }
})
</script>

<style scoped>
.mesp { display: flex; flex-direction: column; gap: 12px; }
.card { background: var(--panel, #fff); border: 1px solid var(--border, rgba(127,127,127,.25)); border-radius: 10px; padding: 12px 14px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.sec { font-size: 13px; font-weight: 600; margin: 0; }
.sub { font-size: 12px; font-weight: 600; margin: 0 0 4px; }
.lbl { font-size: 12px; color: var(--ink-soft, #666); }
.input { border: 1px solid var(--border, rgba(127,127,127,.35)); border-radius: 6px; padding: 4px 8px; background: transparent; color: var(--ink, #222); font-size: 12px; }
.numIn { width: 90px; }
.points { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.ptCard { border: 1px solid var(--border, rgba(127,127,127,.3)); border-radius: 8px; padding: 6px 10px; background: transparent; cursor: pointer; text-align: left; display: flex; flex-direction: column; gap: 2px; min-width: 180px; }
.ptCard.on { border-color: #4a6b57; box-shadow: 0 0 0 1px #4a6b57; }
.ptName { font-size: 12px; font-weight: 600; color: var(--ink, #222); }
.ptMeta { font-size: 11px; color: var(--ink-faint, #888); }
.ptCap { font-size: 11px; color: #3f7d54; }
.ptCap.off { color: #b3714f; }
.empty { color: var(--ink-faint, #999); font-size: 12px; }
.empty.big { padding: 40px 0; text-align: center; }
.hint { font-size: 12px; color: var(--ink-faint, #888); margin: 6px 0 0; }
.err { font-size: 12px; color: #b3403a; white-space: pre-wrap; }
.blk { margin-top: 12px; border-top: 1px dashed var(--border, rgba(127,127,127,.25)); padding-top: 8px; }
.mono { font-size: 12px; font-variant-numeric: tabular-nums; margin: 2px 0; }
.req { color: var(--ink-soft, #555); }
</style>
