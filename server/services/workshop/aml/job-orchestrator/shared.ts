/**
 * 模块头 / 运行中作业与编排器状态类型 / 全局状态
 * (由 server/services/workshop/aml/job-orchestrator.ts 按职责拆出;内容逐行原文搬运)
 */
import type { AmlJobRow } from '../aml.repo'
import type { ChildProcess } from 'node:child_process'
import { createLogger } from '../../logger'

/**
 * AML 作业编排器:FIFO 队列 + 并发上限 + 双段子进程(train → 平台评估)+ 停摆看门狗。
 *
 * 纪律:
 *  - 子进程经 line-spawn(Windows 引号安全);超时/停摆/取消一律杀整棵进程树;
 *  - ##AML NDJSON 协议行解析(非法行丢弃计数,不因日志格式炸掉);
 *  - 永久错误(契约缺失/评估失败)不重试;进程被杀/超时=可重试(retry_count<2);
 *  - 重启恢复:启动时活跃态作业批量置 interrupted;
 *  - 进度经 broadcastSceneEvent('aml.job') 推送(携带 lineId 享逐 peer 过滤)。
 */

export const log = createLogger('aml.job')

export const PROGRESS_WS_MIN_MS = 2000

export interface RunningJob {
  row: AmlJobRow
  jobDir: string
  child: ChildProcess | null
  startedAt: number
  lastProtocolAt: number
  lastWsAt: number
  logLines: string[]
  protocolBadLines: number
  killed: boolean
}

export interface OrchestratorState {
  queue: AmlJobRow[]
  running: Map<string, RunningJob>
  ticker: ReturnType<typeof setInterval> | null
}

export const g = globalThis as typeof globalThis & { __amlOrchestrator?: OrchestratorState }

export function state(): OrchestratorState {
  if (!g.__amlOrchestrator) {
    g.__amlOrchestrator = { queue: [], running: new Map(), ticker: null }
  }
  return g.__amlOrchestrator
}

// ---------- 对外 API ----------
