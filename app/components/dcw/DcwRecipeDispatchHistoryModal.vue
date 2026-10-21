<script setup lang="ts">
/**
 * 配方下发历史 —— recipe 管理页内直接查看该配方的产线域审计
 * (创建/更新/试验/正式下发/逐参数 ACK/回退/开跑整批下发)。
 * 数据源与 Agent recipe_log 同源:GET /api/workshop/ops-logs?scope=line&recipeId=...
 */
import { ref, watch } from 'vue'
import { apiFetch } from '../../composables/workshop/apiClient'

const props = defineProps<{
  open: boolean
  recipeId: string
  recipeName: string
}>()

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

interface OpsRow {
  id?: string
  at: string
  action: string
  actorName?: string
  actor?: string
  actorKind?: string
  summary?: string
  lineId?: string
  productId?: string
  recipeId?: string
  level?: string
}

const rows = ref<OpsRow[]>([])
const loading = ref(false)
const error = ref('')

const ACTION_LABEL: Record<string, string> = {
  'recipe.create': '创建配方',
  'recipe.update': '更新配方',
  'recipe.update.agent': 'Agent 更新配方',
  'recipe.revert': '配方回退',
  'recipe.trial': '试验下发',
  'recipe.apply': '正式下发',
  'recipe.dispatch.ack': '下发回执',
  'recipe.propose': '方案审批',
  'recipe.mark-good': '标记良好批次',
  'recipe.rollback-good': '恢复良好批次',
  'line.start': '开跑整批下发',
  'line.stop': '停线',
  'dcw.write.recipe': '逐参数写入',
  'dcw.write.agent': '逐参数写入',
}

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action
}

function sourceLabel(row: OpsRow): string {
  return { agent: 'Agent', user: '用户', system: '系统' }[String(row.actorKind ?? '')] ?? String(row.actorKind ?? '-')
}

function fmtAt(iso: string): string {
  return String(iso ?? '').length >= 19 ? String(iso).slice(5, 19).replace('T', ' ') : String(iso ?? '')
}

async function load(): Promise<void> {
  if (!props.recipeId) return
  loading.value = true
  error.value = ''
  try {
    const res = await apiFetch<{ logs?: OpsRow[] }>({
      base: '/api/workshop/ops-logs',
      path: `?scope=line&recipeId=${encodeURIComponent(props.recipeId)}&limit=100`,
    })
    // 只保留配方作业面(创建/更新/试验/下发/ACK/回退/开跑/停线/逐参数写),
    // 不要把同样带 recipeId 的告警/数采事件混进"下发历史"
    rows.value = (res?.logs ?? []).filter(r => /^recipe\./.test(r.action) || /^line\.(start|stop)$/.test(r.action) || /^dcw\.write\./.test(r.action))
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    rows.value = []
  }
  finally {
    loading.value = false
  }
}

watch(() => props.open, (open) => {
  if (open) void load()
}, { immediate: true })

function close(): void {
  emit('update:open', false)
}
</script>

<template>
  <div
    v-if="open"
    class="modal-mask"
    @click.self="close"
  >
    <div class="modal recipe-history-modal">
      <div class="modal-hd">
        <h3>{{ $t('dcwDetail.dispatchHistTitle') }} · {{ recipeName || recipeId }}</h3>
        <button
          class="mini-btn"
          @click="close"
        >
          {{ $t('dcwDetail.closeBtn') }}
        </button>
      </div>
      <p class="modal-sub">
        {{ $t('dcwDetail.dispatchHistSub') }}
      </p>
      <p
        v-if="loading"
        class="modal-sub"
      >
        {{ $t('dcwDetail.histLoading') }}
      </p>
      <p
        v-else-if="error"
        class="banner bad"
      >
        {{ error }}
      </p>
      <p
        v-else-if="rows.length === 0"
        class="modal-sub"
      >
        {{ $t('dcwDetail.dispatchHistEmpty') }}
      </p>
      <table
        v-else
        class="nodes-table"
      >
        <thead>
          <tr>
            <th>{{ $t('dcwDetail.dispatchHistTime') }}</th>
            <th>{{ $t('dcwDetail.dispatchHistAction') }}</th>
            <th>{{ $t('dcwDetail.dispatchHistSource') }}</th>
            <th>{{ $t('dcwDetail.dispatchHistSummary') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, i) in rows"
            :key="row.id ?? `${row.at}-${i}`"
          >
            <td class="mono">
              {{ fmtAt(row.at) }}
            </td>
            <td>
              <span class="st-pill">{{ actionLabel(row.action) }}</span>
            </td>
            <td>{{ sourceLabel(row) }} / {{ row.actorName || row.actor || '-' }}</td>
            <td class="summary">
              {{ row.summary || '-' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(8, 12, 18, 0.62);
}
.modal {
  width: min(980px, 96vw);
  max-height: 82vh;
  overflow: auto;
  padding: 18px 20px;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
}
.modal-hd {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
}
.modal-hd h3 {
  margin: 0;
  font-size: 16px;
}
.modal-sub {
  margin: 8px 0 12px;
  font-size: 12px;
  color: var(--ink-faint);
}
.nodes-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.nodes-table th,
.nodes-table td {
  padding: 8px 10px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--divider-hair);
}
.nodes-table th {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.mono {
  font-family: var(--font-mono);
  white-space: nowrap;
}
.summary {
  overflow-wrap: anywhere;
}
.st-pill {
  display: inline-block;
  padding: 2px 8px;
  font-size: 11.5px;
  white-space: nowrap;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
}
.banner.bad {
  padding: 9px 12px;
  font-size: 12.5px;
  color: var(--tone-danger-dot);
  background: var(--tone-danger-bg);
  border: 1px solid color-mix(in srgb, var(--tone-danger-dot) 40%, transparent);
  border-radius: var(--radius-chip);
}
</style>
