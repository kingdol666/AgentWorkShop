/**
 * server/services/workshop/agents/adapters/omp-rpc-client.ts 拆分后的门面(目录 index 解析,外部 import 路径不变)。
 *
 * 结构:
 *   types.ts      依赖类型与 DTO
 *   helpers.ts    模块级纯工具/常量
 *   contracts.ts  跨层能力契约(5 个抽象方法)
 *   state.ts      状态字段 / 构造 / 进程与上下文窗口查询
 *   usage.ts      用量提取 / 存活核对 / 终止
 *   start.ts      启动子进程与握手
 *   api.ts        发送命令 / 事件与原始帧订阅 / 宿主工具回调 / 释放
 *   stdout.ts     内部:stdout 分帧与帧分发
 *   frames.ts     内部:宿主工具调用 / 分块装配 / 退出与错误通知
 *   facade.ts     最终类 + 模块级尾码
 */
export { OmpRpcClient } from './facade'
export type { RpcCommand } from './types'
export type { CompactionResult } from './types'
export type { RpcUsage } from './types'
export type { RpcHostToolDefinition } from './types'
export type { RpcResponse } from './types'
export type { AgentSessionEvent } from './types'
export type { HostToolCallRequest } from './types'
export type { HostToolHandler } from './types'
export type { OmpRpcClientOptions } from './types'
