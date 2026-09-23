/**
 * server/services/workshop/runtime/agent-runtime.ts 拆分后的门面(目录 index 解析,外部 import 路径不变)。
 *
 * 结构:
 *   types.ts      依赖类型与 DTO
 *   helpers.ts    模块级纯工具/常量
 *   contracts.ts  跨层能力契约(5 个抽象方法)
 *   00-state.ts              运行时状态 / 队列视图 / 中断与 steer 注入
 *   01-lifecycle.ts          启动停止 / 信箱唤醒 / 进程面 / 宿主工具与 HITL 转发
 *   02-supervise.ts          监督回合接续 / 任务记忆 / 执行锁 / 消费循环
 *   03-message.ts            单条消息处理(回合执行 / 事件流 / 交付兜底)与投影辅助
 *   facade.ts     最终类 + 模块级尾码
 */
export { AgentRuntime } from './facade'
export type { TaskEventTask } from './types'
export type { ChannelBus } from './types'
export type { MemberChangeEvent } from './types'
export type { TaskEngine } from './types'
export type { AgentRuntimeLike } from './types'
