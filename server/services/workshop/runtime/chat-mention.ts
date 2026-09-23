/**
 * ChatMention 解析 —— v17 群聊 @mention 的服务端权威解析。
 *
 * 约束(主计划 §0.3):
 * - mention 必须是**服务端解析出的稳定 ID**,禁止仅依赖昵称或客户端传入的 userId/fromAgentId;
 * - 客户端提交的 `mentions[]` 只作为"意图提示",必须逐个校验属于当前 Channel,
 *   非法目标一律 400(不能静默丢弃,否则会出现"看起来 @了但没投递");
 * - 文本中的 `@token` 由服务端重新解析(客户端可能只发文本),解析顺序:
 *     ① Agent 精确名(大小写不敏感) → ② Agent 唯一名前缀 → ③ 成员展示名精确 → ④ 成员唯一名前缀
 *   Agent 优先于人类:同名时以 Agent 为准并记录歧义。
 *
 * 解析结果中的 label 仅用于渲染;**投递与通知只用 id**。
 */
import type { ChatMention } from '../db/chat-message.repo'

/** 可被 @ 的 Agent 候选(来自 channel_agents) */
export interface MentionableAgent {
  id: string
  name: string
  role: string
  enabled: number
}

/** 可被 @ 的人类候选(来自 channel_members active ∪ owner) */
export interface MentionableUser {
  id: string
  name: string
}

export interface MentionResolveResult {
  mentions: ChatMention[]
  /** 文本中出现但无法解析成 Channel 内目标的 @token(用于提示/诊断) */
  unresolved: string[]
  /** 同名歧义(Agent 与人类同名);Agent 胜出但记录以便前端提示 */
  ambiguous: string[]
}

/** 从文本提取 @token(去重保序);支持 `@name` 与 `@名字`;遇到标点/空白结束 */
export function extractMentionTokens(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  // @ 必须位于行首或空白之后(与 Composer 的 detectMention 语义一致,避免 email 误命中)
  const re = /(^|[\s(（[【,，、])@([^\s@,，。;；:：!！?？()（）[\]【】<>《》"']+)/g
  let m: RegExpExecArray | null
  for (;;) {
    m = re.exec(text)
    if (!m) break
    const token = m[2]!.trim()
    if (!token) continue
    if (seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

/** 名字归一(小写 + 去空白);用于大小写不敏感匹配 */
function norm(s: string): string {
  return s.trim().toLowerCase()
}

/**
 * 解析 mention。
 * @param explicit 客户端提交的 mentions(已带 type/id);逐个校验;非法 → 由调用方转 400
 * @param validateExplicit 返回 null 表示该显式 mention 合法(已解析),返回错误文案表示非法
 */
export function resolveMentions(input: {
  text: string
  agents: MentionableAgent[]
  users: MentionableUser[]
  explicit?: ChatMention[]
  /** 显式 mention 的归属校验(route 层注入:确保 agent/user 属于本 Channel) */
  validateExplicit?: (m: ChatMention) => string | null
}): MentionResolveResult {
  const agents = input.agents.filter(a => a.enabled === 1)
  const mentions: ChatMention[] = []
  const unresolved: string[] = []
  const ambiguous: string[] = []
  const push = (m: ChatMention): void => {
    if (!mentions.some(x => x.type === m.type && x.id === m.id)) mentions.push(m)
  }

  // ① 显式 mentions 优先(客户端可能用 id 精确指定,文本里没有 @)
  for (const m of input.explicit ?? []) {
    if (!m || (m.type !== 'user' && m.type !== 'agent') || !m.id) continue
    const err = input.validateExplicit?.(m) ?? null
    if (err) {
      unresolved.push(`${m.type}:${m.id}`)
      continue
    }
    const label = m.type === 'agent'
      ? agents.find(a => a.id === m.id)?.name
      : input.users.find(u => u.id === m.id)?.name
    push({ type: m.type, id: m.id, label })
  }

  // ② 文本 @token 服务端重新解析
  for (const token of extractMentionTokens(input.text)) {
    const lower = norm(token)
    // ⓿ 稳定 ID 直呼(最高优先级):`@<agent 实例 id>` / `@<用户 id>` 精确命中。
    //    这是"服务端稳定 ID 解析"的核心路径 —— 展示名可能重名/随时改名,
    //    而 id 不会;也避免测试/集成场景因用户仓储不可用而无法 @。
    const agentById = agents.find(a => a.id === token)
    if (agentById) {
      push({ type: 'agent', id: agentById.id, label: agentById.name })
      continue
    }
    const userById = input.users.find(u => u.id === token)
    if (userById) {
      push({ type: 'user', id: userById.id, label: userById.name })
      continue
    }
    // Agent 精确名
    let agent = agents.find(a => norm(a.name) === lower)
    // Agent 唯一前缀
    if (!agent) {
      const partial = agents.filter(a => norm(a.name).startsWith(lower) || norm(a.name).includes(lower))
      if (partial.length === 1) agent = partial[0]
    }
    // 人类精确名
    const userExact = input.users.find(u => norm(u.name) === lower)
    if (agent) {
      if (userExact) ambiguous.push(token)
      push({ type: 'agent', id: agent.id, label: agent.name })
      continue
    }
    if (userExact) {
      push({ type: 'user', id: userExact.id, label: userExact.name })
      continue
    }
    // 人类唯一前缀
    const userPartial = input.users.filter(u => norm(u.name).startsWith(lower) || norm(u.name).includes(lower))
    if (userPartial.length === 1) {
      push({ type: 'user', id: userPartial[0]!.id, label: userPartial[0]!.name })
      continue
    }
    // 稳定 ID 唯一前缀(id 通常为 uuid;前缀过短易误命中,要求 ≥6 字符)
    if (token.length >= 6) {
      const agentPrefix = agents.filter(a => a.id.startsWith(token))
      if (agentPrefix.length === 1) {
        push({ type: 'agent', id: agentPrefix[0]!.id, label: agentPrefix[0]!.name })
        continue
      }
      const userPrefix = input.users.filter(u => u.id.startsWith(token))
      if (userPrefix.length === 1) {
        push({ type: 'user', id: userPrefix[0]!.id, label: userPrefix[0]!.name })
        continue
      }
    }
    unresolved.push(token)
  }

  return { mentions, unresolved, ambiguous }
}

/** 从 mentions 中取出 Agent 目标(去重;投递数量 = 此数组长度) */
export function agentMentions(mentions: ChatMention[]): ChatMention[] {
  return mentions.filter(m => m.type === 'agent')
}

/** 从 mentions 中取出用户目标(去重;通知对象) */
export function userMentions(mentions: ChatMention[]): ChatMention[] {
  return mentions.filter(m => m.type === 'user')
}
