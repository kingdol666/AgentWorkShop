/**
 * Task Execution Lease —— 执行交接栅栏(设计文档 §5)。
 *
 * 语义(与 §5.1/§5.2 一一对应):
 *  - 每次「新分配 / 重分配」都产生新的 `assignmentGeneration` 与 `executionLeaseId`;
 *  - worker 的 assign 投递、artifact、progress、complete、failed 事件都携带
 *    generation + lease,由 TaskEngine 与运行时在写入前校验;
 *  - 与当前 lease 不符的事件视为**旧 worker 的迟到事件**,一律丢弃,
 *    不得覆盖重新分配后的新执行结果。
 *
 * 兼容性:升级前创建的历史任务没有 lease(generation=0、lease 为空)。
 * 对这类任务一律放行(无法判定迟到),避免升级瞬间把在途 worker 的事件全部丢弃。
 */
import { randomUUID } from 'node:crypto'
import type { WorkspaceTask } from '../../types/task'

/** 投递消息 metadata 上的栅栏键(assign 消息携带,worker 回合原样回传) */
export const LEASE_META_GENERATION = 'x-aw-assignment-generation'
export const LEASE_META_LEASE_ID = 'x-aw-execution-lease-id'

export interface ExecutionFence {
  generation?: number | null
  leaseId?: string | null
}

export interface IssuedLease {
  assignmentGeneration: number
  executionLeaseId: string
  executionLeaseAgentId: string
  executionLeaseStartedAt: string
  executionLeaseRevokedAt: null
}

/**
 * 生成一份新租约(§5.1「每次新分配/重分配生成新的 generation + lease」)。
 * 调用方负责把返回值写入 tasks 行:`generation` 由调用方决定(新建=0,重分配=旧值+1)。
 */
export function issueLeaseFields(generation: number, agentId: string, at = new Date().toISOString()): IssuedLease {
  return {
    assignmentGeneration: generation,
    executionLeaseId: randomUUID(),
    executionLeaseAgentId: agentId,
    executionLeaseStartedAt: at,
    executionLeaseRevokedAt: null,
  }
}

/** 从消息 metadata 提取栅栏(缺字段时为 undefined = 无栅栏,调用方放行) */export function fenceFromMetadata(metadata: Record<string, unknown> | undefined): ExecutionFence | undefined {
  if (!metadata) return undefined
  const generation = metadata[LEASE_META_GENERATION]
  const leaseId = metadata[LEASE_META_LEASE_ID]
  const gen = typeof generation === 'number' ? generation : (typeof generation === 'string' && generation.trim() !== '' ? Number(generation) : undefined)
  const lease = typeof leaseId === 'string' && leaseId.trim() !== '' ? leaseId : undefined
  if (gen === undefined && lease === undefined) return undefined
  return { generation: Number.isFinite(gen) ? gen : undefined, leaseId: lease }
}

/** 把栅栏写回消息 metadata(仅在有 lease 时写入,历史任务保持无栅栏) */
export function fenceToMetadata(task: { assignmentGeneration?: number, executionLeaseId?: string }): Record<string, unknown> {
  if (!task.executionLeaseId) return {}
  return {
    [LEASE_META_GENERATION]: task.assignmentGeneration ?? 0,
    [LEASE_META_LEASE_ID]: task.executionLeaseId,
  }
}

/**
 * 事件是否属于当前执行代次。
 *  - 任务无 lease:放行(历史任务/尚未发放,无法判定);
 *  - 事件无栅栏:放行(非 worker 任务事件,如调度器/管理端写入);
 *  - 有栅栏:generation 与 leaseId 必须同时匹配当前值。
 */
export function fenceMatches(task: Pick<WorkspaceTask, 'assignmentGeneration' | 'executionLeaseId'>, fence?: ExecutionFence | null): boolean {
  if (!fence) return true
  if (!task.executionLeaseId) return true
  if (fence.leaseId && fence.leaseId !== task.executionLeaseId) return false
  if (fence.generation != null && fence.generation !== (task.assignmentGeneration ?? 0)) return false
  return true
}
