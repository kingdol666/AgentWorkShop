<template>
  <div class="page">
    <!-- 页头:标题 + 手动记录入口 -->
    <header class="head">
      <div>
        <h1 class="h1">
          <span class="i-tabler-list-details" />
          {{ $t('logs.title') }}
        </h1>
        <p class="sub">
          {{ $t('logs.sub') }}
        </p>
      </div>
      <div class="head-actions">
        <span
          class="live-dot"
          :title="$t('logs.liveHint')"
        /><span class="live-txt mono">{{ $t('logs.live') }} {{ opsLog.recent.length }}</span>
        <button
          class="pill-btn"
          @click="openManual"
        >
          <span class="i-tabler-plus" />
          {{ $t('logs.manual') }}
        </button>
      </div>
    </header>

    <!-- 维度筛选:产线 → 产品 → Recipe 级联 + 来源/分类/关键词 -->
    <section class="filter-card">
      <label class="flt">
        <span>{{ $t('logs.fLine') }}</span>
        <select
          v-model="q.lineId"
          class="inp-sel"
          @change="q.productId = ''; q.recipeId = ''"
        >
          <option value="">
            {{ $t('logs.all') }}
          </option>
          <option
            v-for="l in dcw.lines"
            :key="l.id"
            :value="l.id"
          >
            {{ l.name }}
          </option>
        </select>
      </label>
      <label class="flt">
        <span>{{ $t('logs.fProduct') }}</span>
        <select
          v-model="q.productId"
          class="inp-sel"
          @change="q.recipeId = ''"
        >
          <option value="">
            {{ $t('logs.all') }}
          </option>
          <option
            v-for="p in productsOfLine"
            :key="p.id"
            :value="p.id"
          >
            {{ p.name }}
          </option>
        </select>
      </label>
      <label class="flt">
        <span>Recipe</span>
        <select
          v-model="q.recipeId"
          class="inp-sel"
        >
          <option value="">
            {{ $t('logs.all') }}
          </option>
          <option
            v-for="r in recipesOfScope"
            :key="r.id"
            :value="r.id"
          >
            {{ r.name }}
          </option>
        </select>
      </label>
      <label class="flt">
        <span>{{ $t('logs.fSource') }}</span>
        <select
          v-model="q.actorKind"
          class="inp-sel"
        >
          <option value="">
            {{ $t('logs.all') }}
          </option>
          <option value="user">
            {{ $t('logs.src.user') }}
          </option>
          <option value="agent">
            Agent
          </option>
          <option value="system">
            {{ $t('logs.src.system') }}
          </option>
        </select>
      </label>
      <label class="flt">
        <span>{{ $t('logs.fKind') }}</span>
        <select
          v-model="q.kind"
          class="inp-sel"
        >
          <option value="">
            {{ $t('logs.all') }}
          </option>
          <option
            v-for="k in KINDS"
            :key="k"
            :value="k"
          >
            {{ $t(`logs.kind.${k}`) }}
          </option>
        </select>
      </label>
      <label class="flt flt-grow">
        <span>{{ $t('logs.fKeyword') }}</span>
        <input
          v-model="q.text"
          class="inp-sel"
          type="search"
          :placeholder="$t('logs.fKeywordPh')"
          @keydown.enter="doQuery"
        >
      </label>
      <button
        class="pill-btn"
        :disabled="opsLog.loading.list"
        @click="doQuery"
      >
        <span class="i-tabler-search" />
        {{ $t('logs.query') }}
      </button>
      <button
        v-if="hasFilter"
        class="mini-btn"
        @click="resetFilters"
      >
        {{ $t('logs.reset') }}
      </button>
    </section>

    <!-- 结果表:时间/来源/操作者/分类/摘要/归属维度/详情 -->
    <section class="table-card">
      <p
        v-if="opsLog.error.list"
        class="err"
      >
        {{ opsLog.error.list }}
      </p>
      <table class="log-table">
        <thead>
          <tr>
            <th class="th-time">
              {{ $t('logs.thTime') }}
            </th>
            <th class="th-src">
              {{ $t('logs.fSource') }}
            </th>
            <th>{{ $t('logs.thActor') }}</th>
            <th class="th-kind">
              {{ $t('logs.fKind') }}
            </th>
            <th>{{ $t('logs.thSummary') }}</th>
            <th class="th-scope">
              {{ $t('logs.thScope') }}
            </th>
            <th class="th-detail">
              {{ $t('logs.thDetail') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in opsLog.results"
            :key="`${row.id}-${row.at}`"
          >
            <td class="mono dim">
              {{ fmtTime(row.at) }}
            </td>
            <td>
              <span
                class="src-badge"
                :class="row.actorKind"
              >{{ srcLabel(row.actorKind) }}</span>
            </td>
            <td class="actor">
              {{ row.actorName || row.actor || '—' }}
            </td>
            <td>
              <span
                class="kind-chip"
                :class="row.kind"
              >{{ kindLabel(row.kind) }}</span>
            </td>
            <td class="summary">
              {{ row.summary }}
              <small class="mono dim action">{{ row.action }}</small>
            </td>
            <td class="scope">
              <span
                v-if="lineName(row.lineId)"
                class="scope-chip"
                :title="$t('logs.fLine')"
              >{{ lineName(row.lineId) }}</span>
              <span
                v-if="productName(row.productId)"
                class="scope-chip"
                :title="$t('logs.fProduct')"
              >{{ productName(row.productId) }}</span>
              <span
                v-if="recipeName(row.recipeId)"
                class="scope-chip"
                :title="'Recipe'"
              >{{ recipeName(row.recipeId) }}</span>
              <span
                v-if="!row.lineId && !row.productId && !row.recipeId"
                class="dim"
              >—</span>
            </td>
            <td class="detail-cell">
              <button
                v-if="row.detailJson && row.detailJson !== '{}'"
                class="mini-btn"
                @click="toggle(row)"
              >
                {{ expanded === row ? $t('logs.fold') : $t('logs.expand') }}
              </button>
              <span
                v-else
                class="dim"
              >—</span>
            </td>
          </tr>
          <tr>
            <td
              v-if="opsLog.results.length === 0"
              colspan="7"
              class="empty"
            >
              <template v-if="opsLog.loading.list">
                {{ $t('logs.loading') }}
              </template>
              <template v-else>
                {{ $t('logs.empty') }}
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <pre
        v-if="expanded"
        class="detail-box mono"
      >{{ pretty(expanded.detailJson) }}</pre>
    </section>

    <!-- 人工记录弹窗 -->
    <Teleport to="body">
      <div
        v-if="manualOpen"
        class="modal-mask"
        @click.self="manualOpen = false"
      >
        <div class="modal">
          <h3 class="m-title">
            {{ $t('logs.manual') }}
          </h3>
          <label class="m-f">
            <span>{{ $t('logs.mSummary') }} *</span>
            <textarea
              v-model="manual.summary"
              rows="3"
              :placeholder="$t('logs.mSummaryPh')"
            />
          </label>
          <div class="m-grid">
            <label class="m-f">
              <span>{{ $t('logs.fLine') }}</span>
              <select
                v-model="manual.lineId"
                class="inp-sel"
                @change="manual.productId = ''; manual.recipeId = ''"
              >
                <option value="">
                  {{ $t('logs.all') }}
                </option>
                <option
                  v-for="l in dcw.lines"
                  :key="l.id"
                  :value="l.id"
                >
                  {{ l.name }}
                </option>
              </select>
            </label>
            <label class="m-f">
              <span>{{ $t('logs.fProduct') }}</span>
              <select
                v-model="manual.productId"
                class="inp-sel"
                @change="manual.recipeId = ''"
              >
                <option value="">
                  {{ $t('logs.all') }}
                </option>
                <option
                  v-for="p in productsOfLine"
                  :key="p.id"
                  :value="p.id"
                >
                  {{ p.name }}
                </option>
              </select>
            </label>
            <label class="m-f">
              <span>Recipe</span>
              <select
                v-model="manual.recipeId"
                class="inp-sel"
              >
                <option value="">
                  {{ $t('logs.all') }}
                </option>
                <option
                  v-for="r in recipesOfScope"
                  :key="r.id"
                  :value="r.id"
                >
                  {{ r.name }}
                </option>
              </select>
            </label>
          </div>
          <p
            v-if="opsLog.error.post"
            class="err"
          >
            {{ opsLog.error.post }}
          </p>
          <div class="m-actions">
            <button
              class="ghost-btn"
              @click="manualOpen = false"
            >
              {{ $t('common.cancel') }}
            </button>
            <button
              class="pill-btn"
              :disabled="opsLog.loading.posting || !manual.summary.trim()"
              @click="submitManual"
            >
              {{ $t('logs.mSubmit') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { useOpsLog, type OpsLogRow } from '@/app/composables/workshop/useOpsLog'

const tt = (k: string) => useNuxtApp().$i18n.t(k) as string

const dcw = useDcwStream()
const ws = useWorkshopWs()
const opsLog = useOpsLog()

const KINDS = ['write', 'manual', 'alarm', 'line', 'recipe', 'rollback', 'daq', 'system'] as const

const q = reactive({ lineId: '', productId: '', recipeId: '', actorKind: '', kind: '', text: '' })
const expanded = ref<OpsLogRow | null>(null)
const manualOpen = ref(false)
const manual = reactive({ summary: '', lineId: '', productId: '', recipeId: '' })

const hasFilter = computed(() => !!(q.lineId || q.productId || q.recipeId || q.actorKind || q.kind || q.text.trim()))
const productsOfLine = computed(() => dcw.products.filter(p => !q.lineId || p.lineId === q.lineId))
const recipesOfScope = computed(() => dcw.recipes.filter(r =>
  (!q.lineId || r.lineId === q.lineId) && (!q.productId || r.productId === q.productId)))

function doQuery(): void {
  void opsLog.fetchLogs({
    lineId: q.lineId,
    productId: q.productId,
    recipeId: q.recipeId,
    actorKind: q.actorKind,
    kind: q.kind,
    q: q.text.trim(),
    limit: 300,
  })
  expanded.value = null
}

function resetFilters(): void {
  q.lineId = ''
  q.productId = ''
  q.recipeId = ''
  q.actorKind = ''
  q.kind = ''
  q.text = ''
  doQuery()
}

function openManual(): void {
  manual.summary = ''
  manual.lineId = q.lineId
  manual.productId = q.productId
  manual.recipeId = q.recipeId
  manualOpen.value = true
}

async function submitManual(): Promise<void> {
  try {
    await opsLog.postManual({
      summary: manual.summary.trim(),
      lineId: manual.lineId,
      productId: manual.productId,
      recipeId: manual.recipeId,
    })
    message.success(tt('logs.mOk'))
    manualOpen.value = false
    doQuery()
  }
  catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

function toggle(row: OpsLogRow): void {
  expanded.value = expanded.value === row ? null : row
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  }
  catch {
    return json
  }
}

function fmtTime(at: string): string {
  const d = new Date(at)
  if (!Number.isFinite(d.getTime())) return at
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function srcLabel(kind: string): string {
  return kind === 'agent' ? 'Agent' : kind === 'user' ? tt('logs.src.user') : tt('logs.src.system')
}

function kindLabel(kind: string): string {
  return kind ? tt(`logs.kind.${kind}`) : '—'
}

function lineName(id: string): string {
  return dcw.lines.find(l => l.id === id)?.name ?? ''
}

function productName(id: string): string {
  return dcw.products.find(p => p.id === id)?.name ?? ''
}

function recipeName(id: string): string {
  return dcw.recipes.find(r => r.id === id)?.name ?? ''
}

onMounted(() => {
  ws.ensureConnected()
  opsLog.ensureLive()
  void dcw.load()
  doQuery()
})
</script>

<script lang="ts">
export default { name: 'OpsLogsPage' }
</script>

<style scoped>
.page { display: flex; flex-direction: column; gap: 12px; }
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.h1 { display: flex; gap: 8px; align-items: center; margin: 0; font-size: 20px; font-weight: 700; color: var(--ink); }
.sub { margin: 4px 0 0; font-size: 12.5px; color: var(--ink-faint); }
.head-actions { display: flex; gap: 10px; align-items: center; }
.live-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--tone-success-dot);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--tone-success-dot) 45%, transparent);
  animation: livePulse 2s ease-out infinite;
}
@keyframes livePulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--tone-success-dot) 45%, transparent); }
  70% { box-shadow: 0 0 0 8px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.live-txt { font-size: 11px; color: var(--ink-faint); }

.filter-card {
  display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end;
  padding: 10px 14px;
  background: var(--surface-glass);
  border: 1px solid var(--glass-line);
  border-radius: 10px;
  backdrop-filter: blur(var(--aurora-blur)) saturate(1.15);
  -webkit-backdrop-filter: blur(var(--aurora-blur)) saturate(1.15);
}
.flt { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-faint); }
.flt-grow { flex: 1 1 180px; }
.inp-sel {
  min-width: 0; padding: 6px 9px; font-size: 12.5px; color: var(--ink);
  background: var(--frost-bg);
  border: 1px solid var(--glass-line); border-radius: 7px; outline: none;
}
.inp-sel:focus { border-color: color-mix(in srgb, var(--tone-info-dot) 55%, transparent); }
.mini-btn {
  padding: 6px 11px; font-size: 12px; color: var(--ink-soft);
  background: var(--frost-bg); border: 1px solid var(--glass-line); border-radius: 7px;
  cursor: pointer;
}
.mini-btn:hover { border-color: color-mix(in srgb, var(--tone-info-dot) 45%, transparent); }

