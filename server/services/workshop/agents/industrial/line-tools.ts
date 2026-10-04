/**
 * 产线管理工具 —— Agent(频道 lead)的开线/停线/状态面。
 *
 * 权限模型:
 *   - line_start / line_stop:仅频道 lead;频道必须绑线;目标产线 = 频道绑定产线
 *     (不接受跨线参数 —— 管理 action 与 Channel 产线锚点 1:1,杜绝跨线操作)。
 *   - 两者恒为 HITL(人工批准才执行;产线启停直接改变物理状态与批次窗口,无 auto 免批)。
 *   - line_status:只读,lead/worker 均可(复用工业工具的 grant 复核,channel 线 ≥readonly)。
 * 理由强制:reason 必填(启停理由入审计与审批卡,人要看懂为什么启停)。
 */
import { getWorkshopManager } from '@/server/plugins/workshop'
import { getToolApprovals } from '../tool-approvals'
import { agentBadgeLabel } from '../agent-badge'
import { getDcwController } from '../../dcw/dcw-controller'
import { getDcwLineRepo } from '../../dcw/dcw-line.repo'
import { recordOps } from '../../ops/ops'

export interface LineStartInput { recipe_id?: string, reason?: string }
export interface LineStopInput { reason?: string }
export interface LineStatusInput { line_id?: string }

/** 解析「频道 lead + 绑线」上下文;line_start/line_stop 共用 */
async function requireBoundLineLead(agentId: string, channelId: string | undefined): Promise<{ lineId: string, lineName: string } | { error: string }> {
  if (!channelId) return { error: 'line_start/line_stop 仅限频道内使用(缺频道上下文)。' }
  const manager = getWorkshopManager()
  const ch = manager.deps.repos.channels.findById(channelId)
  if (!ch) return { error: `频道不存在: ${channelId}` }
  if (ch.leadAgentId !== agentId) return { error: '产线启停仅限频道 lead 操作(你是 worker;如需启停请向 lead 提出)。' }
  const lineId = String(ch.lineId ?? '').trim()
  if (!lineId) return { error: '本频道未绑定产线,无法执行产线启停(绑线频道才能管理产线)。' }
  const line = getDcwLineRepo().byId(lineId)
  if (!line) return { error: `频道绑定的产线不存在: ${lineId}` }
  return { lineId, lineName: line.name }
}

// 延迟导入避免循环依赖(line-run ← dcw-controller ← 本模块经 controller 已引入)

