/**
 * 【回滚源,非默认路径】引用校验的旧代码表(2026-10-24 WP5 迁移前的事实源)。
 *
 * WP5 已把同样内容迁移进 host-tools.json 的 `references` 字段(声明式单源)。
 * 本文件仅在两种情况下被读取:
 *  1. env `AW_TOOL_VERIFY_LEGACY_SPECS=1`(回滚开关,启动时 audit warn);
 *  2. 声明表尚未装配(单测直接 import tool-verify、目录未加载)时的等价回退。
 * `tests/tool-references.test.ts` 断言「声明表 ⊇ 本表且逐项等价」,防止两份漂移。
 * 迁移完成一个版本周期后本文件应删除。
 */
import type { ToolVerifySpec } from '../tool-reference-spec'

export const LEGACY_VERIFY_SPECS: Record<string, ToolVerifySpec> = {
  // 数控/数采面(v2 禁用桩 handler 自答替代路径,无需预检)
  dcw_control: {},
  param_control: {},
  dcw_rollback: {},
  daq_query: { refs: [{ param: 'node_id', kind: 'node', mode: 'read' }, { param: 'line_id', kind: 'line', mode: 'read' }] },
  daq_frames: { refs: [{ param: 'node_id', kind: 'node', mode: 'read' }, { param: 'line_id', kind: 'line', mode: 'read' }] },
  daq_export: { refs: [{ param: 'line_id', kind: 'line', mode: 'read' }], nodeLists: ['node_ids'] },
  dcw_judge: { atLeastOne: [{ params: ['record_id'], hint: 'record_id 必填(优化记录 id,opt-*);配方面链路判定不用 dcw_judge,达标用 recipe_update 固化、劣化用 recipe_rollback。' }] },
  dcw_journal: {
    atLeastOne: [{ params: ['node_id', 'recipe_id'], hint: 'node_id 或 recipe_id 至少提供一个:查某节点的参数变更史传 node_id;查配方面优化记录传 recipe_id(全节点不落权限面,不提供)。' }],
    refs: [{ param: 'node_id', kind: 'node', mode: 'read' }, { param: 'recipe_id', kind: 'recipe', mode: 'read' }],
  },
  // 判定/日志/配方/前哨面
  ops_log: { refs: [{ param: 'line_id', kind: 'line', mode: 'read' }, { param: 'recipe_id', kind: 'recipe', mode: 'read' }, { param: 'node_id', kind: 'node', mode: 'read' }], readableLineNodes: true },
  // line_log = ops_log 显式别名,引用校验完全同口径
  line_log: { refs: [{ param: 'line_id', kind: 'line', mode: 'read' }, { param: 'recipe_id', kind: 'recipe', mode: 'read' }, { param: 'node_id', kind: 'node', mode: 'read' }], readableLineNodes: true },
  recipe_log: { refs: [{ param: 'line_id', kind: 'line', mode: 'read' }, { param: 'recipe_id', kind: 'recipe', mode: 'read' }] },
  recipe_catalog: { refs: [{ param: 'line_id', kind: 'line', mode: 'read' }] },
  recipe_create: { refs: [{ param: 'line_id', kind: 'line', mode: 'write' }, { param: 'source_recipe_id', kind: 'recipe', mode: 'read' }], deepNodeRefs: ['params[].node_id', 'daq_windows[].node_id'] },
  line_context: { refs: [{ param: 'line_id', kind: 'line', mode: 'read' }] },
  line_status: { refs: [{ param: 'line_id', kind: 'line', mode: 'read' }] },
  line_start: { refs: [{ param: 'recipe_id', kind: 'recipe', mode: 'write' }] },
  recipe_versions: { refs: [{ param: 'recipe_id', kind: 'recipe', mode: 'read' }] },
  recipe_update: { atLeastOne: [{ params: ['recipe_id', 'line_id'], hint: 'recipe_id 或 line_id 至少提供一个:只给 line_id 时按该线当前活动批次解析配方。' }], refs: [{ param: 'recipe_id', kind: 'recipe', mode: 'write' }, { param: 'line_id', kind: 'line', mode: 'read' }], deepNodeRefs: ['params[].node_id'] },
  recipe_rollback: { refs: [{ param: 'recipe_id', kind: 'recipe', mode: 'write' }] },
  recipe_trial: { atLeastOne: [{ params: ['recipe_id', 'line_id'], hint: 'recipe_id 或 line_id 至少提供一个:只给 line_id 时按该线当前活动批次解析配方。' }], refs: [{ param: 'recipe_id', kind: 'recipe', mode: 'write' }, { param: 'line_id', kind: 'line', mode: 'read' }], deepNodeRefs: ['params[].node_id'] },
  recipe_apply: { atLeastOne: [{ params: ['recipe_id', 'line_id'], hint: 'recipe_id 或 line_id 至少提供一个:只给 line_id 时按该线当前活动批次解析配方。' }], refs: [{ param: 'recipe_id', kind: 'recipe', mode: 'write' }, { param: 'line_id', kind: 'line', mode: 'read' }] },
  recipe_propose: { refs: [{ param: 'recipe_id', kind: 'recipe', mode: 'read' }], deepNodeRefs: ['packages[].params[].node_id'] },
  // 分析与经验面
  analysis_save: { refs: [{ param: 'line_id', kind: 'line', mode: 'read' }, { param: 'recipe_id', kind: 'recipe', mode: 'read' }] },
  analysis_query: { refs: [{ param: 'line_id', kind: 'line', mode: 'read' }] },
  aml_activity: { refs: [{ param: 'line_id', kind: 'line', mode: 'read' }] },
  exp_collect: { refs: [{ param: 'line_id', kind: 'line', mode: 'read' }, { param: 'lineId', kind: 'line', mode: 'read' }] },
  // 寻优/孪生面
  optimization_explore: { refs: [{ param: 'control_node_id', kind: 'node', mode: 'read' }, { param: 'target_node_id', kind: 'node', mode: 'read' }] },
  twin_scene_compile: { refs: [{ param: 'line_id', kind: 'line', mode: 'read' }, { param: 'recipe_id', kind: 'recipe', mode: 'read' }], nodeLists: ['node_ids'] },
  twin_scene_freeze: { chained: [{ param: 'scene_id', kind: 'scene', mode: 'write' }] },
  twin_calibration_request: { refs: [{ param: 'line_id', kind: 'line', mode: 'read' }, { param: 'recipe_id', kind: 'recipe', mode: 'read' }] },
  twin_gate_evaluate: { chained: [{ param: 'model_id', kind: 'model', mode: 'read' }] },
  // AML 面
  aml_dataset_build: { refs: [{ param: 'line_id', kind: 'line', mode: 'read' }, { param: 'recipe_id', kind: 'recipe', mode: 'read' }], deepNodeRefs: ['nodes[].node_id'] },
  aml_dataset_stats: { chained: [{ param: 'dataset_id', kind: 'dataset', mode: 'read' }] },
  aml_leaderboard: { chained: [{ param: 'dataset_id', kind: 'dataset', mode: 'read' }] },
  aml_job_submit: { chained: [{ param: 'dataset_id', kind: 'dataset', mode: 'write' }] },
  aml_job_status: { chained: [{ param: 'job_id', kind: 'job', mode: 'read' }] },
  aml_job_logs: { chained: [{ param: 'job_id', kind: 'job', mode: 'read' }] },
  aml_job_cancel: { chained: [{ param: 'job_id', kind: 'job', mode: 'write' }] },
  aml_model_promote: { chained: [{ param: 'model_id', kind: 'model', mode: 'write' }] },
  aml_training_plan_create: { refs: [{ param: 'line_id', kind: 'line', mode: 'read' }, { param: 'recipe_id', kind: 'recipe', mode: 'read' }] },
  aml_training_plan_train: { chained: [{ param: 'plan_id', kind: 'plan', mode: 'write' }] },
  // MES 面(ids 为 MES 数控节点,归属判定与 mes-controller 可见面同源)
  mes_fetch: { nodeLists: ['ids'] },
  mes_export: { nodeLists: ['ids'] },
  // Optimizer(G4.5):binding/run/recommendation 都必须属于当前 Agent 实例
  optimizer_capabilities: {},
  optimizer_solve: { chained: [{ param: 'binding_id', kind: 'binding', mode: 'write' }] },
  optimizer_status: { atLeastOne: [{ params: ['run_id'], hint: 'run_id 必填(optimizer_solve 返回)' }], chained: [{ param: 'run_id', kind: 'run', mode: 'read' }] },
  optimizer_cancel: { atLeastOne: [{ params: ['run_id'], hint: 'run_id 必填' }], chained: [{ param: 'run_id', kind: 'run', mode: 'write' }] },
  optimizer_plan_get: { chained: [{ param: 'run_id', kind: 'run', mode: 'read' }, { param: 'recommendation_id', kind: 'recommendation', mode: 'read' }] },
}
