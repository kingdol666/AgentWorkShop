/**
 * 前端协议类型 + 解析器入口(re-export)
 *
 * wire 类型与 CMDParser 的权威来源是 `#shared/game-protocol`(由 JSON 派生),
 * 此处统一对外暴露,供前端 WS 客户端与 Phaser 场景引用,避免散落多份定义。
 */
export type {
  AgentFacePayload,
  AgentMode,
  AgentMovePayload,
  AgentSayPayload,
  AgentStatePayload,
  ClientToServer,
  DialogOpenPayload,
  Dir,
  ServerToClient,
} from '#shared/game-protocol'

export { CMDParser, agentCallableCommands, toMcpTools } from '#shared/game-protocol'
export type { McpTool, ParseError, ParseResult } from '#shared/game-protocol'

// 地图常量(服务端同源,前端渲染与节流共用)
export { AGENT_SPAWN, GAME_MAP, PLAYER_POS_THROTTLE } from '~~/server/types/game'
