/**
 * 群聊 store(v17 主计划 §5-§7 的前端事实层)。
 *
 * 数据来源三路,共用同一份状态:
 *  ① 频道流 chat.* 帧(chat.message / chat.delivery.status / chat.member / chat.settings);
 *  ② channel.snapshot 的群聊侧基线(payload.chat:成员/最近消息/设置/能力);
 *  ③ REST 历史/名册/权限(断线后补齐 WS 窗口外的数据)。
 *
 * **幂等是硬约束**:同一条 chat.message 可能同时来自实时帧、快照重放与 REST 回填,
 * 三路一律按消息 `id` 去重(投递按 deliveryId、成员按 userId、通知按 eventId),
 * 重复帧绝不产生第二行 —— 否则刷新/重连后时间线会整体翻倍。
 *
 * 排序:createdAt 升序 + 插入序稳定(同毫秒消息保持先到先排)。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  AepChannelChatSettings,
  AepChannelMember,
  AepChatDelivery,
  AepChatMention,
  AepChatMessage,
  AepChatSnapshot,
  AepEnvelope,
} from '#shared/workshop-protocol'
import { useUserStore } from './user'
import { narrowFetch } from './narrow-fetch'
import { apiErrorMessage } from '@/app/utils/api-error'

/** `manager.channelPermissionsOf` 的能力视图(服务端单一事实源;前端只据此渲染按钮) */
export interface ChatPermissions {
  isOwner: boolean
  isMember: boolean
  isAdmin: boolean
  status: string | null
  role: string | null
  canJoin: boolean
  canPost: boolean
  canInvokeAgent: boolean
  canApprove: boolean
  canManage: boolean
}

/** 发送响应(POST /chat/messages) */
export interface ChatSendResult {
  message: AepChatMessage
  deliveries: Array<{ deliveryId: string, agentId: string, status: string }>
  duplicates: boolean
  unresolvedMentions: string[]
  mentions: AepChatMention[]
}

/** 引用/回复目标(ChatTimeline 「回复」→ Composer 顶部 chip) */
export interface ChatReplyTarget {
  channelId: string
  messageId: string
  senderName: string
  excerpt: string
}

interface ApiEnvelope<T> {
  code: number | string
  message?: string
  data?: T | null
}

/** axios 错误形状(仅取错误码/文案用;避免把 axios 类型引入 store) */
interface HttpErrorLike {
  response?: { status?: number, data?: { code?: string | number, message?: string } }
  status?: number
  statusCode?: number
  data?: { code?: string | number, message?: string }
  message?: string
}

/** HTTP 状态码(axios / ofetch 双形态) */
export function chatErrorStatus(err: unknown): number {
  const e = (err ?? {}) as HttpErrorLike
  return Number(e.response?.status ?? e.status ?? e.statusCode ?? 0)
}

/** 业务错误码(VERSION_CONFLICT / CHAT_DISABLED / ALREADY_RESOLVED …) */
export function chatErrorCode(err: unknown): string {
  const e = (err ?? {}) as HttpErrorLike
  const code = e.response?.data?.code ?? e.data?.code
  return code === undefined || code === null ? '' : String(code)
}

/**
 * 统一错误文案:axios 把服务端信封放在 `response.data`,ofetch 放在 `data`,
 * 项目的 `apiErrorMessage` 只识别后者 —— 这里先补 axios 分支再回落到它。
 */
export function chatErrorMessage(err: unknown): string {
  const e = (err ?? {}) as HttpErrorLike
  const msg = e.response?.data?.message ?? e.data?.message
  if (typeof msg === 'string' && msg.trim()) return msg.trim()
  return apiErrorMessage(err)
}

/** 同一 createdAt 时保持插入序:找到第一个「严格更晚」的下标插入 */
function insertSorted(list: AepChatMessage[], msg: AepChatMessage): void {
  let idx = list.length
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]!.createdAt <= msg.createdAt) {
      idx = i + 1
      break
    }
    idx = i
  }
  list.splice(idx, 0, msg)
}

