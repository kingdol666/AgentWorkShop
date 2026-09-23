/**
 * 手动演示 + 验证:两个用户先后 @ 同一个 worker,worker 必须**按顺序**各回一条,
 * 且每条回复只对应自己的提问者(不串线)。
 *
 * 走的是真实链路(无 mock 管理层):manager.sendChatMessage
 *   → chat_messages 落库 + chat_deliveries 台账(§3.3/3.4)
 *   → mailbox 投递(x-aw-source-chat-message-id / x-aw-requester-user-id / x-aw-reply-to)
 *   → Agent 运行 → platformReply → 群聊事实表(自动 @提问者)+ 定向通知(§7)
 * 只有 Agent 本身用 mock(确定性测试替身,行为与真实 harness 同构:见 mock-agent.chatScript)。
 *
 * 运行:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/demo-group-chat-order.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 隔离:绝不触碰真实数据目录
process.env.AW_DATA_DIR = mkdtempSync(join(tmpdir(), 'aw-chat-demo-'))
process.env.AGENTWORKSHOP_TEST = '1'

const { openWorkshopDb, initWorkshopDb } = await import('../server/services/workshop/db/database')
const { createChannelRepo } = await import('../server/services/workshop/db/channel.repo')
const { createAgentRepo } = await import('../server/services/workshop/db/agent.repo')
const { createChannelAgentRepo } = await import('../server/services/workshop/db/channel-agent.repo')
const { createTaskRepo } = await import('../server/services/workshop/db/task.repo')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { createChannelEventRepo } = await import('../server/services/workshop/db/channel-event.repo')
const { createTeamRepo } = await import('../server/services/workshop/db/team.repo')
const { createTeamMemberRepo } = await import('../server/services/workshop/db/team-member.repo')
const { createMessageRepo } = await import('../server/services/workshop/db/message.repo')
const { createSubscriptionRepo } = await import('../server/services/workshop/db/subscription.repo')
const managerMod = await import('../server/services/workshop/runtime/manager')
const { createAgentImpl } = await import('../server/services/workshop/agents/factory')
const { userRepository } = await import('../server/repositories/user.repository')

const lines: string[] = []
function say(text = ''): void {
  lines.push(text)
  console.log(text)
}
/** 简短别名:把 UUID 显示成前 8 位,便于阅读 */
const s8 = (v: string | null | undefined): string => (v ? v.slice(0, 8) : '--')

// ── 建库 + manager(mock harness)──────────────────────────────────────────────
const db: DatabaseSync = openWorkshopDb(':memory:')
initWorkshopDb(db)
function makeManager(db: DatabaseSync) {
  return managerMod.createAgentChannelManager({
    repos: {
      users: undefined as never,
      channelEvents: createChannelEventRepo(db),
      channels: createChannelRepo(db),
      agents: createAgentRepo(db),
      teams: createTeamRepo(db),
      teamMembers: createTeamMemberRepo(db),
      channelAgents: createChannelAgentRepo(db),
      messages: createMessageRepo(db),
      subscriptions: createSubscriptionRepo(db),
      tasks: createTaskRepo(db),
      memories: createMemoryRepo(db),
      schedules: undefined as never,
    },
    implFactory: createAgentImpl,
    db,
  })
}
const manager = makeManager(db)

function mkUser(name: string): { id: string, name: string, role: string } {
  const { user } = userRepository.createWithRoleBootstrap({
    name,
    email: `${name}@chat-demo.local`,
    password: 'Passw0rd!123',
    role: 'user',
    status: 'active',
  })
  return { id: user.id, name: user.name, role: user.role }
}
const ADMIN = mkUser('root-admin') // 首个注册账号 → bootstrap admin
const A = mkUser('alice') // Channel owner
const B = mkUser('bob') // 群成员
const C = mkUser('carol') // 群成员

say('═'.repeat(72))
say('群聊测试:两个用户分别 @ 同一个 worker,验证按顺序回复')
say('═'.repeat(72))
say(`用户:owner=${A.name}(${s8(A.id)})  成员=${B.name}(${s8(B.id)})  成员=${C.name}(${s8(C.id)})  admin=${ADMIN.name}`)
say()

// ── 建 Channel(owner=A,mock lead + 1 个 mock worker)────────────────────────
const { channelId, leadAgentId } = await manager.createChannel({
  name: 'order-demo',
  description: '群聊顺序回复演示',
  ownerUserId: A.id,
  leadAgent: { name: 'demo-lead', harness: 'mock', config: { delayMs: 5 } },
})
const workerTpl = await manager.createAgent({ name: 'demo-worker', harness: 'mock', config: { delayMs: 5 } })
await manager.addAgentToChannel({ channelId, agentId: workerTpl.id, role: 'worker' })
manager.ensureChannelActive(channelId)
const members = manager.deps.repos.channelAgents.listByChannel(channelId)
const worker = members.find(m => m.role === 'worker')!
const workerName = worker.name
say(`Channel: ${channelId.slice(0, 8)}  lead=${s8(leadAgentId)}  worker=${workerName}(${s8(worker.id)})`)

// 开群聊 + B/C 加入(公开、直接加入)
await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1 })
manager.joinChannel(channelId, B)
manager.joinChannel(channelId, C)
say(`已开启群聊(public/open/chatEnabled)并让 ${B.name}、${C.name} 加入`)
say()

