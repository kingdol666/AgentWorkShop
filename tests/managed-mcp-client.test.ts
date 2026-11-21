/**
 * 官方 MCP client v2 对接冒烟：用本仓库自带的 SDK server 起一个 loopback Streamable HTTP
 * 服务，验证 auto 协商回退 legacy、tools/list 与 tools/call 的真实传输。
 * 生产 egress 不允许 loopback；本测试显式注入 global fetch，仅用于客户端 API 校验。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { connectMcpServer } from '../server/services/workshop/mcp-client/client'
import type { McpServerManifest } from '../server/services/workshop/mcp-client/types'

test('v2 client discovers and calls a legacy Streamable HTTP MCP server', async () => {
  let port = 0
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()

  const http = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString('utf8')
      const request = new Request(`http://127.0.0.1:${port}${req.url ?? '/mcp'}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.method === 'GET' || req.method === 'DELETE' ? undefined : raw,
      })
      const sid = request.headers.get('mcp-session-id') ?? null
      let transport = sid ? sessions.get(sid) : undefined
      if (!transport) {
        const newId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => newId })
        const server = new McpServer({ name: 'mock-mcp', version: '1.0.0' })
        server.registerTool('search', {
          description: 'Search a fake catalog',
          inputSchema: { q: z.string() },
        }, async ({ q }) => ({ content: [{ type: 'text', text: `hit:${q}` }] }))
        await server.connect(transport)
        sessions.set(newId, transport)
      }
      const response = await transport.handleRequest(request)
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk)
      }
      res.end()
    }
    catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(err instanceof Error ? err.message : String(err))
    }
  })

  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  port = (http.address() as { port: number }).port
  const manifest: McpServerManifest = {
    id: 'local',
    label: 'Local mock',
    transport: 'streamable-http',
    endpoint: `http://127.0.0.1:${port}/mcp`,
    credentialGeneration: 1,
    enabled: true,
    protocolPolicy: 'auto',
    maxDiscoveryAgeMs: 60_000,
    dataSharing: 'shared-safe',
    tools: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  try {
    const connection = await connectMcpServer(manifest, { fetchImpl: fetch as typeof fetch })
    try {
      const discovered = await connection.discover()
      assert.equal(discovered.tools.length, 1)
      assert.equal(discovered.tools[0]!.upstreamName, 'search')
      assert.match(discovered.tools[0]!.schemaHash, /^[a-f0-9]{64}$/)
      assert.ok(discovered.protocolEra)
      const result = await connection.callTool('search', { q: 'abc' }) as { content: Array<{ text: string }> }
      assert.equal(result.content[0]!.text, 'hit:abc')
    }
    finally {
      await connection.close()
    }
  }
  finally {
    await new Promise<void>(resolve => http.close(() => resolve()))
  }
})
