/**
 * GET /api/workshop/ops-logs —— 产线日志查询(显式 scope 域过滤)。
 *
 * audit_log.scope 是写入时确定的域标识:line=产线域(必须有 line_id)/ system=全局审计。
 * 默认 scope=line:只返回产线域记录(下发/配方/回退/产线/数采/告警/人工记录);
 * scope=system 只返回登录/用户/设置/备份等全局事件;scope=all 返回两者(admin 安全审计)。
 *
 * 维度隔离:lineId / productId / recipeId(后两者可选)+ 来源 actorKind + 分类 kind
 * + 关键词 q + 时间区间。时间参数接受任意 Date.parse 可解析格式,统一归一为配置时区 ISO;
 * 仓储用 julianday 比较绝对时刻。返回 { logs: [...], count, scope }。
 */
import { getQuery } from 'h3'
import { requireRole } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { getOps } from '../../../services/workshop/ops/ops'
import { AppError, ErrorCodes } from '../../../utils/errors'

/** 归一化时间参数;非法值显式 400,不静默退化成"无过滤" */
function isoOf(value: string | undefined, label: string): string | undefined {
  const text = String(value ?? '').trim()
  if (!text) return undefined
  const ms = Date.parse(text)
  if (!Number.isFinite(ms))
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `${label} 不是合法时间: ${text}(示例 2026-10-19T08:00:00+08:00)`)
  return new Date(ms).toISOString()
}

export default defineApiHandler(async (event) => {
  // 全局审计台账含跨产线运维信息,收权到 admin(普通用户走产线维度自己的记录)
  requireRole(event)
  const repo = getOps()?.audit
  if (!repo)
    throw new AppError(503, 'UNAVAILABLE', '产线日志仓储未就绪')
  const q = getQuery(event) as Record<string, string | undefined>
  const scope = String(q.scope ?? 'line').trim() || 'line'
  if (scope !== 'line' && scope !== 'system' && scope !== 'all')
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `scope 只支持 line(默认)/system/all,收到: ${scope}`)
  const from = isoOf(q.from, 'from')
  const to = isoOf(q.to, 'to')
  if (from && to && Date.parse(from) > Date.parse(to))
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, `时间区间无效:from(${q.from}) 晚于 to(${q.to})`)
  const limit = Math.max(1, Math.min(500, Number(q.limit ?? 200) || 200))
  const logs = repo.query({
    scope: scope === 'all' ? undefined : scope as 'line' | 'system',
    lineId: q.lineId?.trim() || undefined,
    productId: q.productId?.trim() || undefined,
    recipeId: q.recipeId?.trim() || undefined,
    actorKind: q.actorKind?.trim() || undefined,
    kind: q.kind?.trim() || undefined,
    level: q.level?.trim() || undefined,
    q: q.q?.trim() || undefined,
    from,
    to,
    limit,
  })
  return { logs, count: logs.length, scope }
})
