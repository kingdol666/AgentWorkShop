/**
 * 官方 MCP TypeScript client v2 封装。
 *
 * - 显式 `versionNegotiation.mode='auto'`：先 modern probe，失败回退 legacy initialize；
 * - 传输层使用受控 fetch（HTTPS/DNS/重定向），不把 MCP 原配置交给 harness；
 * - 凭据只从 AW_MCP_* 环境变量解析，调用方无法传入任意 env 名。
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { McpConnection, McpDiscoverySnapshot, McpServerManifest } from './types'
import { hashSchema } from './config'
import { createMcpFetch } from './egress'
import { AppError } from '../../../utils/errors'

const MAX_DISCOVERED_TOOLS = 200
const CREDENTIAL_REF_RE = /^AW_MCP_[A-Z0-9_]{1,60}$/

export interface ConnectMcpOptions {
  /** 测试注入；生产默认 createMcpFetch() */
  fetchImpl?: typeof fetch
  /** 测试/受控调用注入；生产从 env 解析 */
  credential?: string
  clientName?: string
  clientVersion?: string
}

/** 只接受 AW_MCP_* 环境变量名；缺值 fail closed（不回退空 token） */
export function resolveCredential(ref: string | undefined): string | undefined {
  if (!ref) return undefined
  if (!CREDENTIAL_REF_RE.test(ref)) {
    throw new AppError(400, 'MCP_CREDENTIAL_REF_INVALID', 'credentialRef 必须是 AW_MCP_* 环境变量名')
  }
  const value = process.env[ref]
  if (!value) throw new AppError(503, 'MCP_CREDENTIAL_MISSING', `MCP 凭据环境变量未配置：${ref}`)
  return value
}

export async function connectMcpServer(manifest: McpServerManifest, opts: ConnectMcpOptions = {}): Promise<McpConnection> {
  const fetchImpl = opts.fetchImpl ?? createMcpFetch()
  const credential = opts.credential ?? resolveCredential(manifest.credentialRef)
  const headers: Record<string, string> = { 'x-aw-mcp-server': manifest.id }
  if (credential) headers.authorization = `Bearer ${credential}`

  const transport = new StreamableHTTPClientTransport(new URL(manifest.endpoint), {
    fetch: fetchImpl as typeof fetch,
    requestInit: { headers, redirect: 'manual' },
    redirectPolicy: 'same-origin',
  })
  const client = new Client(
    { name: opts.clientName ?? 'agentworkshop-mcp-broker', version: opts.clientVersion ?? '1.0.0' },
    { versionNegotiation: { mode: 'auto' }, listMaxPages: 16 },
  )
  await client.connect(transport)

  return {
    async discover(): Promise<McpDiscoverySnapshot> {
      const result = await client.listTools()
      const tools = (result.tools ?? []).slice(0, MAX_DISCOVERED_TOOLS).map((tool) => {
        const rawSchema = tool.inputSchema
        const inputSchema = rawSchema && typeof rawSchema === 'object' && !Array.isArray(rawSchema)
          ? rawSchema as Record<string, unknown>
          : { type: 'object', additionalProperties: false }
        return {
          upstreamName: String(tool.name),
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema,
          schemaHash: hashSchema(inputSchema),
        }
      })
      return {
        tools,
        protocolEra: client.getProtocolEra?.(),
      }
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      return await client.callTool({ name, arguments: args })
    },
    async close(): Promise<void> {
      await client.close()
    },
  }
}
