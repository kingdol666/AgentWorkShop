/**
 * server/services/workshop/runtime/task-engine.ts 拆分后的门面(目录 index 解析,外部 import 路径不变)。
 *
 * 结构:
 *   types.ts      依赖类型与 DTO
 *   helpers.ts    模块级纯工具/常量
 *   contracts.ts  跨层能力契约(2 个抽象方法)
 *   00-views.ts              队列视图(全量/精简/单智能体/监督)
 *   01-update.ts             任务更新 / 重投递 / 投递辅助
 *   02-create.ts             创建与派发
 *   03-transition.ts         状态跃迁与事件应用
 *   04-lifecycle.ts          完成 / 改派 / 取消 / 子任务回调
 *   facade.ts     最终类 + 模块级尾码
 */
export { TaskEngine } from './facade'
