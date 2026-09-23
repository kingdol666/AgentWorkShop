/**
 * server/services/workshop/agents/omp-agent.ts 拆分后的门面(目录 index 解析,外部 import 路径不变)。
 *
 * 结构:
 *   types.ts      依赖类型与 DTO
 *   helpers.ts    模块级纯工具/常量
 *   00-core.ts               字段与基础配置面(harnessId/configRecord/collectTurnEvents)
 *   01-context-governance.ts 上下文治理(70% 无中断压缩环)与构造
 *   02-lifecycle.ts          生命周期(dispose / 进程对账)
 *   03-tools-steer.ts        工具桥、prompt 组合与 steer()(含其内部分节的 452 行方法体)
 *   04-event-mapping.ts      omp 事件 → AgentEvent 映射与上下文治理事件
 *   05-client.ts             omp 客户端管理(ensureClient / probeContext)
 *   facade.ts     最终类 + 模块级尾码
 */
export { OmpRpcAgentImpl } from './facade'
export type { OmpAgentConfig } from './types'
