/**
 * 产线日志页的查询态:维度筛选(产线 → 产品 → Recipe + 来源/分类/关键词/时间区间)与行详情展开。
 *
 * 筛选态是页面唯一副本:级联选项、重置按钮的显隐都从它派生。
 * 展开态与查询同源 —— 每次发起查询都要收起详情行,否则旧行的展开会落在新结果集的同一行上。
 * WS 实时轨(useOpsLog.recent)只供页头计数,与这里的结果集(results)互不干扰。
 */
import { computed, reactive, ref } from 'vue'
import { message } from 'ant-design-vue'
import { useOpsLog, type OpsLogRow } from '@/app/composables/workshop/useOpsLog'

/** 操作分类枚举(与 server audit_log.kind 对齐;下拉选项取它,文案走 logs.kind.*) */
export const LOG_KINDS = ['write', 'manual', 'alarm', 'line', 'recipe', 'rollback', 'daq', 'system'] as const

/** 严重级枚举(2026-10-08 写控 ACK 鉴定;error=写入失败 红 / warn=未证实 黄 / info=缺省) */
export const LOG_LEVELS = ['info', 'warn', 'error'] as const

/** datetime-local 值(浏览器本地时间)→ 绝对 ISO;空值/非法值返回 undefined */
function isoOf(local: string): string | undefined {
  const text = local.trim()
  if (!text) return undefined
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

export function useLogsQuery() {
  const opsLog = useOpsLog()
  const { t: tt } = useI18n()

  /** from/to 是 datetime-local 字符串(如 2026-10-19T08:00),查询时再转 ISO */
  const q = reactive({ lineId: '', productId: '', recipeId: '', actorKind: '', kind: '', level: '', from: '', to: '', text: '' })
  /** 当前展开详情的行(audit_log 行 id;null = 全部收起) */
  const expandedId = ref<number | null>(null)

  const hasFilter = computed(() => !!(q.lineId || q.productId || q.recipeId || q.actorKind || q.kind || q.level || q.from || q.to || q.text.trim()))

  function doQuery(): void {
    const from = isoOf(q.from)
    const to = isoOf(q.to)
    if ((q.from && !from) || (q.to && !to)) {
      message.error(tt('logs.invalidTime'))
      return
    }
    if (from && to && Date.parse(from) > Date.parse(to)) {
      message.error(tt('logs.invalidRange'))
      return
    }
    void opsLog.fetchLogs({
      lineId: q.lineId,
      productId: q.productId,
      recipeId: q.recipeId,
      actorKind: q.actorKind,
      kind: q.kind,
      level: q.level,
      from,
      to,
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
    q.level = ''
    q.from = ''
    q.to = ''
    q.text = ''
    doQuery()
  }

  /** 行详情行内展开(同一行再次点击即收起) */
  function toggleRow(row: OpsLogRow): void {
    expandedId.value = expandedId.value === row.id ? null : row.id
  }

  return { q, hasFilter, expandedId, doQuery, resetFilters, toggleRow }
}
