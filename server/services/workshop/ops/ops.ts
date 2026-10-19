/**
 * 合规/运维仓储接线(全局注入,模式同 bindDcwBroadcast):
 * plugins/workshop.ts 装配时 bind;业务侧经 getOps() 读取(未装配 = 测试/降级 → null)。
 * 附 audit() 兜底助手:审计写入失败永不击穿主链路。
 */
import type { createApprovalHistoryRepo, createAlarmEventRepo, createAuditRepo, createApprovalRequestRepo } from '../db/ops.repo'
import { normalizeAuditScope } from '../db/ops.repo'
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
  /** 显式域标识:line(产线日志)/ system(全局审计) */
  scope: 'line' | 'system'
  /** 严重级(2026-10-08 ACK 鉴定):error 红 / warn 黄 / info 缺省 */
  level?: 'info' | 'warn' | 'error'
}

/**
 * 全操作记录(统一入口):落 audit_log + 广播 ops.log 实时帧。
 * summary 人读摘要供实时事件直接渲染;结构化详情在 audit_log.detail_json。
 * 失败静默 —— 日志永不击穿业务主链路。
 *
 * 实时帧只广播**产线域**记录(lineId 非空):登录/用户管理/系统设置/备份等全局事件
 * 仍进 audit_log(安全审计面 /api/workshop/audit 可查),但不得污染 /logs、/operations
 * 的产线日志与实时轨。
 */
export function recordOps(entry: Parameters<ReturnType<typeof createAuditRepo>['append']>[0]): void {
  try {
    const lineId = String(entry.lineId ?? '').trim()
    // 显式域不变量:line 必须有产线锚点;缺锚点 fail-closed 降级 system,不得静默混入产线日志
    const scope = normalizeAuditScope(lineId, entry.scope)
    const normalized = { ...entry, lineId, scope }
    getOps()?.audit.append(normalized)
    if (scope !== 'line') return
    broadcastSceneEvent('ops.log', {
      at: normalized.at ?? new Date().toISOString(),
      actor: normalized.actor,
      actorName: normalized.actorName ?? '',
      actorKind: normalized.actorKind ?? 'user',
      action: normalized.action,
      kind: normalized.kind ?? '',
      summary: normalized.summary ?? normalized.action,
      targetKind: normalized.targetKind ?? '',
      targetId: normalized.targetId ?? '',
      lineId,
      productId: normalized.productId ?? '',
      recipeId: normalized.recipeId ?? '',
      scope,
      ...(normalized.level && normalized.level !== 'info' ? { level: normalized.level } : {}),
    } satisfies OpsLogFrame)
  }
  catch {
    // 日志失败不阻断业务
  }
}
