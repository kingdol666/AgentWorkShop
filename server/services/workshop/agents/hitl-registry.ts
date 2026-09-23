/**
 * HitlRegistry —— 全局"待人工处理"登记处(进程内缓存门面,globalThis 单例)。
 *
 * 把两条互相独立的 HITL 链路统一成一个可发现的视图:
 *  - omp-dialog   omp `rpc-ui` 的 extension_ui_request 对话框(harness-terminal 登记;
 *                 park/暂停计时语义由 terminal 订阅者状态驱动,本模块只存状态与广播)
 *  - dcw-approval 手动确认模式的工具执行审批(tool-approvals 登记/裁决)
 *  - codex/opencode/dsh/claude/qwen/hermes 各 harness 的原生审批与提问(adapter 登记)
 *
 * 职责:登记(hitl.request)/ 落定(hitl.resolved)事件经 per-channel 订阅扇出,
 * 由 workshop ws hub 转接进 AEP 频道流(seq/落库);统一 REST 快照与应答路由
 * (/api/workshop/hitl/pending、/respond)也读本模块。
 *
 * **v17 定位变更(主计划 §13.4):本模块降级为缓存门面,事实源是 `hitl_requests` 表。**
 *  - register() 在登记内存快照的同时**尽力持久化**一行(冻结策略快照 eligibleUserIds/
 *    memberGenerations/policyVersion)并按审批策略生成定向通知(manager.notifyUser,
 *    禁止 broadcastPeerEvent 全局广播)。持久化失败只降级(打日志),绝不抛出 ——
 *    旧测试脚手架在 :memory: 上只装 11 个 repo、没有群聊层仓储,register 必须照常工作。
 *  - resolve() 保持**旧语义完全不变**(未登记的 key 返回 false → 上层 409 ALREADY_RESOLVED);
 *    适配器仍在原生应答成功后调用它。
 *  - settle() 供决策服务(hitl-decision)落定:带持久化状态与 nativeConfirmed 的 hitl.resolved。
 *
 * 依赖方向:本模块**不** import runtime/manager(避免循环初始化)——运行时能力经
 * `configureHitlRuntime()` 注入(测试显式注入),缺省回落到插件挂载的 globalThis.__workshopManager。
 */
import { createLogger } from '../logger'
import type { AepHitlItem, AepHitlQuestion, AepHitlRequestType, AepHitlResolved, AepHitlStatus } from '../../../../shared/workshop-protocol'
import type { ChannelRow } from '../db/database'
import type { HitlPolicySnapshot, HitlRequestRepo } from '../db/hitl-request.repo'
import type { ChannelMemberRepo } from '../db/channel-member.repo'

const log = createLogger('workshop.hitl-registry')

export type HitlKind = AepHitlItem['kind']
export type HitlOutcome = AepHitlResolved['outcome']

/** hitl 帧事件(ws hub 按 channelId 转接进频道流) */
export interface HitlEvent {
  type: 'hitl.request' | 'hitl.resolved'
  payload: AepHitlItem | AepHitlResolved
  agentId?: string
}

type HitlListener = (e: HitlEvent) => void

/** 登记入参(channelId/agentName 可由 resolver 补全;缺 channelId 的条目仅入全局快照) */
export interface HitlRegisterInput {
  kind: HitlKind
  id: string
  agentId: string
  agentName?: string
  channelId?: string
  pid?: number
  method?: AepHitlItem['method']
  title: string
  detail?: string
  options?: string[]
  message?: string
  createdAt?: string
  expiresAt?: string | null
  // ===== v17 增量(全部可选:旧调用方零改动)=====
  /** question(提问) | approval(授权);缺省按 kind/method 推定 */
  requestType?: AepHitlRequestType
  /** 引擎原生 requestId(与 id 区分:omp 用 id,codex/opencode 另有 rpcId) */
  nativeRequestId?: string
  /** 引擎会话 id(重启恢复对账用) */
  sessionId?: string
  /** harness 标识(mock/omp/codex/opencode/dsh/claude/qwen/hermes) */
  harness?: string
  /** 结构化多问题(question 型;单选/多选/自由文本)**原样全量**承载,不得只取第一题 */
  questions?: AepHitlQuestion[]
  /** 结构化应答 schema(引擎原生) */
  schema?: Record<string, unknown>
}

