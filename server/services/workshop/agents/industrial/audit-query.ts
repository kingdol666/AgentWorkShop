/**
 * 审计日志查询共用骨架(ops_log / recipe_log 两工具收敛而来):
 * 窗口参数归一(minutes/limit/from)与多产线扇出去重。
 * audit 仓储为内存/SQLite repo 的 query 接口(结构化过滤参数,非 SQL 拼接)。
 */
import type { getOps } from '../../ops/ops'

export type AuditRepo = NonNullable<ReturnType<typeof getOps>>['audit']
export type AuditQuery = Parameters<AuditRepo['query']>[0]
export type AuditRow = ReturnType<AuditRepo['query']>[number]

/** 查询窗口参数(minutes 缺省 1440;limit 缺省 20、上限 100;from = 窗口起点 ISO) */
export function windowOf(args: { minutes?: number | string, limit?: number | string }): { minutes: number, limit: number, from: string } {
  const minutes = Number(args.minutes) || 1440
  const limit = Math.min(Number(args.limit) || 20, 100)
  return { minutes, limit, from: new Date(Date.now() - minutes * 60_000).toISOString() }
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
