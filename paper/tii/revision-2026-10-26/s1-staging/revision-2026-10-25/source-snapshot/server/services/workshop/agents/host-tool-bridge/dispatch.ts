/**
 * dispatchHostTool —— 全引擎唯一工具分发入口,只做前置校验 + 路由。
 *
 * 分发语义与原实现逐字节对齐:插件工具优先 → workspace 协作/任务/记忆面 →
 * 工业工具族 → 插件兜底 → 未知工具报错。各工具族的实现体在 tools/* 中按行搬运,
 * 原先闭包捕获的 (identity / state / args / ws) 一律改为显式参数。
 *
 * 两处必须保持的细节:
 *  - `return await handler(...)`:处理器在 try 内 await,异常才会落回本层的
 *    「工具执行异常」结果(直接 return 未 await 的 promise 会漏掉这个 catch);
 *  - 工业工具族在 `getWorkspace()` 门控**之前**分流(只依赖 agentId)。
 */
import { getChannelPluginsRepo } from '../../db/channel-plugins.repo'
import { getChannelTwinProfile, modelBackedToolPolicyFor, type AmlChannelProfileKind } from '../../aml/twin/channel-profile'
import { getAmlRuntime } from '../../aml/runtime'
import { getDcwLineRepo } from '../../dcw/dcw-line.repo'
import { AML_TRAINING_TOOL_NAMES, AML_MODEL_BACKED_TOOL_NAMES, HOST_TOOLS } from './catalog'
import { twinWriteGuard } from '../../aml/twin/feature-flags'
import { listPluginTools, pluginOfTool } from '../plugin-tools'
import { auditPluginToolCall, governPluginToolCall } from '../plugin-governance'
import type { HostToolBridgeContext, HostToolCall, HostToolResult } from './types'
import { INDUSTRIAL_TOOL_NAMES, dispatchIndustrialTool } from './tools/industrial'
import { guardIndustrialToolGrant } from '../industrial/grant-guard'
import { verifyIndustrialToolCall } from '../industrial/tool-verify'
import { checkToolAgainstScope } from '../../runtime/permission-scope'
import { optimizerDispatchGate, legacyMpcAliasGate } from './optimizer-gate'
import { channelToolGate } from '../../tools/policy'
import type { WorkshopPermissionScope } from '../../../../../shared/workshop-protocol'
import { handleCompleteTask, handleReportProgress } from './tools/progress'
import { handleCancelTask, handleDispatchTask, handleGetMyTaskQueue, handleGetTaskDetails, handleListChannelTasks, handleReassignTask, handleRefuseTask, handleSubmitTask, handleUpdateTask } from './tools/tasks'
import { handleGrantNodes, handleRevokeNodes } from './tools/team-delegation'
import { handleBroadcastMessage, handleListOtherTeams, handlePollMessages, handleReadChannelMail, handleSearchOtherTeamsMemory, handleSendCrossChannelMessage, handleSendMessageToAgent } from './tools/messaging'
import { handleSaveMemory, handleSearchMemory } from './tools/memory'
import { handleCreateTeamAgent, handleGetQueueOverview, handleListTeamAgents, handleRemoveTeamAgent, handleUpdateTeamAgent } from './tools/team'

/**
 * 分发一次 host tool 调用(全引擎唯一入口):
 * 插件工具优先 → workspace 面 → 工业工具族 → 插件兜底 → 未知工具。
 */
/** 统一出口:所有工具结果经截断收口(单点修改,全族生效) */
export async function dispatchHostTool(ctx: HostToolBridgeContext, req: HostToolCall): Promise<HostToolResult> {
  return truncateToolResult(await dispatchHostToolInner(ctx, req), req.toolName)
}

/** 内置工具名(插件同名注册不参与分发:注入面已显示内置定义,执行面必须同源) */
const BUILTIN_TOOL_NAMES = new Set(HOST_TOOLS.map(t => t.name))

/** 优化器绑定 id 列表(不存在/表未建 → 空,fail-closed 由调用方处理)。 */
function listBindingIds(agentId: string): string[] {
  try {
    return (getAmlRuntime().db.prepare('SELECT id FROM optimizer_bindings WHERE channel_agent_id = ?').all(agentId) as Array<{ id: string }>).map(r => r.id)
  }
  catch {
    return []
  }
}

