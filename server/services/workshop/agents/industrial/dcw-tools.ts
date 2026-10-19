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
import { getDcwLineRepo } from '../../dcw/dcw-line.repo'
import { getRecipeRollBackManager } from '../../dcw/recipe-rollback-manager'
import { limitsBreakdownOf } from '../../dcw/param-limits'
import { nodeSemanticCards, recipeOperationFace } from '../industrial-context'
import { requestManualApproval } from './manual-approval'
import { guardTwinWrite } from '../../aml/twin/write-guard'

export async function toolMyIndustrialNodes(agentId: string): Promise<{ text: string }> {
  const repo = getAgentNodeBindingRepo()
  const bindings = repo.byAgent(agentId)
  if (bindings.length === 0) {
    return { text: '你尚未绑定任何工业对象。请让用户或 lead 为你绑定:数控/数采节点(kind=daq 观察)或配方(kind=recipe,参数写入与下发)。' }
  }
  const cards = nodeSemanticCards(agentId)
  if (cards.stale > 0) repo.removeAgentNodeStale(agentId, bindings.filter((b) => {
    const has = b.kind === 'dcw' ? !!getDcwController().byId(b.nodeId) : b.kind === 'daq' ? !!getDaqNodeRepo().byId(b.nodeId) : true
    return !has
  }).map(b => b.id))
  // 配方操作面(v2:绑定配方的 Agent 在此直接看到"怎么做" —— 运行状态/绑定模式/认证/参数对照)
  const recipeFace = recipeOperationFace(agentId)
  if (!cards.text && !recipeFace) return { text: '绑定的节点均已不存在(可能被删除),请重新绑定。' }
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
    text: `${cards.text}${staleNote}${insightBlock}${recipeFace ? `\n\n${recipeFace}` : ''}

---
通用规则:
1. 一个 Agent 可绑定多个节点与多个配方;先读本清单理解每个节点/配方的物理意义、下发链路与操作守则,再动手。
2. 参数写入与下发一律走你绑定的配方(权限模型 v2,直接写节点已禁用):
   recipe_update(recipe_id, params[{node_id,value}], reason) 保存新版本 → recipe_apply(整批下发到运行中批次)
   或 recipe_trial(候选整批试验,不写版本);劣化用 recipe_rollback(dispatch=true) 统一回退。
   设定值受四层限界联锁(节点安全量程 ∩ 工艺参数基准限界 ∩ 活动产品限界 ∩ 活动配方工艺窗口)逐层收窄,
   越界一律拒绝 —— 用户与 Agent 一体约束,无旁路;底层数控节点(PLC/MES)由配置层承接,你只面对工程量。
   配方必须正在执行(运行门),未运行时任何操作被拒。
3. 数据获取 daq_query(不传 node_id = 全部数采节点),支持按产线/产品/配方/时间检索;解读数据时结合语义卡的判读方法;
   MES 数据用 mes_catalog / mes_fetch(检测向量/图像帧/表格/事件全格式;统计摘要回包,原文落盘)。
   需要完整波形(非统计摘要)做深度分析时用 daq_export:自选节点全量原始时序导出为 CSV + manifest.json
   (节点映射/语义/产线-配方上下文);把 export_id 交 diag_run 发起深度根因诊断,或把目录绝对路径交给其他 worker 离线分析。
4. 改动设定后等待工艺响应(热惯性/传动惯量)再评估,避免连续大幅调整。
5. 调控闭环:每次下发自动开一条优化记录(open);观察数采后用 dcw_judge 落判定(keep/rollback/uncertain);
   判 rollback 后用 recipe_rollback(dispatch=true, reason) 统一回退;dcw_journal 可查节点参数变更史。未判定前再下发,旧记录会被标记 superseded。
   若节点被他人的 open 记录阻塞(对方已消失),超时(30 分钟)后你可接管:dcw_judge 会带接管标记入册。
6. 自查面:line_context 看你控制的产线/产品/配方全景(动手前必读,确认归属);
   ops_log(显式别名 line_log)查产线日志(只含 scope=line 的产线域记录,不含登录/系统设置等全局审计;
   逐条带 scope 与产线/配方/产品归属;参数 line_id/recipe_id/product_id/node_id/kind/actor_kind/from/to/minutes/limit/mine;
   缺省产线=频道绑定线,可用 line_context 拿 line_id 与 recipe_id 后精确过滤);
   recipe_log 查配方变更史(创建/更新/试验/下发/ACK/回退,参数同上,可不传 line_id 只传 recipe_id);
   recipe_versions 查配方参数版本史(谁改的/为什么/参数 diff)。
7. 配方操控闭环(在线优化框架):验证过参数更优 → recipe_update 保存进配方(记录你的名字与原因,
   生成新版本);发现优化有问题 → recipe_rollback 回退到稳定版本(version)或已知良好批次
   (to_last_good=true,dispatch=true 整批恢复运行中产线)。`,
  }
}

