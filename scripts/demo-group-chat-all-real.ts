/**
 * 全真实场景实测:**Leader 与 worker 都是真实 omp**(无 mock agent):
 *
 *   1) 提交简单任务 → 真实 omp Leader 的监督回合产出派发决策 → assign 投给 worker;
 *   2) 真实 omp worker 执行任务(模型真实作答) → 任务完成、交付物落库;
 *   3) 同时验证群聊:@worker 在真实场景下照样拿到真实回复(不串线、不影响任务)。
 *
 * 证据:① channel_agents 行的 harness 字段(事实源) ② omp.exe 进程时间线(pid/时刻/阶段)
 *      ③ assign 消息的 from_agent_id(派发确实出自 lead) ④ 任务终态与交付物 ⑤ 群聊回复正文
 *
 * 运行:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/demo-group-chat-all-real.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AW_DATA_DIR = mkdtempSync(join(tmpdir(), 'aw-allreal-'))
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
const T0 = Date.now()
const stamp = (): string => `+${((Date.now() - T0) / 1000).toFixed(1)}s`

say('='.repeat(78))
say('全真实场景:Leader=omp(真实) + worker=omp(真实),无 mock agent')
say('='.repeat(78))
const avail = checkHarnessAvailability('omp', undefined, { refresh: true })
say(`harness 探测: omp available=${avail.available} path=${avail.resolvedPath ?? '--'}`)
if (!avail.available) {
  say(`BLOCKED:${avail.error}`)
  writeFileSync(join(process.cwd(), '.gw-allreal.txt'), `${lines.join('\n')}\n`, 'utf8')
  process.exit(2)
}

// ── omp.exe 进程探针(阶段标注)─────────────────────────────────────────────
interface Sighting { at: string, pid: string, mem: string, phase: string }
const sightings: Sighting[] = []
const seenPids = new Set<string>()
let phase = '初始化'
function sampleOmp(): void {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq omp.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    for (const l of out.split(/\r?\n/).filter(x => x.includes('omp.exe'))) {
      const c = l.split('","').map(x => x.replace(/^"|"$/g, ''))
      const pid = c[1] ?? '?'
      if (!seenPids.has(pid)) {
        seenPids.add(pid)
        sightings.push({ at: stamp(), pid, mem: c[4] ?? '?', phase })
      }
    }
  }
  catch { /* 探针失败不编造 */ }
}
const probe = setInterval(sampleOmp, 300)

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
    name, email: `${name}@allreal.local`, password: 'Passw0rd!123', role: 'user', status: 'active',
  })
  return { id: user.id, name: user.name, role: user.role }
}
mkUser('root-admin')
const B = mkUser('bob')
const C = mkUser('carol')

phase = '建 Channel(lead=omp, worker=omp)'
// **两个成员都是真实 omp**
const { channelId } = await manager.createChannel({
  name: 'all-real',
  description: 'Lead 与 worker 均真实 omp',
  ownerUserId: B.id,
  leadAgent: { name: 'real-lead', harness: 'omp' },
})
const wTpl = await manager.createAgent({ name: 'real-worker', harness: 'omp' })
await manager.addAgentToChannel({ channelId, agentId: wTpl.id, role: 'worker' })
manager.ensureChannelActive(channelId)
await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1 })
manager.joinChannel(channelId, C)

const members = db.prepare(
  `SELECT id, name, role, harness, enabled FROM channel_agents WHERE channel_id = ? ORDER BY role DESC`,
).all(channelId) as Array<{ id: string, name: string, role: string, harness: string, enabled: number }>
say('')
say('[证据①] Channel 成员表(事实源 channel_agents):')
for (const m of members) {
  say(`   role=${m.role.padEnd(6)} name=${m.name.padEnd(14)} harness=${String(m.harness).padEnd(5)} enabled=${m.enabled} id=${s8(m.id)}`)
}
say(`   -> 全部 harness=omp:${members.every(m => m.harness === 'omp') ? '是(无 mock agent)' : '否!'}`)
const worker = members.find(m => m.role === 'worker')!
const lead = members.find(m => m.role === 'lead')!

