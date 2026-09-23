/**
 * 节点清单、数控下发/回读(dcw_control / dcw_read)
 * (由 server/services/workshop/agents/industrial-tools.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AgentNodeBinding } from '../node-bindings.repo'
import { agentBadgeLabel } from '../agent-badge'
import { findDcwTemplate } from '../../dcw/dcw-templates'
import { getActiveLineRun } from '../../dcw/line-run'
import { getAgentNodeBindingRepo } from '../node-bindings.repo'
import { getDaqNodeRepo } from '../../daq/daq-node.repo'
import { getDcwController } from '../../dcw/dcw-controller'
import { getRecipeRollBackManager } from '../../dcw/recipe-rollback-manager'
import { getToolApprovals } from '../tool-approvals'
import { limitsBreakdownOf } from '../../dcw/param-limits'
import { nodeSemanticCards } from '../industrial-context'
import { writeToleranceOf } from './param-tools'

export async function toolMyIndustrialNodes(agentId: string): Promise<{ text: string }> {
  const repo = getAgentNodeBindingRepo()
  const bindings = repo.byAgent(agentId)
  if (bindings.length === 0) {
    return { text: '你尚未绑定任何工业节点。请在数字孪生界面的 Agent 详情面板中绑定数控/数采节点后再调用工业工具。' }
  }
  const cards = nodeSemanticCards(agentId)
  if (cards.stale > 0) repo.removeAgentNodeStale(agentId, bindings.filter((b) => {
    const has = b.kind === 'dcw' ? !!getDcwController().byId(b.nodeId) : !!getDaqNodeRepo().byId(b.nodeId)
    return !has
  }).map(b => b.id))
  if (!cards.text) return { text: '绑定的节点均已不存在(可能被删除),请重新绑定。' }
  const staleNote = cards.stale > 0
    ? `
(另有 ${cards.stale} 条失效绑定已自动清理)`
    : ''
  // 调控闭环洞察:每个数控节点的 open 优化记录 / lastGood / 最近判定(Agent 驱动的状态面)
  const rb = getRecipeRollBackManager()
  const insights: string[] = []
  for (const b of bindings.filter(x => x.kind === 'dcw')) {
    try {
      const ins = rb.nodeInsight(b.nodeId)
      const parts: string[] = []
      if (ins.openRecord)
        parts.push(`进行中优化 ${ins.openRecord.id}: ${ins.openRecord.params[0]?.from ?? '?'}→${ins.openRecord.params[0]?.to}(setAt ${ins.openRecord.setAt.slice(11, 19)},policy=${ins.openRecord.policy})`)
      if (ins.lastGood != null)
        parts.push(`上次良好值 ${ins.lastGood}`)
      for (const j of ins.recentJudges.slice(0, 1))
        parts.push(`最近判定 ${j.verdict}(${j.by}):${j.reason.slice(0, 60)}`)
      if (parts.length > 0)
        insights.push(`- ${b.nodeId}: ${parts.join(';')}`)
    }
    catch { /* 节点刚被删等情况忽略 */ }
  }
  const insightBlock = insights.length > 0 ? `\n\n调控闭环状态:\n${insights.join('\n')}` : ''
  return {
    text: `${cards.text}${staleNote}${insightBlock}

---
通用规则:
1. 一个 Agent 可绑定多个节点;先读本清单理解每个节点的物理意义与操作守则,再动手。
2. 数控下发优先用 param_control(param, value) 以**工艺参数**寻址(key 语义稳定,跨批次/换配方不变);
   dcw_control(node_id, value) 为节点直接寻址的兼容面。设定值受四层限界联锁
   (节点安全量程 ∩ 工艺参数基准限界 ∩ 活动产品限界 ∩ 活动配方工艺窗口)逐层收窄,
   越界一律拒绝 —— 用户与 Agent 一体约束,无旁路。下发前/后用 param_read(param) 读 PLC 当前值取证复核(被动观测免审批)。
3. 数据获取 daq_query(不传 node_id = 全部数采节点),支持按产线/产品/配方/时间检索;解读数据时结合语义卡的判读方法。
4. 改动设定后等待工艺响应(热惯性/传动惯量)再评估,避免连续大幅调整。
5. 调控闭环:每次下发自动开一条优化记录(open);观察数采后用 dcw_judge 落判定(keep/rollback/uncertain);
   判 rollback 后用 dcw_rollback 执行回退;dcw_journal 可查节点参数变更史。未判定前再下发,旧记录会被标记 superseded。
   若节点被他人的 open 记录阻塞(对方已消失),超时(30 分钟)后你可接管:dcw_judge 会带接管标记入册。
6. 自查面:line_context 看你控制的产线/产品/配方全景(动手前必读,确认归属);
   ops_log 查你负责产线的运维日志(谁/何时做了什么,来源区分 Agent/用户/系统;
   参数 line_id/node_id/kind/actor_kind/minutes/limit/mine);recipe_log 查配方下发与回退事件;
   recipe_versions 查配方参数版本史(谁改的/为什么/参数 diff)。
7. 配方操控闭环(在线优化框架):验证过参数更优 → recipe_update 保存进配方(记录你的名字与原因,
   生成新版本);发现优化有问题 → recipe_rollback 回退到稳定版本(version)或已知良好批次
   (to_last_good=true);运行中 PLC 当前值用 dcw_control 下发,配方定义供后续批次生效。`,
  }
}

