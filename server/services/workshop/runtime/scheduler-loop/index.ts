/**
 * server/services/workshop/runtime/scheduler-loop.ts 拆分后的门面(目录 index 解析,外部 import 路径不变)。
 *
 * 结构:
 *   types.ts      依赖类型与 DTO
 *   helpers.ts    模块级纯工具/常量
 *   contracts.ts  跨层能力契约(8 个抽象方法)
 *   state.ts      状态字段 / 启停 / 定时唤醒 / 重投递回调
 *   tick.ts       内部:回合推进 / 监督节流指纹 / 收口判定
 *   snapshot.ts   监督快照采集与决策分发
 *   rules.ts      规则引擎:快照 → 调度决策
 *   execute.ts    决策执行 / 唤醒 / 空闲刷新 / 协作完成判定
 *   facade.ts     最终类 + 模块级尾码
 */
export { SchedulerLoop } from './facade'
export type { SchedulerLoopOptions } from './types'