/**
 * HITL 运行时能力面(manager 的**结构性**子集)。
 * 只声明本层真正消费的方法,避免 import runtime/manager 造成模块循环初始化;
 * 真实 manager 直接满足该结构(丁点不改 manager.ts)。
 */
export interface HitlRuntimePort {
  groupChat: {
    hitl: HitlRequestRepo
    members: ChannelMemberRepo
  }
  notifyUser(input: {
    recipientUserId: string
    channelId?: string | null
    type: 'mention' | 'agent_reply' | 'hitl_request' | 'hitl_resolved' | 'member'
    eventId: string
    title?: string
    body?: string
    hitlKind?: string | null
    hitlId?: string | null
    payload?: Record<string, unknown>
  }): { id: string, inserted: boolean }
  /** 读视角可见 Channel(admin → 全部) */
  listChannelsVisibleTo(user: { id: string, role?: string }): ChannelRow[]
  /** 本人 owner 的 + owner=NULL 遗留公共(**只读兼容**,不得用于放宽管理面) */
  listChannelsForUser(userId: string): ChannelRow[]
  requireChannelMember(channelId: string, user: { id: string, role?: string }): ChannelRow
  requireCanApprove(
    channelId: string,
    user: { id: string, role?: string },
    opts?: { policy?: string, snapshot?: { eligibleUserIds?: string[], memberGenerations?: Record<string, number> } },
  ): ChannelRow
  /** 旧口径守卫(owner / 遗留公共);仅用于无持久化行的历史条目 */
  getChannelForUser(channelId: string, userId: string): ChannelRow
  findChannelAgentById(agentId: string): { id: string, channelId: string, templateId: string | null } | undefined
  /** 原生应答传导(codex/opencode/dsh/claude/qwen/hermes) */
  respondHarnessHitl(agentId: string, kind: string, id: string, outcome: {
    confirmed?: boolean
    cancelled?: boolean
    value?: string
    response?: string
    comment?: string
  }): Promise<void>
}

/** kind → harness 推定(omp-dialog 由 harness-terminal 登记,不回传 harness 时的兜底) */
const KIND_HARNESS: Record<string, string> = {
  'omp-dialog': 'omp',
  'dcw-approval': 'dcw',
  'codex-approval': 'codex',
  'opencode-permission': 'opencode',
  'dsh-permission': 'dsh',
  'claude-permission': 'claude',
  'qwen-permission': 'qwen',
  'hermes-permission': 'hermes',
}

export function harnessOfKind(kind: string): string {
  return KIND_HARNESS[kind] ?? kind
}

/**
 * requestType 推定(§8 question/approval 必须分开建模):
 * - 显式声明优先;
 * - dcw/codex 的 confirm 类审批 = approval;
 * - input/select/editor 形态 = question(自由文本/选择即"内容是答案")。
 */
export function requestTypeOf(input: { kind: string, requestType?: AepHitlRequestType, method?: AepHitlItem['method'] }): AepHitlRequestType {
  if (input.requestType === 'question' || input.requestType === 'approval') return input.requestType
  if (input.method === 'input' || input.method === 'select' || input.method === 'editor') return 'question'
  return 'approval'
}

/**
 * 引擎原生 questions[] 归一化(§13.5:必须**全量**承载,不得只取第一题)。
 * 兼容 codex `tool/requestUserInput`({id,header,question,options:[{label,description}]})
 * 与 opencode `question.asked`({id,header,question,options,multiple})两种形态;
 * 无法解析的条目按自由文本保留,绝不静默丢弃(丢题 = 丢答案)。
 */
