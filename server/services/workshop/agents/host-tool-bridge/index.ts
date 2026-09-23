/**
 * server/services/workshop/agents/host-tool-bridge.ts 拆分后的门面(目录 index 解析,
 * 外部 import 路径与导出 API 完全不变)。
 *
 * 结构:
 *   types.ts     HostToolCall / HostToolResult / HostToolSessionState / HostToolBridgeContext
 *   session.ts   会话态 createSessionState 与 partsToText
 *   catalog.ts   HOST_TOOLS / LEAD_ONLY_TOOL_NAMES / 占位符注入 / hostToolsForRole
 *   dispatch.ts  dispatchHostTool(前置校验 + 路由)
 *   tools/       按工具族拆分的处理器:industrial / progress / tasks / messaging / memory / team
 */
export { HOST_TOOLS, LEAD_ONLY_TOOL_NAMES, hostToolsForRole } from './catalog'
export type { HostToolBridgeContext, HostToolCall, HostToolResult, HostToolSessionState } from './types'
export { createSessionState, partsToText } from './session'
export { dispatchHostTool } from './dispatch'