export const useChatStore = defineStore('workshop.chat', () => {
  const messages = ref<Record<string, AepChatMessage[]>>({})
  const members = ref<Record<string, AepChannelMember[]>>({})
  const settings = ref<Record<string, AepChannelChatSettings>>({})
  const deliveries = ref<Record<string, Record<string, AepChatDelivery>>>({})
  const permissions = ref<Record<string, ChatPermissions | null>>({})
  /**
   * 已成功拉过历史的频道集合。
   *
   * 注意:「还能不能继续往前拉」由 `hasMoreHistory` 决定,本集合只表示"至少拉过一次"
   * (用于跳过重复的首屏加载)。两者语义不同,不要互相替代。
   */
  const loadedChannels = ref<Set<string>>(new Set())
  /** 每频道「还有更早历史」标志(loadHistory/loadEarlier 判定为空后置 false) */
  const hasMoreHistory = ref<Record<string, boolean>>({})
  const loadingHistory = ref<Record<string, boolean>>({})
  /** 回复目标(引用链;Composer 消费,发完即清) */
  const replyTarget = ref<ChatReplyTarget | null>(null)

  function listOf(channelId: string): AepChatMessage[] {
    return (messages.value[channelId] ??= [])
  }

  /** 幂等 upsert:同 id 只保留一行(实时帧 / 快照重放 / REST 回填三路共用) */
  function upsertMessage(msg: AepChatMessage, channelId?: string): boolean {
    const cid = channelId || msg.channelId
    if (!cid || !msg?.id) return false
    const list = listOf(cid)
    const idx = list.findIndex(m => m.id === msg.id)
    if (idx >= 0) {
      // 同一消息的后续帧只做字段收敛(不重排、不重复插入)
      list[idx] = { ...list[idx]!, ...msg }
      return false
    }
    insertSorted(list, msg)
    return true
  }

  function upsertDelivery(d: AepChatDelivery): void {
    const cid = d.channelId
    if (!cid || !d.deliveryId) return
    const byChannel = (deliveries.value[cid] ??= {})
    byChannel[d.deliveryId] = { ...byChannel[d.deliveryId], ...d }
  }

  /** 频道流 chat.* 帧消费(由 useWorkshopWs 在 seq 守卫之后调用,重复 seq 帧不会到这里) */
  function applyEnvelope(e: AepEnvelope): void {
    switch (e.type) {
      case 'chat.message':
        upsertMessage(e.payload as AepChatMessage, e.channelId || undefined)
        break
      case 'chat.delivery.status':
        upsertDelivery(e.payload as AepChatDelivery)
        break
      case 'chat.member': {
        const m = e.payload as AepChannelMember & { op: string }
        const cid = e.channelId
        if (!cid || !m?.userId) break
        const list = (members.value[cid] ??= [])
        const idx = list.findIndex(x => x.userId === m.userId)
        const next: AepChannelMember = {
          userId: m.userId,
          displayName: m.displayName ?? null,
          role: m.role,
          status: m.status,
          joinedAt: m.joinedAt,
          leftAt: m.leftAt ?? null,
        }
        if (idx >= 0) list[idx] = next
        else list.push(next)
        break
      }
      case 'chat.settings': {
        const s = e.payload as AepChannelChatSettings
        const cid = s?.id || e.channelId
        if (cid) settings.value[cid] = s
        break
      }
    }
  }

  /**
   * channel.snapshot 的群聊侧基线(payload.chat / payload.permissions)。
   * 消息走 upsert(不 replace):重连快照只含最近 50 条,替换会抹掉已翻页加载的更早历史。
   */
  function applySnapshot(channelId: string, chat?: AepChatSnapshot | null, perms?: ChatPermissions | null): void {
    if (!channelId) return
    if (chat?.channel) settings.value[channelId] = chat.channel
    if (Array.isArray(chat?.members)) members.value[channelId] = chat.members.map(m => ({ ...m }))
    for (const msg of chat?.chatMessages ?? []) upsertMessage(msg, channelId)
    // 能力视图优先取群聊侧投影;退化时取快照顶层 permissions
    if (chat?.permissions) permissions.value[channelId] = chat.permissions as ChatPermissions
    else if (perms !== undefined) permissions.value[channelId] = (perms as ChatPermissions | null) ?? null
    loadedChannels.value.add(channelId)
  }

  async function request<T>(path: string, init: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown, query?: Record<string, string | number | undefined> } = {}): Promise<T> {
    const token = useUserStore().token
    const qs = init.query
      ? `?${Object.entries(init.query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}`
      : ''
    const res = await narrowFetch<ApiEnvelope<T>>(`${path}${qs}`, {
      method: init.method ?? 'GET',
      body: init.body as Record<string, unknown> | undefined,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    if (res.code !== 0 || res.data == null) throw new Error(res.message ?? '群聊请求失败')
    return res.data
  }

  /**
   * 拉取群聊历史(`before` = 上一页最旧消息 id;缺省拉最新一页)。
   * 只 upsert 不替换 —— 与 WS 实时帧并存时不做"谁覆盖谁"的假设。
   * @returns 是否可能还有更早历史
   */
  async function loadHistory(channelId: string, opts: { before?: string, limit?: number } = {}): Promise<boolean> {
    if (typeof window === 'undefined' || !channelId) return false
    const limit = opts.limit ?? 50
    loadingHistory.value[channelId] = true
    try {
      const data = await request<{ messages: AepChatMessage[], nextCursor: string | null, permissions: ChatPermissions | null }>(
        `/api/workshop/channels/${channelId}/chat/messages`,
        { query: { before: opts.before, limit } },
      )
      for (const m of data.messages ?? []) upsertMessage(m, channelId)
      if (data.permissions) permissions.value[channelId] = data.permissions
      loadedChannels.value.add(channelId)
      const more = (data.messages?.length ?? 0) >= limit
      hasMoreHistory.value[channelId] = more
      return more
    }
    finally {
      loadingHistory.value[channelId] = false
    }
  }

  /** 名册(成员可见;非成员会被 403 拒绝 → 保持空名册,不抛给 UI) */
  async function loadMembers(channelId: string): Promise<void> {
    if (typeof window === 'undefined' || !channelId) return
    try {
      const data = await request<{ members: AepChannelMember[], permissions: ChatPermissions | null }>(
        `/api/workshop/channels/${channelId}/members`,
      )
      members.value[channelId] = data.members ?? []
      if (data.permissions) permissions.value[channelId] = data.permissions
    }
    catch {
      // 非成员不可见名册(服务端 403):不是错误路径,静默保持空
    }
  }

  /** 能力视图(非成员也可调用;ChatMemberPanel/Composer 的按钮可用性据此渲染) */
  async function loadPermissions(channelId: string): Promise<ChatPermissions | null> {
    if (typeof window === 'undefined' || !channelId) return null
    try {
      const data = await request<{ channel: AepChannelChatSettings | null, permissions: ChatPermissions | null }>(
        `/api/workshop/channels/${channelId}/chat/permissions`,
      )
      if (data.channel) settings.value[channelId] = data.channel
      permissions.value[channelId] = data.permissions
      return data.permissions
    }
    catch {
      // 拉取失败也要落地"未知"态:否则 UI 永远停在"读取中",按钮可用性无从判断
      // (失败原因不抛出 —— 调用方多为 fire-and-forget,未捕获拒绝会触发全局稳定性守卫)
      permissions.value[channelId] = null
      return null
    }
  }

  /** 群聊发言(唯一入站口;mentions 只是意图提示,服务端会重新解析文本) */
  async function send(input: {
    channelId: string
    text: string
    mentions?: AepChatMention[]
    replyToId?: string | null
    clientMessageId?: string
  }): Promise<ChatSendResult> {
    const data = await request<ChatSendResult>(`/api/workshop/channels/${input.channelId}/chat/messages`, {
      method: 'POST',
      body: {
        text: input.text,
        mentions: input.mentions ?? [],
        replyToId: input.replyToId ?? null,
        clientMessageId: input.clientMessageId,
      },
    })
    // 本地先落一份(WS chat.message 帧到达时按 id 去重);重复提交返回原消息,同样幂等
    if (data.message) upsertMessage(data.message, input.channelId)
    for (const d of data.deliveries ?? []) {
      upsertDelivery({
        deliveryId: d.deliveryId,
        chatMessageId: data.message?.id ?? '',
        channelId: input.channelId,
        targetAgentId: d.agentId,
        mailboxMessageId: null,
        status: d.status as AepChatDelivery['status'],
        updatedAt: new Date().toISOString(),
      })
    }
    return data
  }

  async function join(channelId: string): Promise<'active' | 'pending'> {
    const data = await request<{ status: 'active' | 'pending', permissions: ChatPermissions | null }>(
      `/api/workshop/channels/${channelId}/members/join`,
      { method: 'POST', body: {} },
    )
    if (data.permissions) permissions.value[channelId] = data.permissions
    // 加入成功后补齐名册/历史(此前非成员读不到);补齐失败不得否定"已加入"这个事实
    await Promise.all([
      loadMembers(channelId).catch(() => {}),
      loadHistory(channelId).catch(() => {}),
    ])
    return data.status
  }

  async function leave(channelId: string): Promise<void> {
    await request<{ ok: boolean, status: string }>(`/api/workshop/channels/${channelId}/members/leave`, { method: 'POST', body: {} })
    await loadPermissions(channelId)
  }

  /** owner 移除成员 / owner 批准待审成员 */
  async function removeMember(channelId: string, userId: string): Promise<void> {
    await request<{ ok: boolean, status: string }>(`/api/workshop/channels/${channelId}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' })
    await loadMembers(channelId)
  }

  async function approveMember(channelId: string, userId: string): Promise<void> {
    await request<{ ok: boolean }>(`/api/workshop/channels/${channelId}/members/${encodeURIComponent(userId)}/approve`, { method: 'POST', body: {} })
    await loadMembers(channelId)
  }

  /** 群聊设置(owner-only;必须带 version 乐观锁 → 409 VERSION_CONFLICT) */
  async function updateSettings(channelId: string, patch: {
    visibility?: 'private' | 'public'
    joinPolicy?: 'open' | 'owner_approve'
    approvalPolicy?: 'owner_only' | 'any_member'
    chatEnabled?: 0 | 1
  }): Promise<void> {
    const version = settings.value[channelId]?.version
    const data = await request<AepChannelChatSettings & { ownerUserId?: string | null }>(`/api/workshop/channels/${channelId}`, {
      method: 'PATCH',
      body: { ...patch, version },
    })
    // PATCH 返回管理面 ChannelRow:只取群聊维度字段(不把 workspace/llm 等管理字段写进群聊设置)
    const prev = settings.value[channelId]
    settings.value[channelId] = {
      id: data.id ?? channelId,
      name: data.name ?? prev?.name ?? '',
      description: data.description ?? prev?.description ?? '',
      visibility: (data.visibility ?? prev?.visibility ?? 'private') as AepChannelChatSettings['visibility'],
      joinPolicy: (data.joinPolicy ?? prev?.joinPolicy ?? 'owner_approve') as AepChannelChatSettings['joinPolicy'],
      approvalPolicy: (data.approvalPolicy ?? prev?.approvalPolicy ?? 'owner_only') as AepChannelChatSettings['approvalPolicy'],
      chatEnabled: data.chatEnabled ?? prev?.chatEnabled ?? 0,
      version: data.version ?? prev?.version ?? 0,
      legacy: data.ownerUserId === undefined ? (prev?.legacy ?? false) : data.ownerUserId === null,
    }
    await loadPermissions(channelId)
  }

  function setReplyTarget(target: ChatReplyTarget | null): void {
    replyTarget.value = target
  }

  function clearReplyTarget(): void {
    replyTarget.value = null
  }

  /**
   * 某频道全部投递台账(扁平数组)。
   *
   * 渲染方需要"按消息分组",而按消息逐个 `deliveriesOf(channelId, messageId)` 会让
   * 每条消息都全量扫一遍投递表(未虚拟滚动时是 O(消息数 × 投递数));
   * 因此暴露这个"取一次、调用方自己建索引"的入口。
   */
  function deliveriesOfChannel(channelId: string): AepChatDelivery[] {
    const byChannel = deliveries.value[channelId]
    if (!byChannel) return []
    return Object.values(byChannel)
  }

  /** 单条消息的投递台账(低频调用方用;高频渲染请用 deliveriesOfChannel 自建索引) */
  function deliveriesOf(channelId: string, messageId: string): AepChatDelivery[] {
    return deliveriesOfChannel(channelId).filter(d => d.chatMessageId === messageId)
  }

  function clear(channelId: string): void {
    Reflect.deleteProperty(messages.value, channelId)
    Reflect.deleteProperty(members.value, channelId)
    Reflect.deleteProperty(deliveries.value, channelId)
    loadedChannels.value.delete(channelId)
  }

  return {
    messages,
    members,
    settings,
    deliveries,
    permissions,
    loadedChannels,
    hasMoreHistory,
    loadingHistory,
    replyTarget,
    applyEnvelope,
    applySnapshot,
    loadHistory,
    loadMembers,
    loadPermissions,
    send,
    join,
    leave,
    removeMember,
    approveMember,
    updateSettings,
    setReplyTarget,
    clearReplyTarget,
    deliveriesOf,
    deliveriesOfChannel,
    clear,
  }
})
