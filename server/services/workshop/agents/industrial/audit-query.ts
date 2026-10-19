/**
 * 审计日志查询共用骨架(ops_log / recipe_log 两工具收敛而来):
 * 窗口参数归一(minutes / from / to / limit)与多产线扇出去重。
 * audit 仓储为内存/SQLite repo 的 query 接口(结构化过滤参数,非 SQL 拼接)。
 */
import type { getOps } from '../../ops/ops'

export type AuditRepo = NonNullable<ReturnType<typeof getOps>>['audit']
export type AuditQuery = Parameters<AuditRepo['query']>[0]
export type AuditRow = ReturnType<AuditRepo['query']>[number]

export interface OpsWindow {
  /** 回看分钟数(仅在未显式给 from 时用于计算窗口起点;输出文案也用它) */
  minutes: number
  /** 返回条数上限(1..100) */
  limit: number
  /** 窗口起点(ISO,配置时区偏移格式;恒有值) */
  from: string
  /** 窗口终点(ISO;缺省 = 现在/不限) */
  to?: string
  /** 参数错误(非空时调用方应直接回包 isError,不执行查询) */
  error?: string
}

function normalizeTime(value: string | undefined, label: string): { iso?: string, error?: string } {
  const text = String(value ?? '').trim()
  if (!text) return {}
  const ms = Date.parse(text)
  if (!Number.isFinite(ms))
    return { error: `${label} 不是合法时间: ${text}(示例 2026-10-19T08:00:00+08:00)` }
  return { iso: new Date(ms).toISOString() }
}

/** 查询窗口参数归一:显式 from/to 优先,否则按 minutes 回看;非法时间给出可行动错误。 */
export function windowOf(args: {
  minutes?: number | string
  limit?: number | string
  from?: string
  to?: string
}): OpsWindow {
  const minutes = Number(args.minutes) || 1440
  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100))
  const fromArg = normalizeTime(args.from, 'from')
  if (fromArg.error) return { minutes, limit, from: '', error: fromArg.error }
  const toArg = normalizeTime(args.to, 'to')
  if (toArg.error) return { minutes, limit, from: '', error: toArg.error }
  const from = fromArg.iso ?? new Date(Date.now() - minutes * 60_000).toISOString()
  const to = toArg.iso
  if (to && Date.parse(from) > Date.parse(to)) {
    return { minutes, limit, from, to, error: `时间区间无效:from(${args.from ?? from}) 晚于 to(${args.to ?? to})` }
  }
  return { minutes, limit, from, ...(to ? { to } : {}) }
}

/** 多产线扇出查询(每产线可发一条或多条过滤参数)+ id 去重(排序/过滤/截断由调用方按需做) */
export function fanoutQuery(audit: AuditRepo, lineIds: string[], queryOf: (lineId: string) => AuditQuery | AuditQuery[]): AuditRow[] {
  const byId = new Map<string, AuditRow>()
  for (const lid of lineIds) {
    const qs = queryOf(lid)
    for (const q of Array.isArray(qs) ? qs : [qs]) {
      for (const r of audit.query(q))
        byId.set(String(r.id), r)
    }
  }
  return [...byId.values()]
}
