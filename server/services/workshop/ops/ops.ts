/**
 * 合规/运维仓储接线(全局注入,模式同 bindDcwBroadcast):
 * plugins/workshop.ts 装配时 bind;业务侧经 getOps() 读取(未装配 = 测试/降级 → null)。
 * 附 audit() 兜底助手:审计写入失败永不击穿主链路。
 */
import type { createApprovalHistoryRepo, createAlarmEventRepo, createAuditRepo, createApprovalRequestRepo } from '../db/ops.repo'

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
