/**
 * AgentRuntime 的模块级纯工具/常量(原 server/services/workshop/runtime/agent-runtime.ts 类外声明,含类体之后与类无关的部分)。
 */
import type { Part } from '../../types/a2a'
import { createLogger } from '../../logger'

export const log = createLogger('workshop.agent-runtime')

/** ChannelBus:运行时事件总线(逐事件广播 + 任务/成员事件通知 + 调度唤醒) */
/** 任务变更事件携带的源头任务视图(WS 推送免 per-event 回查;WorkspaceTask 结构兼容) */
export function partsToText(parts: Part[]): string {
  return parts.map(p => ('text' in p ? p.text : '')).filter(Boolean).join('\n')
}

/**
 * TaskEngine 结构契约(实现方 T4 task-engine.ts,同步签名)。
 * 以接口而非具体类声明依赖,便于测试注入 fake 与集成装配真实引擎。
 */