/** 工具:dcw_control —— 数控下发(鉴权 → 停线守卫 → 手动审批 → 安全联锁 → 回读语义结果)。
 *  调控闭环:下发自动开优化记录;args.hypothesis 声明本次假设(入册),args.task_id 关联任务。 */
export async function toolDcwControl(agentId: string, args: { node_id?: string, value?: number | string, hypothesis?: string, task_id?: string }, channelId?: string): Promise<{ text: string, isError?: boolean }> {
  // 权限模型 v2:Agent 不直接操作数控节点 —— 参数写入与下发全部收敛到绑定的 recipe
  // (defense in depth:工具面已摘除定义,handler 侧仍拒绝,防直连 invoke 绕行)
  void agentId
  void args
  void channelId
  return {
    text: '直接节点写控已禁用(权限模型 v2):Agent 不再直接操作数控节点。请改用绑定的配方完成同样动作 —— recipe_update(参数写入,生成新版本)/ recipe_apply(整批下发)/ recipe_trial(候选整批试验,不写版本)/ recipe_rollback(回退);均为带理由与 HITL 的配方面操作,治理联锁(量程/步长/限速)照常生效。',
    isError: true,
  }
}

/**
 * v2 前的直写实现(工具面已摘除,但**治理链完整**:四层限界/HITL/60s 联锁/journal/open 记录)。
 * 仍允许**平台内部治理工具**复用:optimization_explore(工艺优化 Channel 的闭环探索,
 * profile 门控)的写入委托它执行 —— Agent 可调用面依然收敛在配方面,此处非 Agent 入口。
 */
export async function dcwControlGovernedInternal(agentId: string, args: { node_id?: string, value?: number | string, hypothesis?: string, task_id?: string }, channelId?: string): Promise<{ text: string, isError?: boolean }> {
  return dcwControlGovernedLegacy(agentId, args, channelId)
}

/** v2 前的直写实现(治理链完整:四层限界/HITL/60s 联锁/journal/open 记录)。
 *  非任何 Agent 工具入口 —— 仅由 dcwControlGovernedInternal 承载平台内部治理写
 *  (optimization_explore 闭环探索的写入委托),Agent 可调用面依然收敛在配方面。 */
