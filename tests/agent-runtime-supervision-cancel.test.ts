import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AgentRuntimeState } from '../server/services/workshop/runtime/agent-runtime/state'
import type { A2AMessage } from '../server/services/workshop/types/a2a'
import type { AgentInfo, AgentInterface } from '../server/services/workshop/agents/agent-interface'
import type { AgentStatusView } from '../server/services/workshop/types/task'

class TestAgentRuntime extends AgentRuntimeState {
  protected superviseController: AbortController | null = null

  constructor() {
    super({ id: 'lead-1', name: 'Lead', role: 'lead', channelId: 'channel-1', harness: 'mock' } as AgentInfo,
      {} as AgentInterface,
      { mailbox: {} as never, taskEngine: {} as never, bus: {} as never, workspace: {} as never })
  }

  beginSupervision(rootId: string, controller: AbortController): void {
    this.superviseController = controller
    this.supervisionAttempt = { ...this.supervisionAttempt, attemptId: 'attempt-1', state: 'RUNNING', activeRootId: rootId }
  }

  protected async consumeLoop(): Promise<void> {}
  protected maybePostSettle(): void {}
  protected async processMessage(_message: A2AMessage): Promise<void> {}
  refreshStatus(): void {}
  protected queueContext(): Pick<AgentStatusView, 'currentTaskId' | 'currentTaskTitle' | 'currentTaskProgress' | 'queuedCount' | 'completedCount' | 'supervision' | 'continuity'> {
    return {} as never
  }
}

test('abortTask aborts supervision rooted at the canceled task', () => {
  const runtime = new TestAgentRuntime()
  const controller = new AbortController()
  runtime.beginSupervision('root-1', controller)

  assert.equal(runtime.abortTask('root-1'), true)
  assert.equal(controller.signal.aborted, true)
  assert.equal(runtime.getSupervisionStatus().state, 'ABORT_REQUESTED')
  assert.equal(runtime.abortTask('other-root'), false)
})
