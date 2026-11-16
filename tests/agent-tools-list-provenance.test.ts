import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { register } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { createApp, createRouter, toWebHandler } from 'h3'

register(new URL('../scripts/_audit/ts-resolve-hook.mjs', import.meta.url))
process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-agent-tools-list-'))

const { userRepository } = await import('../server/repositories/user.repository')
const { ManagerHostTools } = await import('../server/services/workshop/runtime/manager/host-tools')
const { HOST_TOOLS } = await import('../server/services/workshop/agents/host-tool-bridge')
const { OBSERVE_BLOCKED_TOOL_NAMES, allowedWithoutTurnProvenance } = await import('../server/services/workshop/agents/tool-classes')
const { registerPluginTool, unregisterPluginTools } = await import('../server/services/workshop/agents/plugin-tools')
const { default: listTools } = await import('../server/api/workshop/agent-tools/list.get')
const { default: invokeTool } = await import('../server/api/workshop/agent-tools/invoke.post')

const owner = userRepository.create({ name: 'list-owner', email: `list-owner-${process.pid}@test.local`, password: 'test-password-1', role: 'user', status: 'active' } as never)
const outsider = userRepository.create({ name: 'list-outsider', email: `list-outsider-${process.pid}@test.local`, password: 'test-password-1', role: 'user', status: 'active' } as never)
const ownerToken = userRepository.createToken(owner.id, 'list-test').raw
const outsiderToken = userRepository.createToken(outsider.id, 'list-test').raw
const row = { id: 'agent-1', enabled: 1, channelId: 'channel-1', role: 'lead', name: 'lead' }
const authorizationTools = ['team_grant_nodes', 'team_revoke_nodes', 'dispatch_task', 'create_team_agent', 'update_team_agent', 'remove_team_agent']
const pluginNames = ['listing_read', 'listing_write', 'listing_admin', 'listing_undeclared', 'listing_invalid']
const names = [...new Set([...OBSERVE_BLOCKED_TOOL_NAMES, ...authorizationTools, ...HOST_TOOLS.map(tool => tool.name), ...pluginNames])]
const definitions = names.map(name => ({ name, description: name, parameters: {} }))

for (const risk of ['read', 'write', 'admin', 'undeclared', 'invalid'] as const) {
  registerPluginTool('listing-test', {
    name: `listing_${risk}`,
    description: risk,
    parameters: {},
    ...(risk === 'undeclared' ? {} : { riskClass: risk as 'read' | 'write' | 'admin' }),
    handler: async () => ({ text: 'plugin-ok' }),
  })
}
// Built-in names win over plugins in both listing and execution.
registerPluginTool('listing-test', { name: 'search_memory', description: 'collision', parameters: {}, riskClass: 'write', handler: async () => ({ text: 'shadow' }) })

const manager = Object.create(ManagerHostTools.prototype) as Record<string, unknown>
manager.deps = { repos: {
  channelAgents: { findById: (id: string) => id === row.id ? row : null, isTokenValid: (_row: unknown, token: string) => token === 'agent-token' },
  channels: { findById: () => ({ ownerUserId: owner.id }) },
} }
manager.resolveAgentByToken = (token: string) => token === 'agent-token' ? { agentId: row.id, channelId: row.channelId } : null
manager.channelPermissionsOf = (_channelId: string, user: { id: string, role: string }) => ({ isAdmin: user.role === 'admin', isMember: user.id === owner.id })
let definitionsRequested = 0
manager.hostToolDefsFor = () => {
  definitionsRequested++
  return definitions
}
manager.activeScopeOf = () => null
manager.lastToolInvokeAt = new Map()
manager.ensureAgentRuntime = () => ({ workspace: {}, dispatchHostTool: async () => ({ text: 'native-ok' }) })
manager.channelSessionScopeOfAgent = () => null
manager.auditCollabInvocation = () => {}
const globals = globalThis as typeof globalThis & { __workshopManager?: unknown }
const oldManager = globals.__workshopManager
globals.__workshopManager = manager

after(() => {
  unregisterPluginTools('listing-test')
  globals.__workshopManager = oldManager
})

const app = createApp()
const router = createRouter()
router.get('/api/workshop/agent-tools/list', listTools as never)
router.post('/api/workshop/agent-tools/invoke', invokeTool as never)
app.use(router)
const web = toWebHandler(app)
const listUrl = 'http://localhost/api/workshop/agent-tools/list?agentId=agent-1'

async function list(headers: Record<string, string>, url = listUrl) {
  return web(new Request(url, { headers }))
}
async function invoke(tool: string, headers: Record<string, string>) {
  const response = await web(new Request('http://localhost/api/workshop/agent-tools/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ agentId: row.id, tool, args: {} }),
  }))
  return { response, body: await response.json() as { data?: { result?: { text: string, isError?: boolean } } } }
}

