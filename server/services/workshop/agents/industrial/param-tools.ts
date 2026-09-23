/**
 * 工艺参数读写(param_control / param_read)与量程/容差辅助
 * (由 server/services/workshop/agents/industrial-tools.ts 按职责拆出;内容逐行原文搬运)
 */
import type { DcwParamView } from '../../../../../shared/dcw-protocol'
import { agentBadgeLabel } from '../agent-badge'
import { getAgentNodeBindingRepo } from '../node-bindings.repo'
import { getDcwController } from '../../dcw/dcw-controller'
import { getDcwParamRepo } from '../../dcw/param-map.repo'
import { getRecipeRollBackManager } from '../../dcw/recipe-rollback-manager'
import { getToolApprovals } from '../tool-approvals'
import { limitsBreakdownOf } from '../../dcw/param-limits'

/** 读/设定偏差对照容差(与服务端回读死区同口径) */
export function writeToleranceOf(node: { decimals: number, min: number, max: number }): number {
  return Math.max(0.5 * 10 ** -node.decimals, (node.max - node.min) * 0.005)
}

/** 工艺参数解析(param_control/param_read 共用):pp-id 优先,其次按 key;跨产线同名需 line_id 消歧 */
export function resolveParamRef(ref: string, lineId?: string): { ok: true, param: DcwParamView } | { ok: false, text: string, isError: true } {
  const repo = getDcwParamRepo()
  const trimmed = String(ref ?? '').trim()
  if (!trimmed) {
    return { ok: false, text: 'param 必填:工艺参数 id(pp-*)或参数 key(见 my_industrial_nodes)。', isError: true }
  }
  const row = trimmed.startsWith('pp-') ? repo.byId(trimmed) : undefined
  if (row) {
    const view = repo.viewOf(row)
    if (!view) return { ok: false, text: `工艺参数 ${trimmed} 的执行节点已不存在(映射悬空)。`, isError: true }
    if (lineId && view.lineId !== lineId) {
      return { ok: false, text: `工艺参数 ${view.key} 不属于产线 ${lineId}(实际归属:${view.lineId || '未分配'})。`, isError: true }
    }
    return { ok: true, param: view }
  }
  const hits = repo.byKey(trimmed)
    .map(r => repo.viewOf(r))
    .filter((v): v is DcwParamView => v != null)
  const scoped = lineId ? hits.filter(v => v.lineId === lineId) : hits
  if (scoped.length === 1) return { ok: true, param: scoped[0]! }
  if (scoped.length === 0) {
    const catalog = repo.listViews().slice(0, 12).map(v => `${v.key}(${v.name})`).join('、')
    return { ok: false, text: `未找到工艺参数「${trimmed}」${lineId ? `(产线 ${lineId})` : ''}。可用参数:${catalog || '无 —— 请先让用户创建写控节点生成参数面'}。`, isError: true }
  }
  return { ok: false, text: `工艺参数「${trimmed}」命中 ${scoped.length} 条同名映射,请附加 line_id 消歧或改用参数 id(${scoped.map(v => v.id).join(' / ')})。`, isError: true }
}

/** 参数面权限摘要(工具回包统一口径;不透出寄存器等 PLC 寻址细节) */
export function paramLimitsText(param: DcwParamView): string {
  const node = getDcwController().byId(param.nodeId)
  if (!node) return '执行节点已删除'
  const bd = limitsBreakdownOf(node)
  const layers = bd.layers.filter(l => l.min != null || l.max != null).map(l => l.label).join(' ∩ ')
  return `有效写入区间 ${bd.effective.min}~${bd.effective.max}${param.unit}(约束层:${layers || '无'})`
}

/** 工具:param_control —— 按工艺参数下发设定值(推荐的参数语义寻址面)。
 *  权限沿用节点绑定(参数 → 执行节点);限界联锁(参数基准 ∩ 产品 ∩ 配方 ∩ 节点安全量程)
 *  在网关咽喉点统一生效。args.hypothesis 声明本次假设(入册),args.task_id 关联任务。 */
