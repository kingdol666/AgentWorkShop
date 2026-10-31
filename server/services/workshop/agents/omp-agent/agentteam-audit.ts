/**
 * Opt-in, append-only raw tool-event capture for isolated AgentTeam experiments.
 *
 * The regular channel timeline intentionally stores compact summaries.  P12
 * needs the original host-tool request/result and actor/task identity, so an
 * isolated runner may set AW_AGENTTEAM_EVENT_LOG to a run-scoped JSONL file.
 * Capture errors are sticky and cause subsequent OMP host-tool dispatches to
 * fail closed.  This is not enabled unless the environment variable is set.
 */
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { AgentSessionEvent } from '../adapters/omp-rpc-client'

export interface OmpAgentTeamAuditIdentity {
  agentId: string
  role: 'lead' | 'worker'
  channelId: string
  taskId?: string
}

let sequence = 0
let captureFailure: string | null = null
const recordedToolEvents = new Set<string>()

const sensitiveKey = /(token|password|secret|api[-_]?key|authorization|cookie|credential)/i

function redact(value: unknown, key = ''): unknown {
  if (sensitiveKey.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map(item => redact(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k)]))
  }
  if (typeof value === 'string') {
    return value
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:sk[-_]|rk_live_|AKIA|ASIA|AIza|gh[pousr]_|github_pat_|xox[a-z]-)[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED]')
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
      .replace(/((?:token|password|secret|api[-_]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
  }
  return value
}

function appendRecord(path: string, record: Record<string, unknown>): boolean {
  let fd: number | undefined
  let appended = false
  try {
    fd = openSync(path, 'a')
    writeSync(fd, `${JSON.stringify(record)}\n`, undefined, 'utf8')
    fsyncSync(fd)
    appended = true
  }
  catch (error) {
    captureFailure = error instanceof Error ? error.message : String(error)
  }
  finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      }
      catch (error) {
        captureFailure ??= error instanceof Error ? error.message : String(error)
      }
    }
  }
  return appended && captureFailure === null
}

// A boot marker lets the runner distinguish the active process's audit sink
// from a stale file left by an earlier attempt, before any goal task is made.
const bootPath = process.env.AW_AGENTTEAM_EVENT_LOG?.trim()
const bootRunId = process.env.AW_AGENTTEAM_RUN_ID?.trim()
if (bootPath) {
  if (!bootRunId) {
    captureFailure = 'AW_AGENTTEAM_RUN_ID is required when AW_AGENTTEAM_EVENT_LOG is enabled'
  }
  else {
    const sourceSeq = ++sequence
    appendRecord(bootPath, {
      schema_version: 1,
      run_id: bootRunId,
      event_id: `${process.pid}:${sourceSeq}:${randomUUID()}`,
      source: 'aw-omp-agent-adapter',
      source_seq: sourceSeq,
      at_utc: new Date().toISOString(),
      monotonic_ns: process.hrtime.bigint().toString(),
      process_id: process.pid,
      aw_mode: process.env.AW_MODE ?? null,
      aw_home_sha256: process.env.AW_HOME
        ? createHash('sha256').update(resolve(process.env.AW_HOME)).digest('hex')
        : null,
      event_type: 'capture_ready',
    })
  }
}

/** Returns true when capture is disabled or the event was durably appended. */
export function recordOmpAgentTeamToolEvent(
  event: AgentSessionEvent,
  identity: OmpAgentTeamAuditIdentity,
): boolean {
  const path = process.env.AW_AGENTTEAM_EVENT_LOG?.trim()
  if (!path) return true
  if (captureFailure) return false
  if (event.type !== 'tool_execution_start' && event.type !== 'tool_execution_end') return true

  const runId = process.env.AW_AGENTTEAM_RUN_ID?.trim()
  if (!runId) {
    captureFailure = 'AW_AGENTTEAM_RUN_ID is required when AW_AGENTTEAM_EVENT_LOG is enabled'
    return false
  }

  const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : null
  const dedupeKey = toolCallId === null
    ? null
    : JSON.stringify([runId, identity.agentId, toolCallId, event.type])
  if (dedupeKey !== null && recordedToolEvents.has(dedupeKey)) return true

  const seq = ++sequence
  const base = {
    schema_version: 1,
    run_id: runId,
    event_id: `${process.pid}:${seq}:${randomUUID()}`,
    source: 'aw-omp-agent-adapter',
    source_seq: seq,
    at_utc: new Date().toISOString(),
    monotonic_ns: process.hrtime.bigint().toString(),
    actor_agent_id: identity.agentId,
    actor_role: identity.role,
    channel_id: identity.channelId,
    task_id: identity.taskId ?? null,
    tool_call_id: toolCallId,
    event_type: event.type,
    tool: typeof event.toolName === 'string' ? event.toolName : 'tool',
  }
  const record = event.type === 'tool_execution_start'
    ? { ...base, request: redact(event.args ?? {}) }
    : { ...base, response: redact(event.result ?? event.output ?? ''), is_error: event.isError === true }

  const appended = appendRecord(path, record)
  if (appended && dedupeKey !== null) recordedToolEvents.add(dedupeKey)
  return appended
}

export function ompAgentTeamAuditFailure(): string | null {
  return captureFailure
}
