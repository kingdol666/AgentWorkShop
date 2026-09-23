/**
 * 审计日志页的查询态:维度筛选(产线 → 产品 → Recipe + 来源/分类/关键词)与行详情展开。
 *
 * 筛选态是页面唯一副本:级联选项、重置按钮的显隐都从它派生。
 * 展开态与查询同源 —— 每次发起查询都要收起详情行,否则旧行的展开会落在新结果集的同一行上。
 * WS 实时轨(useOpsLog.recent)只供页头计数,与这里的结果集(results)互不干扰。
 */
import { computed, reactive, ref } from 'vue'
import { useOpsLog, type OpsLogRow } from '@/app/composables/workshop/useOpsLog'

/** 操作分类枚举(与 server audit_log.kind 对齐;下拉选项取它,文案走 logs.kind.*) */
export const LOG_KINDS = ['write', 'manual', 'alarm', 'line', 'recipe', 'rollback', 'daq', 'system'] as const

export function useLogsQuery() {
  const opsLog = useOpsLog()

  const q = reactive({ lineId: '', productId: '', recipeId: '', actorKind: '', kind: '', text: '' })
  /** 当前展开详情的行(audit_log 行 id;null = 全部收起) */
  const expandedId = ref<number | null>(null)

  const hasFilter = computed(() => !!(q.lineId || q.productId || q.recipeId || q.actorKind || q.kind || q.text.trim()))

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
    expandedId.value = null
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

  /** 行详情行内展开(同一行再次点击即收起) */
  function toggleRow(row: OpsLogRow): void {
    expandedId.value = expandedId.value === row.id ? null : row.id
  }

  return { q, hasFilter, expandedId, doQuery, resetFilters, toggleRow }
}
