/**
 * ManagerTasks —— 任务作业面:提交/派发/验收/队列/HITL
 * (分层 15/19,承 ManagerChannelTemplates)
 */
import { ManagerChannelTemplates } from './13-channel-templates'
import type { A2AArtifact, Part } from '../../types/a2a'
import type { AgentStatusView, AgentTaskQueueView, WorkspaceTask } from '../../types/task'
import type { ExecutionMode } from '../../agents/agent-interface'
import type { ModeConfig } from '../execution-mode'
import type { TaskPatch } from '../../db/task.repo'
import { AppError } from '../../../../utils/errors'
import { TERMINAL_TASK_STATES } from '../../types/task'
import { assertHarnessUsable } from '../../agents/harness-availability'
import { buildMessage, rowToTask } from './helpers'
import { encodeTaskMode, isGoalSummaryArtifact } from '../execution-mode'
import { parseJson } from '../../db/database'
import { randomUUID } from 'node:crypto'

export abstract class ManagerTasks extends ManagerChannelTemplates {
  /**
   * 人类向 channel 提交任务(HITL 控制面入口):
   *  - 缺省 assigneeId → 自动路由 lead(原行为);
   *  - 指定 assigneeId(Composer @ 某成员)→ 直发该成员:任务 create→ASSIGNED,
   *    assign 消息直投其信箱(不经 lead 调度,人类即此刻的调度者);
   *  - fromLabel(登录用户名)盖章 x-aw-from-label → 时间线以"用户章"渲染发送者。
   */
  async submitChannelTask(input: {
    channelId: string
    title: string
    description?: string
    parts?: Part[]
    mode?: ExecutionMode
    modeConfig?: ModeConfig
    /** HITL 直发目标(缺省 lead);须为本 channel 启用成员 */
    assigneeId?: string
    /** 人类发送者显示名(时间线归属) */
    fromLabel?: string
  }): Promise<WorkspaceTask> {
    const channel = this.deps.repos.channels.findById(input.channelId)
    if (!channel || !channel.leadAgentId) {
      throw new AppError(400, 'NO_LEAD_AGENT', `channel ${input.channelId} 无 lead,请先创建 lead`)
    }
    if (channel.enabled !== 1) {
      throw new AppError(403, 'CHANNEL_DISABLED', `channel ${input.channelId} 已禁用`)
    }
    this.ensureChannelActive(input.channelId)
    // 入口幂等(数据状态驱动):同 channel 同标题且**非终态**的任务已存在 → 409。
    // 挡住 HITL 双击/客户端重试造成的重复执行;前一轮已 COMPLETED 的 loop 重放
    // (LoopController → 本方法)不受影响 —— 终态不参与判定
    const duplicate = this.getTaskEngine().list(input.channelId).find(t =>
      t.title === input.title
      && t.state !== 'COMPLETED' && t.state !== 'FAILED' && t.state !== 'CANCELED')
    if (duplicate) {
      throw new AppError(409, 'TASK_DUPLICATE', `同标题任务已在途:「${input.title}」(${duplicate.id.slice(0, 8)},${duplicate.state}),请等待其完成或取消后再提交`)
    }
    // HITL 直发目标校验 + 容错寻址(id/名字/唯一前缀;人类输入名字即可直发)
    let assigneeId = channel.leadAgentId
    if (input.assigneeId && input.assigneeId !== channel.leadAgentId) {
      assigneeId = this.resolveMemberRef(input.channelId, input.assigneeId).id
    }
    // 任务执行前强校验:收件引擎不可用直接 409(不留「已创建即失败」的幽灵任务)
    const assigneeRow = this.deps.repos.channelAgents.findByChannelAgent(input.channelId, assigneeId)
    if (assigneeRow) assertHarnessUsable(assigneeRow.harness, parseJson<Record<string, unknown>>(assigneeRow.configJson, {}))
    const description = input.mode
      ? encodeTaskMode(input.mode, input.modeConfig ?? {}, input.description ?? '')
      : input.description
    let task = this.getTaskEngine().create({
      channelId: input.channelId,
      creatorId: '',
      assigneeId,
      title: input.title,
      description,
      parts: input.parts,
    })
    // 直发 worker:补 ASSIGNED 迁移(与 dispatchTask 独立任务同构,worker 消费循环按 assign 起回合)
    if (assigneeId !== channel.leadAgentId) {
      task = this.getTaskEngine().transition(task.id, 'ASSIGNED', 'system')
    }
    const messageMetadata: Record<string, unknown> = {
      'x-aw-task-kind': 'assign',
      'x-aw-task-id': task.id,
    }
    if (input.fromLabel) messageMetadata['x-aw-from-label'] = input.fromLabel
    const message = buildMessage(input.channelId, 'ROLE_USER', input.parts ?? [], messageMetadata)
    message.taskId = task.id
    const delivered = this.route(input.channelId, message)
    if (!delivered.includes(assigneeId)) {
      // 投递失败补偿:任务回收终态(不留幽灵任务,用户重试不再累积重复任务)
      this.getTaskEngine().transition(task.id, 'CANCELED', 'system')
      throw new AppError(502, 'DELIVERY_FAILED', `任务指派未能投递到 ${assigneeId.slice(0, 8)} 的信箱,请重试`)
    }
    if (assigneeId !== channel.leadAgentId) this.wakeAgent(input.channelId, assigneeId)
    this.ensureChannelRuntime(input.channelId).wakeScheduler()
    return task
  }

