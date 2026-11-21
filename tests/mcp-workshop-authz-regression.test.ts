/**
 * MCP HTTP ingress 身份与资源范围回归。
 *
 * 覆盖静态复核发现的三类缺口（不启动监听器、不外呼）：
 *  1. 会话初始化与后续请求都必须有有效 Agent token，停用成员/Channel 立即失效；
 *  2. 同一 sessionId 不得切换请求主体；
 *  3. device.list/read/bind_agent 只能触达调用者可见设备，且只能把设备绑定给自己。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertCanBindDevice,
  assertDeviceVisible,
  assertSessionPrincipal,
  bearerTokenOf,
  deviceVisibleTo,
  emptyDeviceScope,
  resolveIngressPrincipal,
} from '../server/mcp/ingress-auth'
import type { AgentInfo } from '../server/services/workshop/agents/agent-interface'

const agent = (id: string): AgentInfo => ({
  id,
  channelId: 'ch-1',
  name: id,
  harness: 'mock',
  role: 'worker',
  config: {},
  enabled: 1,
})

function managerFor(active: Record<string, AgentInfo | null>, fallback: Record<string, AgentInfo> = {}) {
  return {
    findActiveAgentByToken: (token: string) => active[token] ?? undefined,
    findByToken: (token: string) => fallback[token] ?? undefined,
  }
}

const expectStatus = (status: number, code: string) => (err: { status?: number, code?: string }) => {
  assert.equal(err.status, status)
  assert.equal(err.code, code)
  return true
}

test('bearerTokenOf 只接受 Bearer 格式', () => {
  assert.equal(bearerTokenOf('Bearer tok-1'), 'tok-1')
  assert.equal(bearerTokenOf('bearer  spaced  '), 'spaced')
  assert.equal(bearerTokenOf('Basic abc'), null)
  assert.equal(bearerTokenOf(null), null)
})

test('rejects_missing_invalid_and_disabled_agent_tokens', () => {
  const mgr = managerFor({ 'tok-active': agent('a1'), 'tok-disabled': null })
  assert.throws(() => resolveIngressPrincipal(mgr, null), expectStatus(401, 'UNAUTHORIZED'))
  assert.throws(() => resolveIngressPrincipal(mgr, 'Bearer missing'), expectStatus(401, 'UNAUTHORIZED'))
  assert.throws(() => resolveIngressPrincipal(mgr, 'Bearer tok-disabled'), expectStatus(401, 'UNAUTHORIZED'))
  assert.equal(resolveIngressPrincipal(mgr, 'Bearer tok-active').id, 'a1')
})

test('falls back to legacy findByToken only when strict resolver is absent', () => {
  const legacy = { findByToken: (token: string) => (token === 'legacy' ? agent('legacy-agent') : undefined) }
  assert.equal(resolveIngressPrincipal(legacy, 'Bearer legacy').id, 'legacy-agent')
})

test('rejects_mcp_session_principal_change', () => {
  assert.doesNotThrow(() => assertSessionPrincipal('a1', 'a1'))
  assert.throws(() => assertSessionPrincipal('a1', 'a2'), expectStatus(403, 'MCP_SESSION_PRINCIPAL_MISMATCH'))
})

test('device scope: global, mounted workspace and bound devices are visible; others are not', () => {
  const scope = { agentId: 'a1', channelId: 'ch-1', workspaceIds: ['ws-owned'] }
  assert.equal(deviceVisibleTo({ workspaceId: '', boundAgentId: null }, scope), true)
  assert.equal(deviceVisibleTo({ workspaceId: 'ws-owned', boundAgentId: null }, scope), true)
  assert.equal(deviceVisibleTo({ workspaceId: 'ws-foreign', boundAgentId: 'a1' }, scope), true)
  assert.equal(deviceVisibleTo({ workspaceId: 'ws-foreign', boundAgentId: null }, scope), false)
  assert.equal(deviceVisibleTo({ workspaceId: 'ws-foreign', boundAgentId: 'a2' }, scope), false)
})

test('device_read_is_scoped_to_authorized_device', () => {
  const scope = { agentId: 'a1', channelId: 'ch-1', workspaceIds: ['ws-owned'] }
  assert.doesNotThrow(() => assertDeviceVisible({ workspaceId: 'ws-owned', boundAgentId: null }, scope))
  assert.throws(
    () => assertDeviceVisible({ workspaceId: 'ws-foreign', boundAgentId: null }, scope),
    expectStatus(403, 'DEVICE_SCOPE_DENIED'),
  )
})

test('device.bind_agent 只允许绑定自身且不得抢占', () => {
  const scope = { agentId: 'a1', channelId: 'ch-1', workspaceIds: ['ws-owned'] }
  assert.doesNotThrow(() => assertCanBindDevice({ workspaceId: '', boundAgentId: null }, scope, 'a1'))
  assert.throws(
    () => assertCanBindDevice({ workspaceId: '', boundAgentId: null }, scope, 'a2'),
    expectStatus(403, 'DEVICE_BIND_FORBIDDEN'),
  )
  assert.throws(
    () => assertCanBindDevice({ workspaceId: '', boundAgentId: 'a2' }, scope, 'a1'),
    expectStatus(403, 'DEVICE_BIND_FORBIDDEN'),
  )
  assert.throws(
    () => assertCanBindDevice({ workspaceId: 'ws-foreign', boundAgentId: null }, scope, 'a1'),
    expectStatus(403, 'DEVICE_SCOPE_DENIED'),
  )
})

test('emptyDeviceScope 不隐式授予工作区设备', () => {
  const scope = emptyDeviceScope({ id: 'a1', channelId: 'ch-1' })
  assert.deepEqual(scope.workspaceIds, [])
  assert.equal(deviceVisibleTo({ workspaceId: 'ws-any', boundAgentId: null }, scope), false)
})
