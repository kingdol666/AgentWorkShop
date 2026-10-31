/**
 * host tool 目录与按角色装配(原 host-tool-bridge.ts 的 HOST_TOOLS / 占位符注入 / hostToolsForRole,
 * 按行搬运;导出名与签名不变,由 index.ts 原样再导出)。
 */
import type { RpcHostToolDefinition } from '../adapters/omp-rpc-client'
import { loadHostToolDefs } from '../../prompts/loader'
import { daqRuntimeSettings } from '../../settings'
import { HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES, LEAD_ONLY_TOOL_NAMES, MES_READ_TOOL_NAMES } from '../tool-classes'
import { listPluginTools, pluginOfTool } from '../plugin-tools'
import { getChannelPluginsRepo } from '../../db/channel-plugins.repo'
import { getChannelTwinProfile } from '../../aml/twin/channel-profile'
import { amlTwinFeatureFlags } from '../../aml/twin/feature-flags'
import { applyChannelToolPolicy } from '../../tools/policy'
import type { ToolExclusion } from '../../tools/types'
import { registerToolReferenceDeclarations } from '../tool-reference-spec'

/** host tool 定义(外置 .AgentWorkShop/prompts/host-tools.json;加载器缓存) */
export const HOST_TOOLS: RpcHostToolDefinition[] = loadHostToolDefs()

// WP5:定义自带的引用面声明装配进单一声明表(tool-verify 执行期查表;声明在注册时生效)
registerToolReferenceDeclarations(HOST_TOOLS)

// 工具分类常量已上收零依赖叶子模块 agents/tool-classes(权限面/测试在 nitro 之外可用);此处 re-export 保持导入路径兼容
export { LEAD_ONLY_TOOL_NAMES, HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES } from '../tool-classes'

/** Hybrid Twin 工具只对显式 profile=hybrid_twin 的 Channel 注入。 */
export const HYBRID_TWIN_TOOL_NAMES = new Set([
  'twin_provider_catalog', 'twin_scene_discover', 'twin_scene_compile', 'twin_scene_freeze', 'twin_physics_spec_draft', 'twin_physics_spec_validate', 'twin_physics_spec_compile', 'twin_scene_read', 'twin_snapshot_create', 'twin_trial_run', 'mpc_optimize', 'twin_gate_evaluate',
])

/**
 * AML 解耦(2026-09-26 计划 v3):训练 Channel 与工艺优化 Channel 工具面。
 * 训练面=建模/训练/评估(数据集/作业/谱系/场景编译/物理 spec/建模任务);
 * 优化面=探索/验证/寻优(快照/试验/门禁/MPC/贝叶斯/探索步)。
 * 两面互斥注入:训练 Channel 无产线写与 MPC;优化 Channel 无训练族(边训边优被结构禁止)。
 */
export const AML_TRAINING_TOOL_NAMES = new Set([
  'aml_node_catalog', 'aml_dataset_build', 'aml_dataset_stats', 'aml_job_submit', 'aml_job_status', 'aml_job_logs', 'aml_job_cancel', 'aml_leaderboard', 'aml_model_find', 'aml_model_reference', 'twin_provider_catalog', 'twin_scene_discover', 'twin_scene_compile', 'twin_scene_freeze', 'twin_physics_spec_draft', 'twin_physics_spec_validate', 'twin_physics_spec_compile', 'twin_scene_read', 'twin_calibration_request', 'aml_training_plan_list', 'aml_training_plan_create', 'aml_training_plan_train',
])

export const AML_OPTIMIZATION_TOOL_NAMES = new Set([
  'twin_snapshot_create', 'twin_trial_run', 'mpc_optimize', 'twin_gate_evaluate', 'optimization_explore', 'twin_bayes_optimize',
])

/**
 * 优化器工具族(G4):零写设备;仅 aml_optimization / hybrid_twin 注入,
 * 且 solve/status/cancel/plan_get 还要求该 Agent 有有效绑定(per-agent 再裁一次)。
 */
export const OPTIMIZER_TOOL_NAMES = new Set([
  'optimizer_capabilities', 'optimizer_solve', 'optimizer_status', 'optimizer_cancel', 'optimizer_plan_get',
])

/** 仅 aml 模式(已绑定模型)可执行的工具;探索模式下 dispatch 层 fail-closed 拒绝。 */
export const AML_MODEL_BACKED_TOOL_NAMES = new Set([
  'twin_trial_run', 'mpc_optimize', 'twin_bayes_optimize',
])