export function normalizeHitlQuestions(raw: unknown): AepHitlQuestion[] {
  if (!Array.isArray(raw)) return []
  return raw.map((q, i) => {
    const o = (q ?? {}) as Record<string, unknown>
    const rawOptions = Array.isArray(o.options) ? o.options : (Array.isArray(o.choices) ? o.choices : [])
    const options = rawOptions
      .map((op) => {
        // 字符串选项(部分 ACP/omp 形态)与对象选项都接
        if (typeof op === 'string') return { label: op }
        const oo = (op ?? {}) as Record<string, unknown>
        const label = String(oo.label ?? oo.value ?? oo.title ?? oo.name ?? '')
        const description = oo.description ?? oo.detail
        return { label, description: description ? String(description) : undefined }
      })
      .filter(x => x.label !== '')
    const question = String(o.question ?? o.label ?? o.header ?? o.prompt ?? `问题 ${i + 1}`)
    return {
      id: String(o.id ?? o.questionId ?? i),
      header: o.header !== undefined ? String(o.header) : undefined,
      question,
      options: options.length > 0 ? options : undefined,
      multiSelect: o.multiSelect === true || o.multiple === true || o.multi === true,
      // 无选项 = 自由文本;有选项时是否允许补充文本由引擎显式声明
      freeText: o.freeText === true || o.allowFreeText === true || options.length === 0,
    } satisfies AepHitlQuestion
  })
}

/**
 * 结构化答案的线上编码(适配器与决策服务共用;放在本模块以保持 adapter 的依赖图轻量)。
 *
 * 为什么需要信封:manager.respondHarnessHitl 的 outcome 契约是**冻结**的(只有 value:string),
 * 而多问题必须逐题回传。约定:单问题 = 裸文本(旧行为不变);多问题 = JSON 信封
 * `{"x-aw-hitl-answers":[{id,answer},…]}`。非信封字符串一律按单答案处理。
 */
const ANSWER_ENVELOPE = 'x-aw-hitl-answers'

/** 编码:单问题 → 裸文本;多问题 → 信封 JSON */
export function encodeHitlAnswers(answers: Array<{ id: string, answer: string }>, fallback = ''): string {
  if (answers.length === 0) return fallback
  if (answers.length === 1) return answers[0]!.answer
  return JSON.stringify({ [ANSWER_ENVELOPE]: answers })
}

/** 解码(适配器用):非信封格式返回 null,调用方按单答案处理 */
export function decodeHitlAnswers(value: string | undefined): Array<{ id: string, answer: string }> | null {
  if (!value || value[0] !== '{') return null
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    const raw = parsed?.[ANSWER_ENVELOPE]
    if (!Array.isArray(raw)) return null
    return raw.map((r) => {
      const o = (r ?? {}) as Record<string, unknown>
      return { id: String(o.id ?? ''), answer: String(o.answer ?? '') }
    })
  }
  catch {
    return null
  }
}

/** 运行时注入点(测试/嵌入场景);缺省回落 globalThis.__workshopManager(插件挂载) */
let runtimeResolver: (() => HitlRuntimePort | null) | null = null

export function configureHitlRuntime(fn: (() => HitlRuntimePort | null) | null): void {
  runtimeResolver = fn
}

/** 解析 HITL 运行时能力面;不可用返回 null(旧测试脚手架/未装配) */
export function resolveHitlRuntime(): HitlRuntimePort | null {
  if (runtimeResolver) {
    try {
      return runtimeResolver()
    }
    catch {
      return null
    }
  }
  const g = globalThis as typeof globalThis & { __workshopManager?: HitlRuntimePort }
  return g.__workshopManager ?? null
}

/** 频道行读取(内部快照用;admin 视角 = 全量,无需额外权限面) */
export function channelRowOf(manager: HitlRuntimePort, channelId: string): ChannelRow | undefined {
  try {
    return manager.listChannelsVisibleTo({ id: '__hitl__', role: 'admin' }).find(c => c.id === channelId)
  }
  catch {
    return undefined
  }
}

/**
 * 冻结策略快照(§13.4:资格判定 = 创建时资格 ∩ 当前资格)。
 * - eligibleUserIds = 创建时 active 成员 ∪ owner;
 * - memberGenerations = 其会员代数(退出再加入 → 代数 +1,旧请求资格不恢复);
 * - policyVersion = channels.version(群聊维度变更 +1),policy = channels.approval_policy。
 */
