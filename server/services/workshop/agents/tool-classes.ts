/**
 * Host 工具分类的单一声明源(纯常量、零依赖)。
 * 权限面(permission-scope)与测试需在 nitro 之外导入本模块 ——
 * host-tool-bridge/catalog 从此处 re-export,保持既有导入路径兼容。
 */

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

/** Hybrid Twin 的直接写入工具:权限面(permission-scope)与目录注入面(host-tool-bridge/catalog)fail-closed 同源于本集合;dispatch 分发层的同款守卫为并行在飞改动,待其收敛后接入(勿在此重复第三份清单)。 */
export const HYBRID_TWIN_DIRECT_WRITE_TOOL_NAMES = new Set([
  'dcw_control',
  'param_control',
  'dcw_rollback',
  'recipe_update',
  'recipe_rollback',
])