/**
 * 产线 Co-Pilot 观察面档位(2026-10-01 计划 §5.2/§5.3)与频道执行模式 observe(2026-10-28 三模式计划 M2):
 * exp-miner(经验工程师)/ line-doctor(诊断工程师)与 executionMode='observe' 是**零写**只读档 ——
 * 核心工业工具按白名单注入(channel_plugins 只过滤插件挡不住核心族,白名单是核心族唯一的排除机制),
 * 直接写族(agents/tool-classes 清单)在尾部 writesBlocked 再兜底过滤一道。
 * kb_agent/diag_run/diag_status 等 KB/诊断工具走 rag-bridge/diag-bridge 插件面,照常按频道插件开关注入,不进本白名单。
 */
/** 只读观察读面(两档共用,全部只读;exp_collect 由经验采集底座注册,此处按名引用;
 *  analysis_save/query 为数据分析留痕台账面 —— 台账写入非产线写,观察档位同样要留痕诊断结论) */
export const OBSERVER_READ_TOOL_NAMES = new Set([
  'ops_log',
  'line_log',
  'recipe_log',
  'recipe_catalog',
  'recipe_versions',
  'line_context',
  'dcw_journal',
  'daq_query',
  'exp_collect',
  'analysis_save',
  'analysis_query',
])

/**
 * line-doctor 追加面(P2 生效):AML 只读查询族 + 结构化下发族。
 * aml_activity = 优化循环活动自查(recipe_propose 提交前的硬闸自查,只读);
 * recipe_propose = 整包方案审批提交(**不是直写**:批准与选定包由人类在审批卡裁决,
 * 未携带有效 choice 的批准按拒绝收敛;执行走既有 applyRecipe 审批管线)。
 */
export const LINE_DOCTOR_AML_TOOL_NAMES = new Set([
  'aml_model_find',
  'aml_model_reference',
  'aml_leaderboard',
  'twin_gate_evaluate',
  'aml_activity',
  'recipe_propose',
])

/** 观察面档位保留的协作面:消息/记忆/任务执行流(零产线写语义;lead 治理面照旧按角色剔除) */
export const OBSERVER_COLLAB_TOOL_NAMES = new Set([
  'send_message_to_agent',
  'broadcast_message',
  'poll_messages',
  'read_channel_mail',
  'list_other_teams',
  'save_memory',
  'search_memory',
  'search_other_teams_memory',
  'send_cross_channel_message',
  'submit_task',
  'complete_task',
  'supersede_task',
  'report_progress',
  'refuse_task',
  'cancel_task',
  'get_my_task_queue',
  'get_task_details',
  'list_channel_tasks',
  'list_team_agents',
])

/** 观察面档位允许注入的核心工具全集(纯派生;单测断言「工具面零写」的单一事实源)。
 *  2026-10-28 三模式计划 G3:MES 只读族(mes_catalog/mes_fetch/mes_export/mes_dataset_read/mes_datasets)
 *  纳入观察面 —— 观察档位要能拉 MES 数据做只读分析;工具自带绑线授权/窗口/行数/频控护栏,
 *  观察面只读放大不加权。派生集再减去写族/治理族做 belt(即使未来白名单误收写工具也注不出去)。 */
export function observerAllowedToolNames(kind: 'exp-miner' | 'line-doctor'): Set<string> {
  const allowed = new Set([
    ...OBSERVER_READ_TOOL_NAMES,
    ...MES_READ_TOOL_NAMES,
    ...OBSERVER_COLLAB_TOOL_NAMES,
    ...(kind === 'line-doctor' ? LINE_DOCTOR_AML_TOOL_NAMES : []),
  ])
  for (const name of HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES) allowed.delete(name)
  for (const name of OPTIMIZER_TOOL_NAMES) allowed.delete(name)
  return allowed
}

/** 频道执行模式 observe(通用观察档,无角色 persona)的注入白名单:读面+协作面+MES 只读,零写 */
export function observeModeAllowedToolNames(): Set<string> {
  return observerAllowedToolNames('exp-miner')
}

/** 观察面档位的核心工具装配(纯函数:按白名单过滤 base;单测对合成目录与真实 HOST_TOOLS 各断言一层) */
export function scopedToolsForObserverProfile(kind: 'exp-miner' | 'line-doctor', base: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
  const allowed = observerAllowedToolNames(kind)
  return base.filter(t => allowed.has(t.name))
}

/** AML 治理/重负载动作之外,产线直接写工具的声明源已上收 agents/tool-classes(见文件头 re-export)。 */

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

