/**
 * 恢复/下发指引提示的单一事实源(single source of truth;纯常量、零依赖,
 * 与 tool-classes.ts 同风格:可在 nitro 之外导入)。
 *
 * 守门声明:新增或修改 Agent 可见的恢复/下发提示,必须引用本模块导出的常量,
 * 不得在各工具文件手抄;全部引用方禁止出现 dcw_control / dcw_read 字样
 * (权限模型 v2:dcw_control 为恒拒桩,dcw_read 从不存在 ——
 * tests/recovery-hints.test.ts 对引用方全文扫描强制)。
 *
 * 权限模型 v2 下的合法恢复/下发路径(2026-10-28 复核):
 *   整批回退       = 写入保持窗/节拍窗放行后重新 recipe_rollback(dispatch=true);
 *   复测核实       = daq_query(DAQ 无法验证的设定值 → 人工现场确认并升级);
 *   溯源           = dcw_journal / recipe_versions;
 *   逐节点受治理写 = 仅工艺优化 Channel 档位的 optimization_explore;
 *   直写族恒拒     = 任何文案不得建议"逐节点直发",产线/配方链路频道只能整批重试。
 */

/** 整批重试(恢复):写入保持窗/节拍窗未放行导致整批 0/N 时,唯一合法重试路径 —— 等待约 60s 放行后重新整批重下发;逐节点直发路径不存在。 */
export const RECOVERY_RETRY_HINT = '等待约 60s(节点写入保持窗/节拍窗放行)后重新调用 recipe_rollback(dispatch=true) 整批重下发目标版本(逐节点直发路径不存在)'

/** 复测核实(恢复):daq_query 复测产线侧现值;DAQ 无法验证的设定值不做逐节点补写,转人工现场确认并升级。 */
export const RECOVERY_VERIFY_HINT = '用 daq_query 复测产线侧现值确认真实生效;DAQ 无法验证的设定值逐条标记待人工现场确认并升级给人类(不得逐节点直发补写)'

/** 溯源(恢复):本次下发台账与配方版本历史的查询入口。 */
export const RECOVERY_TRACE_HINT = '本次下发的台账与版本历史用 dcw_journal / recipe_versions 溯源复核'

/** 治理下发路径:逐节点直写已禁用,真实下发只走配方面整批或工艺优化面的受治理探索步。 */
export const GOVERNED_DISPATCH_HINT = '真实下发路径仅两条:配方链路整批(recipe_trial / recipe_apply / recipe_rollback),或工艺优化 Channel 的 optimization_explore(受治理的逐节点探索步,联锁照常)'

/** 优化探索分档:optimization_explore 仅存在于工艺优化 Channel 档位;产线/配方链路频道没有逐节点写工具,不得在文案中建议逐节点直发。 */
export const OPT_EXPLORE_HINT = '仅工艺优化 Channel 档位可用 optimization_explore 做受治理的逐节点探索步;产线/配方链路频道无逐节点写工具,参数变更一律整批走配方链路'
