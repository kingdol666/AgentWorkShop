/**
 * 场景 D —— mention 解析(纯函数段):稳定 ID;文本 @ 由服务端重新解析;非本 Channel 目标不投递;未知 token 记 unresolved。本段不触碰共享的 manager/db,故不使用 ctx。
 *
 * 原文 scripts/test-group-chat-unit.ts 第 369–397 行(section 横幅 + 顶层语句块):
 * 语句逐行原文搬运,仅把顶层块包成函数、把共享状态改为 ctx 参数。
 */
import { check, extractMentionTokens, resolveMentions, section } from './lib'
import type { GroupChatTestContext } from './lib'

export async function runSectionD(_ctx: GroupChatTestContext): Promise<void> {
  section('D. mention 解析(稳定 ID;禁止昵称兜底越权)')
  const tokens = extractMentionTokens('@alice 请看下 @worker-1 的结果,邮箱 a@b.com 不算')
  check('文本提取 @token', tokens.includes('alice') && tokens.includes('worker-1') && !tokens.includes('b.com'), JSON.stringify(tokens))
  const agents = [{ id: 'ag-1', name: 'worker-1', role: 'worker', enabled: 1 }]
  const users = [{ id: 'u-1', name: 'alice' }, { id: 'u-2', name: 'bob' }]
  const r1 = resolveMentions({ text: 'hi @worker-1 please look', agents, users })
  check('文本 @Agent 解析为 agent mention 稳定 ID', r1.mentions.length === 1 && r1.mentions[0]!.type === 'agent' && r1.mentions[0]!.id === 'ag-1', JSON.stringify(r1.mentions))
  const r2 = resolveMentions({ text: 'hi @alice', agents, users })
  check('文本 @用户 解析为 user mention 且无 agent', r2.mentions.length === 1 && r2.mentions[0]!.type === 'user' && r2.mentions[0]!.id === 'u-1')
  const r3 = resolveMentions({ text: '没有 at 的普通发言', agents, users })
  check('无 @ → mentions 为空(Agent 执行计数 0 的前提)', r3.mentions.length === 0)
  const r4 = resolveMentions({ text: 'hi @nobody', agents, users })
  check('未知 @token → unresolved 且不产生 mention', r4.mentions.length === 0 && r4.unresolved.includes('nobody'))
  const r5 = resolveMentions({
    text: 'hi',
    agents,
    users,
    explicit: [{ type: 'agent', id: 'ag-foreign' }],
    validateExplicit: m => (m.id === 'ag-foreign' ? 'agent 不属于本 Channel' : null),
  })
  check('显式 mention 指向外部 Agent → 被拒(不投递)', r5.mentions.length === 0 && r5.unresolved.length === 1)
  const r6 = resolveMentions({ text: '@worker 看下', agents, users })
  check('唯一前缀可解析 Agent', r6.mentions.length === 1 && r6.mentions[0]!.id === 'ag-1')
  const r7 = resolveMentions({ text: '@alice @worker-1 一起看', agents, users })
  check('混合 @ 解析出两类目标', r7.mentions.filter(m => m.type === 'agent').length === 1 && r7.mentions.filter(m => m.type === 'user').length === 1)
}
