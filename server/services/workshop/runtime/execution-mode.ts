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
import { randomUUID } from 'node:crypto'
import type { ExecutionMode } from '../agents/agent-interface'
import type { WorkspaceTask } from '../types/task'
import type { A2AArtifact } from '../types/a2a'

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
  if (mode === 'pipeline') {
    // 阶段名从 [stages:name1->name2] 提取(与 encodeTaskMode 编码格式对称)
    const stagesMatch = desc.match(/\[stages:([^\]]+)\]/)
    if (stagesMatch) {
      config.stages = stagesMatch[1]!
        .split('->')
        .map(r => r.trim())
        .filter(Boolean)
        .map(name => ({ name, description: '' }))
    }
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

/** goal-summary 完成标志判定:artifact 名称约定或正文含总结标头 */
export function isGoalSummaryArtifact(a: A2AArtifact): boolean {
  return a.name === 'goal-summary'
    || a.parts.some(p => 'text' in p && p.text.includes('【目标完成总结】'))
}

/**
 * goal 模式收口总结(「目标完成总结」结构化交付物)。
 * 单一事实源:mock lead 确定性生成 / omp lead 按 prompt 模板自写 / 平台在
 * taskEngine.complete 保底合成 —— 三路径同构,目标/判定标准/完成过程/最终成果/结论。
 */
export function synthesizeGoalSummary(
  task: WorkspaceTask,
  children: WorkspaceTask[],
  criteria: string,
): A2AArtifact {
  const results = children
    .flatMap(c => c.artifacts.flatMap(a => (a.name === 'input' ? [] : a.parts)))
    .filter((p): p is { text: string } => 'text' in p)
    .map(p => p.text.trim())
    .filter(t => t.length > 0)
    .slice(-8)
  const conclusion = [
    `【目标完成总结】`,
    `目标: ${task.title}`,
    `判定标准: ${criteria}`,
    `完成过程: ${children.length > 0 ? children.map(c => `「${c.title}」`).join(' → ') : '(单任务达成)'} 全部完成`,
    `最终成果: ${results.length > 0 ? results.join('; ') : '(交付物见任务 artifacts)'}`,
    `结论: 目标已达成,全部任务完成。`,
  ].join('\n')
  return {
    artifactId: randomUUID(),
    name: 'goal-summary',
    parts: [
      { text: conclusion },
      { text: `标准:${criteria}` },
      { text: `子任务:${children.length > 0 ? children.map(c => c.title).join(' + ') : task.title}` },
    ],
  }
}
