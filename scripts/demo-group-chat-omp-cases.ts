/**
 * 真实 omp 群聊实测(两个场景,均为真实 CLI + 真实 LLM,mock 只用于 lead/用户):
 *
 *   场景 1 —— **不执行任务时** @worker:worker 空闲,群聊 @ 直接触发一次真实回复。
 *   场景 2 —— **Leader 正在给 worker 分发任务途中** @worker:worker 正忙(任务在跑),
 *             群聊 @ 以 immediate 优先级投递(steer 注入运行中的会话),必须
 *             ① 群聊提问不丢 ② 有群聊回复 ③ 任务本身仍能完成。
 *
 * 运行:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/demo-group-chat-omp-cases.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AW_DATA_DIR = mkdtempSync(join(tmpdir(), 'aw-chat-omp2-'))
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
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
let T0 = Date.now()
const stamp = (): string => `+${((Date.now() - T0) / 1000).toFixed(1)}s`

say('='.repeat(74))
say('真实 omp 群聊实测: [1] 空闲时 @worker   [2] Leader 分发任务途中 @worker')
say('='.repeat(74))
const avail = checkHarnessAvailability('omp', undefined, { refresh: true })
say(`harness: omp available=${avail.available} path=${avail.resolvedPath ?? '--'}`)
if (!avail.available) {
  say(`BLOCKED:${avail.error}`)
  writeFileSync(join(process.cwd(), '.gw-omp-cases.txt'), `${lines.join('\n')}\n`, 'utf8')
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
    name, email: `${name}@omp2.local`, password: 'Passw0rd!123', role: 'user', status: 'active',
  })
  return { id: user.id, name: user.name, role: user.role }
}
mkUser('root-admin')
const B = mkUser('bob')
const C = mkUser('carol')

/** 建一个「mock lead + 真实 omp worker」的群聊 Channel */
async function buildChannel(name: string): Promise<{ channelId: string, leadId: string, workerId: string, workerName: string }> {
  const { channelId, leadAgentId } = await manager.createChannel({
    name, description: '真实 omp 场景实测', ownerUserId: B.id,
    leadAgent: { name: `${name}-lead`, harness: 'mock', config: { delayMs: 5 } },
  })
  const wTpl = await manager.createAgent({ name: `${name}-omp-worker`, harness: 'omp' })
  await manager.addAgentToChannel({ channelId, agentId: wTpl.id, role: 'worker' })
  manager.ensureChannelActive(channelId)
  const w = manager.deps.repos.channelAgents.listByChannel(channelId).find(m => m.role === 'worker')!
  await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1 })
  manager.joinChannel(channelId, C)
  return { channelId, leadId: leadAgentId!, workerId: w.id, workerName: w.name }
}

interface ReplyRow {
  rowid: number
  id: string
  text: string
  sourceChatMessageId: string | null
  requesterUserId: string | null
  mentionsJson: string
}
const chatReplies = (channelId: string): ReplyRow[] => db.prepare(
  `SELECT rowid, id, text, source_chat_message_id AS sourceChatMessageId,
          requester_user_id AS requesterUserId, mentions_json AS mentionsJson
   FROM chat_messages WHERE channel_id = ? AND sender_type = 'agent' ORDER BY rowid`,
).all(channelId) as ReplyRow[]

/** assign 消息数(messages.metadata_json 带 x-aw-task-kind 的行)= "lead 已派发" 的判据 */
const assignCount = (channelId: string): number => (db.prepare(
  `SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND metadata_json LIKE '%x-aw-task-kind%'`,
).get(channelId) as { n: number }).n

async function waitFor(pred: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
  const t0 = Date.now()
  let last = 0
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true
    if (Date.now() - last > 10000) {
      last = Date.now()
      say(`   [${stamp()}] 等待 ${label}......`)
    }
    await sleep(300)
  }
  return pred()
}

function printReplies(channelId: string, who: Array<{ id: string, name: string }>): number {
  const replies = chatReplies(channelId)
  for (const [i, r] of replies.entries()) {
    const owner = who.find(u => u.id === r.requesterUserId)
    const mentions = JSON.parse(r.mentionsJson) as Array<{ type: string, id: string, label?: string }>
    say(`   [回复 ${i + 1}] 回应=${owner?.name ?? s8(r.requesterUserId)}  自动 @=${mentions.filter(m => m.type === 'user').map(m => m.label ?? s8(m.id)).join(',') || '(无)'}`)
    for (const line of r.text.split('\n')) say(`       | ${line}`)
  }
  return replies.length
}

