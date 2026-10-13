/**
 * 数据分析系统 · 分析报告留痕工具(analysis_save / analysis_query)。
 *
 * 定位:Agent Channel 把分析产出(关键结论/正文/支撑指标)持久化到平台台账,
 * 实现"分析结果可留痕、随时可查回"。台账 append-only —— 本族无更新/删除工具
 * (删仅 REST admin 面),保证留痕不可变。
 *
 * 权限语义(同族只读工具口径):
 *   - 目标产线解析:显式 line_id(须在可见范围)→ 频道绑线兜底 → 都没有则拒。
 *   - 可见产线 = 节点授权线 ∪ 绑定配方所在线 ∪ 频道绑线(agentOpsScope)。
 *   - 不进 WRITE_TOOLS/grant-guard 写族:留痕是台账写入,非产线控制写;
 *     能读该产线数据(≥readonly)的 Agent 才能留痕。
 */
import { randomUUID } from 'node:crypto'
import { agentBadgeLabel } from '../agent-badge'
import { getDcwController } from '../../dcw/dcw-controller'
import { getDcwLineRepo } from '../../dcw/dcw-line.repo'
import { recordOps } from '../../ops/ops'
import { getAnalysisRepo } from '../../analysis/analysis.repo'
import { agentOpsScope, channelBoundLineId, fmtAuditAt } from './ops-tools'

export interface AnalysisSaveInput {
  title?: string
  summary?: string
  conclusions?: string[] | string
  report?: string
  category?: string
  line_id?: string
  recipe_id?: string
  recipe_version?: string
  window_from?: string
  window_to?: string
  data_sources?: string
  metrics?: Record<string, unknown>
}

export interface AnalysisQueryInput {
  report_id?: string
  line_id?: string
  recipe_id?: string
  category?: string
  q?: string
  from?: string
  to?: string
  limit?: number | string
}

/** 可见产线全集 = 节点授权线 ∪ 绑定配方所在线 ∪ 频道绑线(去重) */
function readableLineIdsOf(agentId: string): string[] {
  const bound = channelBoundLineId(agentId)
  const scope = agentOpsScope(agentId)
  if (!scope) return bound ? [bound] : []
  return [...new Set([...scope.lineIds, ...scope.boundLineIds, ...(bound ? [bound] : [])])]
}

/** 目标产线解析:显式 line_id(须可读)→ 频道绑线兜底;返回产线视图或错误文案 */
function resolveTargetLine(agentId: string, explicitLineId?: string): { lineId: string, lineName: string } | { error: string } {
  const lineRepo = getDcwLineRepo()
  const wanted = String(explicitLineId ?? '').trim() || channelBoundLineId(agentId)
  if (!wanted) {
    return { error: '无法确定目标产线:本频道未绑定产线,且未指定 line_id。请先绑线,或显式传入可见范围内的 line_id。' }
  }
  const line = lineRepo.byId(wanted)
  if (!line) return { error: `产线不存在: ${wanted}` }
  const readable = readableLineIdsOf(agentId)
  if (!readable.includes(wanted)) {
    return { error: `产线「${line.name}」不在你的可见范围(节点授权线/绑定配方线/频道绑线)。只能对可见产线留痕。` }
  }
  return { lineId: line.id, lineName: line.name }
}