.table-card {
  background: var(--surface-glass);
  border: 1px solid var(--glass-line);
  border-radius: 10px;
  overflow: hidden;
  backdrop-filter: blur(var(--aurora-blur)) saturate(1.15);
  -webkit-backdrop-filter: blur(var(--aurora-blur)) saturate(1.15);
}
.err { margin: 0; padding: 8px 14px; font-size: 12px; color: var(--tone-danger-dot); }
.log-table { width: 100%; font-size: 12.5px; border-collapse: collapse; }
.log-table th {
  position: sticky; top: 0; z-index: 1;
  padding: 8px 10px; text-align: left; font-weight: 600; color: var(--ink-soft);
  background: var(--frost-bg);
  border-bottom: 1px solid var(--glass-line);
}
.log-table td {
  max-width: 380px; padding: 7px 10px; color: var(--ink-soft);
  border-bottom: 1px solid color-mix(in srgb, var(--glass-line) 55%, transparent);
  vertical-align: top;
}
.th-time, .th-src, .th-kind { white-space: nowrap; }
.th-detail { width: 72px; }
.actor { white-space: nowrap; }
.summary .action { display: block; font-size: 10px; color: var(--ink-faint); }
.scope { display: flex; flex-wrap: wrap; gap: 4px; max-width: 220px; }
.scope-chip {
  padding: 1px 7px; font-size: 10.5px; color: var(--ink-soft);
  background: var(--frost-bg); border-radius: 99px; white-space: nowrap;
}
.detail-cell { white-space: nowrap; }
.empty { padding: 22px 0 !important; color: var(--ink-faint); text-align: center; }
.detail-box {
  max-height: 260px; margin: 0; padding: 10px 14px; overflow: auto;
  font-size: 11.5px; color: var(--ink-soft);
  background: var(--frost-bg); border-top: 1px solid var(--glass-line);
}
.src-badge {
  display: inline-block; padding: 1px 8px; font-size: 10.5px;
  border: 1px solid var(--glass-line); border-radius: 99px; color: var(--ink-faint);
}
.src-badge.agent { color: var(--tone-info-dot); border-color: color-mix(in srgb, var(--tone-info-dot) 40%, transparent); }
.src-badge.user { color: var(--tone-success-dot); border-color: color-mix(in srgb, var(--tone-success-dot) 40%, transparent); }
.kind-chip {
  display: inline-block; padding: 1px 7px; font-size: 10.5px;
  color: var(--ink-soft); background: var(--frost-bg); border-radius: 5px; white-space: nowrap;
}
.kind-chip.alarm { color: var(--tone-danger-dot); background: var(--tone-danger-bg); }
.kind-chip.write { color: var(--tone-info-dot); }
.kind-chip.rollback { color: var(--tone-warning-dot); }
.kind-chip.manual { color: var(--tone-success-dot); }

