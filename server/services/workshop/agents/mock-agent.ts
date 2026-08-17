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

/** 成员管理决策(spawn/update/remove;mock lead 经 teamOps 配置在首个 supervise tick 发出) */
type MemberOp = Extract<SupervisionDecision, { kind: 'spawn_agent' | 'update_agent' | 'remove_agent' }>

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export class MockAgentImpl implements AgentInterface {
  private readonly delayMs: number
  /** 成员空闲起始时间(最久空闲 worker 排序) */
  private readonly idleSince = new Map<string, number>()

  /** 流式演示开关:worker 剧本分片 yield delta(验证 AEP agent.delta 打字机链路) */
  private readonly streamDemo: boolean

  /** lead 首个 supervise tick 要发出的成员管理决策(测 SchedulerLoop 决策路径) */
  private readonly teamOps: MemberOp[]

  constructor(config: Record<string, unknown> = {}) {
    this.delayMs = typeof config.delayMs === 'number' ? config.delayMs : 300
    this.streamDemo = config.streamDemo === true
    this.teamOps = Array.isArray(config.teamOps) ? config.teamOps as MemberOp[] : []
  }

  async* run(request: AgentRunRequest, ctx: AgentRunContext): AsyncIterable<AgentEvent> {
    const kind = request.message.metadata?.['x-aw-task-kind']
    // worker: assign 消息 → 执行任务剧本;lead: 主任务由 supervise 调度循环处理,assign 消息 no-op
    if (kind === 'assign' && ctx.role === 'worker') {
      yield* this.workerScript(request, ctx)
      return
    }
    // worker/lead: 同事点对点消息 → 按触发器语义回复(实时通信驱动)
    if (!kind && request.fromAgentId) {
      yield* this.peerScript(request, ctx)
      return
    }
    // child-completed 及其它消息:no-op(父任务汇总由调度循环完成)
  }

  /** lead 调度决策:观察快照 → 返回决策(与内置规则引擎同构) */
  async supervise(snapshot: SupervisionSnapshot, ctx: AgentRunContext): Promise<SupervisionDecision[]> {
    const decisions: SupervisionDecision[] = []
    const now = snapshot.now
    this.refreshIdle(snapshot, now)
    // 团队管理剧本:首个 tick 发出 teamOps 决策(spawn/update/remove;发完即清)
    if (this.teamOps.length > 0) {
      decisions.push(...this.teamOps.splice(0))
    }
    // 本轮空闲池:选中即移出,防止一轮内把多个任务分给同一个 worker
    const pool = snapshot.members.filter(m => m.role === 'worker' && m.state === 'idle')

    for (const task of snapshot.tasks) {
      // SUBMITTED or WORKING 且 assignee 自己 且无子任务 → dispatch 给最优空闲 worker
      const hasChildren = snapshot.tasks.some(t2 => t2.parentId === task.id)
      if ((task.state === 'SUBMITTED' || task.state === 'WORKING')
        && task.assigneeId === ctx.agentId
        && !hasChildren) {
        const worker = this.pickWorker(pool, now)
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
        const worker = this.pickWorker(pool, now, task.assigneeId)
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
    if (this.streamDemo) {
      // 分片流式增量(打字机链路演示;每片 40ms)
      for (const piece of ['正在分析任务…', '检索上下文并规划步骤…', '执行核心改动…', '自检验证…', '完成。']) {
        yield { kind: 'delta', delta: { text: piece } }
        await sleep(40)
      }
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

  /**
   * 点对点消息剧本(lead 与 worker 通用):
   * 触发器 metadata['x-aw-require-reply']='true' → 必须回执:
   * 回复含执行结果 + 对方所需内容,in_reply_to 关联原消息,require-reply='false'(不再需要响应)。
   * 无触发器 → 不回复(信息性消息)。
   */
  private async* peerScript(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    const fromId = request.fromAgentId
    if (!fromId) return
    const requireReply = request.message.metadata?.['x-aw-require-reply'] === 'true'
    yield { kind: 'status', status: { state: 'WORKING', timestamp: new Date().toISOString() } }
    if (requireReply) {
      const text = request.message.parts
        .map(p => ('text' in p ? p.text : 'data' in p ? JSON.stringify(p.data) : ''))
        .join('\n')
      await ctx.workspace.sendMessage({
        toAgentId: fromId,
        parts: [{ text: `mock 回复(${ctx.agentId}):已处理「${text.slice(0, 60)}」。执行结果:完成;你所需的内容已包含在本回复中。本回复不需要再响应。` }],
        metadata: {
          'x-aw-in-reply-to': request.message.messageId,
          'x-aw-require-reply': 'false',
        },
      })
    }
    yield { kind: 'done' }
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

  /** 从本轮空闲池选最优 worker 并消费(队列最短优先,空闲最久次之) */
  private pickWorker(
    pool: SupervisionSnapshot['members'],
    now: number,
    exclude?: string,
  ): SupervisionSnapshot['members'][number] | undefined {
    const idx = pool.findIndex(w => w.agentId !== exclude)
    if (idx < 0) return undefined
    let best = idx
    for (let i = idx + 1; i < pool.length; i++) {
      const a = pool[i]!
      const b = pool[best]!
      const byQueue = (a.queued ?? 0) - (b.queued ?? 0)
      const byIdle = (this.idleSince.get(a.agentId) ?? now) - (this.idleSince.get(b.agentId) ?? now)
      if (byQueue < 0 || (byQueue === 0 && byIdle < 0)) best = i
    }
    return pool.splice(best, 1)[0]
  }
}
