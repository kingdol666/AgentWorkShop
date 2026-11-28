import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Trusted server-side scope for one turn. Task lease fields are present only
 * when a validated assignment or supervision root supplies them.
 */
export interface ExecutionScope {
  readonly taskId?: string
  readonly agentId: string
  readonly channelId: string
  /** 当前会话（批次 N：写尝试/干预台账的 session 归因；非授权依据） */
  readonly sessionId?: string
  readonly assignmentGeneration?: number
  readonly executionLeaseId?: string
  readonly signal: AbortSignal
  readonly assertActive: () => void
}

const storage = new AsyncLocalStorage<ExecutionScope | undefined>()

export function currentExecutionScope(): ExecutionScope | undefined {
  return storage.getStore()
}

export function runWithExecutionScope<T>(scope: ExecutionScope | undefined, fn: () => T): T {
  // An unscoped call must not inherit the caller's ambient authority.
  return storage.run(scope, fn)
}
