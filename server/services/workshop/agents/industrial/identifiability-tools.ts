/**
 * 可辨识性工具族(科学探索计划 P1/P2,docs/plans/2026-11-02-scientific-exploration-plan.md):
 *  - explorationIdentifiabilityPreflight:optimization_explore 前置门(上次干预未收口/欠功效建议窗未过 → 拦)
 *  - identifiabilityLearningText:verdict → 判读学习文案(方向性外推措辞仅在效应可分辨时出现)
 *  - toolDaqIdentifiability:对数采节点做可辨识性预检(主导周期/建议试验窗/半窗对比)
 *  - toolInterventionHistory:干预台账查询(只读;可读线口径与 line_context 同源)
 * 全部只读;逃生开关 AW_IDENT_GATE=0 一键回到旧行为(零回归通道)。
 */
import { getDaqController } from '../../daq/daq-controller'
import { resolveRefFaces } from './tool-verify'
import { assessIdentifiability, dominantPeriod, type IdentifiabilityVerdict } from '../../aml/identifiability'
import { summarize } from '../../aml/stats'
import { backfillInterventionEvidence } from '../../aml/ontology-learning'
import {
  attachAssessment,
  interventionLines,
  latestIntervention,
  listInterventions,
  pendingUnclosedEvent,
  recentBlockedVerdictEvent,
  verdictCodeOf,
  verdictDetailOf,
  verdictLabel,
} from '../../aml/intervention-ledger'

/** 门禁总开关(缺省启用;AW_IDENT_GATE=0 回到旧行为) */
export function identGateEnabled(): boolean {
  return process.env.AW_IDENT_GATE !== '0'
}

/**
 * 时序取数(与 readTargetMean 同源:daq samples,1s 桶,value/avg 兼容)。
 * 一次调用同时产出均值(台账旧链用)与序列(引擎判读用)—— 判读不增取数。
 */
export async function readTargetWindow(nodeId: string, fromMs: number, toMs: number): Promise<{ mean: number | null, values: number[] }> {
  try {
    const pts = await getDaqController().samples(nodeId, { fromMs, toMs, bucketMs: 1000, limit: Math.max(60, Math.ceil((toMs - fromMs) / 1000) + 10) }) as Array<{ at?: number, value?: number, avg?: number }>
    const values = pts.map(p => Number(p.value ?? p.avg)).filter(Number.isFinite)
    if (values.length === 0) return { mean: null, values }
    return { mean: values.reduce((a, b) => a + b, 0) / values.length, values }
  }
  catch {
    return { mean: null, values: [] }
  }
}

/** 序列周期提示(非阻断;从已取序列派生,不额外取数) */
export function periodHintFromSeries(values: number[]): string {
  if (values.length < 32) return ''
  const period = dominantPeriod(values)
  if (period.lagBeats == null) return ''
  const periodMin = (period.lagBeats / 60).toFixed(2)
  return `目标节点检出主导扰动周期 ≈${periodMin} min:建议单次响应窗(settle_seconds)≥ ${Math.ceil((3 * period.lagBeats) / 60)} min、以 ≥3 个水平做正交阶梯探索,否则单步差分大概率不可辨识。`
}

export interface ExplorationGateResult {
  blocked: boolean
  /** blocked 时的拒绝文案(结构化、带正交化建议) */
  text: string
  /** 非阻断提示(拼进探索回包,提醒窗长/水平设计) */
  hint: string
}

/**
 * optimization_explore 前置门(零取数,只查台账):同节点上一次干预未收口(判读窗未满)
 * 或欠功效/混杂建议窗未过期 → 拒绝新激励。周期探测提示在写后从写前序列派生,不在此读数。
 */
