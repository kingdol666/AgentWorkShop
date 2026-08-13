/**
 * MockAgentImpl — harness 无关的 mock 实现(联调/测试用)。
 * worker run 剧本:assign 消息 → status(WORKING) → 按 delayMs 上报 25/50/75 → artifact → completeTask → done。
 * lead supervise 剧本:SUBMITTED 且 assignee 自己 → dispatch 给最久空闲 worker;FAILED → reassign;子任务全完成 → complete 父。
 * 权威契约见 docs/superpowers/plans/2026-08-13-agent-workshop-multi-agent.md 核心契约块 T5。
 */
import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  AgentInterface,
  AgentRunContext,
  AgentRunRequest,
  SupervisionDecision,
  SupervisionSnapshot,
} from './agent-interface'
import type { A2AArtifact } from '../types/a2a'

/** 终态(§2.2):COMPLETED / FAILED / CANCELED */
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELED'])

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export class MockAgentImpl implements AgentInterface {
  private readonly delayMs: number
  /** 成员空闲起始时间(最久空闲 worker 排序) */
  private readonly idleSince = new Map<string, number>()

  constructor(config: Record<string, unknown> = {}) {
    this.delayMs = typeof config.delayMs === 'number' ? config.delayMs : 300
  }

  async* run(request: AgentRunRequest, ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    const kind = request.message.metadata?.['x-aw-task-kind']
    // worker: assign 消息 → 执行任务剧本;lead: 主任务由 supervise 调度循环处理,assign 消息 no-op
    if (kind === 'assign' && ctx.role === 'worker') {
      yield* this.workerScript(request, ctx)
      return
    }
    // child-completed 及其它消息:no-op(父任务汇总由调度循环完成)
  }

  /** lead 调度决策:观察快照 → 返回决策(与内置规则引擎同构) */
  async supervise(snapshot: SupervisionSnapshot, ctx: AgentRunContext): Promise<SupervisionDecision[]> {
    const decisions: SupervisionDecision[] = []
    const now = snapshot.now
    this.refreshIdle(snapshot, now)
    const idleWorkers = snapshot.members.filter(m => m.role === 'worker' && m.state === 'idle')

    for (const task of snapshot.tasks) {
      // SUBMITTED 且 assignee 自己 → dispatch 给最久空闲 worker
      if (task.state === 'SUBMITTED' && task.assigneeId === ctx.agentId) {
        const worker = this.pickIdleWorker(idleWorkers, now)
        if (worker) {
          decisions.push({
            kind: 'dispatch',
            parentTaskId: task.id,
            assigneeId: worker.agentId,
            title: task.title,
            description: task.description,
          })
        }
      }
      // FAILED 且重试次数 < 3 → reassign 给空闲 worker
      if (task.state === 'FAILED' && task.retryCount < 3) {
        const worker = this.pickIdleWorker(idleWorkers, now, task.assigneeId)
        if (worker) {
          decisions.push({ kind: 'reassign', taskId: task.id, toAgentId: worker.agentId })
        }
      }
    }

    // 子任务全完成且父任务(WAITING/WORKING)→ complete 父
    for (const task of snapshot.tasks) {
      const children = snapshot.tasks.filter(t => t.parentId === task.id)
      if (children.length === 0) continue
      if (TERMINAL.has(task.state)) continue
      const allDone = children.every(c => c.state === 'COMPLETED')
      if (allDone && (task.state === 'WAITING' || task.state === 'WORKING')) {
        // 汇总子任务成果为父任务 artifact(lead 交付物):展开各子任务 artifact 的 parts
        const summary: A2AArtifact = {
          artifactId: randomUUID(),
          name: 'summary',
          parts: [
            ...children.flatMap(c => c.artifacts.flatMap(a => a.parts)),
            { text: `汇总:${children.map(c => c.title).join(' + ')}(${ctx.agentId})` },
          ],
        }
        decisions.push({ kind: 'complete', taskId: task.id, artifacts: [summary] })
      }
    }

    return decisions
  }

  /** worker 剧本:assign 消息 → 执行 + 上报进度 + 产出成果 + 完成 */
  private async* workerScript(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    const taskId = request.taskId ?? (request.message.metadata?.['x-aw-task-id'] as string | undefined)
    if (!taskId) return
    yield { kind: 'status', status: { state: 'WORKING', timestamp: new Date().toISOString() } }
    for (const p of [25, 50, 75]) {
      await sleep(this.delayMs)
      await ctx.workspace.reportTask({ taskId, progress: p })
    }
    const artifact: A2AArtifact = {
      artifactId: randomUUID(),
      name: 'result',
      parts: [{ text: `mock 成果(${ctx.agentId})` }],
    }
    yield { kind: 'artifact', artifact }
    await ctx.workspace.completeTask(taskId, [artifact])
    yield { kind: 'done', final: { taskId } }
  }

  private refreshIdle(snapshot: SupervisionSnapshot, now: number): void {
    for (const m of snapshot.members) {
      if (m.state === 'idle') {
        if (!this.idleSince.has(m.agentId)) this.idleSince.set(m.agentId, now)
      }
      else {
        this.idleSince.delete(m.agentId)
      }
    }
  }

  private pickIdleWorker(
    idleWorkers: SupervisionSnapshot['members'],
    now: number,
    exclude?: string,
  ): SupervisionSnapshot['members'][number] | undefined {
    const pool = exclude ? idleWorkers.filter(w => w.agentId !== exclude) : idleWorkers
    if (pool.length === 0) return undefined
    return [...pool].sort(
      (a, b) => (this.idleSince.get(a.agentId) ?? now) - (this.idleSince.get(b.agentId) ?? now),
    )[0]
  }
}
