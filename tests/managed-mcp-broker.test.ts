/**
 * 外部 MCP broker 回归：未审阅/非 shared-safe/未授权/停用均零上游调用；
 * schema/endpoint 变化回到 pending；超时不重试；结果限长；审计不含 secret。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpBroker } from '../server/services/workshop/mcp-client/broker'
import { hashSchema, readManifest, writeManifest } from '../server/services/workshop/mcp-client/config'
import type { McpConnection, McpDiscoveredTool } from '../server/services/workshop/mcp-client/types'

function tempConfig(): string {
  return mkdtempSync(join(tmpdir(), 'aw-mcp-broker-'))
}

function tool(name: string, schema: Record<string, unknown> = { type: 'object', properties: {}, additionalProperties: false }): McpDiscoveredTool {
  return { upstreamName: name, description: `${name} tool`, inputSchema: schema, schemaHash: hashSchema(schema) }
}

interface FakeState {
  tools: McpDiscoveredTool[]
  calls: Array<{ name: string, args: Record<string, unknown> }>
  discovers: number
  mode: 'ok' | 'hang' | 'large'
}

function fakeConnection(state: FakeState): McpConnection {
  return {
    async discover() {
      state.discovers += 1
      return { tools: state.tools, protocolEra: 'legacy' }
    },
    async callTool(name, args) {
      state.calls.push({ name, args })
      if (state.mode === 'hang') return await new Promise(() => {})
      if (state.mode === 'large') return { content: [{ type: 'text', text: 'x'.repeat(10_000) }] }
      return { content: [{ type: 'text', text: `ok:${name}` }], isError: false }
    },
    async close() {},
  }
}

async function setup(input: {
  dataSharing?: 'shared-safe' | 'project-private' | 'unknown'
  maxDiscoveryAgeMs?: number
  callTimeoutMs?: number
  maxResultChars?: number
  mode?: FakeState['mode']
}) {
  const configRoot = tempConfig()
  const state: FakeState = { tools: [tool('search')], calls: [], discovers: 0, mode: input.mode ?? 'ok' }
  let clock = Date.parse('2026-11-21T00:00:00.000Z')
  const broker = createMcpBroker({
    configRoot,
    connect: async () => fakeConnection(state),
    now: () => clock,
    callTimeoutMs: input.callTimeoutMs ?? 200,
    maxResultChars: input.maxResultChars ?? 64,
  })
  broker.create({
    id: 'mes',
    label: 'MES',
    endpoint: 'https://mcp.example.com/mcp',
    dataSharing: input.dataSharing ?? 'shared-safe',
    maxDiscoveryAgeMs: input.maxDiscoveryAgeMs ?? 60_000,
  })
  return {
    broker,
    state,
    configRoot,
    advance: (ms: number) => { clock += ms },
    cleanup: () => rmSync(configRoot, { recursive: true, force: true }),
  }
}

test('pending/disallowed calls never reach upstream', async () => {
  const s = await setup({})
  try {
    await s.broker.discover('mes')
    s.broker.patch('mes', { enabled: true })
    const pending = await s.broker.call('a1', 'mcp_mes_search', {}, { authorize: () => true })
    assert.equal(pending.isError, true)
    assert.match(pending.text, /未通过审阅/)
    assert.equal(s.state.calls.length, 0)

    const toolId = s.broker.get('mes').tools[0]!.id
    s.broker.review('mes', toolId, { status: 'approved', classification: 'read' }, 'admin')
    const denied = await s.broker.call('a1', 'mcp_mes_search', {}, { authorize: () => false })
    assert.equal(denied.isError, true)
    assert.match(denied.text, /无权/)
    assert.equal(s.state.calls.length, 0)

    const ok = await s.broker.call('a1', 'mcp_mes_search', {}, { authorize: () => true })
    assert.equal(ok.isError, undefined)
    assert.match(ok.text, /ok:search/)
    assert.equal(s.state.calls.length, 1)
  }
  finally {
    s.cleanup()
  }
})

test('approval requires shared-safe and explicit read classification', async () => {
  const s = await setup({ dataSharing: 'project-private' })
  try {
    await s.broker.discover('mes')
    const toolId = s.broker.get('mes').tools[0]!.id
    assert.throws(
      () => s.broker.review('mes', toolId, { status: 'approved', classification: 'read' }, 'admin'),
      (err: { code?: string }) => err.code === 'MCP_DATA_DOMAIN_NOT_SHARED',
    )
  }
  finally {
    s.cleanup()
  }

  const s2 = await setup({ dataSharing: 'shared-safe' })
  try {
    await s2.broker.discover('mes')
    const toolId = s2.broker.get('mes').tools[0]!.id
    assert.throws(
      () => s2.broker.review('mes', toolId, { status: 'approved' }, 'admin'),
      (err: { code?: string }) => err.code === 'MCP_WRITE_TOOL_NOT_ALLOWED',
    )
    const reviewed = s2.broker.review('mes', toolId, { status: 'approved', classification: 'read' }, 'admin')
    assert.equal(reviewed.tool.reviewStatus, 'approved')
    assert.equal(reviewed.tool.classification, 'read')
  }
  finally {
    s2.cleanup()
  }
})

test('schema or endpoint changes return approvals to pending', async () => {
  const s = await setup({})
  try {
    await s.broker.discover('mes')
    let toolId = s.broker.get('mes').tools[0]!.id
    s.broker.review('mes', toolId, { status: 'approved', classification: 'read' }, 'admin')
    s.broker.patch('mes', { enabled: true })
    assert.equal((await s.broker.call('a1', 'mcp_mes_search', {}, { authorize: () => true })).isError, undefined)

    s.state.tools = [tool('search', { type: 'object', properties: { q: { type: 'string' } }, additionalProperties: false })]
    await s.broker.discover('mes')
    toolId = s.broker.get('mes').tools[0]!.id
    assert.equal(s.broker.get('mes').tools[0]!.reviewStatus, 'pending')
    const denied = await s.broker.call('a1', 'mcp_mes_search', {}, { authorize: () => true })
    assert.equal(denied.isError, true)
    assert.equal(s.state.calls.length, 1)

    s.broker.review('mes', toolId, { status: 'approved', classification: 'read' }, 'admin')
    s.broker.patch('mes', { endpoint: 'https://mcp2.example.com/mcp' })
    assert.equal(s.broker.get('mes').tools[0]!.reviewStatus, 'pending')
    assert.ok(s.broker.get('mes').credentialGeneration >= 2)
  }
  finally {
    s.cleanup()
  }
})

test('stale discovery refreshes before call; timeout is not retried; result is bounded', async () => {
  const s = await setup({ maxDiscoveryAgeMs: 60_000, callTimeoutMs: 30, maxResultChars: 100 })
  try {
    await s.broker.discover('mes')
    const toolId = s.broker.get('mes').tools[0]!.id
    s.broker.review('mes', toolId, { status: 'approved', classification: 'read' }, 'admin')
    s.broker.patch('mes', { enabled: true })
    const before = s.state.discovers
    s.advance(120_000)
    s.state.mode = 'large'
    const ok = await s.broker.call('a1', 'mcp_mes_search', {}, { authorize: () => true })
    assert.equal(s.state.discovers, before + 1)
    assert.equal(ok.isError, undefined)
    assert.ok(ok.text.length <= 100)

    s.advance(120_000)
    s.state.mode = 'hang'
    const beforeCalls = s.state.calls.length
    const timedOut = await s.broker.call('a1', 'mcp_mes_search', {}, { authorize: () => true })
    assert.equal(timedOut.isError, true)
    assert.match(timedOut.text, /超时/)
    assert.equal(s.state.calls.length, beforeCalls + 1, 'timeout must not retry')
  }
  finally {
    s.cleanup()
  }
})

test('audit entries never contain credential refs or raw results', async () => {
  const configRoot = tempConfig()
  const state: FakeState = { tools: [tool('search')], calls: [], discovers: 0, mode: 'ok' }
  const audits: unknown[] = []
  try {
    const broker = createMcpBroker({ configRoot, connect: async () => fakeConnection(state) })
    broker.create({ id: 'mes', label: 'MES', endpoint: 'https://mcp.example.com/mcp', credentialRef: 'AW_MCP_MES_TOKEN', dataSharing: 'shared-safe' })
    await broker.discover('mes')
    const toolId = broker.get('mes').tools[0]!.id
    broker.review('mes', toolId, { status: 'approved', classification: 'read' }, 'admin')
    broker.patch('mes', { enabled: true })
    const result = await broker.call('a1', 'mcp_mes_search', { q: 'x' }, {
      authorize: () => true,
      audit: entry => audits.push(entry),
    })
    assert.equal(result.isError, undefined)
    const serialized = JSON.stringify(audits)
    assert.equal(serialized.includes('AW_MCP_MES_TOKEN'), false)
    assert.equal(serialized.includes('ok:search'), false)
    assert.equal(serialized.includes('"q"'), false)
  }
  finally {
    rmSync(configRoot, { recursive: true, force: true })
  }
})

test('manifest credential generation is persisted on endpoint change', async () => {
  const root = tempConfig()
  try {
    const broker = createMcpBroker({ configRoot: root, connect: async () => fakeConnection({ tools: [], calls: [], discovers: 0, mode: 'ok' }) })
    broker.create({ id: 'mes', label: 'MES', endpoint: 'https://mcp.example.com/mcp', dataSharing: 'shared-safe' })
    const before = readManifest(root, 'mes')!
    broker.patch('mes', { endpoint: 'https://mcp2.example.com/mcp' })
    const after = readManifest(root, 'mes')!
    assert.equal(after.credentialGeneration, before.credentialGeneration + 1)
    writeManifest(root, after)
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})
