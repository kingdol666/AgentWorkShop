/**
 * ExecutionMode 编排器 — goal / loop / pipeline 三种执行模式的核心调度逻辑。
 *
 * 模式语义:
 *  - goal:     lead 接收目标 → 分解子任务给 worker → worker 完成 → lead 判断是否满足目标;
 *              不满足则继续下发新任务;满足则完成主任务。核心:lead 的满意度判断。
 *  - loop:     lead 按固定间隔(intervalMs)循环执行相同任务;每次循环:dispatch → worker 完成 →
 *              等待 interval → 重新 dispatch。核心:定时循环重放。
 *  - pipeline: lead 将任务分解为有序阶段(stages),每个阶段依赖前一阶段产出;
 *              阶段 N 完成后 lead 将产出传递给阶段 N+1。核心:顺序依赖流。
 *
 * 模式信息存储:任务 metadata['x-aw-exec-mode'] + metadata['x-aw-mode-config']。
 * SchedulerLoop 每轮 tick 时,ModeOrchestrator 根据 channel 当前任务的模式调整 lead 决策 prompt。
 */
import type { SupervisionSnapshot, ExecutionMode } from '../agents/agent-interface'
import type { WorkspaceTask } from '../types/task'

/** 模式配置(存储在任务 metadata['x-aw-mode-config']) */
export interface ModeConfig {
  /** loop: 循环间隔 ms(默认 60000;前端秒输入 ×1000,zod 下限 100) */
  intervalMs?: number
  /** loop: 最大循环次数(默认 Infinity) */
  maxIterations?: number
  /** pipeline: 阶段定义 */
  stages?: PipelineStage[]
  /** goal: 满意度判断提示(注入 lead prompt) */
  goalCriteria?: string
}

/** pipeline 阶段定义 */
export interface PipelineStage {
  name: string
  description: string
  /** 分配给哪个 worker(agentId);省略则自动选空闲 worker */
  assigneeId?: string
}

/** 模式元信息(从任务 metadata 提取) */
export interface TaskModeInfo {
  mode: ExecutionMode
  config: ModeConfig
}

/** 从任务 metadata 提取模式信息 */
export function extractTaskMode(task: WorkspaceTask): TaskModeInfo | null {
  // 尝试从 history(初始 parts)或 description 中提取模式
  // 模式信息存储在 metadata['x-aw-exec-mode'],但 WorkspaceTask 不直接暴露 metadata
  // 这里通过任务 artifacts(初始 input)或 description 前缀来推断
  const desc = task.description ?? ''
  // 约定:description 以 [mode:xxx] 开头
  const match = desc.match(/^\[mode:(goal|loop|pipeline)\]/)
  if (match) {
    const mode = match[1] as ExecutionMode
    const config = parseModeConfig(desc, mode)
    return { mode, config }
  }
  return null
}

/** 从 description 解析模式配置 */
function parseModeConfig(desc: string, mode: ExecutionMode): ModeConfig {
  const config: ModeConfig = {}
  if (mode === 'loop') {
    const intervalMatch = desc.match(/interval[:\s]+(\d+)/i)
    config.intervalMs = intervalMatch ? parseInt(intervalMatch[1]!, 10) : 60_000
    const maxMatch = desc.match(/max[:\s]+(\d+)/i)
    config.maxIterations = maxMatch ? parseInt(maxMatch[1]!, 10) : Number.POSITIVE_INFINITY
  }
  if (mode === 'goal') {
    // goalCriteria 从 description 中 [criteria:...] 提取
    const criteriaMatch = desc.match(/\[criteria:([^\]]+)\]/)
    config.goalCriteria = criteriaMatch?.[1]?.trim()
  }
  return config
}

/** 将模式信息编码到 description 前缀 */
export function encodeTaskMode(mode: ExecutionMode, config: ModeConfig, description: string): string {
  const parts: string[] = [`[mode:${mode}]`]
  if (mode === 'loop') {
    const intervalMs = Math.min(86_400_000, Math.max(100, Math.floor(config.intervalMs ?? 60_000)))
    parts.push(`[interval:${intervalMs}]`)
    if (config.maxIterations !== undefined && config.maxIterations !== Number.POSITIVE_INFINITY) {
      const maxIterations = Math.min(10_000, Math.max(1, Math.floor(config.maxIterations)))
      parts.push(`[max:${maxIterations}]`)
    }
  }
  if (mode === 'goal' && config.goalCriteria) {
    parts.push(`[criteria:${config.goalCriteria}]`)
  }
  if (mode === 'pipeline' && config.stages) {
    parts.push(`[stages:${config.stages.map(s => s.name).join('->')}]`)
  }
  return `${parts.join('')} ${description}`
}

/**
 * 模式感知的 supervise prompt 构建。
 * 根据 channel 当前活跃任务的模式,生成不同的 lead 指令。
 */
export function buildModeAwarePrompt(
  mode: ExecutionMode,
  config: ModeConfig,
  snapshot: SupervisionSnapshot,
  leadAgentId: string,
): string {
  switch (mode) {
    case 'goal':
      return buildGoalPrompt(config, snapshot, leadAgentId)
    case 'loop':
      return buildLoopPrompt(config, snapshot, leadAgentId)
    case 'pipeline':
      return buildPipelinePrompt(config, snapshot, leadAgentId)
    default:
      return ''
  }
}

