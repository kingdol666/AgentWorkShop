/**
 * host tool 目录与按角色装配(原 host-tool-bridge.ts 的 HOST_TOOLS / 占位符注入 / hostToolsForRole,
 * 按行搬运;导出名与签名不变,由 index.ts 原样再导出)。
 */
import type { RpcHostToolDefinition } from '../adapters/omp-rpc-client'
import { loadHostToolDefs } from '../../prompts/loader'
import { daqRuntimeSettings } from '../../settings'
import { listPluginTools, pluginOfTool } from '../plugin-tools'
import { getChannelPluginsRepo } from '../../db/channel-plugins.repo'
import { isHybridTwinChannel } from '../../aml/twin/channel-profile'

/** host tool 定义(外置 .AgentWorkShop/prompts/host-tools.json;加载器缓存) */
export const HOST_TOOLS: RpcHostToolDefinition[] = loadHostToolDefs()

/** 仅 lead 可见的工具名(dispatch/调度/团队管理面 + AML 模型治理面;worker 注册时剔除,压缩工具上下文) */
export const LEAD_ONLY_TOOL_NAMES = new Set([
  'submit_task',
  'dispatch_task',
  'get_queue_overview',
  'read_channel_mail',
  'reassign_task',
  'update_task',
  'create_team_agent',
  'update_team_agent',
  'remove_team_agent',
  'aml_model_promote',
])

/** Hybrid Twin 工具只对显式 profile=hybrid_twin 的 Channel 注入。 */
export const HYBRID_TWIN_TOOL_NAMES = new Set([
  'twin_scene_read', 'twin_snapshot_create', 'twin_trial_run', 'mpc_optimize', 'twin_gate_evaluate',
])

/** 占位符动态注入:工具描述里的运行时配置值(每次装配实时计算,配置热重载后 Agent 拿到新值) */
function applyDescriptionPlaceholders(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
  let q: { defaultBucketMs: number, minBucketMs: number } | null = null
  try {
    q = daqRuntimeSettings().query
  }
  catch { /* 设置系统不可用(单测) → 保留原始描述 */ }
  if (!q) return tools
  const map: Record<string, string> = {
    queryDefaultBucketMs: String(q.defaultBucketMs),
    queryMinBucketMs: String(q.minBucketMs),
  }
  return tools.map(t => ({
    ...t,
    description: t.description.replace(/\{(queryDefaultBucketMs|queryMinBucketMs)\}/g, (_, k) => map[k] ?? _),
    parameters: JSON.parse(JSON.stringify(t.parameters ?? {}).replace(/\{(queryDefaultBucketMs|queryMinBucketMs)\}/g, (_m: string, k: string) => map[k] ?? _m)),
  }))
}

/**
 * 按角色装配 host tools:lead = 全量;worker = 剔除 lead 专属(执行面 + 通信面 + 记忆面);
 * 尾部合并插件注册工具(roles 过滤,缺省双角色可用;channelId 给定且该团队有显式
 * 插件开关时,关闭的插件其工具不注入 —— 防不需要插件的 channel 上下文被污染)。
 * 全 harness 共用:omp 经 set_host_tools 下发;其余引擎经 MCP 桥 tools/list 拉取。
 */
export function hostToolsForRole(role: 'lead' | 'worker', channelId?: string): RpcHostToolDefinition[] {
  const base = role === 'lead'
    ? HOST_TOOLS
    : HOST_TOOLS.filter(t => !LEAD_ONLY_TOOL_NAMES.has(t.name))
  const hybrid = channelId ? isHybridTwinChannel(channelId) : false
  const scoped = hybrid ? base : base.filter(t => !HYBRID_TWIN_TOOL_NAMES.has(t.name))
  const out = [...scoped]
  // 团队级插件开关:显式配置过的 channel 按行过滤;未配置(无行)= 全启用,向后兼容
  const channelOff = channelId
    ? getChannelPluginsRepo().explicitFor(channelId)
    : null
  for (const [name, tool] of listPluginTools()) {
    if (out.some(t => t.name === name)) continue
    if (tool.roles && !tool.roles.includes(role)) continue
    const owner = pluginOfTool(name)
    if (channelOff && owner && channelOff.get(owner) === false) continue
    out.push({ name, label: tool.label ?? name, description: tool.description, parameters: tool.parameters ?? {} })
  }
  return applyDescriptionPlaceholders(out)
}
