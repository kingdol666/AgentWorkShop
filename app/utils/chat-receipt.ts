/**
 * 群聊里的 mock/Agent 回执解析(第二轮 E8)。
 *
 * mock harness 会把「系统给 Agent 的指令 + 关联提问」原样拼进回复正文:
 *   @visual mock 群聊回复(<uuid>):已处理「[群聊] visual 提问:<问题>
 *   (请回复内容;系统会把你的回复作为群聊消息发出并自动」;source=6285462f
 * 直接展示就是一段 UUID/内部标记噪音。这里只认这一种签名,解析成
 * “提问 / 系统指令”两段;任何普通 Markdown 回答都返回 null,绝不改写真实输出。
 */

export interface ChatReceipt {
  /** 回执的 Agent 名(@ 后的名字) */
  agent: string
  /** 关联 id(优先回执 uuid,其次 source;只用于 title,不展示) */
  correlation: string
  /** 触发本次执行的提问正文 */
  question: string
  /** 系统给 Agent 的执行指令(默认折叠) */
  instruction: string
}

const HEAD = /^@(\S+)\s+(.+?)\s*群聊回复\(\s*([0-9a-fA-F-]{6,})\s*\)\s*[:：]\s*已处理\s*([\s\S]*)$/
const SOURCE = /\s*;?\s*source\s*=\s*([\w-]+)\s*$/
const ASK_PREFIX = /^[^\s:：]+\s*提问\s*[:：]\s*/

/** 清洗问题:去掉 [群聊]/「」/“提问:” 等协议包装。 */
function cleanQuestion(raw: string): string {
  return raw
    .replace(/^[「]+\s*/, '')
    .replace(/^\[[^\]]*\]\s*/, '')
    .replace(ASK_PREFIX, '')
    .replace(/[」\]]+\s*$/, '')
    .trim()
}

export function parseChatReceipt(text: string): ChatReceipt | null {
  const source = String(text ?? '').trim()
  const head = source.match(HEAD)
  if (!head) return null
  const agent = head[1] ?? ''
  const uuid = head[3] ?? ''
  const bodyRaw = head[4] ?? ''

  let body = bodyRaw
  const src = body.match(SOURCE)
  const sourceId = src?.[1] ?? ''
  if (src) body = body.slice(0, src.index ?? 0)
  body = body.replace(/[」\]]+\s*$/, '').trim()

  // 系统指令以 "(请回复内容" 开头;问题在它之前。
  const cut = body.search(/[（(]\s*请回复内容/)
  const questionRaw = cut >= 0 ? body.slice(0, cut) : body
  const hasAsk = /提问\s*[:：]/.test(questionRaw)
  const question = hasAsk ? cleanQuestion(questionRaw) : ''
  // 不是“提问→回复”而是内部事件批次摘要时,整段进折叠的系统指令,不冒充用户问题
  const instruction = hasAsk
    ? (cut >= 0 ? body.slice(cut).trim() : '')
    : body.trim()
  if (!question && !instruction) return null

  return {
    agent,
    correlation: uuid || sourceId,
    question,
    instruction,
  }
}