/**
 * 已绑定 AML 模型是否存在通过的优化资格报告(旧 mpc_optimize 迁移门控)。
 * 资格必须**按模型自身谱系**溯源,不能按产线放行:
 *   model → dataset.spec_ref/spec_version → process_model_eligibility(同 spec/version)。
 * 作用域由产线性质决定(simulated → simulation,否则 real),模拟资格不得授权真实线。
 */
export function boundModelHasEligibility(modelId: string): boolean {
  try {
    const db = getAmlRuntime().db
    const model = db.prepare(
      `SELECT m.line_id AS lineId, m.product_id AS productId, m.recipe_id AS recipeId,
              d.spec_ref AS specRef, d.spec_version AS specVersion
       FROM aml_models m JOIN aml_datasets d ON d.id = m.dataset_id
       WHERE m.id = ?`,
    ).get(modelId) as { lineId: string, productId: string, recipeId: string, specRef: string, specVersion: number | null } | undefined
    if (!model?.specRef) return false
    const line = getDcwLineRepo().byId(model.lineId)
    const scope = line?.simulated === true ? 'simulation' : 'real'
    const rows = db.prepare(
      `SELECT e.report_json AS report FROM process_model_eligibility e
       JOIN process_model_specs s ON s.id = e.spec_id AND s.version = e.spec_version
       WHERE e.spec_id = ? AND e.spec_version = ? AND e.scope = ?
         AND s.line_id = ? AND s.product_id = ? AND s.recipe_id = ?
         AND e.optimization_eligible = 1
       ORDER BY e.created_at DESC LIMIT 50`,
    ).all(model.specRef, model.specVersion ?? 1, scope, model.lineId, model.productId, model.recipeId) as Array<{ report: string }>
    return rows.some((r) => {
      try {
        return JSON.parse(r.report || '{}').optimizationEligible === true
      }
      catch {
        return false
      }
    })
  }
  catch {
    return false
  }
}

/** 工具结果统一出口上限:超长文本截断+尾注(2026-10-05 评审;export/diag 类可经 optOut 放行) */
const TOOL_RESULT_MAX_CHARS = 16_000
const TRUNCATE_OPT_OUT_TOOLS = new Set(['daq_export', 'diag_run'])
function truncateToolResult(result: HostToolResult, toolName: string): HostToolResult {
  if (TRUNCATE_OPT_OUT_TOOLS.has(toolName)) return result
  const text = result.text ?? ''
  if (text.length <= TOOL_RESULT_MAX_CHARS) return result
  const head = text.slice(0, TOOL_RESULT_MAX_CHARS)
  return {
    ...result,
    text: head + `
[truncated: ${text.length} → ${TOOL_RESULT_MAX_CHARS} 字符;请收窄时间窗/减少点位/分页后重试]`,
  }
}