/** 工具:line_start —— lead 申请开线(选配方),恒 HITL,人工批准后执行。 */
export async function toolLineStart(agentId: string, args: LineStartInput, channelId?: string): Promise<{ text: string, isError?: boolean }> {
  const reason = String(args.reason ?? '').trim()
  if (!reason) return { text: 'reason 必填:开线必须说明作业依据(工单/排产/实验目的),人工审批要能看懂。', isError: true }
  const recipeId = String(args.recipe_id ?? '').trim()
  if (!recipeId) return { text: 'recipe_id 必填(line_context 可看到当前配方 id)。', isError: true }
  const ctx = await requireBoundLineLead(agentId, channelId)
  if ('error' in ctx) return { text: ctx.error, isError: true }
  const { lineId, lineName } = ctx
  const ctrl = getDcwController()
  const recipe = ctrl.listRecipes().find(r => r.id === recipeId)
  if (!recipe) return { text: `配方 ${recipeId} 不存在。`, isError: true }
  if (recipe.lineId !== lineId) return { text: `配方「${recipe.name}」不属于本频道绑定的产线「${lineName}」,不能用于开线。`, isError: true }
  if (ctrl.lineState(lineId).active) {
    const cur = ctrl.lineState(lineId)
    return { text: `产线「${lineName}」已在运行(批次 ${cur.runId},配方 ${cur.recipeName});重复开线被拒。如需换配方,先 line_stop 再开。`, isError: true }
  }
  let decision
  try {
    decision = await getToolApprovals().request(
      agentId,
      `line-start:${lineId}`,
      'dcw',
      `产线开跑审批:产线「${lineName}」以配方「${recipe.name}」v${recipe.version ?? 1} 开线(参数:${recipe.params.map((p) => {
        const node = ctrl.byId(p.nodeId)
        return `${node?.name ?? p.nodeId}=${p.value}${node?.unit ?? ''}`
      }).join(';')})。理由:${reason} | 批准=开线并下发配方;拒绝可附指导。`,
      { title: `产线开跑:${lineName}`, payload: { schemaVersion: 1, kind: 'line-start', lineId, recipeId, reason } },
    )
  }
  catch (err) {
    return { text: `提交开线审批失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
  if (!decision.approved) {
    return { text: `开线未获批准(超时未批或人工拒绝),产线未做任何变更。人工意见:${decision.comment || '(无附言)'}` }
  }
  try {
    const run = await ctrl.lineStart(lineId, recipeId)
    try {
      recordOps({
        actor: agentId, actorName: agentBadgeLabel(agentId), actorKind: 'agent',
        action: 'line.start', kind: 'line', targetKind: 'line', targetId: lineId, lineId,
        summary: `Agent 开线:「${lineName}」以配方「${recipe.name}」开跑(批次 ${run.id.slice(0, 8)});理由:${reason}`,
      })
    }
    catch { /* 审计失败不影响执行 */ }
    return { text: `产线「${lineName}」已开跑(批次 ${run.id.slice(0, 8)},配方「${recipe.name}」参数已下发)。用 daq_query 复测确认数采窗口激活。` }
  }
  catch (err) {
    return { text: `开线执行失败(产线未变更):${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

/** 工具:line_stop —— lead 申请停线,恒 HITL;停线关闭批次窗口并停该线数采。 */
export async function toolLineStop(agentId: string, args: LineStopInput, channelId?: string): Promise<{ text: string, isError?: boolean }> {
  const reason = String(args.reason ?? '').trim()
  if (!reason) return { text: 'reason 必填:停线必须说明原因(完工/检修/异常),审计与审批都要看懂。', isError: true }
  const ctx = await requireBoundLineLead(agentId, channelId)
  if ('error' in ctx) return { text: ctx.error, isError: true }
  const { lineId, lineName } = ctx
  const ctrl = getDcwController()
  const st = ctrl.lineState(lineId)
  if (!st.active) return { text: `产线「${lineName}」未在运行,无需停线。`, isError: true }
  let decision
  try {
    decision = await getToolApprovals().request(
      agentId,
      `line-stop:${lineId}`,
      'dcw',
      `产线停线审批:产线「${lineName}」将关闭当前批次窗口(批次 ${st.runId},配方 ${st.recipeName},已打标 ${st.taggedSamples} 样本)。理由:${reason} | 批准=停线(数采同步停止);拒绝可附指导。`,
      { title: `产线停线:${lineName}`, payload: { schemaVersion: 1, kind: 'line-stop', lineId, reason } },
    )
  }
  catch (err) {
    return { text: `提交停线审批失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
  if (!decision.approved) {
    return { text: `停线未获批准(超时未批或人工拒绝),产线继续运行。人工意见:${decision.comment || '(无附言)'}` }
  }
  try {
    const run = ctrl.lineStop(lineId)
    try {
      recordOps({
        actor: agentId, actorName: agentBadgeLabel(agentId), actorKind: 'agent',
        action: 'line.stop', kind: 'line', targetKind: 'line', targetId: lineId, lineId,
        summary: `Agent 停线:「${lineName}」批次 ${run.id.slice(0, 8)} 收窗;理由:${reason}`,
      })
    }
    catch { /* 审计失败不影响执行 */ }
    return { text: `产线「${lineName}」已停线(批次 ${run.id.slice(0, 8)} 收窗,打标样本 ${st.taggedSamples})。数据保留可查(daq_query 历史窗)。` }
  }
  catch (err) {
    return { text: `停线执行失败(产线未变更):${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
}

/** 工具:line_status —— 本频道绑定产线的运行状态(只读)。 */
export async function toolLineStatus(agentId: string, args: LineStatusInput, channelId?: string): Promise<{ text: string, isError?: boolean }> {
  void agentId
  const ctrl = getDcwController()
  const manager = getWorkshopManager()
  const ch = channelId ? manager.deps.repos.channels.findById(channelId) : undefined
  const wantLine = String(args.line_id ?? '').trim() || String(ch?.lineId ?? '').trim()
  const lines = ctrl.listLines().filter(l => !wantLine || l.id === wantLine)
  const states = ctrl.allLineStates().filter(s => !wantLine || s.lineId === wantLine)
  if (lines.length === 0) return { text: `产线不存在或不在你的可见范围: ${wantLine || '(未指定)'}`, isError: true }
  const rows = lines.map((l) => {
    const s = states.find(x => x.lineId === l.id)
    return s?.active
      ? `· ${l.name}:运行中(批次 ${s.runId?.slice(0, 8)},配方「${s.recipeName}」,产品「${s.productName}」,自 ${s.startedAt},已打标 ${s.taggedSamples} 样本)`
      : `· ${l.name}:未运行(数据保留可查)`
  })
  return { text: `产线状态:\n${rows.join('\n')}` }
}
