/**
 * HITL 统一决策服务(§13.4)—— 所有 HITL 端点(respond/pending/approvals)的唯一裁决入口。
 *
 * 决策顺序(不可跳步,主计划 §8 审批流程 4→8):
 *   ① 载入持久化事实行(缺失 → 404/409,视调用口径)
 *   ② requireCanApprove(channelId, user, { policy, snapshot })   ← 创建时资格 ∩ 当前资格 → 403
 *   ③ claimPending(id, decisionId, userId)                       ← 原子抢占 pending→resolving
 *      失败 = 他人已抢占/已终态 → **409 ALREADY_RESOLVED**(带当前状态与处理人,供前端收敛)
 *   ④ 传导原生应答(adapter/terminal/tool-approvals)
 *   ⑤ 引擎确认成功 → finalize(终态, nativeConfirmed: true)
 *   ⑥ 引擎**明确**失败 → releaseClaim(可重试)或 finalize('failed')(不可重试)
 *   ⑦ 结果**未知** → markDeliveryUnknown(绝不重试、绝不标记成功,人工核对后再收敛)
 *   ⑧ 广播 hitl.resolved + 更新 hitl_resolved 定向通知
 *
 * decisionId 每次尝试都是新 uuid:抢占/审计/原生对账共用同一关联 ID(§13.6)。
 *
 * 重启语义:`reconcileHitlOnStartup()` 用 `failAllNonTerminalOnRestart()` 把**本进程启动前**创建的
 * 非终态条目置 failed(原生会话随上一进程消亡)—— **pending HITL 永不自动批准**;
 * 本模块在首次决策前惰性执行一次(幂等,globalThis 标记跨 HMR/多入口存活),
 * 只处理早于进程启动水位的条目,绝不误杀本进程内新建的 live 待办。
 *
 * 降级:无持久化层(旧测试脚手架在 :memory: 上不装群聊仓储)时回落旧口径守卫,
 * 行为与 v17 之前一致,不因引入决策服务而丢失可应答性。
 */
import { randomUUID } from 'node:crypto'
import { AppError } from '@/server/utils/errors'
import { createLogger } from '../logger'
import {
  encodeHitlAnswers,
  getHitlRegistry,
  requestTypeOf,
  resolveHitlRuntime,
  type HitlKind,
  type HitlRuntimePort,
} from './hitl-registry'
import type { AepHitlQuestion, AepHitlStatus } from '../../../../shared/workshop-protocol'
import type { HitlRequestRow } from '../db/database'
import type { HitlPolicySnapshot, HitlStatus } from '../db/hitl-request.repo'
import { getToolApprovals } from './tool-approvals'
import { respondTerminalUi } from './harness-terminal'
import { audit } from '../ops/ops'

const log = createLogger('workshop.hitl-decision')

/** 权限主体(与路由层 ResolvedUser / manager.ActingUser 同构) */
export interface HitlActingUser {
  id: string
  name?: string
  role?: string
}

/** 决策载荷(端点 body 归一化后交给本服务;枚举非法一律 400,绝不静默降级为"允许") */
export interface HitlDecisionPayload {
  /** 单问题自由文本/选择答案,或多问题的合并文本 */
  value?: string
  /** 结构化多问题答案(id 缺省按下标对齐) */
  answers?: Array<{ id?: string, answer: string }>
  confirmed?: boolean
  cancelled?: boolean
  /** 引擎原生选项枚举(opencode permission: once|always|reject 等) */
  response?: string
  comment?: string
}

export interface HitlDecisionInput {
  kind: string
  id: string
  user: HitlActingUser
  decision: HitlDecisionPayload
}

export interface HitlDecisionResult {
  kind: string
  id: string
  status: AepHitlStatus
  outcome: 'answered' | 'cancelled' | 'expired'
  nativeConfirmed: boolean
  /** 是否走了持久化事实源(false = 降级旧口径) */
  persisted: boolean
  /** 决策关联 ID(审计/对账;§13.6) */
  decisionId: string
  /** dcw-approval 专属:工具审批裁决结果 */
  approval?: unknown
}

// ============================================================================
// 错误分类:决定状态机走向(明确失败 vs 结果未知)
// ============================================================================