export function buildHitlPolicySnapshot(
  manager: HitlRuntimePort,
  channelId: string,
  createdAt = new Date().toISOString(),
): HitlPolicySnapshot {
  const channel = channelRowOf(manager, channelId)
  const eligible = new Set<string>()
  const generations: Record<string, number> = {}
  for (const m of manager.groupChat.members.listActiveByChannel(channelId)) {
    eligible.add(m.userId)
    generations[m.userId] = m.generation
  }
  const owner = channel?.ownerUserId ?? null
  if (owner) {
    eligible.add(owner)
    // owner 成员行缺省时(迁移窗口)按 ensureOwner 的初值 1 记账:
    // requireCanApprove 的代数比对在 requireChannelMember 自愈 owner 行之后进行,故恒等。
    if (generations[owner] === undefined) generations[owner] = 1
  }
  return {
    policy: channel?.approvalPolicy ?? 'owner_only',
    policyVersion: channel?.version ?? 0,
    eligibleUserIds: [...eligible],
    memberGenerations: generations,
    createdAt,
  }
}

class HitlRegistryService {
  /** key = `${kind}:${id}`;value 为 AepHitlItem(parkDeadline 单独存,避免污染协议对象) */
  private items = new Map<string, AepHitlItem>()
  private parkDeadline = new Map<string, string | null>()
  private listeners = new Map<string, Set<HitlListener>>()
  /** agentId → { channelId, agentName }(插件装配 repos 后注入;避免反向依赖 manager) */
  private resolver: ((agentId: string) => { channelId: string, agentName: string } | null) | null = null
  /** 已持久化的条目(防止降级重试时重复写;register 已保证幂等,这里是双保险) */
  private persisted = new Set<string>()
  /**
   * 决策上下文标记(hitl-decision 在传导原生应答前后 begin/end):
   * 适配器应答成功后会调用 resolve() —— 处于决策上下文时只清缓存、**不**广播,
   * 由决策服务的 settle() 统一广播带 status/nativeConfirmed 的 hitl.resolved(一次请求一帧)。
   */
  private deciding = new Set<string>()

  configureResolver(fn: (agentId: string) => { channelId: string, agentName: string } | null): void {
    this.resolver = fn
  }

  private key(kind: HitlKind, id: string): string {
    return `${kind}:${id}`
  }

  /**
   * 登记(幂等:同 kind+id 重复登记直接 early-return,不重发事件、不重写持久化行)。
   * v17:登记时尽力持久化事实行 + 生成定向审批通知;任何持久化异常都只降级打日志。
   */
  register(input: HitlRegisterInput): void {
    const key = this.key(input.kind, input.id)
    const existing = this.items.get(key)
    if (existing) return
    let channelId = input.channelId ?? ''
    let agentName = input.agentName ?? ''
    if ((!channelId || !agentName) && this.resolver) {
      try {
        const resolved = this.resolver(input.agentId)
        channelId = channelId || resolved?.channelId || ''
        agentName = agentName || resolved?.agentName || ''
      }
      catch { /* resolver 异常不阻断登记 */ }
    }
    // 策略快照先取:item 需要带 policy/approvalPolicyVersion 供前端展示与 ws 帧消费
    const manager = resolveHitlRuntime()
    let snapshot: HitlPolicySnapshot | null = null
    if (manager && channelId) {
      try {
        snapshot = buildHitlPolicySnapshot(manager, channelId)
      }
      catch (err) {
        log.warn('[hitl] 策略快照构建失败(降级为无快照):', err instanceof Error ? err.message : err)
      }
    }
    const requestType = requestTypeOf(input)
    const item: AepHitlItem = {
      kind: input.kind,
      id: input.id,
      channelId,
      agentId: input.agentId,
      agentName: agentName || input.agentId.slice(0, 8),
      pid: input.pid,
      method: input.method,
      title: input.title,
      detail: input.detail,
      options: input.options,
      message: input.message,
      createdAt: input.createdAt ?? new Date().toISOString(),
      expiresAt: input.expiresAt ?? null,
      // v17 增量
      requestType,
      nativeRequestId: input.nativeRequestId,
      sessionId: input.sessionId,
      harness: input.harness ?? harnessOfKind(input.kind),
      questions: input.questions,
      schema: input.schema,
      status: 'pending',
      policy: snapshot?.policy,
      approvalPolicyVersion: snapshot?.policyVersion,
      channelVersion: snapshot?.policyVersion,
    }
    this.items.set(key, item)
    this.parkDeadline.set(key, item.expiresAt ?? null)
    // ① 事实落库(事实源);② 广播;③ 定向通知(禁止全局广播)
    this.persist(item, snapshot)
    this.emit({ type: 'hitl.request', payload: item, agentId: item.agentId })
    this.notifyRequest(item, snapshot)
  }