// ── 两个用户先后 @ 同一个 worker ────────────────────────────────────────────
const q1 = `@${workerName} 请报告 A 线温度是否正常`
const q2 = `@${workerName} 请报告 B 线压力是否正常`
say('── 发送(注意:B 先发,C 紧接着发,worker 必须按此顺序回复)──')
const sentB = manager.sendChatMessage(channelId, B, { text: q1, clientMessageId: 'demo-b-1' })
say(`[1] ${B.name} → "${q1}"`)
say(`    delivery=${s8(sentB.deliveries[0]!.deliveryId)} agent=${s8(sentB.deliveries[0]!.agentId)} status=${sentB.deliveries[0]!.status}`)
const sentC = manager.sendChatMessage(channelId, C, { text: q2, clientMessageId: 'demo-c-1' })
say(`[2] ${C.name} → "${q2}"`)
say(`    delivery=${s8(sentC.deliveries[0]!.deliveryId)} agent=${s8(sentC.deliveries[0]!.agentId)} status=${sentC.deliveries[0]!.status}`)
say()

// ── 等 worker 把两条都处理完(mailbox 串行消费)──────────────────────────────
/** 群聊事实表里 Agent 回复行(证据字段) */
interface ChatAgentReplyRow {
  seq: number
  id: string
  senderId: string
  text: string
  sourceChatMessageId: string | null
  requesterUserId: string | null
  mentionsJson: string
  createdAt: string
}

const agentMsgs = () => db.prepare(
  `SELECT rowid AS seq, id, sender_id AS senderId, text, source_chat_message_id AS sourceChatMessageId,
          requester_user_id AS requesterUserId, mentions_json AS mentionsJson, created_at AS createdAt
   FROM chat_messages WHERE channel_id = ? AND sender_type = 'agent' ORDER BY rowid`,
).all(channelId) as Array<ChatAgentReplyRow>

const deadline = Date.now() + 15000
while (Date.now() < deadline && agentMsgs().length < 2) await new Promise(r => setTimeout(r, 50))
const replies = agentMsgs()

// ── 打印 worker 的回复正文 ──────────────────────────────────────────────────
say('── worker 的回复(按群聊事实表插入顺序)──')
for (const [i, r] of replies.entries()) {
  const mentions = JSON.parse(r.mentionsJson) as Array<{ type: string, id: string, label?: string }>
  const who = r.requesterUserId === B.id ? B.name : r.requesterUserId === C.id ? C.name : (r.requesterUserId ?? '--')
  say()
  say(`[回复 ${i + 1}] sender=${workerName}(${s8(r.senderId)})  回应提问者=${who}(${s8(r.requesterUserId)})`)
  say(`  正文: ${r.text}`)
  say(`  关联: sourceChatMessageId=${s8(r.sourceChatMessageId)}  → 对应第 ${r.sourceChatMessageId === sentB.message.id ? '1' : r.sourceChatMessageId === sentC.message.id ? '2' : '?'} 条提问`)
  say(`  自动 @: ${mentions.map(m => `${m.type}:${m.label ?? s8(m.id)}`).join(', ') || '(无)'}`)
}
say()

// ── 全链路关联 ID 对照(§12)────────────────────────────────────────────────
say('── 全链路关联 ID 对照 ──')
for (const [i, sent] of [sentB, sentC].entries()) {
  const ledger = manager.groupChat.chat.listDeliveries(sent.message.id)[0]!
  const mailbox = db.prepare('SELECT id FROM messages WHERE id = ?').get(ledger.mailboxMessageId) as { id: string } | undefined
  const reply = replies.find(r => r.sourceChatMessageId === sent.message.id)
  say(`提问 ${i + 1}: chatMessageId=${s8(sent.message.id)} → deliveryId=${s8(ledger.id)}`
    + ` → mailboxMessageId=${s8(ledger.mailboxMessageId)}${mailbox ? '(在 messages 表 ✓)' : '(缺失 ✗)'}`
    + ` → replyChatMessageId=${s8(reply?.id)}`)
}
say()

// ── 断言 ────────────────────────────────────────────────────────────────────
const problems: string[] = []
if (replies.length !== 2) problems.push(`期望 2 条 worker 回复,实际 ${replies.length}`)
if (replies[0]?.sourceChatMessageId !== sentB.message.id) problems.push('第 1 条回复没有对应 B 的提问(顺序错误)')
if (replies[1]?.sourceChatMessageId !== sentC.message.id) problems.push('第 2 条回复没有对应 C 的提问(顺序错误)')
if (replies[0]?.requesterUserId !== B.id) problems.push('第 1 条回复的 requesterUserId 不是 B')
if (replies[1]?.requesterUserId !== C.id) problems.push('第 2 条回复的 requesterUserId 不是 C')
for (const [i, r] of replies.entries()) {
  const mentions = JSON.parse(r.mentionsJson) as Array<{ type: string, id: string }>
  const want = i === 0 ? B.id : C.id
  if (!mentions.some(m => m.type === 'user' && m.id === want)) problems.push(`第 ${i + 1} 条回复没有自动 @ 对应提问者`)
  if (replies.some((o, j) => j !== i && o.text === r.text)) problems.push('两条回复正文完全相同(可能串线)')
}
if (problems.length === 0) {
  say('✅ 全部通过:worker 按 B → C 的顺序各回一条,回复只指向自己的提问者,并自动 @ 原提问用户。')
}
else {
  say('❌ 失败:')
  for (const p of problems) say(`   - ${p}`)
}

writeFileSync(join(process.cwd(), '.gw-chat-order-report.txt'), `${lines.join('\n')}\n`, 'utf8')
await manager.shutdown()
db.close()
process.exit(problems.length > 0 ? 1 : 0)
