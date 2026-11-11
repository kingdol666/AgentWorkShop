/**
 * HITL 桥应答映射纯函数(dsh/hermes ACP 权限 / codex 决策 / opencode 枚举)。
 *
 * 背景(计划 H14,2026-11-11):三族应答映射此前内联在各 respondHitl 里且互为复制
 * (dsh/hermes 逐字重复 ~50 行),协议应答零 adapter 级测试。抽出纯函数后:
 *  - 映射逻辑可单测锁定(见 tests/hitl-bridge-mapping.test.ts);
 *  - dsh/hermes 消除复制;
 *  - fail-closed 语义集中一处:取消绝不等于同意;缺省绝不放行;未知枚举绝不回落 allow。
 */

/** ACP 权限请求的选项面(session/request_permission options) */
export interface AcpPermissionOption {
  optionId?: string
  kind?: string
  name?: string
}

/** 传导层应答意图(dsh/hermes respondHitl 消费) */
export type AcpPermissionReply
  = | { action: 'respond', payload: { outcome: { outcome: 'cancelled' } } }
    | { action: 'respond', payload: { outcome: { outcome: 'selected', optionId: string } } }
    | { action: 'respondError', code: number, message: string }

export interface AcpHitlOutcome {
  confirmed?: boolean
  cancelled?: boolean
}

const isAllowOption = (o: AcpPermissionOption): boolean =>
  String(o.kind ?? '').startsWith('allow') || /allow/i.test(String(o.name ?? ''))

const isRejectOption = (o: AcpPermissionOption): boolean =>
  String(o.kind ?? '').startsWith('reject') || /reject|deny/i.test(String(o.name ?? ''))

/**
 * ACP 权限应答映射(dsh/hermes 共用;与既有内联实现逐语义等价):
 *  - cancelled 优先于一切 → `{outcome:{outcome:'cancelled'}}`;
 *  - confirmed → 首个 allow 语义选项(kind 前缀 allow / name 含 allow);
 *    无 allow 选项 → respondError(-32602 '无可用 allow 选项'),绝不静默改派 reject;
 *  - 其余(含字段缺省)→ 首个 reject/deny 选项;无 → respondError(-32602 '已拒绝')。
 */
export function resolveAcpPermissionReply(options: AcpPermissionOption[], outcome: AcpHitlOutcome): AcpPermissionReply {
  if (outcome.cancelled === true) {
    return { action: 'respond', payload: { outcome: { outcome: 'cancelled' } } }
  }
  if (outcome.confirmed === true) {
    const allow = options.find(isAllowOption)
    if (!allow) return { action: 'respondError', code: -32602, message: '无可用 allow 选项' }
    return { action: 'respond', payload: { outcome: { outcome: 'selected', optionId: String(allow.optionId) } } }
  }
  const reject = options.find(isRejectOption)
  if (!reject) return { action: 'respondError', code: -32602, message: '已拒绝' }
  return { action: 'respond', payload: { outcome: { outcome: 'selected', optionId: String(reject.optionId) } } }
}

/** codex 审批决策:显式枚举(accept|decline|cancel)优先于 confirmed 布尔;cancel 优先于一切 */
export function resolveCodexDecision(outcome: {
  confirmed?: boolean
  cancelled?: boolean
  response?: string
}): 'accept' | 'decline' | 'cancel' {
  if (outcome.cancelled === true || outcome.response === 'cancel') return 'cancel'
  if (outcome.response === 'accept' || outcome.response === 'decline') return outcome.response
  return outcome.confirmed === true ? 'accept' : 'decline'
}

/**
 * opencode permission 应答枚举校验:非空未知值直接抛错(在传导层再兜一道,
 * 防决策服务被绕过把未知值回落成 once/allow);undefined/空串不干预。
 */
export function assertOpenCodePermissionResponse(response: string | undefined): void {
  if (typeof response === 'string' && response !== ''
    && response !== 'once' && response !== 'always' && response !== 'reject') {
    throw new Error(`未知 permission 应答枚举「${response}」:仅允许 once|always|reject`)
  }
}

/**
 * opencode permission → 引擎原生应答(fail-closed):
 *  - cancelled / 显式 reject → 'reject'(取消绝不等价于同意);
 *  - 'always' → 'always';显式 'once' 或 confirmed=true → 'once';
 *  - 其余(含字段缺省)→ 'reject'(缺省不放行)。
 */
export function resolveOpenCodeNativeResponse(outcome: {
  cancelled?: boolean
  response?: string
  confirmed?: boolean
}): 'once' | 'always' | 'reject' {
  if (outcome.cancelled === true || outcome.response === 'reject') return 'reject'
  if (outcome.response === 'always') return 'always'
  return outcome.confirmed === true || outcome.response === 'once' ? 'once' : 'reject'
}

/** 供 opencode question 路径复用的答案信封解码 re-export(集中映射面入口) */
export { decodeHitlAnswers } from './hitl-registry'