/** 工具:dcw_control —— 数控下发(鉴权 → 停线守卫 → 手动审批 → 安全联锁 → 回读语义结果)。
 *  调控闭环:下发自动开优化记录;args.hypothesis 声明本次假设(入册),args.task_id 关联任务。 */
export async function toolDcwControl(agentId: string, args: { node_id?: string, value?: number | string, hypothesis?: string, task_id?: string }): Promise<{ text: string, isError?: boolean }> {
  const nodeId = String(args.node_id ?? '').trim()
  const value = Number(args.value)
  const repo = getAgentNodeBindingRepo()
  const binding: AgentNodeBinding | undefined = nodeId ? repo.find(agentId, nodeId, 'dcw') : undefined
  if (!binding) {
    const mine = repo.byAgent(agentId).filter(b => b.kind === 'dcw')
    return {
      text: mine.length
        ? `无权操作节点 ${nodeId || '(空)'}。你有权控制的数控节点:${mine.map(b => b.nodeId).join(', ')}(可用 my_industrial_nodes 查看物理含义)。`
        : '你尚未绑定任何数控节点,无权下发控制指令。请在数字孪生界面绑定数控节点。',
      isError: true,
    }
  }
  if (!Number.isFinite(value)) {
    return { text: '设定值 value 必须为数字。', isError: true }
  }
  const node = getDcwController().byId(nodeId)
  if (!node) {
    // 节点已被删除 → 绑定失效自清理,提示重新绑定
    repo.removeAgentNode(agentId, nodeId, 'dcw')
    return { text: `数控节点 ${nodeId} 已不存在(可能被删除),原绑定已自动清理,请重新绑定。`, isError: true }
  }
  // 停用/解绑守卫:停用节点拒绝下发(与手动/配方同源语义,给出恢复路径)
  if (!node.enabled) {
    return { text: `节点「${node.name}」已停用(控制已暂停),无法下发。请先让用户在产线/数采界面恢复该节点的控制,或改派其他节点。`, isError: true }
  }
  // 停线守卫:产线未开跑时手动写允许(调试),但提示当前无配方窗口约束
  const tpl = findDcwTemplate(node.templateKey)

  // 手动确认模式:挂起等待用户批准(备注会回给 Agent)
  // 同 Agent 同节点的挂起审批去重:防止审批面板堆积(前一条未决,拒绝新的)
  if (binding.mode === 'manual') {
    const approvals = getToolApprovals()
    if (approvals.hasPendingFor(agentId, nodeId)) {
      return { text: `你对该节点已有一条待审批的下发指令,请等待用户处理后再发新指令(避免审批堆积)。`, isError: true }
    }
    const bd = limitsBreakdownOf(node)
    const detail = `${node.name}(${tpl?.ch ?? node.templateKey})设定 ${value}${node.unit},有效写入区间 ${bd.effective.min}~${bd.effective.max}${node.unit}(${bd.layers.map(l => l.label).join(' ∩ ')})`
    const ap = await approvals.request(agentId, nodeId, 'dcw', detail)
    if (!ap.approved) {
      return { text: `指令未执行:用户${ap.comment.includes('超时') ? '未在时限内批准(超时)' : `拒绝了本次下发`}。用户备注:${ap.comment || '(无)'}` }
    }
    // 审批期间节点可能被解绑/删除(权限在批准时失效):二次校验
    if (!repo.find(agentId, nodeId, 'dcw')) {
      return { text: '指令未执行:审批通过时你的该节点绑定已被解除(权限在批准时失效)。', isError: true }
    }
  }

  try {
    const meta = {
      source: 'agent' as const,
      actor: agentId,
      // 人话操作者:「Channel名/成员名」——/logs 来源=Agent 与用户/系统操作可区分追溯
      actorName: agentBadgeLabel(agentId),
      taskId: args.task_id ? String(args.task_id) : undefined,
      hypothesis: args.hypothesis ? String(args.hypothesis) : '',
    }
    const outcome = await getDcwController().write(nodeId, value, null, meta)
    const run = node.lineId ? getActiveLineRun(node.lineId) : null
    const winTxt = run
      ? `当前活动配方「${run.recipeName}」`
      : '当前无活动配方(全局量程约束)'
    if (outcome.ok) {
      // 调控闭环回包:记录 id + 上一稳定锚 + 策略提示(安全网信息,Agent 据此规划判定)
      const rb = getRecipeRollBackManager()
      const stable = rb.journal({ nodeId, limit: 10 }).find(a => a.prevValue != null && a.prevValue !== a.newValue)
      const policyHint = binding.mode === 'manual'
        ? '本节点为手动确认模式:判定回退将推请用户确认'
        : '本节点为自动模式:越配方监控窗将触发系统自动回退'
      const loopTxt = [
        outcome.recordId ? `优化记录 ${outcome.recordId} 已开窗(观察数采后 dcw_judge 落判定)` : null,
        stable ? `上一稳定锚:${stable.prevValue}${node.unit}(可 dcw_rollback 回退)` : null,
        policyHint,
      ].filter(Boolean).join(';')
      return {
        text: `下发成功:${node.name}(${tpl?.ch ?? node.templateKey})设定 ${value}${node.unit} → PLC 原始值 ${outcome.raw ?? '-'};回读 ${outcome.readback != null ? `${outcome.readback}${node.unit}` : '不支持'}一致。${winTxt}。${outcome.message}\n[调控闭环] ${loopTxt}`,
      }
    }
    // 失败文案带自我纠正线索:当前保持原值 + 建议动作(缩小步进/稍后重试)
    const keptHint = `当前设定值保持 ${node.value ?? '原值'}${node.unit} 未被改动`
    const retryHint = /忙|busy/i.test(outcome.message) ? '链路忙属瞬时状态,可稍后重试' : '可缩小步进幅度后重试'
    return { text: `下发失败:${outcome.message}(节点 ${node.name},物理量 ${tpl?.ch ?? node.templateKey},安全量程 ${node.min}~${node.max}${node.unit};${keptHint};${retryHint})`, isError: true }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const retryHint = /忙|busy/i.test(msg) ? '链路忙属瞬时状态,可稍后重试' : '设定值必须落在安全量程与活动配方工艺窗口内'
    return { text: `下发被拒绝:${msg}(节点 ${node.name},物理量 ${tpl?.ch ?? node.templateKey};${retryHint})`, isError: true }
  }
}