// ── 1) 提交简单任务,等真实 omp Leader 派发 ─────────────────────────────────
say('')
say('-'.repeat(78))
say('步骤 1:提交简单任务 → 真实 omp Leader 监督回合 → 派发给 worker')
say('-'.repeat(78))
phase = 'Leader 监督/派发'
const submitted = await manager.submitChannelTask({
  channelId,
  title: '实测任务',
  description: '请只回答两个字:完成',
  fromLabel: B.name,
})
const taskId = String((submitted as { taskId?: string, id?: string }).taskId
  ?? (submitted as { id?: string }).id ?? '')
say(`[${stamp()}] 任务已提交 taskId=${s8(taskId)}`)

interface AssignRow { id: string, from_agent_id: string | null, to_agent_id: string | null, created_at: string, kind: string }
/** 投给 worker 的 assign(必须按收件人过滤:任务提交时也有一条 x-aw-task-kind 消息发给 lead) */
const findAssign = (): AssignRow | undefined => {
  const row = db.prepare(
    `SELECT id, from_agent_id, to_agent_id, created_at, metadata_json
     FROM messages WHERE channel_id = ? AND to_agent_id = ?
       AND metadata_json LIKE '%x-aw-task-kind%' ORDER BY rowid LIMIT 1`,
  ).get(channelId, worker.id) as (Omit<AssignRow, 'kind'> & { metadata_json: string }) | undefined
  if (!row) return undefined
  let kind = '?'
  try {
    kind = String((JSON.parse(row.metadata_json) as Record<string, unknown>)['x-aw-task-kind'] ?? '?')
  }
  catch { /* 保底 */ }
  return { ...row, kind }
}
/** 全部 x-aw-task-kind 消息(用于看清"谁发给谁、什么类型") */
const taskKindMessages = (): Array<{ from: string | null, to: string | null, kind: string }> => {
  const rows = db.prepare(
    `SELECT from_agent_id AS f, to_agent_id AS t, metadata_json AS m FROM messages
     WHERE channel_id = ? AND metadata_json LIKE '%x-aw-task-kind%' ORDER BY rowid`,
  ).all(channelId) as Array<{ f: string | null, t: string | null, m: string }>
  return rows.map((r) => {
    let kind = '?'
    try {
      kind = String((JSON.parse(r.m) as Record<string, unknown>)['x-aw-task-kind'] ?? '?')
    }
    catch { /* 保底 */ }
    return { from: r.f, to: r.t, kind }
  })
}

let assign: AssignRow | undefined
const tWait = Date.now()
while (Date.now() - tWait < 90_000) {
  assign = findAssign()
  if (assign) break
  await sleep(300)
}
if (!assign) {
  say(`[${stamp()}] 未观察到投给 worker 的 assign(90s 超时)`)
}
else {
  const fromLead = assign.from_agent_id === lead.id
  say(`[${stamp()}] assign(kind=${assign.kind}) 已投递: from=${s8(assign.from_agent_id)}(${fromLead ? lead.name : '非 lead!'}) to=${s8(assign.to_agent_id)}(${assign.to_agent_id === worker.id ? worker.name : '非 worker!'})`)
  say(`   -> 派发确实出自 lead:${fromLead ? '是' : '否'};目标确实是 worker:${assign.to_agent_id === worker.id ? '是' : '否'}`)
}
say('   x-aw-task-kind 消息全览(from → to / kind):')
for (const m of taskKindMessages()) {
  const fromName = m.from === lead.id ? lead.name : m.from === worker.id ? worker.name : s8(m.from)
  const toName = m.to === lead.id ? lead.name : m.to === worker.id ? worker.name : s8(m.to)
  say(`     ${fromName} -> ${toName}  kind=${m.kind}`)
}

