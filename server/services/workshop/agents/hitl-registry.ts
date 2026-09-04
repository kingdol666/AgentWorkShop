/**
 * HitlRegistry —— 全局"待人工处理"登记处(进程内,globalThis 单例)。
 *
 * 把两条互相独立的 HITL 链路统一成一个可发现的视图:
 *  - omp-dialog   omp `rpc-ui` 的 extension_ui_request 对话框(harness-terminal 登记;
 *                 park/暂停计时语义由 terminal 订阅者状态驱动,本模块只存状态与广播)
 *  - dcw-approval 手动确认模式的工具执行审批(tool-approvals 登记/裁决)
 *
 * 职责:登记(hitl.request)/ 落定(hitl.resolved)事件经 per-channel 订阅扇出,
 * 由 workshop ws hub 转接进 AEP 频道流(seq/落库);统一 REST 快照与应答路由
 * (/api/workshop/hitl/pending、/respond)也读本模块。裁决留痕仍在各链路
 * (approval_history / audit),这里不做持久化 —— omp 对话框本就随子进程消亡。
 *
 * 定位:模块级单例(globalThis 跨 HMR 存活,与 tool-approvals 同风格);
 * 不 import runtime/manager(避免循环初始化),channelId 由插件注入 resolver 解析。
 */
import type { AepHitlItem, AepHitlResolved } from '../../../../shared/workshop-protocol'

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
}

class HitlRegistryService {
  /** key = `${kind}:${id}`;value 为 AepHitlItem(parkDeadline 单独存,避免污染协议对象) */
  private items = new Map<string, AepHitlItem>()
  private parkDeadline = new Map<string, string | null>()
  private listeners = new Map<string, Set<HitlListener>>()
  /** agentId → { channelId, agentName }(插件装配 repos 后注入;避免反向依赖 manager) */
  private resolver: ((agentId: string) => { channelId: string, agentName: string } | null) | null = null

  configureResolver(fn: (agentId: string) => { channelId: string, agentName: string } | null): void {
    this.resolver = fn
  }

  private key(kind: HitlKind, id: string): string {
    return `${kind}:${id}`
  }

  /** 登记(幂等:同 kind+id 重复登记只更新 parkDeadline,不重发事件) */
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
    }
    this.items.set(key, item)
    this.parkDeadline.set(key, item.expiresAt ?? null)
    this.emit({ type: 'hitl.request', payload: item, agentId: item.agentId })
  }

  /**
   * 落定(幂等:未登记的 key 返回 false —— 上层据此实现 409 ALREADY_RESOLVED)。
   * outcome:answered(人类已答复/批准/拒绝)/ cancelled(人工放弃或 omp 撤销)/ expired(超时)。
   */
  resolve(kind: HitlKind, id: string, outcome: HitlOutcome, by?: string): boolean {
    const key = this.key(kind, id)
    const item = this.items.get(key)
    if (!item) return false
    this.items.delete(key)
    this.parkDeadline.delete(key)
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
