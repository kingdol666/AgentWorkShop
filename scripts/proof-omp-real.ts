/**
 * 证据脚本:证明群聊回复**确实来自真实 omp 子进程**,而不是 mock。
 *
 * 采集四类证据:
 *   ① DB 事实源:channel_agents 行里 worker 的 harness 字段(omp / mock);
 *   ② 环境探测:omp 可执行文件绝对路径;
 *   ③ **进程证据**:回复期间轮询系统进程表,记录 omp.exe 出现的时间/PID(真实子进程被拉起);
 *   ④ 回复内容特征:mock 替身有固定模板(`mock 群聊回复(...):已处理「...」`),
 *      真实模型不会产出该模板 —— 用它反向排除 mock,并用一个 mock 无法伪造的题目
 *      (2+3=?)验证是模型在作答。
 *
 * 运行:npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/proof-omp-real.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AW_DATA_DIR = mkdtempSync(join(tmpdir(), 'aw-omp-proof-'))
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

/** 系统进程表快照:omp.exe 的 PID(真实子进程证据;探测失败返回 null 而不是编造) */
function ompPids(): Array<{ pid: string, mem: string }> | null {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq omp.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
    const rows = out.split(/\r?\n/).filter(l => l.includes('omp.exe'))
    return rows.map((l) => {
      const c = l.split('","').map(x => x.replace(/^"|"$/g, ''))
      return { pid: c[1] ?? '?', mem: c[4] ?? '?' }
    })
  }
  catch {
    return null
  }
}

say('='.repeat(76))
say('证据:群聊回复是真实 omp 子进程产出的吗?(不是 mock)')
say('='.repeat(76))

// ② 环境探测
const avail = checkHarnessAvailability('omp', undefined, { refresh: true })
say(`[证据②] omp 可执行文件: available=${avail.available} command=${avail.command} path=${avail.resolvedPath ?? '--'}`)
say(`[证据②] 探测时系统里已在跑的 omp.exe: ${JSON.stringify(ompPids())}`)

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
    name, email: `${name}@proof.local`, password: 'Passw0rd!123', role: 'user', status: 'active',
  })
  return { id: user.id, name: user.name, role: user.role }
}
mkUser('root-admin')
const B = mkUser('bob')

// Lead 用 mock(省一次模型调用,与本证据无关);**worker 用真实 omp**
const { channelId, leadAgentId } = await manager.createChannel({
  name: 'proof', description: 'omp 真实性证据', ownerUserId: B.id,
  leadAgent: { name: 'proof-lead', harness: 'mock', config: { delayMs: 5 } },
})
const wTpl = await manager.createAgent({ name: 'proof-omp-worker', harness: 'omp' })
await manager.addAgentToChannel({ channelId, agentId: wTpl.id, role: 'worker' })
manager.ensureChannelActive(channelId)
await manager.updateChannel(channelId, { visibility: 'public', joinPolicy: 'open', chatEnabled: 1 })

// ① DB 事实源:谁是 omp、谁是 mock
const rows = db.prepare(
  `SELECT id, name, role, harness, enabled FROM channel_agents WHERE channel_id = ? ORDER BY role`,
).all(channelId) as Array<{ id: string, name: string, role: string, harness: string, enabled: number }>
say('')
say('[证据①] Channel 成员表(channel_agents,事实源):')
for (const r of rows) {
  say(`   role=${r.role.padEnd(6)} name=${r.name.padEnd(18)} harness=${String(r.harness).padEnd(6)} enabled=${r.enabled} id=${s8(r.id)}`)
}
const worker = rows.find(r => r.role === 'worker')!
say(`   -> 本次 @ 的目标是 worker: name=${worker.name} harness=${worker.harness}`)
say(`   -> lead=${s8(leadAgentId)} harness=${rows.find(r => r.role === 'lead')?.harness}(只做派发,不参与群聊回复)`)

// ③ 发问:题目是 mock 无法伪造的(mock 只会把提问原文套进固定模板回显)
say('')
say('[证据③] 发问(题目:2+3=?;mock 替身只会回显提问模板,答不出 5)')
const q = `@${worker.name} 请只回答一个数字:2+3 等于几?`
const sent = manager.sendChatMessage(channelId, B, { text: q, clientMessageId: 'proof-1' })
const delivery = sent.deliveries[0]!
say(`   ${B.name} -> "${q}"`)
say(`   投递台账: delivery=${s8(delivery.deliveryId)} 目标 agent=${s8(delivery.agentId)}`
  + `(与 worker ${s8(worker.id)} ${delivery.agentId === worker.id ? '一致' : '不一致!'}) status=${delivery.status}`)

// 轮询:记录 omp.exe 出现的时间/PID(真实子进程被拉起)
const sightings: Array<{ at: string, pid: string, mem: string }> = []
const seen = new Set<string>()
let replyText: string | null = null
const t0 = Date.now()
while (Date.now() - t0 < 180_000) {
  const pids = ompPids()
  if (pids && pids.length > 0) {
    for (const p of pids) {
      if (!seen.has(p.pid)) {
        seen.add(p.pid)
        sightings.push({ at: stamp(), pid: p.pid, mem: p.mem })
      }
    }
  }
  const row = db.prepare(
    `SELECT text FROM chat_messages WHERE channel_id = ? AND sender_type = 'agent' ORDER BY rowid DESC LIMIT 1`,
  ).get(channelId) as { text: string } | undefined
  if (row) {
    replyText = row.text
    break
  }
  await sleep(200)
}

say('')
say('[证据③] 回复期间系统进程表里出现的 omp.exe:')
if (sightings.length === 0) {
  say('   (未捕获到 omp.exe —— 探针不可用或并非子进程路径,不能据此声称真实;见下方回复内容判据)')
}
else {
  for (const s of sightings) say(`   ${s.at}  omp.exe pid=${s.pid} mem=${s.mem}`)
}

say('')
say('[证据④] 回复内容')
if (!replyText) {
  say('   ❌ 未收到回复')
}
else {
  for (const line of replyText.split('\n')) say(`   | ${line}`)
  const isMockTemplate = replyText.includes('mock 群聊回复') && replyText.includes('已处理「')
  say('')
  say(`   mock 模板特征("mock 群聊回复(...):已处理「...」")出现 = ${isMockTemplate}`)
  say(`   回复里含 "5"(题目答案)= ${/\b5\b/.test(replyText)}`)
  say(`   判定:${!isMockTemplate ? '不是 mock 模板输出' : '是 mock 模板输出(应为真实模型)'}`
    + `;${/\b5\b/.test(replyText) ? '且答出了 2+3=5(模型作答特征)' : '未答出 5'}`)
}

writeFileSync(join(process.cwd(), '.gw-omp-proof.txt'), `${lines.join('\n')}\n`, 'utf8')
await manager.shutdown()
db.close()
process.exit(0)
