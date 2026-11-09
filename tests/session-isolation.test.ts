/**
 * 会话隔离守卫(2026-11-10 审计 C1/C2/C3)。
 *
 * C1:A2A 工具桥的点对点/广播消息不带 x-aw-session-id,接收端解析不到会话上下文
 *     (manager 侧投递路径本来就盖章,只有 LLM 工具桥漏了)。
 * C2:广播遍历全频道成员,会把 A 会话的广播扇出到 B/C 会话的 clone。
 * C3:clone 名在每个会话内从 1 重计,并存会话里 `Alice·session·1` ×N,
 *     resolveMemberRef 按名字取第一个 → LLM 按名册寻址恒投最早会话。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectBroadcastTargets } from '../server/services/workshop/runtime/manager/broadcast-targets'
import { createChannelSession, SESSION_MARKER, type SessionCloneDeps } from '../server/services/workshop/agents/session-clone'
import { handleSendMessageToAgent, handleBroadcastMessage } from '../server/services/workshop/agents/host-tool-bridge/tools/messaging'

const agent = (id: string, name: string) => ({ id, name })

test('C2:会话 clone 广播只到基础成员 + 本会话 clone,基础成员广播保持全量', () => {
  const all = [
    agent('lead', 'Lead'),
    agent('s1-a', `A${SESSION_MARKER}1`),
    agent('s1-b', `B${SESSION_MARKER}1`),
    agent('s2-a', `A${SESSION_MARKER}2`),
    agent('s2-b', `B${SESSION_MARKER}2`),
  ]
  // 会话 1 的 clone 发起:基础成员 + 本会话两个 clone
  const fromS1 = selectBroadcastTargets(all, 's1-a', new Set(['s1-a', 's1-b']))
  assert.deepEqual(fromS1.map(a => a.id).sort(), ['lead', 's1-b'])

  // 基础成员(lead)发起:频道级全量(既有语义)
  const fromLead = selectBroadcastTargets(all, 'lead', null)
  assert.deepEqual(fromLead.map(a => a.id).sort(), ['s1-a', 's1-b', 's2-a', 's2-b'])

  // clone 发起但会话已关闭/解析不到成员表:只到基础成员(fail-closed,不跨会话)
  const orphan = selectBroadcastTargets(all, 's2-a', null)
  assert.deepEqual(orphan.map(a => a.id), ['lead'])
})

test('C3:两个会话的 clone 名跨会话唯一(不再从 1 重计)', () => {
  const store: Array<{ id: string, name: string, harness: string, role: string, enabled: number, agentKind: null, configJson: string }> = []
  let seq = 0
  const deps: SessionCloneDeps = {
    channelAgents: {
      listByChannel: () => store,
      create: (input) => {
        const row = { id: `clone-${++seq}`, name: input.name, harness: input.harness, role: input.role, enabled: 1, agentKind: null, configJson: '{}' }
        store.push(row)
        return row
      },
    },
    tasks: { list: () => [], cancelTree: () => [] },
    bindings: { byAgent: () => [], bind: () => null },
    unloadAgent: async () => {},
    notify: () => {},
  }
  store.push({ id: 'base-a', name: 'Alice', harness: 'mock', role: 'worker', enabled: 1, agentKind: null, configJson: '{}' })
  const sessionRepo = { create: () => ({ id: `cs-${store.length}` }) }

  createChannelSession(deps, { channelId: 'ch1', actorId: 'u1', sessionRepo })
  createChannelSession(deps, { channelId: 'ch1', actorId: 'u1', sessionRepo })

  const names = store.filter(m => m.name.includes(SESSION_MARKER)).map(m => m.name)
  assert.deepEqual(names, [`Alice${SESSION_MARKER}1`, `Alice${SESSION_MARKER}2`], '第二个会话必须续号,不得重名')
})

test('C1:send_message_to_agent 携带 x-aw-session-id', async () => {
  const seen: Array<Record<string, unknown>> = []
  const ws = {
    sendMessage: async (input: { metadata?: Record<string, unknown> }) => {
      seen.push(input.metadata ?? {})
      return { messageId: 'm-1' }
    },
  }
  await handleSendMessageToAgent(
    { to_agent_id: 'peer-1', message: '请确认参数' },
    { currentTaskId: null, sessionId: 'cs-42', sourceChatMessageId: null, sourceChatDeliveryId: null, replyContext: null },
    ws as never,
  )
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!['x-aw-session-id'], 'cs-42', '接收端按该戳解析会话上下文')

  // 无会话(REST 兜底路径)时不盖戳,行为不变
  await handleSendMessageToAgent(
    { to_agent_id: 'peer-1', message: '再确认' },
    { currentTaskId: null, sessionId: null, sourceChatMessageId: null, sourceChatDeliveryId: null, replyContext: null },
    ws as never,
  )
  assert.equal(seen[1]!['x-aw-session-id'], undefined)
})

test('C1+C2:broadcast_message 走会话收窄的目标面并带会话戳', async () => {
  const delivered: string[] = []
  const meta: Array<Record<string, unknown>> = []
  const ws = {
    listAgents: async () => [agent('lead', 'Lead'), agent('other-session', `A${SESSION_MARKER}2`)],
    listBroadcastTargets: async () => [agent('lead', 'Lead')],
    sendMessage: async (input: { toAgentId: string, metadata?: Record<string, unknown> }) => {
      delivered.push(input.toAgentId)
      meta.push(input.metadata ?? {})
      return { messageId: 'm-2' }
    },
  }
  const result = await handleBroadcastMessage(
    { message: '本会话进度同步' },
    { agentId: 'self', channelId: 'ch1', role: 'worker', name: 'A' },
    { currentTaskId: null, sessionId: 'cs-9', sourceChatMessageId: null, sourceChatDeliveryId: null, replyContext: null },
    ws as never,
  )
  assert.ok(!result.isError)
  assert.deepEqual(delivered, ['lead'], '不得扇出到其他会话的 clone')
  assert.equal(meta[0]!['x-aw-session-id'], 'cs-9')
})