  /**
   * 落定(幂等:未登记的 key 返回 false —— 上层据此实现 409 ALREADY_RESOLVED)。
   * outcome:answered(人类已答复/批准/拒绝)/ cancelled(人工放弃或 omp 撤销)/ expired(超时)。
   * 适配器在原生应答成功后调用;细粒度状态由决策服务的 settle() 承载。
   */
  resolve(kind: HitlKind, id: string, outcome: HitlOutcome, by?: string): boolean {
    const key = this.key(kind, id)
    const item = this.items.get(key)
    if (!item) return false
    this.items.delete(key)
    this.parkDeadline.delete(key)
    // 决策上下文:广播交给 settle()(同样返回 true,调用方语义不变)
    if (this.deciding.has(key)) return true
    const payload: AepHitlResolved = {
      kind,
      id,
      channelId: item.channelId,
      agentId: item.agentId,
      outcome,
      by,
    }
    this.emit({ type: 'hitl.resolved', payload, agentId: item.agentId })
    return true
  }

  /** 进入决策上下文(见 deciding 注释;必须在 finally 中 endDecision) */
  beginDecision(kind: HitlKind, id: string): void {
    this.deciding.add(this.key(kind, id))
  }

  /** 退出决策上下文 */
  endDecision(kind: HitlKind, id: string): void {
    this.deciding.delete(this.key(kind, id))
  }

  /**
   * 决策服务落定:带持久化细粒度状态与 nativeConfirmed 的 hitl.resolved。
   * 内存条目已被适配器 resolve 掉时,靠调用方传入的 channelId/agentId 补全并广播
   * (决策上下文的唯一广播出口);非决策上下文且条目不存在 → 返回 false,不重复广播。
   */
  settle(kind: HitlKind, id: string, opts: {
    outcome: HitlOutcome
    by?: string
    status?: AepHitlStatus
    nativeConfirmed?: boolean
    /** 条目已被适配器清缓存时的兜底路由信息(决策服务从持久化行取得) */
    channelId?: string
    agentId?: string
  }): boolean {
    const key = this.key(kind, id)
    const item = this.items.get(key)
    if (!item && !opts.channelId) return false
    this.items.delete(key)
    this.parkDeadline.delete(key)
    const payload: AepHitlResolved = {
      kind,
      id,
      channelId: item?.channelId || opts.channelId || '',
      agentId: item?.agentId || opts.agentId || '',
      outcome: opts.outcome,
      by: opts.by,
      status: opts.status,
      nativeConfirmed: opts.nativeConfirmed,
    }
    this.emit({ type: 'hitl.resolved', payload, agentId: payload.agentId })
    return true
  }

  /** 查询单条(应答路由用:取 pid / channelId / method) */
  find(kind: HitlKind, id: string): AepHitlItem | null {
    return this.items.get(this.key(kind, id)) ?? null
  }

  /** park 截止更新(harness-terminal 订阅者增减时静默修正;null = 计时暂停) */
  setParkDeadline(kind: HitlKind, id: string, expiresAt: string | null): void {
    const key = this.key(kind, id)
    if (!this.items.has(key)) return
    this.parkDeadline.set(key, expiresAt)
    const item = this.items.get(key)!
    item.expiresAt = expiresAt
  }

  /** 全局(或指定 channel)待处理快照 */
  snapshot(channelId?: string): AepHitlItem[] {
    return [...this.items.values()].filter(i => !channelId || i.channelId === channelId)
  }

  /** per-channel 事件订阅(ws hub ensureStream 时接线;返回退订函数) */
  subscribe(channelId: string, fn: HitlListener): () => void {
    let set = this.listeners.get(channelId)
    if (!set) {
      set = new Set()
      this.listeners.set(channelId, set)
    }
    set.add(fn)
    return () => {
      set.delete(fn)
      if (set.size === 0) this.listeners.delete(channelId)
    }
  }