export async function explorationIdentifiabilityPreflight(controlNodeId: string): Promise<ExplorationGateResult> {
  if (!identGateEnabled()) return { blocked: false, text: '', hint: '' }
  const pending = pendingUnclosedEvent(controlNodeId)
  if (pending) {
    return {
      blocked: true,
      text: `可辨识性门禁:节点 ${controlNodeId} 上一次干预(${pending.row.ts})判读尚未收口,剩余约 ${Math.ceil(pending.remainMs / 1000)}s。两次干预的响应会叠加,判读必然失真 —— 请先等待收口(或以 daq_query 确认上一步响应已回稳),再发新激励。`,
      hint: '',
    }
  }
  const blockedVerdict = recentBlockedVerdictEvent(controlNodeId)
  if (blockedVerdict) {
    const elapsedMin = Math.max(0, Math.ceil((Date.now() - Date.parse(blockedVerdict.row.ts)) / 60000))
    return {
      blocked: true,
      text: `可辨识性门禁:上一次对 ${controlNodeId} 的干预判定为「${verdictLabel(blockedVerdict.row.verdict)}」,其建议试验窗(≈${Math.round(blockedVerdict.suggestedWindowMs / 60000)} min)尚未过期(已过 ${elapsedMin} min)。继续同幅激励大概率重复欠功效探索 —— 建议改为:① settle_seconds ≥ 3×主导周期;② ≥3 个水平正交阶梯往返(随机化顺序);③ 或换目标量/执行器。如确需立即继续,设 AW_IDENT_GATE=0 停用门禁并自行承担判读风险。`,
      hint: '',
    }
  }
  return { blocked: false, text: '', hint: '' }
}

/** verdict → 判读学习文案(方向性外推措辞仅在效应可分辨时出现 —— P1 门禁挂钩第二处) */
export function identifiabilityLearningText(v: IdentifiabilityVerdict): string {
  const fmt = (x: number | null): string => (x != null && Number.isFinite(x) ? x.toPrecision(4) : '?')
  switch (v.verdict) {
    case 'IDENTIFIABLE':
      if (v.significant) {
        return `学习(可辨识): 该方向目标响应 ${v.effect != null && v.effect > 0 ? '上升' : '下降'} ${fmt(Math.abs(v.effect ?? 0))}(95% CI [${fmt(v.ciLow)}, ${fmt(v.ciHigh)}]);可按此符号外推,建议以反向步验证。`
      }
      return `学习(负结论): 本步幅下无可分辨效应:Δ=${fmt(v.effect)},CI 含 0,分辨率 MDE=${fmt(v.mde)}。负结论可入库;若工艺上预期有效应,请增大 step 或 settle_seconds 后重试,不要据本步外推方向。`
    case 'UNDERPOWERED':
      return `学习(不可辨识): 响应窗仅覆盖 ${v.postCoveragePeriods != null ? v.postCoveragePeriods.toFixed(2) : '?'} 个主导扰动周期(<3),分辨率 MDE=${fmt(v.mde)}。建议 settle_seconds ≥ ${v.suggestedWindowMs != null ? Math.round(v.suggestedWindowMs / 1000) : '?'}s、≥3 水平正交阶梯;本次结论按暂定处理,不要外推。`
    case 'CONFOUNDED':
      return `学习(被混杂): 控制量与自然漂移在时间上不可分(|r|=${v.collinearity != null ? v.collinearity.toFixed(3) : '?'}),判读不可信。建议随机化干预相位或 ABAB 往返校验后再判;本次结论按暂定处理。`
    default:
      return ''
  }
}

/**
 * P5 审批卡科学载荷(写咽喉 manual 分支用):把该节点最近一次干预的判定
 * (效应/CI/MDE/建议窗)与可证伪方式装成结构化 payload + 人读行。
 * 无历史 → 字段为 null 并如实写"未评估"(不编造方向性结论)。
 */