/** 时间入参归一:epoch ms 数值串或 ISO 均收,统一出 ISO;无效返回 null(留空=未指明) */
function normTimeArg(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  if (/^\d{10,}$/.test(s)) {
    const ms = Number(s)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
  }
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** conclusions 归一:接受 string[] 或换行分隔的整段字符串(LLM 两种形态都常见) */
function normConclusions(raw: AnalysisSaveInput['conclusions']): string[] {
  if (Array.isArray(raw)) return raw.map(x => String(x).trim()).filter(Boolean)
  return String(raw ?? '')
    .split('\n')
    .map(x => x.replace(/^[-*\d.\s]+/, '').trim())
    .filter(Boolean)
}

/** 频道名快照(归因用;经全局 manager 直读,未装配/直调上下文留空 —— 同 channelBoundLineId 模式) */
function channelNameOf(channelId?: string): string {
  if (!channelId) return ''
  try {
    const g = globalThis as typeof globalThis & {
      __workshopManager?: { deps: { repos: { channels: { findById(id: string): { name?: string } | undefined } } } }
    }
    return g.__workshopManager?.deps.repos.channels.findById(channelId)?.name ?? ''
  }
  catch {
    return ''
  }
}

/** 产线上下文快照:保存瞬间把产品/批次/控制模式固化进台账 */
function lineContextSnapshot(lineId: string): Record<string, unknown> {
  try {
    const ctrl = getDcwController()
    const st = ctrl.lineState(lineId)
    const line = getDcwLineRepo().byId(lineId)
    return {
      controlMode: line?.controlMode ?? '',
      activeRun: st?.active
        ? { runId: st.runId, recipeName: st.recipeName, productName: st.productName, startedAt: st.startedAt }
        : null,
    }
  }
  catch {
    return {}
  }
}

/** 工具:analysis_save —— 把本次分析的关键结论与产出持久化到平台分析台账(数据留痕)。 */
export async function toolAnalysisSave(agentId: string, args: AnalysisSaveInput, channelId?: string): Promise<{ text: string, isError?: boolean }> {
  const title = String(args.title ?? '').trim()
  const summary = String(args.summary ?? '').trim()
  if (!title) return { text: 'title 必填:分析主题(如「BOPET 线膜厚漂移根因分析」),台账列表靠它辨认。', isError: true }
  if (!summary) return { text: 'summary 必填:一句话关键结论 —— 这是留痕的核心产出,人扫一眼列表要能看懂。', isError: true }

  const line = resolveTargetLine(agentId, args.line_id)
  if ('error' in line) return { text: line.error, isError: true }

  // 配方联动:校验存在性 + 归属(留痕的 recipe 字段要可信)
  const recipeId = String(args.recipe_id ?? '').trim()
  let recipeVersion = String(args.recipe_version ?? '').trim()
  if (recipeId) {
    const recipe = getDcwController().listRecipes().find(r => r.id === recipeId)
    if (!recipe) return { text: `配方 ${recipeId} 不存在,recipe_id 留痕被拒(可用 line_context 查看当前配方)。`, isError: true }
    if (recipe.lineId && recipe.lineId !== line.lineId) {
      return { text: `配方「${recipe.name}」不属于产线「${line.lineName}」,不能挂到该线的分析报告下。`, isError: true }
    }
    if (!recipeVersion) recipeVersion = String(recipe.version ?? '')
  }

  const channelName = channelNameOf(channelId)
  const id = `ar-${randomUUID().replace(/-/g, '').slice(0, 8)}`
  const now = new Date().toISOString()
  const conclusions = normConclusions(args.conclusions)
  const windowFrom = normTimeArg(args.window_from)
  const windowTo = normTimeArg(args.window_to)

  getAnalysisRepo().insert({
    id,
    lineId: line.lineId,
    lineName: line.lineName,
    title,
    category: String(args.category ?? '').trim() || 'general',
    summary,
    conclusions,
    report: String(args.report ?? ''),
    metrics: (args.metrics && typeof args.metrics === 'object' && !Array.isArray(args.metrics) ? args.metrics : {}) as Record<string, unknown>,
    recipeId,
    recipeVersion,
    windowFrom,
    windowTo,
    dataSources: String(args.data_sources ?? ''),
    context: lineContextSnapshot(line.lineId),
    channelId: channelId ?? '',
    channelName,
    actor: agentId,
    actorName: agentBadgeLabel(agentId),
    createdAt: now,
  })

  try {
    recordOps({
      actor: agentId, actorName: agentBadgeLabel(agentId), actorKind: 'agent',
      action: 'analysis.save', kind: 'analysis', targetKind: 'analysis', targetId: id,
      lineId: line.lineId, recipeId,
      summary: `Agent 留痕分析报告「${title}」:产线「${line.lineName}」${recipeId ? `,配方 ${recipeId}` : ''} — ${summary}`,
    })
  }
  catch { /* 审计失败不影响留痕 */ }

  const win = windowFrom || windowTo ? `(数据窗 ${windowFrom ?? '?'} ~ ${windowTo ?? '?'})` : ''
  return { text: `分析报告已留痕:${id}。产线「${line.lineName}」${win},结论 ${conclusions.length} 条,配方 ${recipeId || '未关联'}。台账 append-only,不可改删;随时可用 analysis_query(report_id="${id}") 查回全文。` }
}

/** 工具:analysis_query —— 查询历史分析报告(report_id 精确查全文;或按线/配方/时间/关键词列表)。 */
export async function toolAnalysisQuery(agentId: string, args: AnalysisQueryInput): Promise<{ text: string, isError?: boolean }> {
  const readable = readableLineIdsOf(agentId)
  const reportId = String(args.report_id ?? '').trim()
  const repo = getAnalysisRepo()

  if (reportId) {
    const report = repo.get(reportId)
    if (!report) return { text: `分析报告不存在: ${reportId}(留痕不可变,也没有删除找回;请核对 id)。`, isError: true }
    if (report.lineId && !readable.includes(report.lineId)) {
      return { text: `分析报告 ${reportId} 属于产线「${report.lineName}」,不在你的可见范围。`, isError: true }
    }
    const head = [
      `分析报告 ${report.id}:「${report.title}」(分类 ${report.category})`,
      `产线: ${report.lineName || report.lineId || '-'} | 配方: ${report.recipeId || '-'}${report.recipeVersion ? ` v${report.recipeVersion}` : ''}`,
      `分析时间: ${fmtAuditAt(report.createdAt)} | 数据窗: ${report.windowFrom ? fmtAuditAt(report.windowFrom) : '-'} ~ ${report.windowTo ? fmtAuditAt(report.windowTo) : '-'}`,
      `来源: ${report.actorName || report.actor}${report.channelName ? ` @频道「${report.channelName}」` : ''}`,
      `关键结论: ${report.summary}`,
      ...(report.conclusions.length ? [`结论明细:\n${report.conclusions.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`] : []),
    ]
    const body = report.report ? `\n\n— 完整分析正文 —\n${report.report}` : ''
    const metrics = Object.keys(report.metrics ?? {}).length ? `\n\n— 支撑指标 —\n${JSON.stringify(report.metrics, null, 1)}` : ''
    return { text: `${head.join('\n')}${body}${metrics}` }
  }

  const explicitLine = String(args.line_id ?? '').trim()
  if (explicitLine && !readable.includes(explicitLine)) {
    return { text: `产线 ${explicitLine} 不在你的可见范围(节点授权线/绑定配方线/频道绑线)。`, isError: true }
  }
  // 作用域空集 = 不可见任何产线 → 直接空结果,不得落成"不过滤"(防越权列举全量台账)
  if (!explicitLine && readable.length === 0) {
    return { text: '你当前没有任何可见产线(无节点授权、无绑定配方、频道未绑线),暂无可查的分析报告。' }
  }
  const rows = repo.list({
    lineId: explicitLine || undefined,
    lineIds: explicitLine ? undefined : readable,
    recipeId: String(args.recipe_id ?? '').trim() || undefined,
    category: String(args.category ?? '').trim() || undefined,
    q: String(args.q ?? '').trim() || undefined,
    from: normTimeArg(args.from) ?? undefined,
    to: normTimeArg(args.to) ?? undefined,
    limit: Math.min(50, Math.max(1, Number(args.limit) || 20)),
  })
  if (rows.length === 0) {
    return { text: `可见范围内暂无匹配的分析报告${args.q ? `(关键词「${String(args.q)}」)` : ''}。留痕由各频道的 analysis_save 产生;若是刚分析完,确认保存工具已被调用。` }
  }
  const lines = rows.map((r) => {
    const recipe = r.recipeId ? ` | 配方 ${r.recipeId}${r.recipeVersion ? ` v${r.recipeVersion}` : ''}` : ''
    return `[${r.id}] ${fmtAuditAt(r.createdAt)} | ${r.lineName || r.lineId || '-'}${recipe} | ${r.title}(${r.category})\n    ${r.summary} —— ${r.actorName || r.actor}${r.channelName ? ` @「${r.channelName}」` : ''}`
  })
  return { text: `共 ${rows.length} 条分析报告(新→旧):\n${lines.join('\n')}\n\n用 analysis_query(report_id="ar-xxxx") 查看单条完整正文与结论明细。` }
}
