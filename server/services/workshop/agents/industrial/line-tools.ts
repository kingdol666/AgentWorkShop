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
import { resolveRefFaces } from './tool-verify'

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
  if (recipe.params.length === 0) return { text: `配方「${recipe.name}」没有工艺参数,不能开线。请先在配方中保存可下发参数。`, isError: true }
  // 审批快照:人工批准的是「这个版本 + 这组参数」;审批期间配方被改必须重新申请
  const approvedVersion = recipe.version ?? 1
  const approvedParams = JSON.stringify(recipe.params.map(p => ({ nodeId: p.nodeId, value: p.value })))
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
      { title: `产线开跑:${lineName}`, payload: { schemaVersion: 1, kind: 'line-start', lineId, recipeId, recipeVersion: approvedVersion, reason } },
    )
  }
  catch (err) {
    return { text: `提交开线审批失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
  if (!decision.approved) {
    return { text: `开线未获批准(超时未批或人工拒绝),产线未做任何变更。人工意见:${decision.comment || '(无附言)'}` }
  }
  // 审批期间频道绑线/成员角色/配方归属都可能变化:批准不等于授权仍有效
  const again = await requireBoundLineLead(agentId, channelId)
  if ('error' in again) return { text: `审批通过后复核失败,本次未开线:${again.error}`, isError: true }
  if (again.lineId !== lineId) {
    return { text: `审批通过后复核失败:频道绑定产线已从「${lineName}」变更为「${again.lineId}」,本次未开线。请重新提交开线申请。`, isError: true }
  }
  const recipeNow = ctrl.listRecipes().find(r => r.id === recipeId)
  if (!recipeNow || recipeNow.lineId !== lineId) {
    return { text: `审批通过后复核失败:配方「${recipe.name}」已删除或不再属于产线「${lineName}」,本次未开线。`, isError: true }
  }
  const versionNow = recipeNow.version ?? 1
  const paramsNow = JSON.stringify(recipeNow.params.map(p => ({ nodeId: p.nodeId, value: p.value })))
  if (versionNow !== approvedVersion || paramsNow !== approvedParams) {
    return {
      text: `审批通过后复核失败:配方「${recipe.name}」在审批期间已变更(批准 v${approvedVersion},当前 v${versionNow};参数${paramsNow === approvedParams ? '一致' : '已变更'}),本次未开线。请按当前配方重新提交开线申请。`,
      isError: true,
    }
  }
  if (ctrl.lineState(lineId).active) {
    return { text: `审批通过后复核失败:产线「${lineName}」已在运行(批次 ${ctrl.lineState(lineId).runId}),本次未重复开线。`, isError: true }
  }
  try {
    const run = await ctrl.lineStart(lineId, recipeId)
    const results = run.results ?? []
    const failed = results.filter(r => !r.ok)
    const unverified = results.filter(r => r.ok && r.verify?.verdict !== 'verified' && r.ack !== 'readback-verified')
    const detailOf = (r: typeof results[number]): string => {
      const node = r.nodeId ? ctrl.byId(r.nodeId) : undefined
      return `${node?.name ?? r.templateRef ?? r.nodeId ?? '?'}: ${String(r.message).slice(0, 100)}`
    }
    // 写参期间人工可能停线并重开:本批次不再活动时,不能把本次结果报成「当前已开跑」
    const activeAfter = ctrl.lineState(lineId)
    if (!activeAfter.active || activeAfter.runId !== run.id) {
      try {
        recordOps({
          actor: agentId, actorName: agentBadgeLabel(agentId), actorKind: 'agent',
          action: 'line.start', kind: 'line', targetKind: 'line', targetId: lineId, lineId,
          level: 'error',
          summary: `Agent 开线结果失效:批次 ${run.id.slice(0, 8)} 在写参期间被替代/停止(当前批次 ${activeAfter.runId ?? '无'});未报成功`,
        })
      }
      catch { /* 审计失败不改变拒绝语义 */ }
      return {
        text: `开线执行期间产线批次已变更(本次批次 ${run.id.slice(0, 8)},当前批次 ${activeAfter.runId ?? '无'}),本次结果不能代表当前运行状态。请用 line_status/daq_query 复核实际工况;如需重开请重新提交申请。`,
        isError: true,
      }
    }
    // 全部参数失败 = 线已开但 PLC 未按配方生效:自动停线收窗,避免空跑采样与误判。
    // 只停「本次刚开的批次」:写参数期间人工可能已停线并重开,不能误停新批次。
    if (results.length > 0 && failed.length === results.length) {
      const activeNow = ctrl.lineState(lineId)
      let stopped = false
      let stopNote = ''
      if (activeNow.active && activeNow.runId === run.id) {
        try {
          ctrl.lineStop(lineId)
          stopped = true
        }
        catch { /* 已停/停线失败在文案中如实说明 */ }
      }
      else {
        stopNote = `本批次已被替代或已停止(当前批次 ${activeNow.runId ?? '无'}),未执行自动停线`
      }
      try {
        recordOps({
          actor: agentId, actorName: agentBadgeLabel(agentId), actorKind: 'agent',
          action: 'line.start', kind: 'line', targetKind: 'line', targetId: lineId, lineId,
          level: 'error',
          summary: `Agent 开线失败:「${lineName}」配方「${recipe.name}」全部 ${results.length} 个参数未下发成功(批次 ${run.id.slice(0, 8)});${stopNote || (stopped ? '已自动停线' : '自动停线未成功')};理由:${reason}`,
        })
        if (stopped) {
          recordOps({
            actor: agentId, actorName: agentBadgeLabel(agentId), actorKind: 'agent',
            action: 'line.stop', kind: 'line', targetKind: 'line', targetId: lineId, lineId,
            level: 'warn',
            summary: `Agent 自动停线:批次 ${run.id.slice(0, 8)} 收窗(开线后全部参数下发失败)`,
          })
        }
      }
      catch { /* 审计失败不改变拒绝语义 */ }
      return {
        text: `开线失败:配方「${recipe.name}」全部 ${results.length} 个参数均未下发成功。${stopped ? '已自动停线收窗,产线未保持运行状态。' : stopNote || '自动停线未成功,请立即人工检查并停止产线。'}\n失败明细:\n  - ${failed.map(detailOf).join('\n  - ')}`,
        isError: true,
      }
    }
    try {
      recordOps({
        actor: agentId, actorName: agentBadgeLabel(agentId), actorKind: 'agent',
        action: 'line.start', kind: 'line', targetKind: 'line', targetId: lineId, lineId,
        summary: `Agent 开线:「${lineName}」以配方「${recipe.name}」开跑(批次 ${run.id.slice(0, 8)};失败 ${failed.length},未证实 ${unverified.length});理由:${reason}`,
        level: failed.length > 0 ? 'error' : unverified.length > 0 ? 'warn' : 'info',
      })
    }
    catch { /* 审计失败不影响执行 */ }
    if (failed.length > 0 || unverified.length > 0) {
      const acks = run.ackSummary
      const parts = [
        `产线「${lineName}」已开跑(批次 ${run.id.slice(0, 8)},配方「${recipe.name}」),但参数下发未全部证实${acks ? `(证实 ${acks.verified}/${acks.total},未证实 ${acks.unverified},失败 ${acks.failed})` : ''}:`,
        ...(failed.length > 0 ? [`失败参数:`, ...failed.map(r => `  - ${detailOf(r)}`)] : []),
        ...(unverified.length > 0 ? [`未证实参数(命令已受理,设备侧未确认):`, ...unverified.map(r => `  - ${detailOf(r)}`)] : []),
        '请先用 daq_query 复测实际工况;未生效参数需人工处置或 line_stop 后重试,禁止把本次开线当作全量生效。',
      ]
      return { text: parts.join('\n'), isError: true }
    }
    return { text: `产线「${lineName}」已开跑(批次 ${run.id.slice(0, 8)},配方「${recipe.name}」参数已全部设备证实)。用 daq_query 复测确认数采窗口激活。` }
  }
  catch (err) {
    // lineStart 可能已在创建批次后抛错:不能固定宣称「产线未变更」,按当前状态如实说明
    const after = ctrl.lineState(lineId)
    const stateNote = after.active
      ? `产线当前显示运行中(批次 ${after.runId},配方 ${after.recipeName ?? '-'}),本次调用异常;请立即用 line_status/daq_query 复核,必要时人工停线`
      : '产线当前未运行'
    return { text: `开线执行失败:${err instanceof Error ? err.message : String(err)};${stateNote}。`, isError: true }
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
      { title: `产线停线:${lineName}`, payload: { schemaVersion: 1, kind: 'line-stop', lineId, runId: st.runId, reason } },
    )
  }
  catch (err) {
    return { text: `提交停线审批失败:${err instanceof Error ? err.message : String(err)}`, isError: true }
  }
  if (!decision.approved) {
    return { text: `停线未获批准(超时未批或人工拒绝),产线继续运行。人工意见:${decision.comment || '(无附言)'}` }
  }
  // 审批期间频道可能换线/换 lead,或产线已被人工停止:批准不等于状态未变
  const again = await requireBoundLineLead(agentId, channelId)
  if ('error' in again) return { text: `审批通过后复核失败,本次未停线:${again.error}`, isError: true }
  if (again.lineId !== lineId) {
    return { text: `审批通过后复核失败:频道绑定产线已从「${lineName}」变更为「${again.lineId}」,本次未停线。`, isError: true }
  }
  const now = ctrl.lineState(lineId)
  if (!now.active) {
    return { text: `审批通过后产线「${lineName}」已停止(可能由人工或其他操作完成),无需重复停线。` }
  }
  // 只停审批时看到的那一批:等待期间人工可能停线并重开,批准旧单不得误停新批次
  if (st.runId && now.runId !== st.runId) {
    return {
      text: `审批通过后复核失败:产线「${lineName}」批次已变更(审批时 ${st.runId},当前 ${now.runId}),本次未停线。如仍需停止当前批次,请重新提交停线申请。`,
      isError: true,
    }
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
  const ctrl = getDcwController()
  const manager = getWorkshopManager()
  const ch = channelId ? manager.deps.repos.channels.findById(channelId) : undefined
  const faces = resolveRefFaces(agentId)
  const readable = [...faces.readableLines]
  const wantLine = String(args.line_id ?? '').trim() || String(ch?.lineId ?? '').trim()
  // 2026-10-17 补强:产线参数必须落在可读面内(此前无 channelId 时任意 line_id 可查、缺省列全平台产线)
  if (wantLine && !faces.readableLines.has(wantLine)) {
    return {
      text: `无权查看产线 ${wantLine}(你的可读产线:${readable.join(', ') || '(无)'}${faces.channelLineId ? `;频道绑线「${faces.channelLineId}」为只读来源` : ''})。如需访问,请让用户授予对应产线权限(权限管理),或把当前频道绑定到该产线;也可以改用上述可读产线重试。`,
      isError: true,
    }
  }
  if (!wantLine && readable.length === 0) {
    return { text: '你当前没有可读产线(未绑定任何节点/配方,频道也未绑定产线)。请先让用户或 lead 完成绑定后重试。', isError: true }
  }
  const scopeLines = wantLine ? [wantLine] : readable
  const lines = ctrl.listLines().filter(l => scopeLines.includes(l.id))
  const states = ctrl.allLineStates().filter(s => scopeLines.includes(s.lineId))
  if (lines.length === 0) return { text: `产线不存在或不在你的可见范围: ${wantLine || '(未指定)'}`, isError: true }
  const rows = lines.map((l) => {
    const s = states.find(x => x.lineId === l.id)
    return s?.active
      ? `· ${l.name}:运行中(批次 ${s.runId?.slice(0, 8)},配方「${s.recipeName}」,产品「${s.productName}」,自 ${s.startedAt},已打标 ${s.taggedSamples} 样本)`
      : `· ${l.name}:未运行(数据保留可查)`
  })
  return { text: `产线状态:\n${rows.join('\n')}` }
}
