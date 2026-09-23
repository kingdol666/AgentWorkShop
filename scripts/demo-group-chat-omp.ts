/**
 * 真实 Harness 群聊测试:**omp**(真实 CLI + 真实 LLM,非 mock)。
 *
 * 场景:两个群成员先后 @ 同一个 omp worker,验证真实引擎按顺序回复、且回复只对应自己的提问者。
 * 只跑一条实时链路:sendChatMessage → chat_messages + chat_deliveries → mailbox
 *   → AgentRuntime 拉起真实 omp 子进程 → 模型产出文本 → platformReply
 *   → 群聊事实表(自动 @提问者)+ 定向通知。
 * lead 用 mock(本测试只验证 worker 的真实回复,避免多一次模型调用浪费 token)。
 *
 * 运行:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/demo-group-chat-omp.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AW_DATA_DIR = mkdtempSync(join(tmpdir(), 'aw-chat-omp-'))
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
const { checkHarnessAvailability } = await import('../server/services/workshop/agents/harness-availability')
const { userRepository } = await import('../server/repositories/user.repository')

const lines: string[] = []
const say = (t = ''): void => {
  lines.push(t)
  console.log(t)
}
const s8 = (v: string | null | undefined): string => (v ? v.slice(0, 8) : '--')
const t0 = Date.now()
const stamp = (): string => `+${((Date.now() - t0) / 1000).toFixed(1)}s`

say('═'.repeat(72))
say('真实 Harness 群聊测试:omp(真实 CLI + 真实 LLM)')
say('═'.repeat(72))

const avail = checkHarnessAvailability('omp', undefined, { refresh: true })
say(`[${stamp()}] harness 探测: available=${avail.available} command=${avail.command} path=${avail.resolvedPath ?? '--'}`)
if (!avail.available) {
  say(`❌ BLOCKED:${avail.error}`)
  writeFileSync(join(process.cwd(), '.gw-omp-report.txt'), `${lines.join('\n')}\n`, 'utf8')
  process.exit(2)
}

const db: DatabaseSync = openWorkshopDb(':memory:')
initWorkshopDb(db)
const manager = managerMod.createAgentChannelManager({
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

function mkUser(name: string): { id: string, name: string, role: string } {
  const { user } = userRepository.createWithRoleBootstrap({
    name, email: `${name}@omp-demo.local`, password: 'Passw0rd!123', role: 'user', status: 'active',
  })
  return { id: user.id, name: user.name, role: user.role }
}
const A = mkUser('root-admin')
const B = mkUser('bob')
const C = mkUser('carol')

const { channelId, leadAgentId } = await manager.createChannel({
  name: 'omp-demo',
  description: '真实 omp 群聊',
  ownerUserId: A.id,
  leadAgent: { name: 'demo-lead', harness: 'mock', config: { delayMs: 5 } },
})
// 真实 harness worker
const workerTpl = await manager.createAgent({ name: 'omp-worker', harness: 'omp' })
await manager.addAgentToChannel({ channelId, agentId: workerTpl.id, role: 'worker' })
manager.ensureChannelActive(channelId)
const worker = manager.deps.repos.channelAgents.listByChannel(channelId).find(m => m.role === 'worker')!
say(`[${stamp()}] channel=${s8(channelId)} lead=${s8(leadAgentId)}(mock) worker=${worker.name}(${s8(worker.id)}, harness=omp)`)

await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1 })
manager.joinChannel(channelId, B)
manager.joinChannel(channelId, C)
say(`[${stamp()}] 群聊已开启;${B.name}、${C.name} 已加入`)

const q1 = `@${worker.name} 请只回答两个字:收到`
const q2 = `@${worker.name} 请只回答:好的`
say()
say('── 发送 ──')
const sentB = manager.sendChatMessage(channelId, B, { text: q1, clientMessageId: 'omp-b-1' })
say(`[${stamp()}] [1] ${B.name} → "${q1}"  delivery=${s8(sentB.deliveries[0]!.deliveryId)} status=${sentB.deliveries[0]!.status}`)
const sentC = manager.sendChatMessage(channelId, C, { text: q2, clientMessageId: 'omp-c-1' })
say(`[${stamp()}] [2] ${C.name} → "${q2}"  delivery=${s8(sentC.deliveries[0]!.deliveryId)} status=${sentC.deliveries[0]!.status}`)
say()
say('── 等待真实 omp 回复(共 2 条;模型推理时间不计入性能口径)──')

interface ReplyRow {
  rowid: number
  id: string
  senderId: string
  text: string
  sourceChatMessageId: string | null
  requesterUserId: string | null
  mentionsJson: string
}
const agentReplies = (): ReplyRow[] => db.prepare(
  `SELECT rowid, id, sender_id AS senderId, text, source_chat_message_id AS sourceChatMessageId,
          requester_user_id AS requesterUserId, mentions_json AS mentionsJson
   FROM chat_messages WHERE channel_id = ? AND sender_type = 'agent' ORDER BY rowid`,
).all(channelId) as ReplyRow[]

const DEADLINE_MS = 300_000
let lastTick = 0
while (Date.now() - t0 < DEADLINE_MS) {
  const got = agentReplies().length
  if (got >= 2) break
  if (Date.now() - lastTick > 8000) {
    lastTick = Date.now()
    say(`[${stamp()}] 已收到 ${got}/2 条……(omp 子进程运行中)`)
  }
  await new Promise(r => setTimeout(r, 300))
}

const replies = agentReplies()
say()
say('── omp worker 的真实回复 ──')
for (const [i, r] of replies.entries()) {
  const who = r.requesterUserId === B.id ? B.name : r.requesterUserId === C.id ? C.name : (r.requesterUserId ?? '--')
  const mentions = JSON.parse(r.mentionsJson) as Array<{ type: string, id: string, label?: string }>
  say()
  say(`[回复 ${i + 1}] [${stamp()}] sender=${worker.name}(${s8(r.senderId)})  回应提问者=${who}(${s8(r.requesterUserId)})`)
  say('  ┌─ 正文 ─────────────────────────────────────────────')
  for (const line of r.text.split('\n')) say(`  │ ${line}`)
  say('  └────────────────────────────────────────────────────')
  say(`  关联: sourceChatMessageId=${s8(r.sourceChatMessageId)} 自动 @=${mentions.map(m => `${m.type}:${m.label ?? s8(m.id)}`).join(', ') || '(无)'}`)
}

if (replies.length === 0) {
  // 没有回复时,把 worker 的最新运行态/错误打出来(不猜原因)
  const st = db.prepare('SELECT state, updated_at FROM channel_agents WHERE id = ?').get(worker.id)
  say()
  say(`❌ 未收到任何 omp 回复。worker 行状态=${JSON.stringify(st)}`)
  const msgs = db.prepare('SELECT role, substr(text,1,200) AS t, created_at FROM messages ORDER BY rowid DESC LIMIT 5')
    .all() as Array<{ role: string, t: string, created_at: string }>
  say('最近 5 条 mailbox 消息:')
  for (const m of msgs) say(`  [${m.role}] ${m.t}`)
}
else if (replies.length === 1) {
  say()
  say('⚠ 只收到 1 条回复(第二条仍在推理或未完成)')
}
else {
  say()
  const orderOk = replies[0]!.sourceChatMessageId === sentB.message.id && replies[1]!.sourceChatMessageId === sentC.message.id
  const targetOk = replies[0]!.requesterUserId === B.id && replies[1]!.requesterUserId === C.id
  say(orderOk && targetOk
    ? '✅ 通过:真实 omp worker 按 bob → carol 顺序各回一条,回复只指向自己的提问者。'
    : `❌ 串线/顺序错误:order=${orderOk} target=${targetOk}`)
}

writeFileSync(join(process.cwd(), '.gw-omp-report.txt'), `${lines.join('\n')}\n`, 'utf8')
await manager.shutdown()
db.close()
process.exit(0)