export async function toolParamControl(agentId: string, args: {
  param?: string
  value?: number | string
  hypothesis?: string
  task_id?: string
  line_id?: string
}): Promise<{ text: string, isError?: boolean }> {
  const resolved = resolveParamRef(String(args.param ?? ''), args.line_id ? String(args.line_id) : undefined)
  if (!resolved.ok) return resolved
  const param = resolved.param
  const value = Number(args.value)
  if (!Number.isFinite(value)) {
    return { text: '设定值 value 必须为数字。', isError: true }
  }
  const repo = getAgentNodeBindingRepo()
  const binding = repo.find(agentId, param.nodeId, 'dcw')
  if (!binding) {
    const mine = repo.byAgent(agentId).filter(b => b.kind === 'dcw')
    return {
      text: mine.length
        ? `无权操作工艺参数「${param.key}」(执行节点 ${param.nodeId} 未绑定给你)。你有权控制的数控节点:${mine.map(b => b.nodeId).join(', ')}。`
        : '你尚未绑定任何数控节点,无权下发控制指令。请在数字孪生界面绑定数控节点。',
      isError: true,
    }
  }
  const node = getDcwController().byId(param.nodeId)
  if (!node) {
    repo.removeAgentNode(agentId, param.nodeId, 'dcw')
    return { text: `工艺参数「${param.key}」的执行节点已不存在(可能被删除),原绑定已自动清理。`, isError: true }
  }
  if (!node.enabled) {
    return { text: `工艺参数「${param.key}」的执行节点「${node.name}」已停用(控制已暂停),无法下发。`, isError: true }
  }
  // 手动确认模式:与 dcw_control 同源审批面,备注回给 Agent
  if (binding.mode === 'manual') {
    const approvals = getToolApprovals()
    if (approvals.hasPendingFor(agentId, param.nodeId)) {
      return { text: '你对该执行节点已有一条待审批的下发指令,请等待用户处理后再发新指令(避免审批堆积)。', isError: true }
    }
    const detail = `工艺参数「${param.key}」(${param.name})设定 ${value}${param.unit},${paramLimitsText(param)}`
    const ap = await approvals.request(agentId, param.nodeId, 'dcw', detail)
    if (!ap.approved) {
      return { text: `指令未执行:用户${ap.comment.includes('超时') ? '未在时限内批准(超时)' : `拒绝了本次下发`}。用户备注:${ap.comment || '(无)'}` }
    }
    if (!repo.find(agentId, param.nodeId, 'dcw')) {
      return { text: '指令未执行:审批通过时你的该节点绑定已被解除(权限在批准时失效)。', isError: true }
    }
  }
  try {
    const meta = {
      source: 'agent' as const,
      actor: agentId,
      actorName: agentBadgeLabel(agentId),
      taskId: args.task_id ? String(args.task_id) : undefined,
      hypothesis: args.hypothesis ? String(args.hypothesis) : '',
    }
    const outcome = await getDcwController().writeParam(param.id, value, meta)
    if (outcome.ok) {
      const stable = getRecipeRollBackManager().journal({ nodeId: param.nodeId, limit: 10 }).find(a => a.prevValue != null && a.prevValue !== a.newValue)
      const loopTxt = [
        outcome.recordId ? `优化记录 ${outcome.recordId} 已开窗(观察数采后 dcw_judge 落判定)` : null,
        stable ? `上一稳定锚:${stable.prevValue}${param.unit}(可 dcw_rollback 回退)` : null,
      ].filter(Boolean).join(';')
      return {
        text: `下发成功:工艺参数「${param.key}」(${param.name})设定 ${value}${param.unit} → 执行节点「${node.name}」;回读 ${outcome.readback != null ? `${outcome.readback}${param.unit}` : '不支持'}一致。${paramLimitsText(param)}。${outcome.message}${loopTxt ? `\n[调控闭环] ${loopTxt}` : ''}`,
      }
    }
    return { text: `下发失败:${outcome.message}(工艺参数 ${param.key},执行节点「${node.name}」;${paramLimitsText(param)};当前设定值保持 ${node.value ?? '原值'}${param.unit} 未被改动)`, isError: true }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { text: `下发被拒绝:${msg}(工艺参数 ${param.key};${paramLimitsText(param)})`, isError: true }
  }
}

/** 工具:param_read —— 按工艺参数读取 PLC 当前值(被动观测免审批) */
export async function toolParamRead(agentId: string, args: {
  param?: string
  line_id?: string
}): Promise<{ text: string, isError?: boolean }> {
  const resolved = resolveParamRef(String(args.param ?? ''), args.line_id ? String(args.line_id) : undefined)
  if (!resolved.ok) return resolved
  const param = resolved.param
  const repo = getAgentNodeBindingRepo()
  if (!repo.find(agentId, param.nodeId, 'dcw')) {
    const mine = repo.byAgent(agentId).filter(b => b.kind === 'dcw')
    return {
      text: mine.length
        ? `无权读取工艺参数「${param.key}」(执行节点 ${param.nodeId} 未绑定给你)。你有权读取的数控节点:${mine.map(b => b.nodeId).join(', ')}。`
        : '你尚未绑定任何数控节点,无权读取控制通道数据。请在数字孪生界面绑定数控节点。',
      isError: true,
    }
  }
  const node = getDcwController().byId(param.nodeId)
  if (!node) {
    repo.removeAgentNode(agentId, param.nodeId, 'dcw')
    return { text: `工艺参数「${param.key}」的执行节点已不存在(可能被删除),原绑定已自动清理。`, isError: true }
  }
  try {
    const read = await getDcwController().readParam(param.id)
    if (!read.ok && read.value == null && !node.readValue) {
      return { text: `读取失败:${read.message}(执行节点「${node.name}」驱动 ${node.driver} 可能不支持读取;可改用 daq_query 查关联数采通道)`, isError: true }
    }
    const readTxt = read.value != null
      ? `${Number(read.value.toFixed(param.decimals))}${param.unit} @ ${read.at.slice(11, 19)}`
      : (node.readValue != null ? `${node.readValue}${param.unit}(最近一次)` : '无读数')
    return {
      text: `读取成功:工艺参数「${param.key}」(${param.name})\n  PLC 读数(ACT): ${readTxt}\n  当前设定(SET): ${node.value != null ? `${node.value}${param.unit}` : '从未下发'}\n  ${paramLimitsText(param)}`,
    }
  }
  catch (err) {
    return { text: `读取被拒绝:${err instanceof Error ? err.message : String(err)}(工艺参数 ${param.key})`, isError: true }
  }
}
