/**
 * 合规/运维仓储接线(全局注入,模式同 bindDcwBroadcast):
 * plugins/workshop.ts 装配时 bind;业务侧经 getOps() 读取(未装配 = 测试/降级 → null)。
 * 附 audit() 兜底助手:审计写入失败永不击穿主链路。
 */
import type { createApprovalHistoryRepo, createAlarmEventRepo, createAuditRepo, createApprovalRequestRepo } from '../db/ops.repo'
import { broadcastSceneEvent } from '../scene-events'

export interface OpsRepos {
  approvalHistory: ReturnType<typeof createApprovalHistoryRepo>
  alarmEvents: ReturnType<typeof createAlarmEventRepo>
  audit: ReturnType<typeof createAuditRepo>
  approvalRequests: ReturnType<typeof createApprovalRequestRepo>
}

const g = globalThis as typeof globalThis & { __opsRepos?: OpsRepos }

export function bindOpsRepos(repos: OpsRepos): void {
  g.__opsRepos = repos
}

export function getOps(): OpsRepos | null {
  return g.__opsRepos ?? null
}

/** 审计埋点(R1):失败静默,绝不影响业务主路径 */
export function audit(entry: Parameters<ReturnType<typeof createAuditRepo>['append']>[0]): void {
  try {
    getOps()?.audit.append(entry)
  }
  catch {
    // 审计失败不阻断业务(如需告警接入 R4 指标)
  }
}

/** 运维日志事件帧(WS 实时事件轨渲染摘要;完整详情落 audit_log 由日志管理页查询) */
export interface OpsLogFrame {
  at: string
  actor: string
  actorName: string
  actorKind: 'user' | 'agent' | 'system'
  action: string
  kind: string
  summary: string
  targetKind: string
  targetId: string
  lineId: string
  productId: string
  recipeId: string
}

/**
 * 全操作记录(统一入口):落 audit_log + 广播 ops.log 实时帧。
 * summary 人读摘要供实时事件直接渲染;结构化详情在 audit_log.detail_json。
 * 失败静默 —— 日志永不击穿业务主链路。
 */
export function recordOps(entry: Parameters<ReturnType<typeof createAuditRepo>['append']>[0]): void {
  try {
    getOps()?.audit.append(entry)
    broadcastSceneEvent('ops.log', {
      at: entry.at ?? new Date().toISOString(),
      actor: entry.actor,
      actorName: entry.actorName ?? '',
      actorKind: entry.actorKind ?? 'user',
      action: entry.action,
      kind: entry.kind ?? '',
      summary: entry.summary ?? entry.action,
      targetKind: entry.targetKind ?? '',
      targetId: entry.targetId ?? '',
      lineId: entry.lineId ?? '',
      productId: entry.productId ?? '',
      recipeId: entry.recipeId ?? '',
    } satisfies OpsLogFrame)
  }
  catch {
    // 日志失败不阻断业务
  }
}