// ==========================================================================
say('')
say('-'.repeat(74))
say('场景 1:不执行任务时 @worker(worker 空闲)')
say('-'.repeat(74))
T0 = Date.now()
{
  const { channelId, workerId, workerName } = await buildChannel('idle')
  const taskCount = (db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE channel_id = ?').get(channelId) as { n: number }).n
  say(`[${stamp()}] 前置: channel=${s8(channelId)} worker=${workerName}(${s8(workerId)}) 任务数=${taskCount} assign 消息数=${assignCount(channelId)}`)
  const q = `@${workerName} 请只回答四个字:当前空闲`
  const sent = manager.sendChatMessage(channelId, B, { text: q, clientMessageId: 'idle-1' })
  say(`[${stamp()}] ${B.name} -> "${q}"  delivery=${s8(sent.deliveries[0]!.deliveryId)} status=${sent.deliveries[0]!.status}`)
  const ok = await waitFor(() => chatReplies(channelId).length >= 1, 180_000, 'omp 回复')
  say(`[${stamp()}] 收到回复=${ok}`)
  const n = printReplies(channelId, [B, C])
  say(`   ${n >= 1 ? 'PASS 场景 1:空闲状态下 @worker 得到真实回复' : 'FAIL 场景 1:未收到回复'}`)
}

// ==========================================================================
say('')
say('-'.repeat(74))
say('场景 2:Leader 正在给 worker 分发任务途中 @worker')
say('-'.repeat(74))
T0 = Date.now()
{
  const { channelId, workerId, workerName } = await buildChannel('busy')
  say(`[${stamp()}] channel=${s8(channelId)} worker=${workerName}(${s8(workerId)})`)
  const submitted = await manager.submitChannelTask({
    channelId,
    title: '实测任务',
    description: '请只回答两个字:完成',
    fromLabel: B.name,
  })
  const taskId = String((submitted as { taskId?: string, id?: string }).taskId
    ?? (submitted as { id?: string }).id ?? '')
  say(`[${stamp()}] 已提交任务 taskId=${s8(taskId)}`)
  const assigned = await waitFor(() => assignCount(channelId) > 0, 60_000, 'lead 派发 assign')
  const stateAtMention = manager.getTaskEngine().get(taskId)?.state ?? '(未知)'
  say(`[${stamp()}] lead 已派发=${assigned}; 此刻任务状态=${stateAtMention} -> 正在分发/执行途中`)
  const q = `@${workerName} 请只回答:收到`
  const sent = manager.sendChatMessage(channelId, B, { text: q, clientMessageId: 'busy-1' })
  say(`[${stamp()}] ${B.name} -> "${q}"  delivery=${s8(sent.deliveries[0]!.deliveryId)} status=${sent.deliveries[0]!.status}(immediate)`)

  const gotReply = await waitFor(() => chatReplies(channelId).length >= 1, 240_000, '群聊回复')
  await waitFor(() => {
    const st = manager.getTaskEngine().get(taskId)?.state
    return st === 'COMPLETED' || st === 'FAILED' || st === 'CANCELLED'
  }, 120_000, '任务终态')
  const finalState = manager.getTaskEngine().get(taskId)?.state ?? '(未知)'
  say(`[${stamp()}] 群聊回复=${gotReply}  任务终态=${finalState}`)
  const n = printReplies(channelId, [B, C])
  const artifacts = (manager.getTaskEngine().get(taskId)?.artifacts ?? [])
    .filter(a => a.name !== 'input')
    .map(a => a.parts.map(p => ('text' in p ? p.text : '')).join('').slice(0, 200))
  if (artifacts.length) say(`   任务交付物: ${artifacts.join(' | ')}`)
  say(`   ${n >= 1 && finalState === 'COMPLETED'
    ? 'PASS 场景 2:分发途中 @worker 既拿到群聊回复,任务也照常完成(两不耽误)'
    : `WARN 场景 2: 群聊回复=${n >= 1} 任务终态=${finalState}`}`)
}

writeFileSync(join(process.cwd(), '.gw-omp-cases.txt'), `${lines.join('\n')}\n`, 'utf8')
await manager.shutdown()
db.close()
process.exit(0)
