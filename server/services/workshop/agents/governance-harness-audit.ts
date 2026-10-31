import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { HostToolBridgeContext, HostToolCall, HostToolResult } from './host-tool-bridge/types'

export interface ToolInvocation {
  runId: string
  invocationId: string
  harness: string
  agentId: string
  role: 'lead' | 'worker'
  channelId: string
  taskId: string | null
  tool: string
}

interface AuditSink {
  path: string
  runId: string
  sequence: number
  failure: string | null
}

interface InvocationContext extends ToolInvocation {
  sink: AuditSink
}

const invocationStorage = new AsyncLocalStorage<InvocationContext>()
const sinks = new Map<string, AuditSink>()
const sensitiveKey = /(token|password|secret|api[-_]?key|authorization|cookie|credential)/i

function redact(value: unknown, key = ''): unknown {
  if (sensitiveKey.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map(item => redact(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k)]))
  }
  if (typeof value !== 'string') return value
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk[-_]|rk_live_|AKIA|ASIA|AIza|gh[pousr]_|github_pat_|xox[a-z]-)[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/((?:token|password|secret|api[-_]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
}

export class GovernanceHarnessAuditError extends Error {
  constructor(readonly phase: string, message: string) {
    super(`governance Harness audit ${phase}: ${message}`)
    this.name = 'GovernanceHarnessAuditError'
  }
}

function append(sink: AuditSink, phase: string, record: Record<string, unknown>): void {
  if (sink.failure) throw new GovernanceHarnessAuditError(phase, sink.failure)
  let fd: number | undefined
  try {
    const sequence = ++sink.sequence
    const data = {
      schema_version: 1,
      run_id: sink.runId,
      event_id: `${process.pid}:${sequence}:${randomUUID()}`,
      source_seq: sequence,
      at_utc: new Date().toISOString(),
      monotonic_ns: process.hrtime.bigint().toString(),
      process_id: process.pid,
      ...record,
    }
    fd = openSync(sink.path, 'a')
    writeFileSync(fd, `${JSON.stringify(redact(data))}\n`, 'utf8')
    fsyncSync(fd)
  }
  catch (error) {
    sink.failure = String(redact(error instanceof Error ? error.message : String(error)))
  }
  finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      }
      catch (error) { sink.failure ??= String(redact(error instanceof Error ? error.message : String(error))) }
    }
  }
  if (sink.failure) throw new GovernanceHarnessAuditError(phase, sink.failure)
}

function configuredSink(): AuditSink | undefined {
  const path = process.env.AW_GOV_HARNESS_EVENT_LOG?.trim()
  if (!path) return undefined
  const runId = process.env.AW_GOV_HARNESS_RUN_ID?.trim() ?? ''
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(runId)) {
    throw new GovernanceHarnessAuditError('configuration', 'AW_GOV_HARNESS_RUN_ID must contain 8–80 safe characters')
  }
  if (!isAbsolute(path)) throw new GovernanceHarnessAuditError('configuration', 'AW_GOV_HARNESS_EVENT_LOG must be absolute')
  const key = JSON.stringify([path, runId])
  let sink = sinks.get(key)
  if (!sink) {
    sink = { path, runId, sequence: 0, failure: null }
    sinks.set(key, sink)
    append(sink, 'capture_ready', {
      source: 'aw-shared-host-tool-dispatch',
      event_type: 'capture_ready',
      aw_mode: process.env.AW_MODE ?? null,
      aw_home_sha256: process.env.AW_HOME ? createHash('sha256').update(resolve(process.env.AW_HOME)).digest('hex') : null,
    })
  }
  return sink
}

/** Trusted server invocation context; never derived from tool arguments. */
export function currentToolInvocation(): ToolInvocation | undefined {
  const context = invocationStorage.getStore()
  if (!context) return undefined
  const { sink: _sink, ...invocation } = context
  return invocation
}

function identityFields(context?: ToolInvocation) {
  return {
    invocation_id: context?.invocationId ?? null,
    actor_agent_id: context?.agentId ?? null,
    actor_role: context?.role ?? null,
    harness: context?.harness ?? null,
    channel_id: context?.channelId ?? null,
    task_id: context?.taskId ?? null,
    tool: context?.tool ?? null,
  }
}

/** Separate opt-in sink; P12's OMP adapter capture remains independent. */
export async function withGovernanceHarnessToolAudit(
  ctx: HostToolBridgeContext,
  req: HostToolCall,
  activeRootTaskId: string | undefined,
  execute: () => Promise<HostToolResult>,
): Promise<HostToolResult> {
  const sink = configuredSink()
  if (!sink) return execute()
  if (!ctx.identity.harness || !ctx.identity.agentId || !ctx.identity.channelId) {
    throw new GovernanceHarnessAuditError('tool_start', 'actual harness, agent and channel identity are required')
  }
  const context: InvocationContext = {
    sink,
    runId: sink.runId,
    invocationId: randomUUID(),
    harness: ctx.identity.harness,
    agentId: ctx.identity.agentId,
    role: ctx.identity.role,
    channelId: ctx.identity.channelId,
    taskId: ctx.state.currentTaskId ?? activeRootTaskId ?? null,
    tool: req.toolName,
  }
  append(sink, 'tool_start', { source: 'aw-shared-host-tool-dispatch', ...identityFields(context), event_type: 'tool_invocation_start', request: req.arguments })
  return invocationStorage.run(context, async () => {
    let result: HostToolResult
    try {
      result = await execute()
    }
    catch (error) {
      if (error instanceof GovernanceHarnessAuditError && sink.failure) throw error
      append(sink, 'tool_end', {
        source: 'aw-shared-host-tool-dispatch', ...identityFields(context), event_type: 'tool_invocation_end',
        is_error: true, response: { error: error instanceof Error ? error.message : String(error) },
      })
      throw error
    }
    append(sink, 'tool_end', {
      source: 'aw-shared-host-tool-dispatch', ...identityFields(context), event_type: 'tool_invocation_end',
      is_error: result.isError === true, response: result,
    })
    return result
  })
}

interface DriverCallAudit {
  sink: AuditSink
  invocation?: InvocationContext
  driverCallId: string
  fields: Record<string, unknown>
}

export function beginGovernanceDriverCall(fields: {
  node_id: string
  line_id: string | null
  driver: string
  requested_value: number
  plc_value: number
  tolerance: number
  recipe_run_id: string | null
  driver_config: Record<string, unknown>
}): DriverCallAudit | undefined {
  const invocation = invocationStorage.getStore()
  const sink = invocation?.sink ?? configuredSink()
  if (!sink) return undefined
  const call = { sink, invocation, driverCallId: randomUUID(), fields }
  append(sink, 'driver_start', {
    source: 'aw-dcw-driver', ...identityFields(invocation), ...fields,
    event_type: 'driver_call_start', driver_call_id: call.driverCallId,
  })
  return call
}

export function endGovernanceDriverCall(call: DriverCallAudit | undefined, outcome: unknown): void {
  if (!call) return
  append(call.sink, 'driver_end', {
    source: 'aw-dcw-driver', ...identityFields(call.invocation), ...call.fields,
    event_type: 'driver_call_end', driver_call_id: call.driverCallId, outcome,
  })
}

// Emit the boot marker when configured before server startup. Dispatch still
// checks the same sticky sink failure before allowing any tool to execute.
try {
  configuredSink()
}
catch { /* A configured but unavailable sink is reported by the first dispatch. */ }
