import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { ompAgentTeamAuditFailure, recordOmpAgentTeamToolEvent } from '../server/services/workshop/agents/omp-agent/agentteam-audit'

const oldLog = process.env.AW_AGENTTEAM_EVENT_LOG
const oldRunId = process.env.AW_AGENTTEAM_RUN_ID
const dirs: string[] = []

after(() => {
  if (oldLog === undefined) delete process.env.AW_AGENTTEAM_EVENT_LOG
  else process.env.AW_AGENTTEAM_EVENT_LOG = oldLog
  if (oldRunId === undefined) delete process.env.AW_AGENTTEAM_RUN_ID
  else process.env.AW_AGENTTEAM_RUN_ID = oldRunId
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

test('captures paired OMP tool events with actor/task identity and redacts credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-agentteam-audit-'))
  dirs.push(dir)
  const path = join(dir, 'events.jsonl')
  process.env.AW_AGENTTEAM_EVENT_LOG = path
  process.env.AW_AGENTTEAM_RUN_ID = 'run-test'
  const identity = { agentId: 'agent-worker-a', role: 'worker' as const, channelId: 'channel-test', taskId: 'task-test' }

  assert.equal(recordOmpAgentTeamToolEvent({
    type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'daq_query',
    args: { line_id: 'line-test', api_key: 'must-not-appear' },
  }, identity), true)
  assert.equal(recordOmpAgentTeamToolEvent({
    type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'daq_query',
    result: 'value=12 token=must-not-appear Authorization: Bearer abc.def.ghi sk_test_abcdefghijklmnopqrstuvwxyz123456 AKIA1234567890ABCDEF', isError: false,
  }, identity), true)

  const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(row => row.event_type), ['tool_execution_start', 'tool_execution_end'])
  assert.ok(rows.every(row => row.actor_agent_id === identity.agentId && row.task_id === identity.taskId))
  assert.equal(rows[0].request.api_key, '[REDACTED]')
  assert.match(rows[1].response, /token=\[REDACTED\]/)
  assert.doesNotMatch(rows[1].response, /abc\.def\.ghi|sk_test_abcdefghijklmnopqrstuvwxyz123456|AKIA1234567890ABCDEF/)
  assert.ok(rows.every(row => row.tool_call_id === 'call-1'))
  assert.ok(rows[1].source_seq > rows[0].source_seq)
})

test('deduplicates repeated tool frames while keeping different actors and calls independent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-agentteam-audit-dedupe-'))
  dirs.push(dir)
  const path = join(dir, 'events.jsonl')
  process.env.AW_AGENTTEAM_EVENT_LOG = path
  process.env.AW_AGENTTEAM_RUN_ID = 'run-test-dedupe'
  const actorA = { agentId: 'agent-a', role: 'lead' as const, channelId: 'channel-test', taskId: 'task-a' }
  const actorB = { agentId: 'agent-b', role: 'worker' as const, channelId: 'channel-test', taskId: 'task-b' }

  assert.equal(recordOmpAgentTeamToolEvent({
    type: 'tool_execution_start', toolCallId: 'shared-call', toolName: 'line_context', args: { value: 'first' },
  }, actorA), true)
  assert.equal(recordOmpAgentTeamToolEvent({
    type: 'tool_execution_start', toolCallId: 'shared-call', toolName: 'line_context', args: { value: 'duplicate' },
  }, actorA), true)
  assert.equal(recordOmpAgentTeamToolEvent({
    type: 'tool_execution_start', toolCallId: 'shared-call', toolName: 'line_context', args: { value: 'other actor' },
  }, actorB), true)
  assert.equal(recordOmpAgentTeamToolEvent({
    type: 'tool_execution_start', toolCallId: 'other-call', toolName: 'line_context', args: { value: 'other call' },
  }, actorA), true)

  assert.equal(recordOmpAgentTeamToolEvent({
    type: 'tool_execution_end', toolCallId: 'shared-call', toolName: 'line_context', result: 'first result',
  }, actorA), true)
  assert.equal(recordOmpAgentTeamToolEvent({
    type: 'tool_execution_end', toolCallId: 'shared-call', toolName: 'line_context', result: 'duplicate result',
  }, actorA), true)
  assert.equal(recordOmpAgentTeamToolEvent({
    type: 'tool_execution_end', toolCallId: 'shared-call', toolName: 'line_context', result: 'other actor result',
  }, actorB), true)
  assert.equal(recordOmpAgentTeamToolEvent({
    type: 'tool_execution_end', toolCallId: 'other-call', toolName: 'line_context', result: 'other call result',
  }, actorA), true)

  const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.length, 6)
  assert.deepEqual(rows.map(row => [row.actor_agent_id, row.tool_call_id, row.event_type]), [
    ['agent-a', 'shared-call', 'tool_execution_start'],
    ['agent-b', 'shared-call', 'tool_execution_start'],
    ['agent-a', 'other-call', 'tool_execution_start'],
    ['agent-a', 'shared-call', 'tool_execution_end'],
    ['agent-b', 'shared-call', 'tool_execution_end'],
    ['agent-a', 'other-call', 'tool_execution_end'],
  ])
  assert.deepEqual(rows[0].request, { value: 'first' })
  assert.equal(rows[3].response, 'first result')
})

test('keeps tool events without a call ID as separate records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-agentteam-audit-no-call-id-'))
  dirs.push(dir)
  const path = join(dir, 'events.jsonl')
  process.env.AW_AGENTTEAM_EVENT_LOG = path
  process.env.AW_AGENTTEAM_RUN_ID = 'run-test-no-call-id'
  const identity = { agentId: 'agent-worker', role: 'worker' as const, channelId: 'channel-test', taskId: 'task-test' }

  assert.equal(recordOmpAgentTeamToolEvent({
    type: 'tool_execution_start', toolName: 'daq_query', args: { value: 'first' },
  }, identity), true)
  assert.equal(recordOmpAgentTeamToolEvent({
    type: 'tool_execution_start', toolName: 'daq_query', args: { value: 'second' },
  }, identity), true)

  const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(rows.length, 2)
  assert.ok(rows.every(row => row.tool_call_id === null))
  assert.deepEqual(rows.map(row => row.request.value), ['first', 'second'])
})

test('latches an event sink failure so later host-tool dispatch can fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-agentteam-audit-missing-'))
  dirs.push(dir)
  process.env.AW_AGENTTEAM_EVENT_LOG = join(dir, 'absent', 'events.jsonl')
  process.env.AW_AGENTTEAM_RUN_ID = 'run-test-failure'

  assert.equal(recordOmpAgentTeamToolEvent({ type: 'tool_execution_start', toolName: 'dcw_control', args: {} }, {
    agentId: 'agent-worker-a', role: 'worker', channelId: 'channel-test', taskId: 'task-test',
  }), false)
  assert.ok(ompAgentTeamAuditFailure())
})
