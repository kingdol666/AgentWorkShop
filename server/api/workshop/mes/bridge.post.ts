/**
 * POST /api/workshop/mes/bridge —— MES 历史 → 平台 TSDB 桥(用户面,H1)。
 *
 * body: { node_ids | ids, from, to, max_rows?, run_id?, include?, resample_to?, param?, dry_run? }
 *
 * 权限:点位必须在你可读产线上,且桥接属于**数据面写**,要求 operate 档;
 * 频控:每用户 60s ≤10 次(桥接比预览重);写库走 mes-bridge(幂等 + 批次打标),
 * 结果与 Agent 工具 mes_bridge 同构。数据源原文不进入响应(只回统计)。
 */
import { readBody } from 'h3'
import { resolveUser } from '@/server/api/workshop/caller'
import { defineApiHandler } from '@/server/utils/response'
import { AppError, ErrorCodes } from '@/server/utils/errors'
import { mesUserRateCheck, visibleMesNodesForUser } from '@/server/services/workshop/eda/mes-console'
import { requireLineMode } from '@/server/services/workshop/permissions'
import { getDcwNodeRepo } from '@/server/services/workshop/dcw/dcw-node.repo'
import { bridgeMesHistory } from '@/server/services/workshop/mes/mes-bridge'
import { recordOps } from '@/server/services/workshop/ops/ops'

export default defineApiHandler(async (event) => {
  const user = resolveUser(event)
  const body = await readBody<{
    node_ids?: string[] | string
    ids?: string[] | string
    from?: string
    to?: string
    max_rows?: number | string
    run_id?: string
    include?: string[] | string
    resample_to?: number | string
    param?: unknown
    dry_run?: boolean | string
  }>(event) ?? {}

  const rawIds = body.node_ids ?? body.ids
  const ids = (Array.isArray(rawIds) ? rawIds : String(rawIds ?? '').split(/[,\s;]+/))
    .map(x => String(x).trim())
    .filter(Boolean)
  if (ids.length === 0) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'node_ids 必填:目标 mes-rest 点位 id 数组。')
  const from = String(body.from ?? '').trim()
  const to = String(body.to ?? '').trim()
  if (!from || !to) throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'from/to 必填(ISO 时间窗,≤7 天)。')
  if (!mesUserRateCheck(user.id, 10)) {
    throw new AppError(429, 'MES_RATE_LIMITED', 'MES 桥接过于频繁(每用户 60 秒最多 10 次),请稍后再试。')
  }

  // 可见面 = 可读产线上的 mes-rest 点位;桥接再要求 operate(数据面写)
  const visible = new Map(visibleMesNodesForUser(user).map(n => [n.id, n]))
  const notAllowed = ids.filter(id => !visible.has(id))
  if (notAllowed.length > 0) {
    throw new AppError(403, 'SCOPE_VIOLATION', `无权桥接点位:${notAllowed.join(', ')}(须为你的可读产线上已启用的 mes-rest 点位)。`)
  }
  for (const id of ids) {
    const node = getDcwNodeRepo().byId(id)
    requireLineMode(user, node?.lineId, 'operate')
  }

  const includeRaw = body.include
  const include = (Array.isArray(includeRaw) ? includeRaw : String(includeRaw ?? '').split(/[,;\s]+/))
    .map(x => String(x).trim())
    .filter(Boolean) as Array<'scalar' | 'vector' | 'image'>
  const maxRows = body.max_rows == null || String(body.max_rows).trim() === '' ? undefined : Number(body.max_rows)
  const resampleTo = body.resample_to == null || String(body.resample_to).trim() === '' ? undefined : Number(body.resample_to)
  const dryRun = body.dry_run === true || body.dry_run === 'true'

  const outcome = await bridgeMesHistory({
    nodeIds: ids,
    fromIso: from,
    toIso: to,
    ...(maxRows !== undefined ? { maxRows } : {}),
    ...(String(body.run_id ?? '').trim() ? { runId: String(body.run_id).trim() } : {}),
    ...(include.length > 0 ? { include } : {}),
    ...(resampleTo !== undefined ? { resampleTo } : {}),
    ...(body.param !== undefined ? { param: body.param } : {}),
    ...(dryRun ? { dryRun } : {}),
  })

  try {
    recordOps({
      actor: user.id,
      actorName: user.name,
      actorKind: 'user',
      action: 'mes.bridge',
      kind: 'daq',
      targetKind: 'daq',
      targetId: ids.join(','),
      lineId: getDcwNodeRepo().byId(ids[0]!)?.lineId ?? '',
      scope: 'line',
      summary: `MES 历史桥接(${ids.length} 点位,${from} ~ ${to}${dryRun ? ',试运行' : ''}):写入 ${outcome.totals.inserted} 行`,
      detail: { ids, dryRun, totals: outcome.totals },
    })
  }
  catch { /* 埋点失败不影响桥接结果 */ }

  return {
    ok: outcome.ok,
    text: outcome.text,
    totals: outcome.totals,
    nodes: outcome.nodes,
  }
})