/** goal 模式 prompt:lead 判断目标是否满足 */
function buildGoalPrompt(config: ModeConfig, snapshot: SupervisionSnapshot, _leadAgentId: string): string {
  const criteria = config.goalCriteria ?? '任务描述中的需求已全部完成'
  const lines: string[] = [
    `## Execution Mode: GOAL`,
    `You are working in GOAL mode. Your objective is to ensure the following goal is fully achieved:`,
    `**Goal Criteria**: ${criteria}`,
    ``,
    `## Decision Process`,
    `1. If there are tasks assigned to you with no children yet: dispatch them to idle workers.`,
    `2. If all child tasks are COMPLETED: evaluate whether the goal criteria are met by examining the artifacts.`,
    `3. If the goal is NOT met: dispatch NEW tasks to address the gaps. Use the task description and artifacts to identify what's missing.`,
    `4. If the goal IS met: call complete_task on the parent task with a summary of what was achieved.`,
    ``,
    `## Current State`,
    formatSnapshotForPrompt(snapshot),
  ]
  return lines.join('\n')
}

/** loop 模式 prompt:lead 循环执行 */
function buildLoopPrompt(config: ModeConfig, snapshot: SupervisionSnapshot, _leadAgentId: string): string {
  const interval = (config.intervalMs ?? 60_000) / 1000
  const lines: string[] = [
    `## Execution Mode: LOOP`,
    `You are working in LOOP mode. The task should be executed repeatedly every ${interval}s.`,
    `Interval: ${interval}s${config.maxIterations !== undefined && config.maxIterations !== Number.POSITIVE_INFINITY ? `, Max iterations: ${config.maxIterations}` : ''}`,
    ``,
    `## Decision Process`,
    `1. If the parent task is COMPLETED: do nothing (the loop controller will re-submit automatically).`,
    `2. If the parent task is SUBMITTED/WORKING with no children: dispatch to an idle worker.`,
    `3. If all children are COMPLETED: complete the parent task.`,
    ``,
    `## Current State`,
    formatSnapshotForPrompt(snapshot),
  ]
  return lines.join('\n')
}

/** pipeline 模式 prompt:lead 按阶段流水线编排 */
function buildPipelinePrompt(config: ModeConfig, snapshot: SupervisionSnapshot, _leadAgentId: string): string {
  const stages = config.stages ?? []
  const stageList = stages.length > 0
    ? stages.map((s, i) => `  Stage ${i + 1}: ${s.name} — ${s.description}`).join('\n')
    : '  (no stages defined — decompose the task into sequential stages yourself)'
  const lines: string[] = [
    `## Execution Mode: PIPELINE`,
    `You are working in PIPELINE mode. The task must be executed as a sequence of stages,`,
    `where each stage depends on the output of the previous stage.`,
    ``,
    `## Pipeline Stages`,
    stageList,
    ``,
    `## Decision Process`,
    `1. Identify which stage should run next (the first incomplete stage with no children).`,
    `2. For the current stage: dispatch a child task to a worker, including the previous stage's output (from artifacts) as context.`,
    `3. Do NOT start stage N+1 until stage N is COMPLETED.`,
    `4. When all stages are COMPLETED: complete the parent task with the final deliverable.`,
    ``,
    `## Current State`,
    formatSnapshotForPrompt(snapshot),
  ]
  return lines.join('\n')
}

/** 格式化快照为 prompt 友好文本 */
function formatSnapshotForPrompt(snapshot: SupervisionSnapshot): string {
  const members = snapshot.members.map(m =>
    `  - ${m.agentId} (${m.name}, ${m.role}, ${m.state})`,
  ).join('\n')
  const tasks = snapshot.tasks.map((t) => {
    const artifacts = t.artifacts.length > 0 ? `, artifacts=${t.artifacts.length}` : ''
    return `  - ${t.id} [${t.state}] "${t.title}" assignee=${t.assigneeId}, progress=${t.progress}%${artifacts}`
  }).join('\n')
  return `### Team\n${members || '  (none)'}\n\n### Tasks\n${tasks || '  (none)'}`
}

/**
 * Loop 控制器:管理 loop 模式的循环重放。
 * 当主任务完成后,在 intervalMs 后重新创建相同任务。
 */
export class LoopController {
  private iterations = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private active = true

  constructor(
    private readonly channelId: string,
    private readonly taskTitle: string,
    private readonly taskDescription: string,
    private readonly intervalMs: number,
    private readonly maxIterations: number,
    private readonly onResubmit: (title: string, description: string) => void,
  ) {}

  /** 主任务完成时调用:启动下一轮倒计时 */
  onTaskCompleted(): void {
    this.iterations += 1
    if (this.iterations >= this.maxIterations || !this.active) return
    this.timer = setTimeout(() => {
      if (!this.active) return
      this.onResubmit(this.taskTitle, this.taskDescription)
    }, this.intervalMs)
  }

  /** 停止循环 */
  stop(): void {
    this.active = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /** 是否已达到最大迭代次数或已停止 */
  get exhausted(): boolean {
    return !this.active || this.iterations >= this.maxIterations
  }

  get currentIteration(): number {
    return this.iterations
  }
}

/**
 * 检查 channel 中是否有处于特定模式的活跃任务。
 * 返回第一个匹配的任务(通常 channel 同时只跑一个模式)。
 */
export function findModeTask(
  tasks: WorkspaceTask[],
  leadAgentId: string,
): { task: WorkspaceTask, mode: ExecutionMode, config: ModeConfig } | null {
  for (const task of tasks) {
    if (task.assigneeId !== leadAgentId) continue
    if (task.state === 'COMPLETED' || task.state === 'CANCELED' || task.state === 'FAILED') continue
    const modeInfo = extractTaskMode(task)
    if (modeInfo) {
      return { task, mode: modeInfo.mode, config: modeInfo.config }
    }
  }
  return null
}