/** 原生投递结果**未知**(超时/连接中断/无回执)→ delivery_unknown;绝不重试、绝不标记成功 */
export class HitlDeliveryUnknownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HitlDeliveryUnknownError'
  }
}

/** 原生调用明确失败但**条目仍在引擎侧 pending**(可安全让出抢占重试)→ 回落 pending */
export class HitlRetryableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HitlRetryableError'
  }
}

/** 引擎/条目层面的**确定性**失败(不可重试):409 NOT_RESPONDABLE、410 SESSION_GONE、404 NOT_FOUND 等 */
function isDefiniteNativeFailure(err: unknown): boolean {
  if (err instanceof HitlRetryableError || err instanceof HitlDeliveryUnknownError) return false
  if (err instanceof AppError) {
    return ['NOT_FOUND', 'NOT_RESPONDABLE', 'SESSION_GONE', 'UNKNOWN_HARNESS', 'HARNESS_UNAVAILABLE', 'BAD_REQUEST', 'INVALID_RESPONSE', 'ALREADY_RESOLVED'].includes(err.code)
  }
  // adapter 的原生条目丢失(引擎侧已自行收敛):确定性失败,不得留在 pending 悬空
  const msg = err instanceof Error ? err.message : String(err)
  return /待办不存在或已处理|审批不存在或已处理|会话已关闭|session.*(closed|gone)/i.test(msg)
}

// ============================================================================
// response 枚举白名单(未知枚举直接拒绝,不得默认允许 —— §13.5)
// ============================================================================

/** providerKind → 允许的 response 枚举 */
const RESPONSE_ENUMS: Record<string, ReadonlySet<string>> = {
  'opencode-permission': new Set(['once', 'always', 'reject']),
  'codex-approval': new Set(['accept', 'decline', 'cancel']),
}

/** 校验决策载荷(未知枚举 → 400;不返回任何默认"允许") */
export function assertDecisionPayload(kind: string, decision: HitlDecisionPayload): void {
  const response = typeof decision.response === 'string' ? decision.response.trim() : ''
  if (!response) return
  const allowed = RESPONSE_ENUMS[kind]
  if (!allowed) {
    throw new AppError(400, 'INVALID_RESPONSE', `kind=${kind} 不接受 response 枚举(仅 ${Object.keys(RESPONSE_ENUMS).join('/')} 接受);请改用 confirmed/cancelled/value`)
  }
  if (!allowed.has(response)) {
    throw new AppError(400, 'INVALID_RESPONSE', `未知 response 枚举「${response}」(kind=${kind} 仅允许 ${[...allowed].join('|')});已拒绝,不会按默认值放行`)
  }
}

/** 决策 → 持久化终态映射(question 与 approval 分开建模,§8) */
export function statusOfDecision(
  requestType: 'question' | 'approval',
  decision: HitlDecisionPayload,
): { status: HitlStatus, outcome: 'answered' | 'cancelled' } {
  if (decision.cancelled === true) return { status: 'cancelled', outcome: 'cancelled' }
  if (decision.response === 'reject' || decision.response === 'decline') return { status: 'rejected', outcome: 'answered' }
  if (requestType === 'approval') {
    return decision.confirmed === true
      ? { status: 'approved', outcome: 'answered' }
      : { status: 'rejected', outcome: 'answered' }
  }
  return { status: 'answered', outcome: 'answered' }
}

// ============================================================================
// 结构化答案载荷(编码/解码见 hitl-registry;此处仅做转发与"决策载荷 → 答案列表"的归一)
// ============================================================================

/** 把决策载荷摊平成 (问题 → 答案) 列表:结构化 answers 优先,缺省用 value 兜底 */
export function resolveAnswers(
  questions: AepHitlQuestion[],
  decision: HitlDecisionPayload,
): Array<{ id: string, answer: string }> {
  const provided = decision.answers ?? []
  if (questions.length === 0) {
    const text = decision.value ?? decision.comment ?? ''
    return text ? [{ id: '', answer: text }] : []
  }
  return questions.map((q, i) => {
    const hit = provided.find(a => a.id && a.id === q.id) ?? provided[i]
    const answer = hit?.answer ?? (questions.length === 1 ? (decision.value ?? decision.comment ?? '') : '')
    return { id: q.id || String(i), answer }
  })
}

