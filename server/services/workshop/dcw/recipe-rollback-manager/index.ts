/**
 * server/services/workshop/dcw/recipe-rollback-manager.ts 拆分后的门面(目录 index 解析,外部 import 路径不变)。
 *
 * 结构:
 *   types.ts      依赖类型与 DTO
 *   helpers.ts    模块级纯工具/常量
 *   contracts.ts  跨层能力契约(7 个抽象方法)
 *   00-state.ts              状态字段与广播装配
 *   01-lock.ts               写路径挂锁(open 记录 / 互斥 / 冷却方向性)
 *   02-judge.ts              判定:Agent / 系统 / 用户 三路
 *   03-rollback.ts           分级回退(全部经 controller.write 单点)
 *   04-sweep.ts              系统兜底评估(按 sweep 节拍)
 *   05-views.ts              数据面:窗口聚合 / 台账 / 序列
 *   06-internal.ts           内部:事件广播
 *   facade.ts     最终类 + 模块级尾码
 */
export { RecipeRollBackManager, getRecipeRollBackManager } from './facade'
