/**
 * 产线操作页的数据面:统一操作流水(REST 快照为底 + WS 实时帧合并)与操作分类。
 *
 * 数据权威在 server audit_log:GET /api/workshop/ops-logs 按维度查询(useOpsLog.fetchLogs);
 * 实时面是 WS ops.log 帧(useOpsLog.recent 环形缓冲)—— 按当前筛选前插进流水,与快照
 * 以 at+actor+action+summary 去重。分类语义与 workshop 操作面板(operation-events)同源:
 * 写控 / 数采 / 建模 / 配方 / 回退 / 告警 / 产线 / 人工 / 系统。
 */
import { computed, reactive, ref, watch } from 'vue'
import { useOpsLog, type OpsLogRow } from '@/app/composables/workshop/useOpsLog'

/** 流水分类(渲染配色/图标的唯一键;文案走 operations.cat.*) */
export type OperationCategory = 'write' | 'daq' | 'aml' | 'recipe' | 'rollback' | 'alarm' | 'line' | 'manual' | 'system'

export const OPERATION_KINDS: OperationCategory[] = ['write', 'recipe', 'rollback', 'daq', 'alarm', 'aml', 'line', 'manual', 'system']

/** REST kind 筛选值:与 audit_log.kind 对齐(aml 是建模动作的 kind,其余按 kind 直查) */
export const OPERATION_KIND_FILTERS = ['write', 'recipe', 'rollback', 'daq', 'alarm', 'aml', 'manual', 'line', 'system'] as const

/** 行 → 分类:kind 优先,action 前缀兜底(audit_log 的 kind 与 action 是两套自由面) */
export function classifyOpsRow(row: OpsLogRow): OperationCategory {
  if (row.kind === 'write' || row.action.startsWith('dcw.write')) return 'write'
  if (row.kind === 'alarm' || row.action.startsWith('daq.alarm')) return 'alarm'
  if (row.kind === 'aml' || row.action.startsWith('aml.')) return 'aml'
  if (row.kind === 'rollback' || row.action.startsWith('rollback')) return 'rollback'
  if (row.kind === 'recipe' || row.action.startsWith('recipe')) return 'recipe'
  if (row.kind === 'daq' || row.action.startsWith('daq.')) return 'daq'
  if (row.kind === 'line' || row.action.startsWith('line.')) return 'line'
  if (row.kind === 'manual') return 'manual'
  return 'system'
}

/** 分类 → 图标(tabler);与 workshop 面板的图标语义保持一族 */
export const CATEGORY_ICONS: Record<OperationCategory, string> = {
  write: 'i-tabler-bolt',
  daq: 'i-tabler-activity',
  aml: 'i-tabler-flask',
  recipe: 'i-tabler-clipboard-list',
  rollback: 'i-tabler-arrow-back-up',
  alarm: 'i-tabler-alert-triangle',
  line: 'i-tabler-player-play',
  manual: 'i-tabler-user',
  system: 'i-tabler-server',
}

export interface OperationDiff {
  prev: number | null
  next: number | null
  ok: boolean
  message: string
}

/** 写控行的结构化变更(detailJson.eng/prevValue;其余动作无 diff) */
export function diffOf(row: OpsLogRow): OperationDiff | null {
  if (!row.detailJson) return null
  try {
    const d = JSON.parse(row.detailJson) as Record<string, unknown>
    const eng = Number(d.eng)
    const prev = Number(d.prevValue)
    if (!Number.isFinite(eng) && !Number.isFinite(prev)) return null
    return {
      prev: Number.isFinite(prev) ? prev : null,
      next: Number.isFinite(eng) ? eng : null,
      ok: d.ok !== false,
      message: String(d.message ?? ''),
    }
  }
  catch {
    return null
  }
}

export function useOperationsFeed() {
  const opsLog = useOpsLog()

  const q = reactive({ lineId: '', kind: '', actorKind: '', text: '' })
  const hasFilter = computed(() => Boolean(q.lineId || q.kind || q.actorKind || q.text.trim()))

  /** 统一流水(新→旧):REST 快照为底,WS 实时帧按当前筛选合并前插 */
  const rows = ref<OpsLogRow[]>([])
  const rowKey = (r: OpsLogRow) => `${r.at}|${r.actor}|${r.action}|${r.summary}`
  let seen = new Set<string>()

  function reindex(): void {
    seen = new Set(rows.value.map(rowKey))
  }

  /** 实时帧入流水:过当前筛选;容量封顶防长跑膨胀 */
  function acceptFrame(r: OpsLogRow): void {
    const key = rowKey(r)
    if (seen.has(key)) return
    if (q.lineId && r.lineId !== q.lineId) return
    if (q.kind && r.kind !== q.kind) return
    if (q.actorKind && r.actorKind !== q.actorKind) return
    const needle = q.text.trim().toLowerCase()
    if (needle && !`${r.summary} ${r.action} ${r.actorName}`.toLowerCase().includes(needle)) return
    seen.add(key)
    rows.value.unshift(r)
    if (rows.value.length > 300) rows.value.splice(300)
  }

  watch(() => opsLog.recent.length, () => {
    for (const r of opsLog.recent) acceptFrame(r)
  })

  async function doQuery(): Promise<void> {
    await opsLog.fetchLogs({
      lineId: q.lineId || undefined,
      kind: q.kind || undefined,
      actorKind: q.actorKind || undefined,
      q: q.text.trim() || undefined,
      limit: 200,
    })
    rows.value.splice(0, rows.value.length, ...opsLog.results)
    reindex()
  }

  function resetFilters(): void {
    q.lineId = ''
    q.kind = ''
    q.actorKind = ''
    q.text = ''
    void doQuery()
  }

  /** 分类计数(当前流水;统计条用) */
  const stats = computed(() => {
    const out = {} as Record<OperationCategory, number>
    for (const r of rows.value) {
      const c = classifyOpsRow(r)
      out[c] = (out[c] ?? 0) + 1
    }
    return out
  })

  return { q, hasFilter, rows, stats, doQuery, resetFilters, acceptFrame }
}