// ============================================================================
// 可见性 / 审批资格(单一事实源:列表与决策共用,避免"看得见却办不了"或反向越权)
// ============================================================================

/** 遗留 owner=NULL 公共 Channel 的可见性口径(与旧端点一致:任意登录用户可见,不可放宽管理面) */
function visibleChannelIds(manager: HitlRuntimePort, user: HitlActingUser): Set<string> {
  const ids = new Set<string>()
  for (const c of manager.listChannelsVisibleTo(user)) ids.add(c.id)
  try {
    for (const c of manager.listChannelsForUser(user.id)) ids.add(c.id)
  }
  catch { /* 遗留口径不可用(降级):仅用 listChannelsVisibleTo */ }
  return ids
}

/**
 * 断言调用者可见且**可裁决**该 Channel 的 HITL。
 * - 可见性:listChannelsVisibleTo ∪ listChannelsForUser(遗留公共);admin 全量
 * - 审批资格:requireCanApprove(成员 + owner_only/any_member + 创建时资格快照 ∩ 当前资格)
 * - 遗留 owner=NULL Channel:保持旧口径(getChannelForUser),不放宽也不收紧既有语义
 */
export function assertCanDecideHitlChannel(
  channelId: string,
  user: HitlActingUser,
  opts: { policy?: string, snapshot?: { eligibleUserIds?: string[], memberGenerations?: Record<string, number> } } = {},
): void {
  const manager = resolveHitlRuntime()
  if (!manager || !channelId) return
  if (user.role === 'admin') {
    manager.requireChannelMember(channelId, user)
    return
  }
  if (!visibleChannelIds(manager, user).has(channelId)) {
    throw new AppError(403, 'SCOPE_VIOLATION', '该待办所属 Channel 对当前用户不可见')
  }
  try {
    manager.requireCanApprove(channelId, user, opts)
  }
  catch (err) {
    // 遗留无主 Channel(owner=NULL):v17 之前旧端点只做 getChannelForUser,而
    // getChannelForUser 对 owner=NULL 放行**任意登录用户** —— 等于"任何登录用户都能
    // 批准一个无主 Channel 里的高危操作"。这属于 §13.2 要求收口的审批旁路。
    //
    // v17 收紧:遗留 Channel 的 HITL 仅 **admin** 可裁决(与 ws.ts 终端接入、
    // requireChannelMember 对遗留 Channel 的口径一致)。owner 需先显式认领
    // (写 owner_user_id)再审批 —— §13.7「owner=NULL 遗留 Channel 默认不可开放,
    // 必须显式认领并审计」。这是**收紧**而非放宽,不违反 §0.8 的兼容约束。
    if (err instanceof AppError && err.code === 'FORBIDDEN_LEGACY') {
      throw new AppError(403, 'FORBIDDEN_LEGACY_APPROVAL',
        '该 Channel 为遗留无归属数据(owner 缺失),HITL 审批仅管理员可执行;请先显式认领 Channel')
    }
    throw err
  }
}

/** 布尔判定(列表过滤用;不抛异常) */
export function canDecideHitlChannel(
  channelId: string,
  user: HitlActingUser,
  opts: { policy?: string, snapshot?: { eligibleUserIds?: string[], memberGenerations?: Record<string, number> } } = {},
): boolean {
  try {
    assertCanDecideHitlChannel(channelId, user, opts)
    return true
  }
  catch {
    return false
  }
}

/** 解析持久化行的策略快照(容错:历史行 JSON 坏 → 只有 policy 生效) */
export function snapshotOfRow(row: HitlRequestRow): { eligibleUserIds?: string[], memberGenerations?: Record<string, number> } {
  try {
    const raw = JSON.parse(row.policySnapshotJson || '{}') as Partial<HitlPolicySnapshot>
    return {
      eligibleUserIds: Array.isArray(raw.eligibleUserIds) ? raw.eligibleUserIds : undefined,
      memberGenerations: raw.memberGenerations && typeof raw.memberGenerations === 'object' ? raw.memberGenerations : undefined,
    }
  }
  catch {
    return {}
  }
}

