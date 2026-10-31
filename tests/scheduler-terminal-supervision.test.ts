import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SchedulerLoopTick } from '../server/services/workshop/runtime/scheduler-loop/tick'
import type { SupervisionSnapshot } from '../server/services/workshop/agents/agent-interface'
import type { SchedulerDecision } from '../server/services/workshop/runtime/scheduler-loop/types'

class TestSchedulerLoop extends SchedulerLoopTick {
  constructor() {
    super({ channelId: 'channel-1' } as never, { agentId: 'lead-1', supervise: async () => [] } as never)
    this.lastSuperviseAt = 1
  }

  remember(snapshot: SupervisionSnapshot): void {
    this.lastFingerprint = this.superviseFingerprint(snapshot)
  }

  shouldRun(snapshot: SupervisionSnapshot): boolean {
    return this.shouldSupervise(snapshot)
  }

  protected override checkLoopCompletion(): void {}
  protected override collectSnapshot(): SupervisionSnapshot { return {} as never }
  protected override async decide(): Promise<SchedulerDecision[]> { return [] }
  protected override execute(): void {}
  protected override pickWorker(): SupervisionSnapshot['members'][number] | undefined { return undefined }
  protected override refreshIdle(): void {}
  protected override ruleEngine(): SchedulerDecision[] { return [] }
  protected override async runRound(): Promise<void> {}
}

const snapshot = (state: string, mail: string[] = []): SupervisionSnapshot => ({
  tick: 2,
  activeRootId: 'root-1',
  tasks: [{ id: 'root-1', parentId: null, assigneeId: 'lead-1', state }],
  members: [],
  mail: mail.map(messageId => ({ messageId })),
} as never)

test('terminal-task-only snapshot does not restart lead supervision; new mail and active roots still do', () => {
  const scheduler = new TestSchedulerLoop()
  const working = snapshot('WORKING')
  scheduler.remember(working)

  assert.equal(scheduler.shouldRun(snapshot('CANCELED')), false)
  assert.equal(scheduler.shouldRun(snapshot('CANCELED', ['message-1'])), true)
  assert.equal(scheduler.shouldRun(snapshot('WORKING')), true)
})