test('pure provenance policy applies built-in precedence and fails closed on plugin risk', () => {
  for (const name of [...OBSERVE_BLOCKED_TOOL_NAMES, ...authorizationTools]) {
    assert.equal(allowedWithoutTurnProvenance(name, true), false, name)
    assert.equal(allowedWithoutTurnProvenance(name, false, { riskClass: 'read' }), false, name)
  }
  assert.equal(allowedWithoutTurnProvenance('search_memory', true, { riskClass: 'write' }), true)
  assert.equal(allowedWithoutTurnProvenance('unknown_tool', false), true)
  assert.equal(allowedWithoutTurnProvenance('listing_read', false, { riskClass: 'read' }), true)
  for (const riskClass of [undefined, 'write', 'admin', 'invalid', null]) {
    assert.equal(allowedWithoutTurnProvenance('plugin', false, { riskClass }), false, String(riskClass))
  }
})

test('agent-token listing agrees with the provenance call gate and preserves user listing', async () => {
  const tokenHeaders = { 'x-aw-agent-token': 'agent-token' }
  const userHeaders = { authorization: `Bearer ${ownerToken}` }
  const tokenResponse = await list(tokenHeaders)
  assert.equal(tokenResponse.status, 200)
  const tokenBody = await tokenResponse.json() as { data: { tools: Array<{ name: string }> } }
  const listed = new Set(tokenBody.data.tools.map(tool => tool.name))
  assert.equal(listed.has('search_memory'), true)
  assert.equal(listed.has('listing_read'), true)
  for (const name of [...OBSERVE_BLOCKED_TOOL_NAMES, ...authorizationTools, ...pluginNames.filter(name => name !== 'listing_read')]) {
    assert.equal(listed.has(name), false, name)
  }

  for (const name of names) {
    const { response, body } = await invoke(name, tokenHeaders)
    assert.equal(response.status, 200, name)
    const provenanceDenied = Boolean(body.data?.result?.isError && body.data.result.text.includes('turn provenance'))
    assert.equal(provenanceDenied, !listed.has(name), name)
  }
  const ownerResponse = await list(userHeaders)
  assert.equal(ownerResponse.status, 200)
  const ownerBody = await ownerResponse.json() as { data: { tools: Array<{ name: string }> } }
  assert.deepEqual(ownerBody.data.tools.map(tool => tool.name), names)
  const ownerCall = await invoke('line_start', userHeaders)
  assert.equal(ownerCall.body.data?.result?.text, 'native-ok')

  const tokenEtag = tokenResponse.headers.get('etag')!
  const ownerEtag = ownerResponse.headers.get('etag')!
  assert.notEqual(tokenEtag, ownerEtag)
  assert.equal((await list({ ...tokenHeaders, 'if-none-match': tokenEtag })).status, 304)
  assert.equal((await list({ ...tokenHeaders, 'if-none-match': ownerEtag })).status, 200)
  assert.equal((await list({ ...userHeaders, 'if-none-match': tokenEtag })).status, 200)
  assert.equal((await list({ 'x-aw-agent-token': 'invalid' })).status, 401)
  assert.equal((await list({ authorization: `Bearer ${outsiderToken}` })).status, 403)
})

test('listing authenticates before loading definitions or evaluating conditional requests', async () => {
  const good = await list({ 'x-aw-agent-token': 'agent-token' })
  const etag = good.headers.get('etag')!
  const before = definitionsRequested
  const unauthorized = [
    await list({ 'x-aw-agent-token': 'invalid', 'if-none-match': etag }),
    await list({ 'x-aw-agent-token': 'agent-token', 'if-none-match': etag }, 'http://localhost/api/workshop/agent-tools/list?agentId=other-agent'),
    await list({ 'x-aw-agent-token': 'invalid', 'authorization': `Bearer ${ownerToken}`, 'if-none-match': etag }),
    await list({ 'authorization': `Bearer ${outsiderToken}`, 'if-none-match': etag }),
    await list({ 'if-none-match': etag }),
  ]
  assert.deepEqual(unauthorized.map(response => response.status), [401, 401, 401, 403, 401])
  for (const response of unauthorized) {
    assert.equal(response.headers.get('etag'), null)
    const body = await response.json() as { data: unknown }
    assert.equal(body.data, null)
  }
  assert.equal(definitionsRequested, before)
})

test('agent-token list and ETag react to plugin risk changes', async () => {
  const headers = { 'x-aw-agent-token': 'agent-token' }
  const before = await list(headers)
  const beforeEtag = before.headers.get('etag')!
  const beforeBody = await before.json() as { data: { tools: Array<{ name: string }> } }
  registerPluginTool('listing-test', {
    name: 'listing_read', description: 'now write', parameters: {}, riskClass: 'write', handler: async () => ({ text: 'unexpected' }),
  })
  const afterResponse = await list({ ...headers, 'if-none-match': beforeEtag })
  assert.equal(afterResponse.status, 200)
  assert.notEqual(afterResponse.headers.get('etag'), beforeEtag)
  const body = await afterResponse.json() as { data: { tools: Array<{ name: string }> } }
  assert.deepEqual(body.data.tools.map(tool => tool.name), beforeBody.data.tools.map(tool => tool.name).filter(name => name !== 'listing_read'))
  const call = await invoke('listing_read', headers)
  assert.match(call.body.data?.result?.text ?? '', /turn provenance/)
})