.m-title { margin: 0 0 10px; font-size: 15px; color: var(--ink); }
.modal-mask {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  background: color-mix(in srgb, var(--ink) 32%, transparent);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}
.modal {
  width: min(560px, 94vw);
  padding: 16px 18px;
  background: var(--surface-glass);
  border: 1px solid var(--glass-line);
  border-radius: 12px;
  backdrop-filter: blur(calc(var(--aurora-blur) * 1.4)) saturate(1.2);
  -webkit-backdrop-filter: blur(calc(var(--aurora-blur) * 1.4)) saturate(1.2);
}
.m-f { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--ink-faint); }
.m-f textarea, .m-f .inp-sel {
  padding: 7px 9px; font-size: 12.5px; color: var(--ink);
  background: var(--frost-bg); border: 1px solid var(--glass-line); border-radius: 7px; outline: none;
  font-family: inherit; resize: vertical;
}
.m-f textarea:focus, .m-f .inp-sel:focus { border-color: color-mix(in srgb, var(--tone-info-dot) 55%, transparent); }
.m-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 8px; }
.m-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.ghost-btn {
  padding: 7px 14px; font-size: 12.5px; color: var(--ink-soft);
  background: transparent; border: 1px solid var(--glass-line); border-radius: 8px; cursor: pointer;
}
</style>
