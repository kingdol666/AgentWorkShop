/**
 * param_experience_query —— 参数经验检索（批次 M，只读）。
 *
 * 与 operation_provenance 的分工：
 *  - operation_provenance = 事实（某次设定 + 数采 + 判定）；
 *  - param_experience_query = 规律（按节点/变量/修订聚合的结构化主张）。
 * 每条主张回指 intervention_id / daq_evidence_id / run_id，Agent 可继续用
 * operation_provenance / daq_query 下钻原始事实。
 */
import { getAmlRuntime } from '../../aml/runtime'
import { createMemoryRepo } from '../../db/memory.repo'
import { queryParameterExperience } from '../../experience/claims'
import { resolveRefFaces } from './tool-verify'
import { channelIdOfAgent } from './ops-tools'
import type { DaqQueryExecutionScope } from './daq-tools'

export async function toolParamExperienceQuery(agentId: string, args: {
  line_id?: string
  product_id?: string
  node_id?: string
  variable?: string
  recipe_revision?: string
  verdict?: string
  deployed_only?: boolean | string
  include_legacy?: boolean | string
  limit?: number | string
}, scope?: DaqQueryExecutionScope): Promise<{ text: string, isError?: boolean }> {
  try {
    const trusted = scope ? { productId: String(scope.productId ?? '').trim(), lineId: String(scope.lineId ?? '').trim() } : undefined
    if (trusted) {
      if (args.product_id && String(args.product_id).trim() !== trusted.productId) {
        return { text: `product_id 与会话固定产品 ${trusted.productId} 不一致，拒绝查询。`, isError: true }
      }
      if (args.line_id && String(args.line_id).trim() !== trusted.lineId) {
        return { text: `line_id 与会话固定产线 ${trusted.lineId} 不一致，拒绝查询。`, isError: true }
      }
    }
    const lineId = String(args.line_id ?? '').trim() || trusted?.lineId || ''
    const productId = String(args.product_id ?? '').trim() || trusted?.productId || ''
    const faces = resolveRefFaces(agentId)
    // 作用域（fail-closed）：频道档只读本 agent 所属频道；产线档按可读产线跨频道共享。
    // 旧实现完全不带频道条件，只靠 `!item.lineId || readableLines…` 在结果层过滤 ——
    // 没有产线锚点的 channel 档主张（任意频道、任意 owner）对所有人可见。
    const ownChannelId = channelIdOfAgent(agentId)
    const ownBindings = ownChannelId ? createMemoryRepo(getAmlRuntime().db).contextFor(ownChannelId) : { lineIds: [], productIds: [] }
    const items = queryParameterExperience(getAmlRuntime().db, {
      lineId: lineId || undefined,
      productId: productId || undefined,
      nodeId: String(args.node_id ?? '').trim() || undefined,
      variable: String(args.variable ?? '').trim() || undefined,
      recipeRevision: String(args.recipe_revision ?? '').trim() || undefined,
      verdict: String(args.verdict ?? '').trim() || undefined,
      deployedOnly: args.deployed_only === true || args.deployed_only === 'true' || args.deployed_only === '1',
      includeLegacy: args.include_legacy === true || args.include_legacy === 'true' || args.include_legacy === '1',
      limit: Number(args.limit ?? 50),
      scopeChannelIds: ownChannelId ? [ownChannelId] : [],
      scopeLineIds: [...new Set([...faces.readableLines, ...ownBindings.lineIds])],
      scopeProductIds: ownBindings.productIds,
    }).filter(item => !item.channelId || item.channelId === ownChannelId
      || (item.lineId !== '' && faces.readableLines.has(item.lineId))
      || (item.lineId === '' && item.productId !== '' && faces.boundNodes.has(item.nodeId)))
    if (items.length === 0) {
      return { text: '没有匹配的参数经验主张（可能需要更多判定/部署，或先用 operation_provenance 查看事实）。' }
    }
    const lines = [`参数经验主张（${items.length} 条${lineId ? `，产线 ${lineId}` : ''}${productId ? `，产品 ${productId}` : ''}）：`]
    for (const item of items.slice(0, 50)) {
      const effect = item.effect != null
        ? ` effect=${item.effect.toPrecision(4)}${item.ciLow != null && item.ciHigh != null ? ` CI[${item.ciLow.toPrecision(3)},${item.ciHigh.toPrecision(3)}]` : ''}`
        : ''
      const daq = item.daq
        ? ` DAQ前=${fmt(item.daq.preMean)} 后=${fmt(item.daq.postMean)} n=${item.daq.sampleCount}${item.daq.rawAvailable ? '' : '(raw过期)'}`
        : ' DAQ=未采集'
      lines.push(`- ${item.observedAt} ${item.nodeName || item.nodeId}/${item.variable || '参数'} ${item.direction} ${fmt(item.fromValue)}→${fmt(item.toValue)} verdict=${item.verdict}${effect}${daq}`)
      lines.push(`  状态：${item.memoryStatus || '?'} / ${item.lifecycle || '?'} / deployment=${item.deployment || 'none'} / 主张=${item.claimStatus}；证据 intervention=${item.interventionId} daq=${item.daqEvidenceId || '—'} run=${item.runId || '—'} recipe=${item.recipeId || '—'}@v${item.recipeRevision || '?'}`)
    }
    return { text: lines.join('\n') }
  }
  catch (err) {
    return { text: `参数经验查询失败：${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

function fmt(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(6)).toString() : '?'
}
