/**
 * 工业工具族(my_industrial_nodes / aml_* / dcw_* / param_* / daq_* / ops_log / recipe_* / line_context)。
 *
 * 原 dispatchHostTool 首个 switch 的 26 个转发分支按行搬运到本模块:每个分支都只是
 * 「按 agentId 查绑定与节点后转交 industrial 模块的同名函数」,因此把闭包捕获的
 * (identity.agentId, args) 收敛为显式参数,并整理成「工具名 → 处理器」一张表。
 * 工具名集合与处理器表同源(INDUSTRIAL_TOOL_NAMES 由表键导出),不会出现有名字无处理器的分支。
 *
 * 该族**不依赖 workspace**,由 dispatch 在 workspace 门控之前分流(保持原分发顺序)。
 */
import type { HostToolResult } from '../types'
import { toolAmlDatasetBuild, toolAmlDatasetStats, toolAmlJobCancel, toolAmlJobLogs, toolAmlJobStatus, toolAmlJobSubmit, toolAmlLeaderboard, toolAmlModelPromote, toolAmlModelReference, toolAmlNodeCatalog, toolDaqFrames, toolDaqQuery, toolDcwControl, toolDcwJudge, toolDcwJournal, toolDcwRead, toolDcwRollback, toolLineContext, toolMyIndustrialNodes, toolOpsLog, toolParamControl, toolParamRead, toolRecipeLog, toolRecipeRollback, toolRecipeUpdate, toolRecipeVersions } from '../../industrial'

type IndustrialToolHandler = (agentId: string, args: Record<string, unknown>) => Promise<HostToolResult>

/** 工具名 → 转发处理器(顺序与原 dispatch 首个 switch 的分支顺序一致) */
const INDUSTRIAL_HANDLERS = new Map<string, IndustrialToolHandler>([
  ['my_industrial_nodes', agentId => toolMyIndustrialNodes(agentId)],
  ['aml_node_catalog', agentId => toolAmlNodeCatalog(agentId)],
  ['aml_dataset_build', (agentId, args) => toolAmlDatasetBuild(agentId, args as Parameters<typeof toolAmlDatasetBuild>[1])],
  ['aml_dataset_stats', (agentId, args) => toolAmlDatasetStats(agentId, args as Parameters<typeof toolAmlDatasetStats>[1])],
  ['aml_job_submit', (agentId, args) => toolAmlJobSubmit(agentId, args as Parameters<typeof toolAmlJobSubmit>[1])],
  ['aml_job_status', (agentId, args) => toolAmlJobStatus(agentId, args as Parameters<typeof toolAmlJobStatus>[1])],
  ['aml_job_logs', (agentId, args) => toolAmlJobLogs(agentId, args as Parameters<typeof toolAmlJobLogs>[1])],
  ['aml_job_cancel', (agentId, args) => toolAmlJobCancel(agentId, args as Parameters<typeof toolAmlJobCancel>[1])],
  ['aml_leaderboard', (agentId, args) => toolAmlLeaderboard(agentId, args as Parameters<typeof toolAmlLeaderboard>[1])],
  ['aml_model_promote', (agentId, args) => toolAmlModelPromote(agentId, args as Parameters<typeof toolAmlModelPromote>[1])],
  ['aml_model_reference', (agentId, args) => toolAmlModelReference(agentId, args as Parameters<typeof toolAmlModelReference>[1])],
  ['dcw_control', (agentId, args) => toolDcwControl(agentId, args as { node_id?: string, value?: number | string, hypothesis?: string, task_id?: string })],
  ['dcw_read', (agentId, args) => toolDcwRead(agentId, args as { node_id?: string })],
  ['param_control', (agentId, args) => toolParamControl(agentId, args as { param?: string, value?: number | string, hypothesis?: string, task_id?: string, line_id?: string })],
  ['param_read', (agentId, args) => toolParamRead(agentId, args as { param?: string, line_id?: string })],
  ['daq_query', (agentId, args) => toolDaqQuery(agentId, args as Parameters<typeof toolDaqQuery>[1])],
  ['daq_frames', (agentId, args) => toolDaqFrames(agentId, args as Parameters<typeof toolDaqFrames>[1])],
  ['dcw_judge', (agentId, args) => toolDcwJudge(agentId, args as { record_id?: string, verdict?: string, reason?: string })],
  ['dcw_rollback', (agentId, args) => toolDcwRollback(agentId, args as { record_id?: string, node_id?: string, to?: string })],
  ['dcw_journal', (agentId, args) => toolDcwJournal(agentId, args as { node_id?: string, recipe_id?: string, limit?: number | string })],
  ['ops_log', (agentId, args) => toolOpsLog(agentId, args as Parameters<typeof toolOpsLog>[1])],
  ['recipe_log', (agentId, args) => toolRecipeLog(agentId, args as Parameters<typeof toolRecipeLog>[1])],
  ['line_context', (agentId, args) => toolLineContext(agentId, args as { line_id?: string })],
  ['recipe_versions', (agentId, args) => toolRecipeVersions(agentId, args as { recipe_id?: string, limit?: number | string })],
  ['recipe_update', (agentId, args) => toolRecipeUpdate(agentId, args as Parameters<typeof toolRecipeUpdate>[1])],
  ['recipe_rollback', (agentId, args) => toolRecipeRollback(agentId, args as Parameters<typeof toolRecipeRollback>[1])],
])

/** 工业工具名集合(与 INDUSTRIAL_HANDLERS 同源;dispatch 据此在 workspace 门控前分流) */
export const INDUSTRIAL_TOOL_NAMES: ReadonlySet<string> = new Set(INDUSTRIAL_HANDLERS.keys())

/**
 * 工业工具族分发:按工具名转交 industrial 模块(调用参数与该族原分支逐字一致)。
 * 调用方先经 INDUSTRIAL_TOOL_NAMES 判断,故「未登记的工具名」不可达 —— 仍然显式拒绝,
 * 避免静默返回与未知工具混淆。
 */
export function dispatchIndustrialTool(agentId: string, toolName: string, args: Record<string, unknown>): Promise<HostToolResult> {
  const handler = INDUSTRIAL_HANDLERS.get(toolName)
  if (!handler) return Promise.reject(new Error(`未知工业工具: ${toolName}`))
  return handler(agentId, args)
}