  /** 持久化事实行(失败只降级:旧脚手架无群聊层仓储时 register 必须照常工作) */
  private persist(item: AepHitlItem, snapshot: HitlPolicySnapshot | null): void {
    const manager = resolveHitlRuntime()
    if (!manager || !item.channelId) return
    const key = this.key(item.kind, item.id)
    if (this.persisted.has(key)) return
    try {
      const repo = manager.groupChat.hitl
      if (!repo.findById(item.id)) {
        repo.create({
          id: item.id,
          kind: item.kind,
          requestType: requestTypeOf(item),
          nativeRequestId: item.nativeRequestId,
          channelId: item.channelId,
          agentId: item.agentId,
          agentName: item.agentName,
          sessionId: item.sessionId,
          harness: item.harness,
          mode: item.requestType,
          title: item.title,
          detail: item.detail,
          options: item.options,
          questions: item.questions,
          schema: item.schema,
          policy: snapshot?.policy ?? 'owner_only',
          policySnapshot: snapshot ?? buildHitlPolicySnapshot(manager, item.channelId),
          expiresAt: item.expiresAt ?? null,
        })
      }
      this.persisted.add(key)
    }
    catch (err) {
      log.warn('[hitl] 持久化登记失败(降级为纯内存):', err instanceof Error ? err.message : err)
    }
  }

  /**
   * 登记时按策略生成**定向**审批通知(§8 步骤 3)。
   * - any_member:创建时冻结的合格成员全体(∩ 当前 active,退出者不再打扰);
   * - owner_only:仅 owner(其余成员无权决策,通知即噪音)。
   * eventId 幂等(`hitl_request:${kind}:${id}`),重复投递不产生重复弹窗。
   */
  private notifyRequest(item: AepHitlItem, snapshot: HitlPolicySnapshot | null): void {
    const manager = resolveHitlRuntime()
    if (!manager || !snapshot || !item.channelId) return
    try {
      const owner = channelRowOf(manager, item.channelId)?.ownerUserId ?? null
      const active = new Set(manager.groupChat.members.listActiveByChannel(item.channelId).map(m => m.userId))
      if (owner) active.add(owner)
      const policy = snapshot.policy
      const recipients = policy === 'any_member'
        ? snapshot.eligibleUserIds.filter(u => active.has(u))
        : (owner ? [owner] : [])
      for (const recipientUserId of recipients) {
        manager.notifyUser({
          recipientUserId,
          channelId: item.channelId,
          type: 'hitl_request',
          eventId: `hitl_request:${item.kind}:${item.id}`,
          title: item.title,
          body: item.detail ?? '',
          hitlKind: item.kind,
          hitlId: item.id,
          payload: {
            requestType: requestTypeOf(item),
            harness: item.harness,
            agentId: item.agentId,
            agentName: item.agentName,
            policy,
            approvalPolicyVersion: snapshot.policyVersion,
            questions: item.questions ?? [],
          },
        })
      }
    }
    catch (err) {
      log.warn('[hitl] 登记通知投递失败(不影响待办):', err instanceof Error ? err.message : err)
    }
  }

  private emit(e: HitlEvent): void {
    const channelId = (e.payload as AepHitlItem).channelId
    const set = channelId ? this.listeners.get(channelId) : undefined
    if (!set) return
    for (const fn of set) {
      try {
        fn(e)
      }
      catch { /* 单个订阅者异常不影响扇出 */ }
    }
  }
}

const g = globalThis as typeof globalThis & { __hitlRegistry?: HitlRegistryService }

export function getHitlRegistry(): HitlRegistryService {
  g.__hitlRegistry ??= new HitlRegistryService()
  return g.__hitlRegistry
}

/** 插件接线用别名(语义直白) */
export const configureHitlResolver = (fn: (agentId: string) => { channelId: string, agentName: string } | null): void =>
  getHitlRegistry().configureResolver(fn)

/** per-channel 事件订阅(ws hub 建流时挂接;hitl.request/hitl.resolved 扇出) */
export function subscribeHitlEvents(channelId: string, fn: HitlListener): () => void {
  return getHitlRegistry().subscribe(channelId, fn)
}