async function dcwControlGovernedLegacy(agentId: string, args: { node_id?: string, value?: number | string, hypothesis?: string, task_id?: string }, channelId?: string): Promise<{ text: string, isError?: boolean }> {
  const twinGuard = guardTwinWrite(agentId, channelId)
  if (!twinGuard.allowed) return { text: `${twinGuard.code}: ${twinGuard.message}`, isError: true }
  const nodeId = String(args.node_id ?? '').trim()
  const value = Number(args.value)
  const repo = getAgentNodeBindingRepo()
  const binding: AgentNodeBinding | undefined = nodeId ? repo.find(agentId, nodeId, 'dcw') : undefined
  // 权限模型 v2:配方绑定(kind=recipe)覆盖其参数节点 —— 该节点在绑定配方参数内即算授权
  let recipeAuthorized = false
  let recipeBinding: AgentNodeBinding | undefined
  let authorizedRecipe: ReturnType<ReturnType<typeof getDcwController>['listRecipes']>[number] | undefined
  if (!binding && nodeId) {
    const recipes = repo.byAgent(agentId).filter(b => b.kind === 'recipe')
    for (const b of recipes) {
      const r = getDcwController().listRecipes().find(x => x.id === b.nodeId)
      if (r?.params.some(p => p.nodeId === nodeId)) {
        recipeAuthorized = true
        recipeBinding = b
        authorizedRecipe = r
        break
      }
    }
    // 二级认证(与 recipe-gate 同口径):开认证但 Agent 不在授权清单 = 不可写
    if (authorizedRecipe?.access?.requireAuth && !(authorizedRecipe.access.authorizedAgentIds ?? []).includes(agentId)) {
      return {
        text: `配方「${authorizedRecipe.name}」已开启二级认证,你不在其授权 Agent 清单内,节点 ${nodeId} 的下发被拒。请让用户把你的 Agent 加入配方授权清单。`,
        isError: true,
      }
    }
  }
  if (!binding && !recipeAuthorized) {
    const mine = repo.byAgent(agentId).filter(b => b.kind === 'dcw')
    return {
      text: mine.length
        ? `无权操作节点 ${nodeId || '(空)'}。你有权控制的数控节点:${mine.map(b => b.nodeId).join(', ')}(可用 my_industrial_nodes 查看物理含义)。`
        : '你尚未绑定任何数控节点,也无含该参数的配方绑定,无权下发控制指令(权限模型 v2:持有含该参数的配方绑定即可)。',
      isError: true,
    }
  }
  if (!Number.isFinite(value)) {
    return { text: '设定值 value 必须为数字。', isError: true }
  }
  const node = getDcwController().byId(nodeId)
  if (!node) {
    // 节点已被删除 → 绑定失效自清理,提示重新绑定(仅 dcw 直绑;配方路径无绑定可清)
    if (binding) repo.removeAgentNode(agentId, nodeId, 'dcw')
    return { text: `数控节点 ${nodeId} 已不存在(可能被删除),原绑定已自动清理,请重新绑定。`, isError: true }
  }
  // 停用/解绑守卫:停用节点拒绝下发(与手动/配方同源语义,给出恢复路径)
  if (!node.enabled) {
    return { text: `节点「${node.name}」已停用(控制已暂停),无法下发。请先让用户在产线/数采界面恢复该节点的控制,或改派其他节点。`, isError: true }
  }
  // 停线守卫:产线未开跑时手动写允许(调试),但提示当前无配方窗口约束
  const tpl = findDcwTemplate(node.templateKey)

  // 手动确认模式:与 param_control 同源审批面(manual-approval),批准附言回进回执。
  // 配方授权路径同样受 HITL 约束(2026-10-18 修复):此前只认 dcw 直绑的 mode,
  // 持 recipe 绑定(首绑恒 manual)经 optimization_explore 写节点可绕过人工批准。
  const lineManual = (authorizedRecipe?.lineId ? getDcwLineRepo().controlModeOf(authorizedRecipe.lineId) === 'manual' : false)
  const needsApproval = binding?.mode === 'manual'
    || (!!recipeBinding && (recipeBinding.mode === 'manual' || lineManual))
  let manualFeedback = ''
  if (needsApproval) {
    const bd = limitsBreakdownOf(node)
    const via = recipeBinding && authorizedRecipe
      ? `经配方授权「${authorizedRecipe.name}」${lineManual ? '(产线手动模式)' : ''}`
      : ''
    const ap = await requestManualApproval({
      agentId,
      nodeId,
      detail: `${node.name}(${tpl?.ch ?? node.templateKey})设定 ${value}${node.unit},有效写入区间 ${bd.effective.min}~${bd.effective.max}${node.unit}(${bd.layers.map(l => l.label).join(' ∩ ')})${via ? ` ${via}` : ''}`,
      // 批准后复核同一条授权路径:直绑看 dcw 绑定,配方授权看配方绑定与参数仍存在
      verify: recipeBinding
        ? () => {
            const still = repo.find(agentId, recipeBinding!.nodeId, 'recipe')
            const rec = getDcwController().listRecipes().find(x => x.id === recipeBinding!.nodeId)
            return !!still && (rec?.params.some(p => p.nodeId === nodeId) ?? false)
          }
        : undefined,
    })
    if (!ap.ok) return { text: ap.text, isError: ap.isError }
    manualFeedback = ap.comment ?? ''
  }

  // 审批期间 owner 产线 grant 可能被撤销:批准后重新跑一次分发层同源复核(收权即失活)
  if (channelId) {
    try {
      const { guardIndustrialToolGrant } = await import('./grant-guard')
      const denied = await guardIndustrialToolGrant({ agentId, channelId }, 'optimization_explore', { node_id: nodeId })
      if (denied) return { text: `审批通过后复核失败,本次未执行:${denied.text.replace(/^工具调用被拒(?:\([^)]*\))?[:：]?/, '').trim()}`, isError: true }
    }
    catch (err) {
      // fail-closed:复核服务故障不放行(与 grant-guard 同纪律)
      return { text: `审批通过后权限复核不可用,本次未执行:${err instanceof Error ? err.message : String(err)}。请稍后重试;若持续出现请联系管理员。`, isError: true }
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
      const policyHint = binding?.mode === 'manual'
        ? '本节点为手动确认模式:判定回退将推请用户确认'
        : '本节点为自动模式:越配方监控窗将触发系统自动回退'
      const loopTxt = [
        outcome.recordId ? `优化记录 ${outcome.recordId} 已开窗(观察数采后 dcw_judge 落判定)` : null,
        stable ? `上一稳定锚:${stable.prevValue}${node.unit}(可 dcw_rollback 回退)` : null,
        policyHint,
      ].filter(Boolean).join(';')
      // ACK 鉴定如实表述(2026-10-08):ok 只是命令受理 —— 回读证实与仅链路受理必须区分,
      // 不许对无回读驱动(mqtt/http-no-echo)虚报"回读一致"。
      const ackTxt = outcome.ack === 'readback-verified'
        ? `回读 ${outcome.readback != null ? `${outcome.readback}${node.unit}` : '-'}一致 [设备证实✓]`
        : outcome.ack === 'transport-ack'
          ? '设备侧未回读证实,仅链路受理 [未证实⚠,建议 daq_query 复测]'
          : '无确认通道 [未证实⚠]'
      return {
        text: `下发受理:${node.name}(${tpl?.ch ?? node.templateKey})设定 ${value}${node.unit} → PLC 原始值 ${outcome.raw ?? '-'};${ackTxt}。${winTxt}。${outcome.message}\n[调控闭环] ${loopTxt}${manualFeedback ? `\n[人工反馈] ${manualFeedback}` : ''}`,
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
