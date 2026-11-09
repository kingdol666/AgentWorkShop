/**
 * 202 复核挂起判定(无依赖,可在 node:test 里直接验证)。
 *
 * 高危写(配方整批下发/节点删除/控制网关/回滚)在开启双人复核时,服务端**不执行**,
 * 只登记一条审批并返回 `{pending:true, requestId}`(HTTP 202,信封 code=0)。
 * 消费方必须先判这个分支,否则会把"待批核"当成成功:
 *   - 删节点:本地 splice 掉了,服务端还在(刷新才回来);
 *   - 整批下发:直接读 `run.results` → TypeError,用户看到英文崩错。
 */
export interface PendingApproval { pending: true, requestId: string }

export function isPendingApproval(data: unknown): data is PendingApproval {
  return Boolean(data && typeof data === 'object' && (data as { pending?: unknown }).pending === true)
}
