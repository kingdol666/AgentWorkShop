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
import { AML_TRAINING_TOOL_NAMES, AML_MODEL_BACKED_TOOL_NAMES } from './catalog'
import { twinWriteGuard } from '../../aml/twin/feature-flags'
import { listPluginTools, pluginOfTool } from '../plugin-tools'
import type { HostToolBridgeContext, HostToolCall, HostToolResult } from './types'
import { INDUSTRIAL_TOOL_NAMES, dispatchIndustrialTool } from './tools/industrial'
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
export async function dispatchHostTool(ctx: HostToolBridgeContext, req: HostToolCall): Promise<HostToolResult> {
  const identity = ctx.identity
  const state = ctx.state
  // 插件工具分发(ctx.omp.registerTool 注册的自定义工具;不依赖 workspace,优先于内置面)
  const pluginTool = listPluginTools().get(req.toolName)
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
    try {
      return await pluginTool.handler(req.arguments ?? {}, identity)
    }
    catch (err) {
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

  // 所有真实写入口在统一分发层再做一次服务端 fail-closed 守卫；工具目录隐藏不是安全边界。
  if (['dcw_control', 'param_control', 'dcw_rollback', 'recipe_update', 'recipe_rollback', 'recipe_trial', 'recipe_apply'].includes(req.toolName)) {
    const profile = getChannelTwinProfile(identity.channelId)
    const guard = twinWriteGuard(identity.channelId, profile)
    if (!guard.allowed) return { text: `${guard.code}: ${guard.message}`, isError: true }
  }

  // 工业工具族不依赖 workspace(只按 agentId 查绑定与节点),先于 workspace 门控执行 ——
  // 否则 worker 首回合前的 REST/MCP 直调(my_industrial_nodes 等)会被误拒
  if (INDUSTRIAL_TOOL_NAMES.has(req.toolName)) {
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
      case 'dcw_read':
      case 'param_control':
      case 'param_read':
      case 'daq_query':
      case 'daq_frames':
      case 'daq_export':
      case 'dcw_judge':
      case 'dcw_rollback':
      case 'dcw_journal':
      case 'ops_log':
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
