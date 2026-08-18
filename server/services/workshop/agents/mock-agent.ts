/**
 * MockAgentImpl — harness 无关的 mock 实现(联调/测试用)。
 * worker run 剧本:assign 消息 → status(WORKING) → 按 delayMs 上报 25/50/75 → artifact → completeTask → done。
 * lead supervise 剧本(模式感知,与真实 LLM lead 提示词同构):
 *  - goal:     SUBMITTED 且 assignee 自己 → dispatch 给最久空闲 worker;子任务全完成 →
 *              lead 判定目标是否满足;不满足(goalRejectRounds 次)→ 补充分发新子任务;
 *              满足 → complete 父任务。
 *  - loop:     默认剧本(完成即 complete 父);循环重放由 SchedulerLoop 的 LoopController 接管。
 *  - pipeline: 按 [stages:a->b->c] 严格顺序分阶段分发,阶段 N 完成前不启动 N+1;
 *              全部阶段完成后 complete 父任务,随后 idle(不判定 goal、不重放)。
 *  - 默认:     分发 → 子任务全完成 → complete 父。
 * 失败处理:FAILED → reassign(模式无关)。
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
import type { WorkspaceTask } from '../types/task'
import { extractTaskMode } from '../runtime/execution-mode'

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

  /** goal 模式:判定"目标不满足"的次数(lead 补充分发该次数后才接受并 complete;0 表示首次即接受) */
  private readonly goalRejectRounds: number

  /** goal 模式:父任务已完成的不满足判定轮次(lead 判断状态记忆) */
  private readonly goalJudged = new Map<string, number>()

  /** 场景系统提示词前缀(由 config.systemPromptPrefix 注入;mock 以状态消息透出以便验证链路) */
  private readonly systemPromptPrefix: string

  constructor(config: Record<string, unknown> = {}) {
    this.delayMs = typeof config.delayMs === 'number' ? config.delayMs : 300
    this.streamDemo = config.streamDemo === true
    this.teamOps = Array.isArray(config.teamOps) ? config.teamOps as MemberOp[] : []
    this.goalRejectRounds = typeof config.goalRejectRounds === 'number' && config.goalRejectRounds >= 0
      ? Math.floor(config.goalRejectRounds)
      : 0
    this.systemPromptPrefix = typeof config.systemPromptPrefix === 'string' ? config.systemPromptPrefix : ''
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

  /** lead 调度决策:观察快照 → 返回决策(模式感知;goal/pipeline 专属剧本,loop/默认共用剧本) */
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

    // 模式感知调度:只处理 assignee 自己的任务(lead 名下的主任务)
    for (const task of snapshot.tasks) {
      if (task.assigneeId !== ctx.agentId) continue
      const modeInfo = extractTaskMode(task)
      if (modeInfo?.mode === 'goal') {
        this.goalScript(task, snapshot, pool, now, decisions)
      }
      else if (modeInfo?.mode === 'pipeline') {
        this.pipelineScript(task, snapshot, pool, now, decisions)
      }
      else {
        // loop 与无模式:分发 → 子任务全完成 → complete 父;loop 的循环重放由 LoopController 接管
        this.defaultScript(task, snapshot, pool, now, decisions)
      }
    }

    // FAILED 且重试次数 < 3 → reassign 给空闲 worker(模式无关)
    for (const task of snapshot.tasks) {
      if (task.state === 'FAILED' && task.retryCount < 3) {
        const worker = this.pickWorker(pool, now, task.assigneeId)
        if (worker) {
          decisions.push({ kind: 'reassign', taskId: task.id, toAgentId: worker.agentId })
        }
      }
    }

    return decisions
  }

  /**
   * goal 剧本:子任务全完成 → lead 判定目标是否满足。
   * 不满足(判定轮次未达 goalRejectRounds)→ 补充分发新子任务;
   * 满足 → complete 父任务。判定是确定性的(goalRejectRounds 次否决后接受)。
   */
  private goalScript(
    task: WorkspaceTask,
    snapshot: SupervisionSnapshot,
    pool: SupervisionSnapshot['members'],
    now: number,
    decisions: SupervisionDecision[],
  ): void {
    const children = snapshot.tasks.filter(t => t.parentId === task.id)
    if ((task.state === 'SUBMITTED' || task.state === 'WORKING') && children.length === 0) {
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
      return
    }
    if ((task.state !== 'WAITING' && task.state !== 'WORKING') || children.length === 0) return
    // 有子任务在跑(或失败走 FAILED 重试路径)→ 不判定
    if (!children.every(c => c.state === 'COMPLETED')) return

    const judged = this.goalJudged.get(task.id) ?? 0
    if (judged < this.goalRejectRounds) {
      this.goalJudged.set(task.id, judged + 1)
      const worker = this.pickWorker(pool, now)
      if (worker) {
        const criteria = extractTaskMode(task)?.config.goalCriteria ?? '任务描述中的需求'
        decisions.push({
          kind: 'dispatch',
          parentTaskId: task.id,
          assigneeId: worker.agentId,
          title: `${task.title} - 目标补充第 ${judged + 1} 轮`,
          description: `[goal 缺口补充] 评审结论:目标尚未满足(标准:${criteria})。请基于既有成果继续补齐。`,
        })
      }
      return
    }
    this.goalJudged.delete(task.id)
    // 目标满足判定后必须产出总结性输出(goal-summary),lead 的"收口"交付物
    const criteria = extractTaskMode(task)?.config.goalCriteria ?? '任务描述中的需求'
    decisions.push({ kind: 'complete', taskId: task.id, artifacts: [this.goalSummary(task, children, criteria)] })
  }

  /**
   * pipeline 剧本:按 [stages:...] 严格顺序分阶段分发。
   * 阶段 N 完成前不启动 N+1;全部阶段完成 → complete 父任务,随后 idle(不判定 goal、不重放)。
   * 无阶段定义时退化为默认剧本(单次分发 → 完成 → idle)。
   */
  private pipelineScript(
    task: WorkspaceTask,
    snapshot: SupervisionSnapshot,
    pool: SupervisionSnapshot['members'],
    now: number,
    decisions: SupervisionDecision[],
  ): void {
    if (task.state !== 'SUBMITTED' && task.state !== 'WORKING' && task.state !== 'WAITING') return
    const children = snapshot.tasks.filter(t => t.parentId === task.id)
    // 有阶段在执行中 → 等待,不推进
    if (children.some(c => !TERMINAL.has(c.state))) return

    const stages = extractTaskMode(task)?.config.stages ?? []
    const allCompleted = children.length > 0 && children.every(c => c.state === 'COMPLETED')

    if (stages.length === 0) {
      if (children.length === 0) {
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
      else if (allCompleted) {
        decisions.push({ kind: 'complete', taskId: task.id, artifacts: [this.summarize(task, children)] })
      }
      return
    }

    if (children.length === 0) {
      const stage = stages[0]!
      const worker = this.pickWorker(pool, now)
      if (worker) {
        decisions.push({
          kind: 'dispatch',
          parentTaskId: task.id,
          assigneeId: worker.agentId,
          title: `Stage 1: ${stage.name}`,
          description: `[pipeline 阶段 1/${stages.length}] ${stage.description || stage.name}`,
        })
      }
      return
    }
    // 有失败子任务 → FAILED 重试路径接管,不推进阶段
    if (!allCompleted) return
    if (children.length >= stages.length) {
      // 所有阶段完成 → 汇总交付,之后 idle
      decisions.push({ kind: 'complete', taskId: task.id, artifacts: [this.summarize(task, children)] })
      return
    }
    // 顺序执行保证:children 全完成且按序创建 → children.length 即已完成阶段数
    const next = stages[children.length]!
    const prevParts = children.flatMap(c => c.artifacts.flatMap(a => a.parts))
    const worker = this.pickWorker(pool, now)
    if (worker) {
      decisions.push({
        kind: 'dispatch',
        parentTaskId: task.id,
        assigneeId: worker.agentId,
        title: `Stage ${children.length + 1}: ${next.name}`,
        description: `[pipeline 阶段 ${children.length + 1}/${stages.length}] ${next.description || next.name}`,
        parts: prevParts.length > 0
          ? [{ text: `上一阶段成果:\n${prevParts.filter(p => 'text' in p).map(p => p.text).join('\n')}` }]
          : undefined,
      })
    }
  }

  /** 默认剧本(loop 与无模式):分发 → 子任务全完成 → complete 父 */
  private defaultScript(
    task: WorkspaceTask,
    snapshot: SupervisionSnapshot,
    pool: SupervisionSnapshot['members'],
    now: number,
    decisions: SupervisionDecision[],
  ): void {
    const children = snapshot.tasks.filter(t => t.parentId === task.id)
    if ((task.state === 'SUBMITTED' || task.state === 'WORKING') && children.length === 0) {
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
    if (children.length > 0
      && (task.state === 'WAITING' || task.state === 'WORKING')
      && children.every(c => c.state === 'COMPLETED')) {
      decisions.push({ kind: 'complete', taskId: task.id, artifacts: [this.summarize(task, children)] })
    }
  }

  /** 汇总子任务成果为父任务 artifact(lead 交付物):展开各子任务 artifact 的 parts */
  private summarize(task: WorkspaceTask, children: SupervisionSnapshot['tasks']): A2AArtifact {
    return {
      artifactId: randomUUID(),
      name: 'summary',
      parts: [
        ...children.flatMap(c => c.artifacts.flatMap(a => a.parts)),
        { text: `汇总:${children.map(c => c.title).join(' + ')}` },
      ],
    }
  }

  /**
   * goal 模式收口:lead 判定目标满足后的「总结性输出」——以结论化最终描述作为父任务交付物。
   * 与 omp lead 的 goal prompt 约束同构(mock 是确定性替身):目标/判定标准/完成过程/最终成果/结论。
   */
  private goalSummary(task: WorkspaceTask, children: WorkspaceTask[], criteria: string): A2AArtifact {
    const results = children
      .flatMap(c => c.artifacts.flatMap(a => a.parts))
      .filter((p): p is { text: string } => 'text' in p)
      .map(p => p.text)
    const conclusion = [
      `【目标完成总结】`,
      `目标: ${task.title}`,
      `判定标准: ${criteria}`,
      `完成过程: ${children.map(c => `「${c.title}」`).join(' → ')} 全部完成`,
      `最终成果: ${results.length > 0 ? results.join('; ') : '(无)'}`,
      `结论: 目标已达成,全部任务完成。`,
    ].join('\n')
    return {
      artifactId: randomUUID(),
      name: 'goal-summary',
      parts: [
        { text: conclusion },
        { text: `标准:${criteria}` },
        { text: `子任务:${children.map(c => c.title).join(' + ')}` },
      ],
    }
  }

  /** worker 剧本:assign 消息 → 执行 + 上报进度 + 产出成果 + 完成 */
  private async* workerScript(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    const taskId = request.taskId ?? (request.message.metadata?.['x-aw-task-id'] as string | undefined)
    if (!taskId) return
    // 场景系统提示注入:mock 无 LLM,prompt 以首条状态消息透出(验证 config.systemPromptPrefix 已到达 harness)
    if (this.systemPromptPrefix) {
      yield {
        kind: 'status',
        status: {
          state: 'WORKING',
          message: {
            messageId: `scenario-${randomUUID()}`,
            contextId: ctx.channelId,
            role: 'ROLE_AGENT',
            parts: [{ text: `[场景系统提示已注入]\n${this.systemPromptPrefix}` }],
          },
          timestamp: new Date().toISOString(),
        },
      }
    }
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
