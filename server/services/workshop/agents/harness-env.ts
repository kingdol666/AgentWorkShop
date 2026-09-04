/**
 * HarnessEnv —— 三引擎(codex/dsh/opencode)MCP 桥装配的共享环境计算。
 *
 * 桥脚本(server/harness/aw-mcp-bridge.mjs)由各引擎以本地 MCP server 形式拉起,
 * 需要:平台回程地址(AW_BASE_URL)、agent 身份与自证 token、桥脚本绝对路径。
 * 本模块统一解析,避免三个 impl 各写一套路径/端口推断。
 */
import { join } from 'node:path'

export function resolveBridgePath(config?: string): string {
  if (config) return config
  const root = process.env.AW_PACKAGE_ROOT ?? process.cwd()
  return join(root, 'server', 'harness', 'aw-mcp-bridge.mjs')
}

export function resolvePlatformBaseUrl(config?: string): string {
  if (config) return config.replace(/\/$/, '')
  if (process.env.AW_BASE_URL) return process.env.AW_BASE_URL.replace(/\/$/, '')
  const port = process.env.PORT ?? process.env.NUXT_PORT ?? 3000
  return `http://127.0.0.1:${port}`
}

export interface McpBridgeEnvInput {
  agentId: string
  token?: string
  baseUrl?: string
  bridgePath?: string
  /** 引擎进程额外 env(CODEX_HOME / DEEPSEEK_API_KEY 等) */
  extra?: Record<string, string>
}

export interface McpBridgeEnv {
  /** 桥脚本绝对路径 */
  bridgePath: string
  /** 桥进程环境(AW_* 面) */
  bridgeEnv: Record<string, string>
  /** 引擎引擎进程环境(bridgeEnv 引用同值;供 config 内联展开) */
  engineEnv: Record<string, string>
}

export function generateMcpBridgeEnv(input: McpBridgeEnvInput): McpBridgeEnv {
  const bridgePath = resolveBridgePath(input.bridgePath)
  const bridgeEnv = {
    AW_BASE_URL: resolvePlatformBaseUrl(input.baseUrl),
    AW_AGENT_ID: input.agentId,
    AW_AGENT_TOKEN: input.token ?? '',
    AW_MCP_TOOL_TIMEOUT_MS: String(200_000),
  }
  return {
    bridgePath,
    bridgeEnv,
    engineEnv: { ...input.extra },
  }
}