// ============================================================================
// 启动对账(重启不自动批准)
// ============================================================================

const g = globalThis as typeof globalThis & { __hitlReconciledAt?: string }

/**
 * 本进程启动水位:启动对账只处理**早于本进程**创建的条目。
 * 理由:原生会话随进程消亡,只有上一进程遗留的待办才"必然不可应答";
 * 本进程内新建的 pending 是 live 条目,绝不能被一次惰性对账误杀。
 */
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString()

/**
 * 启动对账:把随上一进程消亡的原生会话条目(非终态)全部置 failed,**绝不自动批准**。
 * - 默认只处理 `createdAt < PROCESS_STARTED_AT` 的条目(重启遗留);`force` 则处理全部非终态
 *   (运维/测试显式语义:视同重启);
 * - 纯重启场景(全部非终态都早于本进程)走仓储 `failAllNonTerminalOnRestart`;
 *   混合场景(含本进程 live 条目)逐条 finalize('failed'),live 条目保持 pending;
 * - 幂等:同进程只跑一次(force 可重跑);无持久化层 → 返回空清单(纯内存脚手架)。
 */
export function reconcileHitlOnStartup(opts: { force?: boolean, error?: string, before?: string } = {}): {
  failed: number
  entries: Array<{ kind: string, id: string, status: string, channelId: string, nativeConfirmed: boolean }>
} {
  const manager = resolveHitlRuntime()
  const repo = manager?.groupChat?.hitl
  if (!manager || !repo) return { failed: 0, entries: [] }
  if (g.__hitlReconciledAt && !opts.force && !opts.before) {
    return { failed: 0, entries: [] }
  }
  g.__hitlReconciledAt = new Date().toISOString()
  try {
    const all = repo.listNonTerminal()
    const watermark = opts.before ?? PROCESS_STARTED_AT
    const stale = opts.force ? all : all.filter(r => r.createdAt < watermark)
    if (stale.length === 0) return { failed: 0, entries: [] }
    const sample = stale.slice(0, 10).map(r => `${r.kind}:${r.id}`).join(', ')
    const error = opts.error
      ?? `服务重启:原生会话已随上一进程失效,待办不可再应答(未自动批准);受影响 ${stale.length} 条:${sample}`
    let failed: number
    if (stale.length === all.length) {
      // 纯重启:整表非终态都是上一进程遗留 → 仓储级启动恢复入口(绝不自动批准)
      failed = repo.failAllNonTerminalOnRestart(error)
    }
    else {
      // 混合:只收敛确属上一进程的条目,本进程 live 待办保持 pending
      failed = 0
      for (const r of stale) {
        if (repo.finalize(r.id, 'failed', { nativeConfirmed: false, error })) failed += 1
      }
    }
    log.warn(`[hitl] 启动对账:${failed} 条非终态待办置 failed(绝不自动批准)`)
    return {
      failed,
      entries: stale.map(r => ({ kind: r.kind, id: r.id, status: r.status, channelId: r.channelId, nativeConfirmed: false })),
    }
  }
  catch (err) {
    log.error('[hitl] 启动对账失败:', err instanceof Error ? err.message : err)
    return { failed: 0, entries: [] }
  }
}

// ============================================================================
// 原生应答传导(可插拔:测试/嵌入场景替换;缺省走真实 adapter 面)
// ============================================================================

export interface HitlNativeDispatchContext {
  kind: string
  id: string
  requestType: 'question' | 'approval'
  channelId: string
  agentId: string
  /** 内存快照里的 pid(omp-dialog 终止对话框用) */
  pid?: number
  /** 问题列表(多问题答案按问题 id 对齐回传;来自持久化行,回落到内存快照) */
  questions: AepHitlQuestion[]
  decision: HitlDecisionPayload
  user: HitlActingUser
}

export type HitlNativeDispatcher = (ctx: HitlNativeDispatchContext) => Promise<unknown> | unknown

const nativeDispatchers = new Map<string, HitlNativeDispatcher>()

/** 注册/覆盖某 providerKind 的原生应答传导(测试与嵌入装配用) */
export function registerHitlNativeDispatcher(kind: string, fn: HitlNativeDispatcher | null): void {
  if (fn) nativeDispatchers.set(kind, fn)
  else nativeDispatchers.delete(kind)
}

