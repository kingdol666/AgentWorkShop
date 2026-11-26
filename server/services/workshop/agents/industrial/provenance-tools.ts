/**
 * operation_provenance —— 操作与数采全量追溯（批次 N3，只读）。
 *
 * 与 intervention_history 的分工：
 *  - intervention_history 保持旧的文本摘要（兼容既有调用）；
 *  - operation_provenance 返回设定 + 上下文（产品/配方/修订/run/审批/任务/会话）
 *    + DAQ 前后统计/序列/原始可用性 + 判定，并包含被拒绝/未知尝试的“想写值”。
 *
 * 权限与 intervention_history/daq_query 同源：可读产线 ∪ 绑定节点；跨频道/跨产品
 * 由调用方会话快照再收口（fail-closed）。
 */
import { getAmlRuntime } from '../../aml/runtime'
import { operationProvenanceLines, queryOperationProvenance } from '../../aml/provenance-query'
import { resolveRefFaces } from './tool-verify'
import type { DaqQueryExecutionScope } from './daq-tools'

export async function toolOperationProvenance(agentId: string, args: {
  line_id?: string
  product_id?: string
  recipe_id?: string
  recipe_revision?: string
  run_id?: string
  node_id?: string
  from?: string
  to?: string
  actor?: string
  path?: string
  verdict?: string
  has_daq?: boolean | string
  attempt_id?: string
  proposal_id?: string
  limit?: number | string
  before_ts?: string
  before_id?: string
}, scope?: DaqQueryExecutionScope): Promise<{ text: string, isError?: boolean }> {
  try {
    const trusted = scope
      ? {
          productId: String(scope.productId ?? '').trim(),
          lineId: String(scope.lineId ?? '').trim(),
        }
      : undefined
    const lineId = String(args.line_id ?? '').trim() || trusted?.lineId || ''
    const productId = String(args.product_id ?? '').trim() || trusted?.productId || ''
    if (trusted) {
      if (args.product_id && String(args.product_id).trim() !== trusted.productId) {
        return { text: `product_id ${String(args.product_id).trim()} 与会话固定产品 ${trusted.productId} 不一致，拒绝查询。`, isError: true }
      }
      if (args.line_id && String(args.line_id).trim() !== trusted.lineId) {
        return { text: `line_id ${String(args.line_id).trim()} 与会话固定产线 ${trusted.lineId} 不一致，拒绝查询。`, isError: true }
      }
    }
    const faces = resolveRefFaces(agentId)
    const page = queryOperationProvenance(getAmlRuntime().db, {
      lineId: lineId || undefined,
      productId: productId || undefined,
      recipeId: String(args.recipe_id ?? '').trim() || undefined,
      recipeRevision: String(args.recipe_revision ?? '').trim() || undefined,
      runId: String(args.run_id ?? '').trim() || undefined,
      nodeId: String(args.node_id ?? '').trim() || undefined,
      fromIso: String(args.from ?? '').trim() || undefined,
      toIso: String(args.to ?? '').trim() || undefined,
      actor: String(args.actor ?? '').trim() || undefined,
      path: String(args.path ?? '').trim() || undefined,
      verdict: String(args.verdict ?? '').trim() || undefined,
      hasDaq: args.has_daq === undefined ? undefined : (args.has_daq === true || args.has_daq === 'true' || args.has_daq === '1'),
      attemptId: String(args.attempt_id ?? '').trim() || undefined,
      proposalId: String(args.proposal_id ?? '').trim() || undefined,
      limit: Number(args.limit ?? 50),
      beforeTs: String(args.before_ts ?? '').trim() || undefined,
      beforeId: String(args.before_id ?? '').trim() || undefined,
    })
    // 可见性 = 可读产线 ∪ 绑定节点；行有产线时必须可读，无产线时节点必须绑定
    const items = page.items.filter(item =>
      (item.lineId ? faces.readableLines.has(item.lineId) : faces.boundNodes.has(item.nodeId))
      || faces.boundNodes.has(item.nodeId),
    )
    const attempts = page.attempts.filter(a =>
      (a.lineId ? faces.readableLines.has(a.lineId) : faces.boundNodes.has(a.nodeId))
      || faces.boundNodes.has(a.nodeId),
    )
    if (page.items.length > 0 && items.length === 0 && attempts.length === 0) {
      return { text: '查询命中记录但均不在你的可读范围（可读产线 ∪ 绑定节点）内，已按 fail-closed 隐藏。', isError: true }
    }
    const lines = [
      `操作追溯（共 ${items.length} 条${lineId ? `，产线 ${lineId}` : ''}${productId ? `，产品 ${productId}` : ''}；覆盖率 exact ${page.coverage.exact}/run ${page.coverage.run}/time-window ${page.coverage.timeWindow}/unknown ${page.coverage.unknown}）：`,
      ...operationProvenanceLines({ ...page, items, attempts }),
    ]
    if (page.nextCursor) {
      lines.push(`下一页：before_ts=${page.nextCursor.ts}&before_id=${page.nextCursor.id}`)
    }
    return { text: lines.join('\n') }
  }
  catch (err) {
    return { text: `操作追溯查询失败：${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}
