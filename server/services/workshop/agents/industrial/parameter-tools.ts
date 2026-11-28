/**
 * param_proposal —— 参数建议（批次 M2，只读建议，绝不下发）。
 *
 * 输入：line/product/recipe/revision/node 集/当前值。
 * 输出：1–3 条建议 + doNothing + cold_start/explore；每条带 intervention/daq 证据深链。
 * 下发仍必须走 recipe_trial/recipe_update/recipe_apply + HITL + 本体护栏。
 */
import { getAmlRuntime } from '../../aml/runtime'
import { proposeParameterAdjustment } from '../../experience/parameter-proposal'
import { resolveRefFaces } from './tool-verify'
import { getDcwRecipeRepo } from '../../dcw/dcw-recipe.repo'
import { channelIdOfAgent } from './ops-tools'
import type { DaqQueryExecutionScope } from './daq-tools'

export async function toolParamProposal(agentId: string, args: {
  line_id?: string
  product_id?: string
  recipe_id?: string
  recipe_revision?: string
  node_ids?: string | string[]
  current_values?: Record<string, number | string>
  target_metric?: string
}, scope?: DaqQueryExecutionScope): Promise<{ text: string, isError?: boolean }> {
  try {
    const trusted = scope ? { productId: String(scope.productId ?? '').trim(), lineId: String(scope.lineId ?? '').trim() } : undefined
    if (trusted) {
      if (args.product_id && String(args.product_id).trim() !== trusted.productId) {
        return { text: `product_id 与会话固定产品 ${trusted.productId} 不一致，拒绝。`, isError: true }
      }
      if (args.line_id && String(args.line_id).trim() !== trusted.lineId) {
        return { text: `line_id 与会话固定产线 ${trusted.lineId} 不一致，拒绝。`, isError: true }
      }
    }
    const lineId = String(args.line_id ?? '').trim() || trusted?.lineId || ''
    if (!lineId) return { text: 'line_id 必填（或会话已固定产线）。', isError: true }
    const faces = resolveRefFaces(agentId)
    if (!faces.readableLines.has(lineId)) {
      return { text: `产线 ${lineId} 不在你的可读范围，已按 fail-closed 拒绝。`, isError: true }
    }
    const recipe = args.recipe_id ? getDcwRecipeRepo().byId(String(args.recipe_id).trim()) : undefined
    const revision = String(args.recipe_revision ?? recipe?.version ?? '').trim()
    const nodeIds = Array.isArray(args.node_ids)
      ? args.node_ids
      : String(args.node_ids ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const currentValues: Record<string, number> = {}
    for (const [k, v] of Object.entries(args.current_values ?? {})) {
      const n = Number(v)
      if (Number.isFinite(n)) currentValues[k] = n
    }
    const result = proposeParameterAdjustment(getAmlRuntime().db, {
      channelId: channelIdOfAgent(agentId),
      lineId,
      productId: String(args.product_id ?? '').trim() || trusted?.productId,
      recipeId: recipe?.id ?? String(args.recipe_id ?? '').trim(),
      recipeRevision: revision,
      nodeIds,
      currentValues,
      targetMetric: String(args.target_metric ?? '').trim() || undefined,
      actor: agentId,
    })
    const lines: string[] = [`参数建议（${result.mode}）：`]
    for (const s of result.suggestions) {
      lines.push(`- [${s.id}] ${s.nodeName || s.nodeId}/${s.variable}：${s.direction === 'increase' ? '上调' : s.direction === 'decrease' ? '下调' : '保持'} ${s.fromValue ?? '?'} → ${s.toValue}`)
      lines.push(`  期望效应 ${s.expectedEffect?.toPrecision(4) ?? '?'}${s.ciLow != null && s.ciHigh != null ? ` CI[${s.ciLow.toPrecision(3)},${s.ciHigh.toPrecision(3)}]` : ''}；置信 ${(s.confidence * 100).toFixed(0)}%；支持 ${s.support}/否证 ${s.refute}`)
      lines.push(`  证据：${s.evidence.map(e => `intervention=${e.interventionId} daq=${e.daqEvidenceId || '—'} claim=${e.claimId}`).join('；')}`)
      lines.push(`  下发：必须走 recipe_trial/recipe_update/recipe_apply + HITL + 本体护栏；本工具不写设备。`)
    }
    if (result.suggestions.length === 0) lines.push('- 无满足硬过滤的建议。')
    lines.push(`- doNothing：${result.doNothing.reason}`)
    for (const m of result.messages) lines.push(`- 说明：${m}`)
    return { text: lines.join('\n') }
  }
  catch (err) {
    return { text: `参数建议生成失败：${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}