/** 默认传导:omp 对话框写 stdin;dcw 走工具审批服务;其余走 manager→adapter */
async function defaultDispatch(ctx: HitlNativeDispatchContext): Promise<unknown> {
  const manager = resolveHitlRuntime()
  const { decision } = ctx
  if (ctx.kind === 'omp-dialog') {
    // 保持既有 410 SESSION_GONE 语义:pid 缺失/进程已退出 = 会话不可用(确定性失败)
    if (!ctx.pid) throw new AppError(410, 'SESSION_GONE', '对话框缺少 pid(进程已退出?)')
    try {
      respondTerminalUi(ctx.pid, {
        id: ctx.id,
        value: typeof decision.value === 'string' ? decision.value : undefined,
        confirmed: typeof decision.confirmed === 'boolean' ? decision.confirmed : undefined,
        cancelled: decision.cancelled === true,
      })
    }
    catch (err) {
      throw new AppError(410, 'SESSION_GONE', `omp 会话不可用: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { via: 'omp-terminal' }
  }
  if (ctx.kind === 'dcw-approval') {
    // dcw 工具审批:与 hitl/respond 同语义(缺省视为拒绝,approved 必须显式 confirmed===true)
    const approval = getToolApprovals().decide(
      ctx.id,
      decision.confirmed === true,
      String(decision.comment ?? ''),
      ctx.user.id,
      ctx.user.name ?? '',
    )
    return { via: 'tool-approvals', approval }
  }
  if (!manager) throw new AppError(409, 'NOT_RESPONDABLE', 'Workshop 运行时未装配,无法应答该 harness 请求')
  await manager.respondHarnessHitl(ctx.agentId, ctx.kind, ctx.id, {
    confirmed: typeof decision.confirmed === 'boolean' ? decision.confirmed : undefined,
    cancelled: decision.cancelled === true,
    value: encodeHitlAnswers(resolveAnswers(ctx.questions, decision), decision.value),
    response: typeof decision.response === 'string' ? decision.response : undefined,
    comment: typeof decision.comment === 'string' ? decision.comment : undefined,
  })
  return { via: 'harness', harness: ctx.kind }
}

// ============================================================================
// 决策主流程
// ============================================================================

const safeRepo = (manager: HitlRuntimePort | null) => {
  if (!manager) return null
  try {
    return manager.groupChat?.hitl ?? null
  }
  catch {
    return null
  }
}

/**
 * 统一决策入口(所有 HITL 端点唯一调用点)。
 * 抛错语义:
 *  - 404 NOT_FOUND            持久化行不存在(且无内存快照)
 *  - 409 ALREADY_RESOLVED     未登记 / 抢占失败(附当前状态与处理人)
 *  - 403 *                    非成员 / 审批策略或资格不通过
 *  - 400 INVALID_RESPONSE     未知 response 枚举
 *  - 410 SESSION_GONE         omp 会话不可用(保持旧语义)
 *  - 409 NOT_RESPONDABLE      该 harness 不支持程序化应答
 *  - 502 DELIVERY_UNKNOWN     原生结果未知 → 已标记待核对(**不是成功**)
 */
export async function decideHitlRequest(input: HitlDecisionInput): Promise<HitlDecisionResult> {
  ensureReconciledOnce()
  const { kind, id, user } = input
  const decision: HitlDecisionPayload = { ...input.decision }
  assertDecisionPayload(kind, decision)

  const manager = resolveHitlRuntime()
  const repo = safeRepo(manager)
  const item = getHitlRegistry().find(kind as HitlKind, id)
  const row = repo?.find(kind, id) ?? undefined

  if (!item && !row) {
    // 保持旧语义:未登记/已落定 → 409(respond.post 也依赖该口径)
    throw new AppError(409, 'ALREADY_RESOLVED', `待办已处理或不存在: ${id}`)
  }

  const channelId = row?.channelId || item?.channelId || ''
  const agentId = row?.agentId || item?.agentId || ''
  const requestType = requestTypeOf({
    kind,
    requestType: (row?.requestType as 'question' | 'approval' | undefined) ?? item?.requestType,
    method: item?.method,
  })

  // ② 审批资格(创建时资格 ∩ 当前资格)
  if (row) {
    assertCanDecideHitlChannel(channelId, user, { policy: row.policy, snapshot: snapshotOfRow(row) })
  }
  else if (manager && channelId) {
    // 降级路径(无持久化行):与 v17 之前完全一致的口径
    manager.getChannelForUser(channelId, user.id)
  }

  const decisionId = randomUUID()

  // ③ 原子抢占:并发审批只允许一个成功
  if (row && repo) {
    if (!repo.claimPending(row.id, decisionId, user.id)) {
      const cur = repo.findById(row.id)
      const responder = cur?.responderUserId ? `,处理人=${cur.responderUserId}` : ''
      throw new AppError(
        409,
        'ALREADY_RESOLVED',
        `该待办已被他人处理(当前状态=${cur?.status ?? 'unknown'}${responder}),请刷新后重试`,
      )
    }
  }

  const questions = row?.questionsJson && row.questionsJson !== '[]'
    ? safeParseQuestions(row.questionsJson)
    : (item?.questions ?? [])
  const ctx: HitlNativeDispatchContext = {
    kind,
    id,
    requestType,
    channelId,
    agentId,
    pid: item?.pid,
    decision,
    user,
    questions,
  }

  const registry = getHitlRegistry()
  registry.beginDecision(kind as HitlKind, id)
  try {
    // ④ 传导原生应答
    const custom = nativeDispatchers.get(kind)
    const native = custom ? await custom(ctx) : await defaultDispatch(ctx)

    // ⑤ 引擎确认成功才落终态(§8 步骤 7)
    const { status, outcome } = statusOfDecision(requestType, decision)
    if (row && repo) {
      repo.finalize(row.id, status, {
        decision: {
          decisionId,
          by: user.id,
          byName: user.name ?? '',
          requestType,
          confirmed: decision.confirmed,
          cancelled: decision.cancelled,
          response: decision.response,
          value: decision.value,
          answers: resolveAnswers(questions, decision),
          comment: decision.comment,
        },
        nativeConfirmed: true,
      })
    }
    getHitlRegistry().settle(kind as HitlKind, id, { outcome, by: user.id, status, nativeConfirmed: true, channelId, agentId })
    const approval = (native as { approval?: unknown } | undefined)?.approval
    // 审计:操作者 / 策略 / 原生请求 ID / 原始决策 / 引擎确认结果(§8 审计要求)
    audit({
      actor: user.id,
      actorName: user.name ?? '',
      actorKind: 'user',
      action: status === 'approved' ? 'approval.approve' : status === 'rejected' ? 'approval.reject' : 'hitl.respond',
      targetKind: kind,
      targetId: id,
      detail: {
        decisionId,
        channelId,
        agentId,
        requestType,
        policy: row?.policy,
        approvalPolicyVersion: row?.policyVersion,
        nativeRequestId: row?.nativeRequestId ?? '',
        status,
        nativeConfirmed: true,
        cancelled: decision.cancelled === true,
        confirmed: decision.confirmed === true,
        response: decision.response,
      },
    })
    notifyResolved(manager, kind, id, channelId, row, status, user, true, decisionId)
    return {
      kind,
      id,
      status,
      outcome,
      nativeConfirmed: true,
      persisted: !!row,
      decisionId,
      approval,
    }
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 持久化层可用但行缺失(降级登记的旧条目)时不得写状态机,故统一判 row && repo
    if (err instanceof HitlRetryableError) {
      // ⑥ 明确失败且条目仍在引擎侧 pending → 让出抢占(可重试)
      if (row && repo) repo.releaseClaim(row.id, msg)
      audit({ actor: user.id, actorName: user.name ?? '', actorKind: 'user', action: 'hitl.respond', targetKind: kind, targetId: id, detail: { decisionId, channelId, agentId, result: 'retryable', error: msg } })
      throw err
    }
    if (isDefiniteNativeFailure(err)) {
      // ⑥ 确定性失败:条目不可再应答 → failed(nativeConfirmed=false)
      if (row && repo) repo.finalize(row.id, 'failed', { decision: { decisionId, by: user.id }, nativeConfirmed: false, error: msg })
      getHitlRegistry().settle(kind as HitlKind, id, { outcome: 'cancelled', by: user.id, status: 'failed', nativeConfirmed: false, channelId, agentId })
      notifyResolved(manager, kind, id, channelId, row, 'failed', user, false, decisionId)
      audit({ actor: user.id, actorName: user.name ?? '', actorKind: 'user', action: 'hitl.respond', targetKind: kind, targetId: id, detail: { decisionId, channelId, agentId, result: 'failed', error: msg } })
      if (err instanceof AppError) throw err
      throw new AppError(409, 'NATIVE_REJECTED', `原生应答失败(条目已置 failed):${msg}`)
    }
    // ⑦ 结果未知:绝不重试、绝不标记成功(§13.4 delivery_unknown)
    if (row && repo) repo.markDeliveryUnknown(row.id, msg)
    // outcome 只是三值旧投影(answered/cancelled/expired);真实状态在 status 字段
    getHitlRegistry().settle(kind as HitlKind, id, { outcome: 'cancelled', by: user.id, status: 'delivery_unknown', nativeConfirmed: false, channelId, agentId })
    notifyResolved(manager, kind, id, channelId, row, 'delivery_unknown', user, false, decisionId)
    audit({ actor: user.id, actorName: user.name ?? '', actorKind: 'user', action: 'hitl.respond', targetKind: kind, targetId: id, detail: { decisionId, channelId, agentId, result: 'delivery_unknown', error: msg } })
    log.error(`[hitl] 原生应答结果未知(${kind}:${id}):`, msg)
    throw new AppError(502, 'DELIVERY_UNKNOWN', `引擎应答结果未知,已标记待人工核对(不会重试、不视为成功):${msg}`)
  }
  finally {
    // 决策上下文必须退出:否则后续同 id 的适配器 resolve() 会被静默吞掉广播
    registry.endDecision(kind as HitlKind, id)
  }
}

/** 首次决策/首次快照前执行一次启动对账(重启不自动批准) */
function ensureReconciledOnce(): void {
  if (g.__hitlReconciledAt) return
  reconcileHitlOnStartup()
}

/**
 * 惰性启动对账入口(供 HITL 端点调用):
 * 进程重启后第一次触碰 HITL 面(pending 快照 / 决策)即收敛上一进程遗留的待办,
 * 无需依赖插件改动(插件若调用 `reconcileHitlOnStartup()` 更早,也完全等价,幂等)。
 */
export function ensureHitlReconciled(): void {
  ensureReconciledOnce()
}

function safeParseQuestions(json: string): AepHitlQuestion[] {
  try {
    const raw = JSON.parse(json) as unknown
    return Array.isArray(raw) ? raw as AepHitlQuestion[] : []
  }
  catch {
    return []
  }
}

/** 落定通知:定向给处理人 + 当前 active 成员(退出者不再打扰;eventId 幂等) */
function notifyResolved(
  manager: HitlRuntimePort | null,
  kind: string,
  id: string,
  channelId: string,
  row: HitlRequestRow | undefined,
  status: HitlStatus,
  user: HitlActingUser,
  nativeConfirmed: boolean,
  decisionId: string,
): void {
  if (!manager || !channelId) return
  try {
    const recipients = new Set<string>([user.id])
    if (row?.responderUserId) recipients.add(row.responderUserId)
    for (const m of manager.groupChat.members.listActiveByChannel(channelId)) recipients.add(m.userId)
    for (const recipientUserId of recipients) {
      manager.notifyUser({
        recipientUserId,
        channelId,
        type: 'hitl_resolved',
        eventId: `hitl_resolved:${kind}:${id}`,
        title: status === 'approved' ? '审批已通过' : status === 'rejected' ? '审批已拒绝' : '待办已处理',
        body: `处理人=${user.name || user.id};状态=${status}`,
        hitlKind: kind,
        hitlId: id,
        payload: { status, nativeConfirmed, by: user.id, decisionId },
      })
    }
  }
  catch (err) {
    log.warn('[hitl] 落定通知投递失败(不影响决策):', err instanceof Error ? err.message : err)
  }
}
