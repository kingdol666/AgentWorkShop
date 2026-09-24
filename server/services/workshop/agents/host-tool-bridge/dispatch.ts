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
import { listPluginTools, pluginOfTool } from '../plugin-tools'
import type { HostToolBridgeContext, HostToolCall, HostToolResult } from './types'
import { INDUSTRIAL_TOOL_NAMES, dispatchIndustrialTool } from './tools/industrial'
import { handleCompleteTask, handleReportProgress } from './tools/progress'
import { handleCancelTask, handleDispatchTask, handleGetMyTaskQueue, handleGetTaskDetails, handleListChannelTasks, handleReassignTask, handleRefuseTask, handleSubmitTask, handleUpdateTask } from './tools/tasks'
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

  // 工业工具族不依赖 workspace(只按 agentId 查绑定与节点),先于 workspace 门控执行 ——
  // 否则 worker 首回合前的 REST/MCP 直调(my_industrial_nodes 等)会被误拒
  if (INDUSTRIAL_TOOL_NAMES.has(req.toolName)) {
    return await dispatchIndustrialTool(identity.agentId, req.toolName, args)
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
        return await handleDispatchTask(args, ws)
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
      case 'aml_model_promote':
      case 'aml_model_reference':
      case 'dcw_control':
      case 'dcw_read':
      case 'param_control':
      case 'param_read':
      case 'daq_query':
      case 'daq_frames':
      case 'dcw_judge':
      case 'dcw_rollback':
      case 'dcw_journal':
      case 'ops_log':
      case 'recipe_log':
      case 'line_context':
      case 'recipe_versions':
      case 'recipe_update':
      case 'recipe_rollback':
        return await dispatchIndustrialTool(identity.agentId, req.toolName, args)
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
