/**
 * 外部 MCP manifest/egress 配置回归：HTTPS-only、凭据引用、redaction、
 * 原子存取、工具名去重、保留/私网地址拒绝与重定向逐跳校验。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureUniqueExposedNames,
  hashSchema,
  listManifests,
  newManifest,
  readManifest,
  redactManifest,
  validateCredentialRef,
  validateMcpEndpoint,
  writeManifest,
} from '../server/services/workshop/mcp-client/config'
import { guardedFetch, isBlockedAddress, resolveAndValidateHost, validateEgressUrl } from '../server/services/workshop/mcp-client/egress'

const expectCode = (code: string) => (err: { code?: string }) => {
  assert.equal(err.code, code)
  return true
}

test('endpoint is HTTPS-only without credentials/query/fragment', () => {
  assert.equal(validateMcpEndpoint('https://mcp.example.com/mcp'), 'https://mcp.example.com/mcp')
  assert.throws(() => validateMcpEndpoint('http://mcp.example.com/mcp'), expectCode('MCP_HTTPS_REQUIRED'))
  assert.throws(() => validateMcpEndpoint('https://user:pass@mcp.example.com/mcp'), expectCode('VALIDATION_ERROR'))
  assert.throws(() => validateMcpEndpoint('https://mcp.example.com/mcp?token=x'), expectCode('VALIDATION_ERROR'))
  assert.throws(() => validateMcpEndpoint('https://mcp.example.com/mcp#frag'), expectCode('VALIDATION_ERROR'))
})

test('credentialRef only allows AW_MCP_* env names', () => {
  assert.equal(validateCredentialRef('AW_MCP_MES_TOKEN'), 'AW_MCP_MES_TOKEN')
  assert.equal(validateCredentialRef(''), undefined)
  assert.throws(() => validateCredentialRef('PATH'), expectCode('VALIDATION_ERROR'))
  assert.throws(() => validateCredentialRef('AWS_SECRET_ACCESS_KEY'), expectCode('VALIDATION_ERROR'))
})

test('manifest defaults disabled/unknown and redacts credential value', () => {
  const manifest = newManifest({
    id: 'mes',
    label: 'MES',
    endpoint: 'https://mcp.example.com/mcp',
    credentialRef: 'AW_MCP_MES_TOKEN',
    dataSharing: 'unknown',
  }, '2026-11-21T00:00:00.000Z')
  assert.equal(manifest.enabled, false)
  assert.equal(manifest.credentialGeneration, 1)
  assert.equal(manifest.dataSharing, 'unknown')
  const redacted = redactManifest(manifest)
  assert.equal(redacted.hasCredential, true)
  assert.equal(redacted.credentialRef, 'AW_MCP_MES_TOKEN')
  assert.equal(JSON.stringify(redacted).includes('secret-value'), false)
})

test('manifest write/read/list is atomic and idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-mcp-config-'))
  try {
    const manifest = newManifest({ id: 'mes', label: 'MES', endpoint: 'https://mcp.example.com/mcp', dataSharing: 'shared-safe' })
    writeManifest(root, manifest)
    assert.equal(readManifest(root, 'mes')?.label, 'MES')
    assert.equal(listManifests(root).length, 1)
    const raw = readFileSync(join(root, 'mcp', 'servers', 'mes.json'), 'utf8')
    assert.equal(raw.includes('shared-safe'), true)
    assert.equal(raw.includes('AW_MCP_'), false)
  }
  finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tool exposed names are deterministic and collision-safe', () => {
  const tools = ensureUniqueExposedNames('mes', [
    { serverId: 'mes', upstreamName: 'search', description: '', inputSchema: {}, schemaHash: hashSchema({}), reviewStatus: 'pending', classification: 'write' },
    { serverId: 'mes', upstreamName: 'search', description: '', inputSchema: { type: 'object' }, schemaHash: hashSchema({ type: 'object' }), reviewStatus: 'pending', classification: 'write' },
  ])
  assert.equal(tools.length, 2)
  assert.notEqual(tools[0]!.exposedName, tools[1]!.exposedName)
  assert.ok(tools.every(t => t.exposedName.startsWith('mcp_mes_')))
})

test('isBlockedAddress covers loopback/private/link-local/CGNAT/documentation/reserved', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '192.0.2.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', 'ff02::1']) {
    assert.equal(isBlockedAddress(ip), true, ip)
  }
  assert.equal(isBlockedAddress('8.8.8.8'), false)
  assert.equal(isBlockedAddress('2606:4700:4700::1111'), false)
})

test('blocks private DNS and redirect before any upstream tool call', async () => {
  let hits = 0
  const fetchImpl = async (): Promise<Response> => {
    hits += 1
    return new Response('{}', { status: 200 })
  }
  await assert.rejects(
    () => guardedFetch(new URL('https://127.0.0.1/mcp'), undefined, { validate: validateEgressUrl, fetchImpl }),
    expectCode('MCP_EGRESS_DENIED'),
  )
  assert.equal(hits, 0)
})

test('rejects non-http and URL credentials before network', async () => {
  let hits = 0
  const fetchImpl = async (): Promise<Response> => {
    hits += 1
    return new Response('{}')
  }
  await assert.rejects(
    () => guardedFetch(new URL('http://example.com/mcp'), undefined, { validate: validateEgressUrl, fetchImpl }),
    expectCode('MCP_HTTPS_REQUIRED'),
  )
  await assert.rejects(
    () => guardedFetch(new URL('https://user:pass@example.com/mcp'), undefined, { validate: validateEgressUrl, fetchImpl }),
    expectCode('MCP_URL_CREDENTIALS_DENIED'),
  )
  assert.equal(hits, 0)
})

test('validates redirect origin and stops before the second request', async () => {
  let hits = 0
  const seen: string[] = []
  const fetchImpl = async (input: URL | string | Request): Promise<Response> => {
    hits += 1
    seen.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    return new Response(null, { status: 302, headers: { location: 'https://evil.example.net/mcp' } })
  }
  await assert.rejects(
    () => guardedFetch(new URL('https://mcp.example.com/mcp'), undefined, { validate: async () => {}, fetchImpl }),
    expectCode('MCP_REDIRECT_ORIGIN_DENIED'),
  )
  assert.equal(hits, 1)
  assert.deepEqual(seen, ['https://mcp.example.com/mcp'])
})

test('resolveAndValidateHost rejects unresolved/private literals without fetch', async () => {
  await assert.rejects(() => resolveAndValidateHost('127.0.0.1'), expectCode('MCP_EGRESS_DENIED'))
  await assert.rejects(() => resolveAndValidateHost('::1'), expectCode('MCP_EGRESS_DENIED'))
})