// ── 2) worker 执行途中,群聊 @worker(真实场景群聊)──────────────────────────
say('')
say('-'.repeat(78))
say('步骤 2:worker 执行任务途中,群聊 @worker(验证真实场景下群聊可用)')
say('-'.repeat(78))
phase = 'worker 执行任务 + 群聊'
const stateAtMention = manager.getTaskEngine().get(taskId)?.state ?? '(未知)'
const q = `@${worker.name} 请只回答:收到`
const sent = manager.sendChatMessage(channelId, B, { text: q, clientMessageId: 'allreal-1' })
say(`[${stamp()}] 任务状态=${stateAtMention}; ${B.name} -> "${q}"`)
say(`   投递: delivery=${s8(sent.deliveries[0]!.deliveryId)} agent=${s8(sent.deliveries[0]!.agentId)} status=${sent.deliveries[0]!.status}`)

// ── 3) 等两件事都完成 ──────────────────────────────────────────────────────
interface ChatRow { rowid: number, text: string, requesterUserId: string | null, mentionsJson: string, sourceChatMessageId: string | null }
const chatReplies = (): ChatRow[] => db.prepare(
  `SELECT rowid, text, requester_user_id AS requesterUserId, mentions_json AS mentionsJson,
          source_chat_message_id AS sourceChatMessageId
   FROM chat_messages WHERE channel_id = ? AND sender_type = 'agent' ORDER BY rowid`,
).all(channelId) as ChatRow[]

const tEnd = Date.now()
while (Date.now() - tEnd < 240_000) {
  const st = manager.getTaskEngine().get(taskId)?.state ?? ''
  if (chatReplies().length >= 1 && (st === 'COMPLETED' || st === 'FAILED' || st === 'CANCELLED')) break
  await sleep(300)
}
const finalState = manager.getTaskEngine().get(taskId)?.state ?? '(未知)'
const replies = chatReplies()
clearInterval(probe)
sampleOmp()

// ── 结果 ──────────────────────────────────────────────────────────────────
say('')
say('[证据②] omp.exe 进程时间线(每个 pid 只记首次出现):')
if (sightings.length === 0) say('   (未捕获;探针不可用)')
for (const s of sightings) say(`   ${s.at}  pid=${s.pid}  mem=${s.mem}  阶段=${s.phase}`)
say(`   共捕获 ${sightings.length} 个不同 omp.exe 进程`)

say('')
say('[证据③④] 任务结果:')
say(`   终态=${finalState}`)
const artifacts = (manager.getTaskEngine().get(taskId)?.artifacts ?? [])
  .filter(a => a.name !== 'input')
  .map(a => a.parts.map(p => ('text' in p ? p.text : '')).join('').slice(0, 200))
if (artifacts.length) for (const a of artifacts) say(`   交付物: ${a}`)

say('')
say('[证据⑤] 群聊回复:')
for (const [i, r] of replies.entries()) {
  const mentions = JSON.parse(r.mentionsJson) as Array<{ type: string, label?: string, id: string }>
  say(`   [回复 ${i + 1}] 回应=${r.requesterUserId === B.id ? B.name : s8(r.requesterUserId)}`
    + ` 自动 @=${mentions.filter(m => m.type === 'user').map(m => m.label ?? s8(m.id)).join(',') || '(无)'}`
    + ` source=${s8(r.sourceChatMessageId)}`)
  for (const line of r.text.split('\n')) say(`       | ${line}`)
}

say('')
const allReal = members.every(m => m.harness === 'omp')
const dispatched = !!assign && assign.from_agent_id === lead.id && assign.to_agent_id === worker.id
const taskOk = finalState === 'COMPLETED'
const chatOk = replies.length >= 1
say('='.repeat(78))
say(`结论: Leader/worker 全真实 omp=${allReal} | lead 派发=${dispatched} | 任务完成=${taskOk} | 群聊回复=${chatOk}`)
say(allReal && dispatched && taskOk && chatOk
  ? 'PASS 全真实场景通过:真实 omp Leader 派发 → 真实 omp worker 执行,且群聊同时可用'
  : 'PARTIAL/FAIL 见上方各项')
say('='.repeat(78))

writeFileSync(join(process.cwd(), '.gw-allreal.txt'), `${lines.join('\n')}\n`, 'utf8')
await manager.shutdown()
db.close()
process.exit(0)