/** 工具:dcw_read —— 读取数控节点的 PLC 当前值(读写集成的读半边;被动观测免审批)。
 *  返回 PLC 实时读数(标定解码后的物理量)与当前设定值对照,供下发前取证/下发后复核。 */
export async function toolDcwRead(agentId: string, args: { node_id?: string }): Promise<{ text: string, isError?: boolean }> {
  const nodeId = String(args.node_id ?? '').trim()
  const repo = getAgentNodeBindingRepo()
  const binding: AgentNodeBinding | undefined = nodeId ? repo.find(agentId, nodeId, 'dcw') : undefined
  if (!binding) {
    const mine = repo.byAgent(agentId).filter(b => b.kind === 'dcw')
    return {
      text: mine.length
        ? `无权读取节点 ${nodeId || '(空)'}。你有权读取的数控节点:${mine.map(b => b.nodeId).join(', ')}。`
        : '你尚未绑定任何数控节点,无权读取控制通道数据。请在数字孪生界面绑定数控节点。',
      isError: true,
    }
  }
  const node = getDcwController().byId(nodeId)
  if (!node) {
    repo.removeAgentNode(agentId, nodeId, 'dcw')
    return { text: `数控节点 ${nodeId} 已不存在(可能被删除),原绑定已自动清理,请重新绑定。`, isError: true }
  }
  const tpl = findDcwTemplate(node.templateKey)
  try {
    const read = await getDcwController().readNow(nodeId)
    if (!read.ok && read.value == null && !node.readValue) {
      return { text: `读取失败:${read.message}(节点 ${node.name},驱动 ${node.driver} 可能不支持读取;可改用 daq_query 查关联数采通道)`, isError: true }
    }
    const setTxt = node.value != null ? `${node.value}${node.unit}` : '从未下发'
    const readTxt = read.value != null
      ? `${Number(read.value.toFixed(node.decimals))}${node.unit}`
      : (node.readValue != null ? `${node.readValue}${node.unit}(最近一次)` : '无读数')
    const devTxt = read.value != null && node.value != null
      ? (Math.abs(read.value - node.value) < writeToleranceOf(node)
          ? '读数与设定一致(设定已生效)'
          : '读数与设定存在偏差(可能工艺在响应或被本地修改)')
      : '设定与读数暂不可对照'
    return {
      text: `读取成功:${node.name}(${tpl?.ch ?? node.templateKey})\n  PLC 读数(ACT): ${readTxt} @ ${read.at.slice(11, 19)}\n  当前设定(SET): ${setTxt}\n  对照: ${devTxt}${read.raw != null ? `\n  原始值(raw): ${Number(read.raw.toFixed(4))}` : ''}`,
    }
  }
  catch (err) {
    return { text: `读取被拒绝:${err instanceof Error ? err.message : String(err)}(节点 ${node.name})`, isError: true }
  }
}