export interface HostToolScope {
  /** 已通过角色/profile/写守卫/插件开关的注入面(未应用 Channel 逐工具选择) */
  tools: RpcHostToolDefinition[]
  /** 被硬规则排除的工具 → 原因(透明化 UI/API 用;执行面仍以各自守卫为准) */
  excluded: Map<string, ToolExclusion>
}

/**
 * 按角色装配 host tools,同时记录硬规则排除原因。
 * 这是全引擎唯一的“合格工具集合”来源;Channel 逐工具选择只在结果上做减法。
 */
export function scopeHostToolsForRole(role: 'lead' | 'worker', channelId?: string, locale: 'zh' | 'en' = 'zh'): HostToolScope {
  const excluded = new Map<string, ToolExclusion>()
  const allTools = locale === 'zh' ? HOST_TOOLS : loadHostToolDefs(locale)
  const base = role === 'lead'
    ? allTools
    : allTools.filter(t => !LEAD_ONLY_TOOL_NAMES.has(t.name))
  if (role === 'worker') {
    for (const tool of allTools) {
      if (LEAD_ONLY_TOOL_NAMES.has(tool.name)) {
        excluded.set(tool.name, { reason: 'ROLE_DENIED', message: '仅 lead 角色可用' })
      }
    }
  }

  /** 过滤并把被剔除项记入 excluded(后写覆盖先写;同一工具只保留最后一次硬规则原因) */
  const narrow = (
    input: RpcHostToolDefinition[],
    keep: (tool: RpcHostToolDefinition) => boolean,
    reason: ToolExclusion['reason'],
    message: string,
  ): RpcHostToolDefinition[] => {
    const kept = input.filter(keep)
    const keptNames = new Set(kept.map(t => t.name))
    for (const tool of input) {
      if (!keptNames.has(tool.name)) excluded.set(tool.name, { reason, message })
    }
    return kept
  }

  const profile = channelId ? getChannelTwinProfile(channelId) : null
  const kind = profile?.profile ?? 'legacy'
  const flags = amlTwinFeatureFlags()
  // 频道执行模式 observe(2026-10-28 三模式计划 M2):通用只读观察档,优先于各 profile 档位
  // (观察是更强的收紧,任何档位叠加 observe 都按零写装配)。白名单与角色观察档同族:
  // 读面+协作面+MES 只读,再减写族/治理族 belt。
  const execMode = profile?.executionMode ?? 'auto'
  let scoped: RpcHostToolDefinition[]
  if (execMode === 'observe') {
    scoped = scopedToolsForObserverProfile('exp-miner', base)
    const keptNames = new Set(scoped.map(t => t.name))
    for (const tool of base) {
      if (keptNames.has(tool.name)) continue
      const writesFamily = HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES.has(tool.name) || tool.name === 'optimization_explore'
      excluded.set(tool.name, writesFamily
        ? { reason: 'WRITE_GUARD', message: '当前频道为观察执行模式(observe),物理零写,不开放产线写工具' }
        : { reason: 'EXEC_MODE_OBSERVE', message: '当前频道为观察执行模式(observe),只开放读面与协作面' })
    }
  }
  else if (kind === 'aml_training') {
    // 训练面:剔除优化族与优化器族(gate 保留 —— 模型晋升前需门禁评估)
    scoped = narrow(
      base,
      t => (!AML_OPTIMIZATION_TOOL_NAMES.has(t.name) || t.name === 'twin_gate_evaluate') && !OPTIMIZER_TOOL_NAMES.has(t.name),
      'PROFILE_DENIED',
      `当前 Channel 档位(${kind})不开放该工具(训练面不求解)`,
    )
  }
  else if (kind === 'aml_optimization') {
    // 优化面:剔除训练族(gate 保留);优化器族保留(per-agent 再按绑定裁剪)
    scoped = narrow(
      base,
      t => !AML_TRAINING_TOOL_NAMES.has(t.name) || t.name === 'twin_gate_evaluate',
      'PROFILE_DENIED',
      `当前 Channel 档位(${kind})不开放该工具(优化面不承担建模/训练)`,
    )
  }
  else if (kind === 'exp-miner' || kind === 'line-doctor') {
    // 产线 Co-Pilot 观察面(经验工程师/诊断工程师):核心工具按白名单注入 —— 物理零写
    scoped = scopedToolsForObserverProfile(kind, base)
    const keptNames = new Set(scoped.map(t => t.name))
    for (const tool of base) {
      if (keptNames.has(tool.name)) continue
      const writesFamily = HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES.has(tool.name) || tool.name === 'optimization_explore'
      excluded.set(tool.name, writesFamily
        ? { reason: 'WRITE_GUARD', message: `当前 Channel 档位(${kind})物理零写,不开放产线写工具` }
        : { reason: 'PROFILE_DENIED', message: `当前 Channel 档位(${kind})只开放观察读面与协作面` })
    }
  }
  else {
    const hybrid = channelId ? kind === 'hybrid_twin' : false
    // legacy:孪生/训练/优化三族全族摘除(dispatch 对 legacy 拒绝这些工具 —— 注入面与
    // 分发守卫同口径,免得 worker 对着必拒工具烧 token 试错)。
    scoped = hybrid
      ? [...base]
      : narrow(
          base,
          t => !HYBRID_TWIN_TOOL_NAMES.has(t.name)
            && !AML_TRAINING_TOOL_NAMES.has(t.name)
            && !AML_OPTIMIZATION_TOOL_NAMES.has(t.name)
            && !OPTIMIZER_TOOL_NAMES.has(t.name),
          'PROFILE_DENIED',
          '当前 Channel 为 legacy 档位,不开放孪生/训练/优化/优化器族工具',
        )
  }

  // 直写工具守卫:hybrid 沿用 bounded_auto 开关;工艺优化 Channel 一律不给 dcw 直写
  // (真实写入统一走 optimization_explore 的治理链),训练 Channel 无写语义;
  // 观察面档位(exp-miner/line-doctor)与观察执行模式(observe)零写 —— 白名单已不含写族,此处再兜底一道。
  const writesBlocked = Boolean(profile?.profile === 'hybrid_twin' && (!flags.governedWriteEnabled || !flags.boundedAutoEnabled || profile.controlPolicy !== 'bounded_auto'))
    || kind === 'aml_optimization' || kind === 'aml_training'
    || kind === 'exp-miner' || kind === 'line-doctor'
    || execMode === 'observe'
  const out = writesBlocked
    ? narrow(scoped, t => !HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES.has(t.name), 'WRITE_GUARD', '当前 Channel 档位不允许产线直接写工具')
    : [...scoped]

  // 团队级插件开关:显式配置过的 channel 按行过滤;未配置(无行)= 全启用,向后兼容
  const channelOff = channelId
    ? getChannelPluginsRepo().explicitFor(channelId)
    : null
  const outNames = new Set(out.map(t => t.name))
  for (const [name, tool] of listPluginTools()) {
    if (outNames.has(name)) continue
    if (tool.roles && !tool.roles.includes(role)) {
      excluded.set(name, { reason: 'ROLE_DENIED', message: `该插件工具仅对 ${tool.roles.join('/')} 角色开放` })
      continue
    }
    const owner = pluginOfTool(name)
    if (channelOff && owner && channelOff.get(owner) === false) {
      excluded.set(name, { reason: 'CHANNEL_PLUGIN_DISABLED', message: `本 Channel 已关闭插件「${owner}」` })
      continue
    }
    out.push({ name, label: tool.label ?? name, description: tool.description, parameters: tool.parameters ?? {} })
    outNames.add(name)
  }
  return { tools: applyDescriptionPlaceholders(out), excluded }
}

/**
 * 按角色装配 host tools:lead = 全量;worker = 剔除 lead 专属(执行面 + 通信面 + 记忆面);
 * 尾部合并插件注册工具(roles 过滤,缺省双角色可用;channelId 给定且该团队有显式
 * 插件开关时,关闭的插件其工具不注入 —— 防不需要插件的 channel 上下文被污染)。
 * AML 解耦:aml_training/aml_optimization Channel 按面注入(训练族与优化族互斥);
 * 产线 Co-Pilot 观察面(exp-miner/line-doctor)按白名单注入,物理零写;
 * hybrid_twin 保持全功能面;legacy 无 twin 工具。
 * 最后应用 Channel 逐工具选择(无策略 = 全部合格工具,向后兼容)。
 * 全 harness 共用:omp 经 set_host_tools 下发;其余引擎经 MCP 桥 tools/list 拉取。
 */
export function hostToolsForRole(role: 'lead' | 'worker', channelId?: string, locale: 'zh' | 'en' = 'zh'): RpcHostToolDefinition[] {
  const scoped = scopeHostToolsForRole(role, channelId, locale)
  return applyChannelToolPolicy(scoped.tools, channelId)
}
