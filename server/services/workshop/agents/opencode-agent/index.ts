/**
 * server/services/workshop/agents/opencode-agent.ts 拆分后的门面(目录 index 解析,外部 import 路径不变)。
 *
 * 结构:
 *   types.ts            依赖类型与 DTO
 *   helpers.ts          模块级纯工具/常量
 *   core.ts             字段与构造
 *   lifecycle.ts        生命周期 / 进程面
 *   engine-agnostic.ts  引擎无关面(状态/上下文/steer/回合结算)
 *   turn.ts             回合执行(prompt → SSE → AgentEvent)
 *   hitl.ts             HITL(权限 / 提问 / 注册)
 *   server.ts           opencode 服务进程与 HTTP 客户端
 *   facade.ts           最终类 + 模块级尾码
 */
export { OpenCodeAgentImpl } from './facade'
export type { OpenCodeAgentConfig } from './types'