export function scientificPayloadForWrite(nodeId: string, nodeName: string, proposedValue: number): { payload: Record<string, unknown>, lines: string[] } {
  const last = latestIntervention(nodeId)
  const fmt = (x: number | null): string => (x != null && Number.isFinite(x) ? x.toPrecision(4) : '—')
  const payload = {
    controlNodeId: nodeId,
    nodeName,
    proposedValue,
    lastVerdict: last?.verdict ?? null,
    lastEffect: last?.effect ?? null,
    lastCiLow: last?.ciLow ?? null,
    lastCiHigh: last?.ciHigh ?? null,
    lastMde: last?.mde ?? null,
    suggestedWindowMs: (last?.verdictDetail?.suggestedWindowMs as number | undefined) ?? null,
    actionCoverage: (last?.verdictDetail?.controlLevels as number | undefined) ?? null,
    falsificationMethod: last
      ? `若响应窗(≥3 个主导扰动周期)内目标变化 95% CI 不含 0 且方向与上次判定相反,则上次因果断言被否证;Δ 小于 MDE 时只能记"不可辨识"`
      : `首次干预:须在响应窗(≥3 个主导扰动周期)后按 bootstrap CI 判定;Δ 小于 MDE 记"不可辨识",不外推方向`,
  }
  const lines = [
    `[科学依据] 上次判定:${last ? `${verdictLabel(last.verdict)}${last.effect != null ? `;效应 ${fmt(last.effect)}` : ''}${last.mde != null ? `;MDE=${fmt(last.mde)}` : ''}` : '无历史(首次干预,判读窗口须覆盖 ≥3 个主导扰动周期)'}`,
    ...(payload.suggestedWindowMs ? [`[科学依据] 建议响应窗 ≥ ${Math.round((payload.suggestedWindowMs as number) / 1000)}s(3×主导周期)`] : []),
    `[可证伪] ${payload.falsificationMethod}`,
  ]
  return { payload, lines }
}

/** 探索步后:引擎判定回填干预台账(写咽喉已落行,此处挂目标与判定)+ 回灌本体证据 */
export function attachExplorationVerdict(controlNodeId: string, targetNodeId: string, v: IdentifiabilityVerdict): void {
  try {
    const ev = latestIntervention(controlNodeId)
    if (!ev || ev.path !== 'agent') return
    attachAssessment(ev.id, {
      verdict: verdictCodeOf(v),
      effect: v.effect,
      ciLow: v.ciLow,
      ciHigh: v.ciHigh,
      mde: v.mde,
      targetNodeId,
      detail: verdictDetailOf(v),
    })
    // P6:判定回灌本体证据(幂等;无已发布本体则暂留在台账)
    const updated = latestIntervention(controlNodeId)
    if (updated) {
      try {
        backfillInterventionEvidence(updated)
      }
      catch {
        // 证据登记失败不影响探索回包(台账仍是事实源)
      }
    }
  }
  catch {
    // 回填失败不影响探索回包
  }
}

/**
 * daq_identifiability:对数采节点做可辨识性预检(只读)。
 * 输出:序列摘要 / 主导扰动周期 / 建议试验窗 / 前后半窗对比判定(漂移与自然波动基线)。
 */