  async dispatchTask(
    channelId: string,
    callerAgentId: string,
    input: {
      parentTaskId?: string
      assigneeId: string
      title: string
      description?: string
      parts?: Part[]
      routeReason?: string
    },
  ): Promise<WorkspaceTask> {
    const caller = this.requireMember(channelId, callerAgentId)
    if (caller.role !== 'lead') {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可 dispatch 任务')
    }
    const assignee = this.deps.repos.channelAgents.findByChannelAgent(channelId, input.assigneeId)
    if (!assignee) {
      throw new AppError(403, 'SCOPE_VIOLATION', 'assignee 不在本 channel')
    }
    // 执行前强校验:worker 引擎未安装 → 报错回 lead(可改派),不产生必败子任务
    assertHarnessUsable(assignee.harness, parseJson<Record<string, unknown>>(assignee.configJson, {}))
    let task: WorkspaceTask
    if (input.parentTaskId) {
      const parent = this.getTaskEngine().get(input.parentTaskId)
      if (!parent) throw new AppError(404, 'NOT_FOUND', `父任务不存在: ${input.parentTaskId}`)
      if (parent.channelId !== channelId) {
        throw new AppError(403, 'SCOPE_VIOLATION', '父任务不在本 channel')
      }
      // 防重复派发守卫(确定性,不依赖 LLM 纪律):同父任务下同标题子任务
      //  - 在途(非终态)→ 拒绝,告知等待现有执行(省 token 不重跑)
      //  - 已完成且有交付 → 拒绝,直接附上既有成果预览(lead 可引用,不必重做)
      const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
      const siblings = this.getTaskEngine().list(channelId).filter(t => t.parentId === input.parentTaskId)
      const dupTitle = (t: WorkspaceTask): boolean => norm(t.title) === norm(input.title)
      const inFlight = siblings.find(t => dupTitle(t) && !['COMPLETED', 'CANCELED', 'FAILED'].includes(t.state))
      if (inFlight) {
        throw new AppError(409, 'DUPLICATE_DISPATCH', `子任务 "${input.title}" 已在执行中(状态 ${inFlight.state},指派 ${inFlight.assigneeId?.slice(0, 8) ?? '?'})。不要重复派发——等待其完成;若内容有差异请换一个能区分意图的标题。`)
      }
      const done = siblings.find(t => dupTitle(t) && t.state === 'COMPLETED' && t.artifacts.length > 0)
      if (done) {
        const preview = done.artifacts[0]?.parts
          ?.map(p => ('text' in p ? p.text : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300) ?? ''
        throw new AppError(409, 'DUPLICATE_DISPATCH', `子任务 "${input.title}" 已完成并交付(任务 ${done.id})。已有成果:${preview || '(见任务详情)'}。直接引用该成果即可,不要重复派发相同工作。`)
      }
      // 父任务接取:dispatch 的合法前置状态是 WORKING/WAITING。
      //  - 人类任务入口提交的根任务初态 ASSIGNED,由运行时消费 assign 投递时接取 → WORKING;
      //  - lead 经 submit_task 登记的根任务**不投递 assign**(自我唤醒只会空转),初态停在 SUBMITTED,
      //    由调度器按"lead 名下未规划根任务"请 lead 继续。
      // 于是 lead 在同一回合里 submit_task → dispatch_task 时父任务仍是 SUBMITTED,
      // 旧实现会走到 TaskEngine.dispatch 的后半段才 transition(WAITING):
      // 非法迁移 SUBMITTED → WAITING 抛出,而**子任务此时已落库**(dispatch 先建子后迁父),
      // 留下"SUBMITTED 父任务下挂孤儿子任务"的脏状态,子任务也永远不会被验收。
      // 与 SchedulerLoop.execute('dispatch') 的 SUBMITTED → WORKING 保持同一口径:
      // 由 lead 先接取父任务,再分解。此处前置校验,后续 dispatch 不再可能抛迁移异常。
      // 终态父任务先拒(任何副作用之前):COMPLETED/CANCELED 没有出边,FAILED 只能 → ASSIGNED,
      // 三者都到不了 WAITING —— 若不先拒,dispatch 会先建子任务再抛迁移异常,同样留下孤儿。
      if (parent.state === 'COMPLETED' || parent.state === 'CANCELED' || parent.state === 'FAILED') {
        const why = parent.state === 'COMPLETED' ? '已完成' : parent.state === 'CANCELED' ? '已取消' : '已判失败'
        throw new AppError(409, 'TASK_TERMINAL',
          `父任务 ${parent.id.slice(0, 8)} ${why},无法再派发子任务(状态机无 WAITING 出边);`
          + (parent.state === 'FAILED' ? '请先 reassign_task 重试,或另起根任务' : '请另起一个根任务'),
        )
      }
      const dispatchParent = parent.state === 'SUBMITTED' || parent.state === 'ASSIGNED'
        ? this.getTaskEngine().transition(parent.id, 'WORKING', callerAgentId)
        : parent
      task = this.getTaskEngine().dispatch(dispatchParent, {
        assigneeId: input.assigneeId,
        title: input.title,
        description: input.description,
        parts: input.parts,
        routeReason: input.routeReason,
      })
      this.wakeAgent(channelId, input.assigneeId)
    }
    else {
      task = this.getTaskEngine().create({
        channelId,
        creatorId: callerAgentId,
        assigneeId: input.assigneeId,
        title: input.title,
        description: input.description,
        parts: input.parts,
      })
      task = this.getTaskEngine().transition(task.id, 'ASSIGNED', callerAgentId)
      const message = buildMessage(channelId, 'ROLE_USER', input.parts ?? [], {
        'x-aw-task-kind': 'assign',
        'x-aw-task-id': task.id,
        'x-aw-from-agent': callerAgentId,
      })
      message.taskId = task.id
      const delivered = this.route(channelId, message)
      if (!delivered.includes(input.assigneeId)) {
        // 投递失败补偿:子任务回收终态(父任务等全部子任务终态后由调度器重新决策)
        this.getTaskEngine().transition(task.id, 'CANCELED', callerAgentId)
        throw new AppError(502, 'DELIVERY_FAILED', `子任务指派未能投递到 ${input.assigneeId.slice(0, 8)} 的信箱,请重试或改派`)
      }
    }
    return task
  }

  /**
   * 任务拒绝(assignee 认为任务超出自己能力/作业范畴时主动退回):
   *  - 任务置 FAILED(调度器将按重试规则改派他人,而非本 Agent 硬扛或静默搁置);
   *  - 回执拒绝通知:优先发任务创建者(本 channel 成员),否则 channel lead ——
   *    有发送人就必须让对方知道"为什么被拒",防止错发任务石沉大海。
   */
  async refuseTask(
    channelId: string,
    refuserId: string,
    taskId: string,
    reason: string,
  ): Promise<{ task: WorkspaceTask, notifiedTo: string | null }> {
    this.requireMember(channelId, refuserId)
    const engine = this.getTaskEngine()
    const task = engine.get(taskId)
    if (!task || task.channelId !== channelId) {
      throw new AppError(404, 'NOT_FOUND', `任务不存在或不在本 channel: ${taskId}`)
    }
    if (task.assigneeId !== refuserId) {
      throw new AppError(403, 'SCOPE_VIOLATION', `只能拒绝指派给自己的任务(assignee=${task.assigneeId.slice(0, 8)})`)
    }
    if (task.state === 'WAITING') {
      throw new AppError(400, 'INVALID_TRANSITION', 'WAITING 父任务(有子任务/阶段在执行)不可整体拒绝;请拒绝对应的子任务,父任务会按子任务结果汇总')
    }
    const trimmedReason = reason.trim()
    if (!trimmedReason) throw new AppError(400, 'BAD_REQUEST', '拒绝必须说明原因(reason)')

    let current = task
    if (!TERMINAL_TASK_STATES[current.state]) {
      // 状态机需经 WORKING 到 FAILED(SUBMITTED/ASSIGNED 直达 FAILED 非法)
      if (current.state === 'SUBMITTED' || current.state === 'ASSIGNED') {
        current = engine.transition(taskId, 'WORKING', refuserId)
      }
      if (current.state !== 'FAILED') {
        current = engine.transition(taskId, 'FAILED', refuserId)
      }
      // 拒绝理由进任务历史(审计留痕)
      this.deps.repos.tasks.update(taskId, {
        history: [...current.history, {
          messageId: randomUUID(),
          contextId: channelId,
          role: 'ROLE_AGENT' as const,
          parts: [{ text: `[任务拒绝] ${refuserId.slice(0, 8)}:${trimmedReason}` }],
        }],
      })
    }

    // 回执对象:任务创建者(仍为本 channel 在册成员)优先,fallback channel lead
    const members = this.deps.repos.channelAgents.listByChannel(channelId).filter(m => m.enabled === 1)
    const notifyTo = members.find(m => m.id === task.creatorId)?.id
      ?? members.find(m => m.role === 'lead')?.id
      ?? null
    if (notifyTo && notifyTo !== refuserId) {
      const message = buildMessage(channelId, 'ROLE_AGENT', [{
        text: `【任务拒绝回执】任务「${task.title}」(${taskId.slice(0, 8)}) 已被 ${refuserId.slice(0, 8)} 拒绝。原因:${trimmedReason}。请改派给能力匹配的成员,或取消该任务。`,
      }], {
        'x-aw-target-agent': notifyTo,
        'x-aw-from-agent': refuserId,
        'x-aw-msg-priority': 'immediate',
      })
      const delivered = this.route(channelId, message)
      return { task: engine.get(taskId) ?? current, notifiedTo: delivered.includes(notifyTo) ? notifyTo : null }
    }
    return { task: engine.get(taskId) ?? current, notifiedTo: null }
  }

  async reportTask(
    channelId: string,
    callerAgentId: string,
    input: { taskId: string, progress?: number, artifact?: A2AArtifact, message?: string },
  ): Promise<WorkspaceTask> {
    const task = this.requireTaskInScope(channelId, callerAgentId, input.taskId)
    if (task.assigneeId !== callerAgentId) {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 assignee 可上报任务')
    }
    // 终态设防:进度/交付物/历史是任务活性信号,终态任务(COMPLETED/FAILED/CANCELED)
    // 不得再写 —— 否则状态数据被污染(如 cancel 后迟到回合继续长出"新进度"),
    // 破坏"所有执行都标记 state"的数据状态驱动不变量
    if (task.state === 'COMPLETED' || task.state === 'FAILED' || task.state === 'CANCELED') {
      return task
    }
    const patch: TaskPatch = {}
    if (input.progress !== undefined) patch.progress = input.progress
    if (input.artifact) patch.artifacts = [...task.artifacts, input.artifact]
    if (input.message) {
      patch.history = [
        ...task.history,
        { messageId: randomUUID(), contextId: task.channelId, role: 'ROLE_AGENT' as const, parts: [{ text: input.message }] },
      ].slice(-200)
    }
    const updated = this.deps.repos.tasks.update(input.taskId, patch)
    const next = rowToTask(updated!)
    this.notifyTask(task.channelId, { taskId: task.id, progress: next.progress, agentId: callerAgentId })
    return next
  }

  async completeTask(
    channelId: string,
    callerAgentId: string,
    input: { taskId: string, artifacts?: A2AArtifact[] },
  ): Promise<WorkspaceTask> {
    const task = this.requireTaskInScope(channelId, callerAgentId, input.taskId)
    if (task.assigneeId !== callerAgentId) {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 assignee 可完成任务')
    }
    // 终态幂等:已完成 → 原样返回(重复 complete 不炸);
    // 已取消/失败 → 语义化错误(非裸状态机异常),调用方可据此引导继续下一项
    if (task.state === 'COMPLETED') return task
    if (task.state === 'CANCELED' || task.state === 'FAILED') {
      throw new AppError(409, 'TASK_TERMINAL', `任务 ${input.taskId.slice(0, 8)} 已被平台${task.state === 'CANCELED' ? '取消' : '判定失败'},不能再标记完成;请继续处理队列下一项`)
    }
    const completed = this.getTaskEngine().complete(input.taskId, input.artifacts)
    // goal 保底合成产物广播(goal 模式父任务且 lead 未自带总结时,taskEngine 追加了
    // 平台合成的 goal-summary;以 goal-summary 语义 + artifactId 差集识别,幂等不重复广播)
    const knownIds = new Set([
      ...task.artifacts.map(a => a.artifactId),
      ...(input.artifacts ?? []).map(a => a.artifactId),
    ])
    for (const artifact of completed.artifacts) {
      if (isGoalSummaryArtifact(artifact) && !knownIds.has(artifact.artifactId)) {
        this.runtimeOf(channelId, callerAgentId)?.emitExternal({ kind: 'artifact', artifact }, callerAgentId)
      }
    }
    if (completed.parentId) {
      this.getTaskEngine().onChildCompleted(completed)
      const parent = this.getTaskEngine().get(completed.parentId)
      if (parent) this.wakeAgent(completed.channelId, parent.assigneeId)
    }
    return completed
  }

  async cancelTask(
    channelId: string,
    callerAgentId: string,
    input: { taskId: string },
  ): Promise<WorkspaceTask> {
    const task = this.requireTaskInScope(channelId, callerAgentId, input.taskId)
    const caller = this.requireMember(channelId, callerAgentId)
    const isLead = caller.role === 'lead'
    const isCreator = task.creatorId === callerAgentId
    if (!isLead && !isCreator) {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead/creator 可取消任务')
    }
    const canceled = this.getTaskEngine().cancel(input.taskId, callerAgentId)
    this.runtimeOf(channelId, canceled.assigneeId)?.abortCurrent()
    this.wakeAgent(channelId, canceled.assigneeId)
    return canceled
  }

  /**
   * HITL:前端独立中断指定成员运行时(worker 或 lead)。
   *  - worker:强制 stop + detach(中断当前 run/杀子进程),成员行保留 enabled=1,
   *    后续任务投递按需重新装配(interrupt 语义,不删成员)。
   *  - lead:stopAndDetach 内部同时停 SchedulerLoop;channel 恢复活跃由
   *    下次任务提交(ensureChannelActive)自动重装配 lead + 调度器。
   * 变更经 AEP agent.member(op=updated) 广播回流前端。
   */
  async stopAgentRuntime(channelId: string, agentId: string, by = 'user'): Promise<{ agentId: string, stopped: boolean }> {
    const m = this.deps.repos.channelAgents.findByChannelAgent(channelId, agentId)
    if (!m) throw new AppError(404, 'NOT_FOUND', `成员不存在: ${agentId}`)
    await this.stopAndDetach(channelId, agentId)
    this.notifyMember(channelId, {
      op: 'updated',
      agentId,
      name: m.name,
      role: m.role as 'lead' | 'worker',
      harness: m.harness,
      enabled: m.enabled,
      by,
      reason: 'HITL stop',
    })
    return { agentId, stopped: true }
  }

  /**
   * HITL:用户重试 FAILED 任务(lead/worker 任务均可)。
   * 优先原 assignee(仍在本 channel 且启用),否则选队列最短的空闲 worker;
   * 无可用承接者 → 400 NO_WORKER。重试后经调度循环重新投递执行。
   */
  async retryTask(channelId: string, callerAgentId: string, taskId: string): Promise<WorkspaceTask> {
    const task = this.requireTaskInScope(channelId, callerAgentId, taskId)
    if (task.state !== 'FAILED') {
      throw new AppError(400, 'INVALID_STATE', `仅 FAILED 任务可重试(当前 ${task.state})`)
    }
    let target = this.deps.repos.channelAgents.findByChannelAgent(channelId, task.assigneeId)
    if (!target || target.enabled !== 1) {
      const receiver = this.pickReceiverWorker(channelId, '')
      if (!receiver) throw new AppError(400, 'NO_WORKER', '无可用 worker 承接重试任务')
      target = this.deps.repos.channelAgents.findByChannelAgent(channelId, receiver)!
    }
    const updated = this.getTaskEngine().reassign(taskId, target.id)
    this.wakeAgent(channelId, target.id)
    return updated
  }

  async listTasks(channelId: string, callerAgentId: string): Promise<WorkspaceTask[]> {
    this.requireMember(channelId, callerAgentId)
    return this.deps.repos.tasks.listByChannel(channelId).map(rowToTask)
  }

  async getTask(channelId: string, callerAgentId: string, taskId: string): Promise<WorkspaceTask> {
    return this.requireTaskInScope(channelId, callerAgentId, taskId)
  }

  /** 自己的任务队列视图(待执行 FIFO / 执行中 / 已完成)——每个 agent 的任务管理系统入口 */
  async myQueue(channelId: string, callerAgentId: string): Promise<AgentTaskQueueView> {
    this.requireMember(channelId, callerAgentId)
    return this.getTaskEngine().queueViewOf(channelId, callerAgentId)
  }

  /** 全员实时状态 + 队列总览(lead 统一调度/最优调配的观察面) */
  async queueOverview(channelId: string, callerAgentId: string): Promise<AgentStatusView[]> {
    this.requireMember(channelId, callerAgentId)
    const cr = this.channels.get(channelId)
    const wired = new Map((cr?.getAgents() ?? []).map(a => [a.agentId, a]))
    return this.deps.repos.channelAgents.listByChannel(channelId)
      .filter(m => m.enabled === 1)
      .map((m) => {
        const runtime = wired.get(m.id)
        if (runtime) return runtime.getStatus()
        // 未装配(懒加载)成员:状态按 idle,队列视图仍来自 tasks 表
        const view = this.getTaskEngine().queueViewOf(channelId, m.id)
        return {
          agentId: m.id,
          channelId,
          role: m.role as 'lead' | 'worker',
          name: m.name,
          state: 'idle' as const,
          currentTaskId: view.current?.id ?? null,
          currentTaskTitle: view.current?.title ?? null,
          currentTaskProgress: view.current?.progress != null ? view.current.progress : null,
          queuedCount: view.queued.length,
          completedCount: view.completed.length,
        }
      })
  }

  /** 修改待执行任务(lead 对 worker 队列的"改";仅待执行态可改)+ 唤醒 assignee 消费新投递 */
  async updateTask(
    channelId: string,
    callerAgentId: string,
    taskId: string,
    patch: { title?: string, description?: string },
  ): Promise<WorkspaceTask> {
    const task = this.requireTaskInScope(channelId, callerAgentId, taskId)
    const caller = this.requireMember(channelId, callerAgentId)
    if (caller.role !== 'lead' && task.creatorId !== callerAgentId) {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead/创建者可修改任务')
    }
    const updated = this.getTaskEngine().updateTask(taskId, patch, callerAgentId)
    this.wakeAgent(channelId, updated.assigneeId)
    return updated
  }

  /** 重新指派(lead 的"调配":待执行/失败任务迁移到其他 worker)+ 唤醒新 assignee */
  async reassignTask(
    channelId: string,
    callerAgentId: string,
    taskId: string,
    toAgentId: string,
  ): Promise<WorkspaceTask> {
    this.requireTaskInScope(channelId, callerAgentId, taskId) // 校验任务在调用方作用域内
    const caller = this.requireMember(channelId, callerAgentId)
    if (caller.role !== 'lead') {
      throw new AppError(403, 'SCOPE_VIOLATION', '仅 lead 可调配任务')
    }
    const target = this.resolveMemberRef(channelId, toAgentId)
    const updated = this.getTaskEngine().reassign(taskId, target.id)
    this.wakeAgent(channelId, target.id)
    return updated
  }
}
