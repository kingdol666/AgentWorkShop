/**
 * server/services/workshop/agents/codex-agent.ts 拆分后的门面(目录 index 解析,外部 import 路径不变)。
 *
 * 结构:
 *   types.ts    依赖类型与 DTO
 *   helpers.ts  模块级纯工具/常量
 *   core.ts     字段 / 构造 / 配置面 / 进程面
 *   turn.ts     回合:steer / onTurnSettled / 事件流桥接
 *   hitl.ts     HITL:审批与用户输入的注册与应答
 *   client.ts   codex 子进程与客户端管理
 *   facade.ts   最终类 + 模块级尾码
 */
export { CodexAgentImpl } from './facade'
export type { CodexAgentConfig } from './types'