export async function toolDaqIdentifiability(agentId: string, args: { node_id?: string, minutes?: number | string }): Promise<{ text: string, isError?: boolean }> {
  try {
    const nodeId = String(args.node_id ?? '').trim()
    if (!nodeId) return { text: '缺少 node_id。', isError: true }
    const faces = resolveRefFaces(agentId)
    if (!faces.daqBoundNodes.has(nodeId) && !faces.channelLineNodes.has(nodeId)) {
      return {
        text: `节点 ${nodeId} 不在你的数采可见范围(绑定数采节点:${[...faces.daqBoundNodes].join(', ') || '(无)'}${faces.channelLineNodes.size > 0 ? `;频道绑线只读节点:${faces.channelLineNodes.size} 个` : ''})。请让用户或 lead 绑定该数采节点。`,
        isError: true,
      }
    }
    const minutes = Math.min(240, Math.max(5, Math.floor(Number(args.minutes ?? 30) || 30)))
    const now = Date.now()
    const series = (await readTargetWindow(nodeId, now - minutes * 60_000, now)).values
    if (series.length < 8) {
      return { text: `节点 ${nodeId} 近 ${minutes} min 仅 ${series.length} 拍(需 ≥8):采样不足或节点不活跃,无法做可辨识性预检。`, isError: true }
    }
    const sum = summarize(nodeId, 'target', series, 0, 0)
    const lines = [
      `可辨识性预检(${nodeId},近 ${minutes} min):`,
      `  序列:${sum.count} 拍,均值 ${sum.mean.toFixed(4)},σ=${sum.std.toFixed(4)},范围 [${sum.min.toFixed(4)}, ${sum.max.toFixed(4)}]`,
    ]
    const period = dominantPeriod(series)
    if (period.lagBeats != null) {
      const periodMin = (period.lagBeats / 60).toFixed(2)
      lines.push(`  主导扰动周期 ≈ ${periodMin} min(自相关峰 r=${period.peakCorr.toFixed(2)})`)
      lines.push(`  建议正交试验:单点响应窗 ≥ ${(3 * period.lagBeats / 60).toFixed(1)} min(3×周期),≥3 个水平阶梯往返`)
    }
    else {
      lines.push('  未检出显著周期性;试验窗按噪声分辨率(MDE)评估即可')
    }
    const half = Math.floor(series.length / 2)
    const v = assessIdentifiability({ pre: series.slice(0, half), post: series.slice(half), beatMs: 1000 })
    lines.push(`  前后半窗对比:Δ=${v.effect != null ? v.effect.toPrecision(4) : '?'}(95% CI [${v.ciLow?.toPrecision(4) ?? '?'}, ${v.ciHigh?.toPrecision(4) ?? '?'}]),判定:${v.verdict}${v.significant ? '(显著漂移)' : ''}`)
    for (const r of v.reasons) lines.push(`  · ${r}`)
    return { text: lines.join('\n') }
  }
  catch (err) {
    return { text: `可辨识性预检失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

/**
 * intervention_history:干预台账查询(只读;可见性 = 可读产线 ∪ 绑定节点,与 line_context 同源)。
 */
export async function toolInterventionHistory(agentId: string, args: { node_id?: string, line_id?: string, limit?: number | string }): Promise<{ text: string, isError?: boolean }> {
  try {
    const faces = resolveRefFaces(agentId)
    const limit = Math.min(50, Math.max(1, Math.floor(Number(args.limit ?? 10) || 10)))
    const nodeId = String(args.node_id ?? '').trim()
    const lineId = String(args.line_id ?? '').trim()
    if (!nodeId && !lineId) {
      return { text: '请传 node_id 或 line_id(可先用 line_context 取产线 id)。', isError: true }
    }
    const rows = listInterventions({ nodeId: nodeId || undefined, lineId: lineId || undefined, limit })
    const visible = rows.filter(r => faces.readableLines.has(r.lineId) || faces.boundNodes.has(r.nodeId))
    if (rows.length > 0 && visible.length === 0) {
      return { text: '查询命中记录但均不在你的可读范围(可读产线 ∪ 绑定节点)内,已按 fail-closed 隐藏。', isError: true }
    }
    if (visible.length === 0) {
      return { text: `干预台账暂无${nodeId ? `节点 ${nodeId}` : ''}${lineId ? `产线 ${lineId}` : ''}的记录(台账记录所有已受理下发,含手动/Agent/配方/回退;2026-11-02 起积累)。` }
    }
    const byVerdict = new Map<string, number>()
    for (const r of visible) byVerdict.set(r.verdict, (byVerdict.get(r.verdict) ?? 0) + 1)
    const stats = [...byVerdict.entries()].map(([k, n]) => `${verdictLabel(k)}×${n}`).join(', ')
    const lines = [
      `干预台账(最近 ${visible.length} 条${nodeId ? `,节点 ${nodeId}` : ''}${lineId ? `,产线 ${lineId}` : ''};判定分布:${stats}):`,
      ...interventionLines(visible).map(l => `  ${l}`),
    ]
    return { text: lines.join('\n') }
  }
  catch (err) {
    return { text: `台账查询失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}