async function dispatchHostToolInner(ctx: HostToolBridgeContext, req: HostToolCall): Promise<HostToolResult> {
  const identity = ctx.identity
  const state = ctx.state
  // §13.3 人类发起者作用域:进程内工具调用同样受管理面/高危写限制。
  // REST/MCP 路径已在 manager.invokeHostTool 检查;omp 的 host_tool_call 只经过本函数,
  // 此前完全绕过(群成员 @Agent 可借 Agent 身份执行高危写)。
  {
    const g = globalThis as typeof globalThis & {
      __workshopManager?: { invocationScopeOf?(agentId: string): WorkshopPermissionScope | null }
    }
    const scope = g.__workshopManager?.invocationScopeOf?.(identity.agentId) ?? null
    const verdict = checkToolAgainstScope(scope, req.toolName)
    if (!verdict.allowed) return { text: verdict.message, isError: true }
  }
  // Channel 逐工具选择:执行面复核(目录可能被引擎缓存;不能只靠注入面隐藏)。
  // 未知工具不在此拦截,保持既有“未知工具”错误语义。
  {
    const gate = channelToolGate(identity.channelId, req.toolName)
    if (gate.blocked) return { text: gate.message ?? `工具 ${req.toolName} 不可用`, isError: true }
  }
  // 插件工具分发(ctx.omp.registerTool 注册的自定义工具;不依赖 workspace,优先于内置面)。
  // 同名遮蔽内置工具不生效:否则插件 handler 会绕过 grant/verify/HITL 全部门控,
  // 而注入面仍展示内置 schema(目录与执行语义分裂)。
  const pluginTool = BUILTIN_TOOL_NAMES.has(req.toolName) ? undefined : listPluginTools().get(req.toolName)
  if (pluginTool) {
    // 团队级插件开关:显式关闭的插件,其工具在该团队拒绝执行(与注入过滤同源)
    const channelOff = getChannelPluginsRepo().explicitFor(identity.channelId)
    const owner = pluginOfTool(req.toolName)
    if (channelOff && owner && channelOff.get(owner) === false) {
      return {
        text: `该团队未启用插件「${owner}」,${req.toolName} 不可用。可在团队设置→插件中开启。`,
        isError: true,
      }
    }
    // roles 是执行边界而非仅注入提示:worker 直调 lead 专属插件工具同样拒绝
    if (pluginTool.roles && !pluginTool.roles.includes(identity.role)) {
      return {
        text: `工具 ${req.toolName} 仅对 ${pluginTool.roles.join('/')} 角色开放(当前 ${identity.role})。`,
        isError: true,
      }
    }
    // 平台侧插件治理(WP4b/WP8):kb 入库 HITL + 声明式引用校验;原生/REST/MCP 同源
    const governed = await governPluginToolCall(identity, req.toolName, req.arguments ?? {}, pluginTool)
    if (governed) return governed
    try {
      const result = await pluginTool.handler(req.arguments ?? {}, identity)
      auditPluginToolCall(identity, req.toolName, result)
      return result
    }
    catch (err) {
      auditPluginToolCall(identity, req.toolName, { text: err instanceof Error ? err.message : String(err), isError: true })
      return {
        text: `工具执行异常(${req.toolName}): ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  }
  const args = req.arguments ?? {}

  // AML 解耦门控(fail-closed,与注入过滤同源;目录隐藏不是安全边界):
  //  - legacy:全部 twin/explore 工具拒绝(原始行为);
  //  - trial/mpc/bayes:仅 hybrid_twin,或 aml_optimization 的 aml 模式(已绑定模型);
  //    探索模式给「探索阶段」明确指引而非裸报错;
  //  - optimization_explore:仅工艺优化 Channel;
  //  - 场景/spec/校准请求族:hybrid_twin + 训练 Channel;
  //  - 训练族(aml_job/dataset 等):工艺优化 Channel 拒绝(边训边优被结构禁止)。
  const twinKind: AmlChannelProfileKind = getChannelTwinProfile(identity.channelId).profile
  // G4.6:旧 mpc_optimize 在既无 Profile 绑定也无 AML 模型绑定时不再返回调参方案
  {
    const profile = getChannelTwinProfile(identity.channelId)
    const legacy = legacyMpcAliasGate({
      toolName: req.toolName,
      hasOptimizerBinding: listBindingIds(identity.agentId).length > 0,
      hasBoundModel: Boolean(profile.boundModelId),
      hasEligibleModel: profile.boundModelId ? boundModelHasEligibility(profile.boundModelId) : false,
    })
    if (!legacy.allowed) return { text: `${legacy.code}: ${legacy.message}`, isError: true }
  }
  const isTwinTool = req.toolName.startsWith('twin_') || ['mpc_optimize', 'optimization_explore'].includes(req.toolName)
  if (isTwinTool) {
    const isSceneFamily = /^twin_(scene|physics|provider|calibration)/.test(req.toolName)
    if (req.toolName === 'optimization_explore') {
      if (twinKind !== 'aml_optimization') {
        return { text: `optimization_explore 仅适用于工艺优化 Channel(当前 profile=${twinKind})。`, isError: true }
      }
    }
    else if (AML_MODEL_BACKED_TOOL_NAMES.has(req.toolName)) {
      const policy = modelBackedToolPolicyFor(identity.channelId)
      if (!policy.allowed) {
        return {
          text: policy.reason === 'EXPLORATION_MODE_NO_MODEL'
            ? `当前为探索模式:Channel 尚未绑定 AML 模型,${req.toolName}(孪生验证/贝叶斯寻优)暂不可用。\n请继续用 optimization_explore 做真实激励探索并积累数据;待 AML 训练出合格模型并在 Channel 设置中绑定后,本工具自动启用。`
            : `${req.toolName} 要求模型受控状态(hybrid_twin 或 aml_optimization 的 aml 模式;当前 ${twinKind}${policy.reason ? `/${policy.reason}` : ''})。`,
          isError: true,
        }
      }
    }
    else if (isSceneFamily) {
      if (twinKind !== 'hybrid_twin' && twinKind !== 'aml_training') {
        return { text: `场景/物理 spec 工具仅对 hybrid_twin 或训练 Channel(aml_training)开放(当前 profile=${twinKind})。`, isError: true }
      }
    }
    else if (twinKind === 'legacy') {
      return { text: `Channel ${identity.channelId} 未启用 Twin profile，Twin/MPC 工具拒绝执行。`, isError: true }
    }
  }
  if (AML_TRAINING_TOOL_NAMES.has(req.toolName) && twinKind === 'aml_optimization') {
    return { text: `工艺优化 Channel 不承担建模与训练(职责解耦):${req.toolName} 仅限 AML 训练 Channel 使用。请在此专注 goal 探索与模型驱动寻优。`, isError: true }
  }

  // Optimizer 工具显式门控(G4.3 / B.8.2 #3-#4):
  // 注入面隐藏不是安全边界 —— REST/MCP 直调必须在这里被同样拒绝。
  {
    const gate = optimizerDispatchGate({
      toolName: req.toolName,
      twinKind,
      bindingCount: req.toolName.startsWith('optimizer_') ? listBindingIds(identity.agentId).length : 0,
    })
    if (!gate.allowed) return { text: `${gate.code}: ${gate.message}`, isError: true }
  }

  // 所有真实写入口在统一分发层再做一次服务端 fail-closed 守卫；工具目录隐藏不是安全边界。
  if (['dcw_control', 'param_control', 'dcw_rollback', 'recipe_create', 'recipe_update', 'recipe_rollback', 'recipe_trial', 'recipe_apply'].includes(req.toolName)) {
    // Profile 级写面(2026-10-18):观察面零写、训练面无产线写、优化面只认 optimization_explore。
    // 此前这些 Channel 只是目录不注入,按名直调(REST/MCP)仍可落到写 handler。
    if (twinKind === 'exp-miner' || twinKind === 'line-doctor') {
      return { text: `${req.toolName} 在产线观察面(exp-miner/line-doctor)不可用:该档位物理零写。请改用只读分析工具;若确需改参,请由用户在具备写权限的 Channel 中操作。`, isError: true }
    }
    if (twinKind === 'aml_training') {
      return { text: `${req.toolName} 在 AML 训练 Channel 不可用:训练面不承担产线写入。请把执行放到工艺优化 Channel(optimization_explore 治理链)或由用户手动操作。`, isError: true }
    }
    if (twinKind === 'aml_optimization') {
      return { text: `${req.toolName} 在工艺优化 Channel 不开放:真实写入统一走 optimization_explore 治理链(绑定/HITL/限界/回读同源)。请改用 optimization_explore。`, isError: true }
    }
    const profile = getChannelTwinProfile(identity.channelId)
    const guard = twinWriteGuard(identity.channelId, profile)
    if (!guard.allowed) return { text: `${guard.code}: ${guard.message}`, isError: true }
  }

  // 工业工具族不依赖 workspace(只按 agentId 查绑定与节点),先于 workspace 门控执行 ——
  // 否则 worker 首回合前的 REST/MCP 直调(my_industrial_nodes 等)会被误拒
  if (INDUSTRIAL_TOOL_NAMES.has(req.toolName)) {
    // 权限模型 v3:运行时 grant 复核(收权即失活;绑定面是静态授权,撤销后此处拦截)
    const denied = await guardIndustrialToolGrant(identity, req.toolName, args)
    if (denied) return denied
    // 统一预检:参数形状 + 引用归属(node_id/line_id/recipe_id/dataset_id… 必须落在
    // 调用者的绑定面内;越界拒绝并把「你的绑定面 + 下一步」返回给 Agent)
    const verifyDenied = verifyIndustrialToolCall(identity.agentId, req.toolName, args)
    if (verifyDenied) return verifyDenied
    return await dispatchIndustrialTool(identity.agentId, req.toolName, args, identity.channelId)
  }

  const ws = ctx.getWorkspace()
  if (!ws) {
    return { text: 'workspace 未就绪', isError: true }
  }

  try {
    switch (req.toolName) {
      case 'report_progress':
        return await handleReportProgress(args, state, ws)
      case 'complete_task':
        return await handleCompleteTask(args, state, ws)
      case 'submit_task':
        return await handleSubmitTask(args, state, ws)
      case 'dispatch_task':
        return await handleDispatchTask(args, ws, identity)
      case 'team_grant_nodes':
        return await handleGrantNodes(identity, args, ws)
      case 'team_revoke_nodes':
        return await handleRevokeNodes(identity, args, ws)
      case 'send_message_to_agent':
        return await handleSendMessageToAgent(args, state, ws)
      case 'send_cross_channel_message':
        return await handleSendCrossChannelMessage(args, ws)
      case 'list_other_teams':
        return await handleListOtherTeams(ws)
      case 'search_other_teams_memory':
        return await handleSearchOtherTeamsMemory(args, ws)
      case 'refuse_task':
        return await handleRefuseTask(args, ws)
      case 'poll_messages':
        return await handlePollMessages(args, state, ws)
      case 'read_channel_mail':
        return await handleReadChannelMail(args, ws)
      case 'broadcast_message':
        return await handleBroadcastMessage(args, identity, ws)
      case 'list_channel_tasks':
        return await handleListChannelTasks(ws)
      case 'get_my_task_queue':
        return await handleGetMyTaskQueue(identity, ws)
      case 'get_queue_overview':
        return await handleGetQueueOverview(ws)
      case 'reassign_task':
        return await handleReassignTask(args, ws)
      case 'update_task':
        return await handleUpdateTask(args, ws)
      case 'cancel_task':
        return await handleCancelTask(args, ws)
      case 'list_team_agents':
        return await handleListTeamAgents(ws)
      case 'get_task_details':
        return await handleGetTaskDetails(args, ws)
      case 'search_memory':
        return await handleSearchMemory(args, ws)
      case 'save_memory':
        return await handleSaveMemory(args, ws)
      case 'create_team_agent':
        return await handleCreateTeamAgent(args, ws)
      case 'update_team_agent':
        return await handleUpdateTeamAgent(args, ws)
      case 'remove_team_agent':
        return await handleRemoveTeamAgent(args, ws)

      // 工业工具族的名册(实现在 tools/industrial.ts):上面 workspace 门控前已分流,
      // 这里保留同名路由标签,与原分发表逐条对齐(不可达,行为与原实现一致)。
      case 'my_industrial_nodes':
      case 'aml_node_catalog':
      case 'aml_dataset_build':
      case 'aml_dataset_stats':
      case 'aml_job_submit':
      case 'aml_job_status':
      case 'aml_job_logs':
      case 'aml_job_cancel':
      case 'aml_leaderboard':
      case 'aml_model_find':
      case 'aml_model_promote':
      case 'aml_model_reference':
      case 'twin_scene_read':
      case 'twin_snapshot_create':
      case 'twin_trial_run':
      case 'mpc_optimize':
      case 'twin_gate_evaluate':
      case 'twin_calibration_request':
      case 'dcw_control':
      case 'param_control':
      case 'daq_query':
      case 'daq_frames':
      case 'daq_export':
      case 'dcw_judge':
      case 'dcw_rollback':
      case 'dcw_journal':
      case 'ops_log':
      case 'line_log':
      case 'recipe_log':
      case 'line_context':
      case 'recipe_versions':
      case 'recipe_update':
      case 'recipe_rollback':
        return await dispatchIndustrialTool(identity.agentId, req.toolName, args, identity.channelId)
    }
    return { text: `未知工具: ${req.toolName}`, isError: true }
  }
  catch (err) {
    return {
      text: `工具执行异常(${req.toolName}): ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    }
  }
}
