/**
 * AgentMemory P0 测试:repo(FTS/去重/touch/delete/team 预埋)→ 模块(排序/预算/格式)→ 运行时集成。
 * 运行: npx tsx scripts/test-memory.ts
 */
import type { DatabaseSync } from 'node:sqlite'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import { createMemoryRepo, TEAM_AGENT_ID } from '../server/services/workshop/db/memory.repo'
import { AgentMemory, buildMatchQuery, estimateTokens, segmentCJK } from '../server/services/workshop/runtime/memory'
import { randomUUID } from 'node:crypto'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { Mailbox } from '../server/services/workshop/runtime/mailbox'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createTeamRepo } from '../server/services/workshop/db/team.repo'
import { createTeamMemberRepo } from '../server/services/workshop/db/team-member.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { AppError } from '../server/utils/errors'
import { AgentRuntime } from '../server/services/workshop/runtime/agent-runtime'
import type { ChannelBus, TaskEngine } from '../server/services/workshop/runtime/agent-runtime'
import type {
  AgentEvent,
  AgentInterface,
  AgentInfo,
  AgentRunContext,
  AgentRunRequest,
  AgentWorkspace,
} from '../server/services/workshop/agents/agent-interface'
import type { WorkspaceTask, TaskState, AgentTaskQueueView } from '../server/services/workshop/types/task'
import type { Part } from '../server/services/workshop/types/a2a'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const db: DatabaseSync = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const seg = (s: string): string => s.replace(/([\u4e00-\u9fff])/g, ' $1 ')

// ---- repo:写入 + CJK FTS 检索(title 经 titleFts 切分入索引;content 切分传入)----
repo.upsert({ channelId: 'ch1', agentId: 'a1', kind: 'episodic-task', title: '实现登录页面', titleFts: seg('实现登录页面'), content: seg('用OAuth2方案完成了登录鉴权'), importance: 0.8, taskId: 't1', dedupKey: 'task:t1' })
repo.upsert({ channelId: 'ch1', agentId: 'a1', kind: 'episodic-task', title: '数据库调研', titleFts: seg('数据库调研'), content: seg('最终选择SQLite因为轻量嵌入式'), importance: 0.8, taskId: 't2', dedupKey: 'task:t2' })
repo.upsert({ channelId: 'ch1', agentId: 'a2', kind: 'episodic-task', title: '他人记忆', titleFts: seg('他人记忆'), content: seg('别的agent的登录杂事'), importance: 0.8, taskId: 't3', dedupKey: 'task:t3' })

const hit = repo.search('a1', `${seg('登录').trim()} OR oauth`, 5)
check('FTS 中英混合检索命中(经 titleFts)', hit.length >= 1 && hit[0].title === '实现登录页面', `hits=${hit.length}`)
check('展示 title 保持原文(未切分)', hit[0]?.title === '实现登录页面')
check('FTS 不串他人私有记忆', hit.every(r => r.agentId === 'a1'))

// ---- repo:team 域预埋(search 恒含 team 行)----
repo.upsert({ channelId: 'ch1', agentId: TEAM_AGENT_ID, kind: 'semantic', title: 'channel 代码风格', titleFts: seg('channel 代码风格'), content: seg('全部使用TypeScript strict模式'), importance: 0.9, taskId: null, dedupKey: 'style:ts' })
const teamQuery = seg('代码风格').trim().split(/\s+/).join(' OR ') // → '代 OR 码 OR 风 OR 格'
const teamHit = repo.search('a1', teamQuery, 5)
check('team 记忆对所有 agent 可见(经 titleFts 命中)', teamHit.some(r => r.agentId === TEAM_AGENT_ID))
check('listRecent 严格本人(不含 team)', !repo.listRecent('a1', 10).some(r => r.agentId === TEAM_AGENT_ID))

// ---- repo:去重 upsert ----
repo.upsert({ channelId: 'ch1', agentId: 'a1', kind: 'episodic-task', title: '实现登录页面', titleFts: seg('实现登录页面'), content: seg('重跑后改用JWT方案'), importance: 0.8, taskId: 't1', dedupKey: 'task:t1' })
check('同 dedupKey 去重', repo.listByAgent('a1', 10).length === 2)
check('upsert 刷新后 FTS 同步', repo.search('a1', 'jwt', 5).length === 1)
const dedup = repo.findByAgentDedup('a1', 'task:t1')
check('findByAgentDedup 返回 id+rowid', dedup !== null && typeof dedup.rowid === 'number')

// ---- repo:touch + delete ----
repo.touch(dedup!.id)
check('touch 递增 access_count', repo.listByAgent('a1', 10).find(r => r.id === dedup!.id)!.accessCount >= 1)
const teamDel = repo.findByAgentDedup(TEAM_AGENT_ID, 'style:ts')!
check('team 行去重键独立', teamDel !== null)
check('delete 返回 true 且 FTS 同步清理', repo.delete(dedup!.id) === true && repo.search('a1', 'jwt', 5).length === 0)
check('listMemoryAgentIds 排除 team', repo.listMemoryAgentIds().includes(TEAM_AGENT_ID) === false)

// ═══════════ 模块:AgentMemory ═══════════
console.log('\n--- AgentMemory 模块 ---')

check('segmentCJK 汉字间加空格', segmentCJK('登录oauth') === ' 登 录 oauth')
check('buildMatchQuery OR 连接 + 剔除操作符/保留词(引号包裹)', buildMatchQuery('登录 (页面) AND not') === '"登" OR "录" OR "页" OR "面"')
check('buildMatchQuery 空查询 null', buildMatchQuery('   ') === null)
check('buildMatchQuery ASCII 单字词过滤', buildMatchQuery('a b oauth') === '"oauth"')
check('estimateTokens 中英混合', estimateTokens('登录ab') === 3)
check('buildMatchQuery 剥除路径标点', buildMatchQuery('读取 D:/codes/x/.tmp-a/input.txt 内容') !== null && !buildMatchQuery('读取 D:/codes/x/.tmp-a/input.txt 内容')!.includes('.'))
check('buildMatchQuery 词项全部引号包裹', (() => {
  const q = buildMatchQuery('登录 oauth 页面')
  return q === null || q.split(' OR ').every(t => t.startsWith('"') && t.endsWith('"'))
})())
// 前段 delete 了 task:t1 行,重新播种供模块段使用(fresh insert,access_count=0)
repo.upsert({ channelId: 'ch1', agentId: 'a1', kind: 'episodic-task', title: '实现登录页面', titleFts: seg('实现登录页面'), content: seg('用OAuth2方案完成了登录鉴权'), importance: 0.8, taskId: 't1', dedupKey: 'task:t1' })

const memA = new AgentMemory(repo, { channelId: 'ch1', agentId: 'a1' })
await memA.recall('数据库', { touch: false })
check('touch:false 不改 access_count', repo.listByAgent('a1', 10).find(r => r.title === '数据库调研')!.accessCount === 0)

// 查询同时含本人记忆与 team 记忆的词(两者都经 FTS 命中;listRecent 兜底不含 team)
const block = await memA.recall('登录页面 代码风格')
check('recall 含本人相关记忆', block !== null && block.includes('实现登录页面'))
check('recall 含 team 共享记忆', block !== null && block.includes('channel 代码风格'), block?.slice(0, 100))
check('recall 不含他人私有记忆', block !== null && !block.includes('他人记忆'))
const t1row = repo.listByAgent('a1', 10).find(r => r.title === '实现登录页面')
check('recall 默认 touch', t1row !== undefined && t1row.accessCount >= 1)

const memTiny = new AgentMemory(repo, { channelId: 'ch1', agentId: 'a1', budgetTokens: 5 })
const tiny = await memTiny.recall('登录 数据库')
check('极小预算整行取舍', tiny === null || tiny.split('\n').length <= 3)

const memEmpty = new AgentMemory(repo, { channelId: 'ch1', agentId: 'nobody' })
check('无记忆 recall 返回 null', (await memEmpty.recall('任意')) === null)

const pathResult = await new AgentMemory(repo, { channelId: 'ch1', agentId: 'a1' })
  .recall('配置在 D:/codes/.tmp-x/config.json 怎么改')
  .then(v => v ?? null, () => '__THROWN__')
check('路径文本 recall 不炸', pathResult !== '__THROWN__')

// ═══════════ 运行时集成:召回注入 + 结束沉淀 ═══════════
console.log('\n--- AgentRuntime 记忆集成 ---')

/** 落库一个 channel(messages.channel_id 外键依赖;照抄 test-agent-runtime.ts) */
function seedChannel(database: DatabaseSync, id: string): void {
  const now = new Date().toISOString()
  database.prepare(
    `INSERT INTO channels (id, name, description, lead_agent_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, id, '', null, 1, now, now)
}

seedChannel(db, 'ch-mem')

const memBus: ChannelBus = {
  emit: () => {}, onEvent: () => () => {}, notifyTask: () => {}, onTaskEvent: () => () => {},
  notifyAgent: () => {}, onAgentStatus: () => () => {}, wakeScheduler: () => {},
}
// fake engine(签名对齐 agent-runtime.ts 的 TaskEngine 契约;完成态经 transition 驱动)
const memTasks = new Map<string, WorkspaceTask>()
const fakeEngine: TaskEngine = {
  create: (input: { channelId: string, creatorId: string, assigneeId: string, title: string }) => {
    const t: WorkspaceTask = { id: randomUUID(), channelId: input.channelId, assigneeId: input.assigneeId, creatorId: input.creatorId, title: input.title, state: 'SUBMITTED', progress: 0, retryCount: 0, artifacts: [], history: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
    memTasks.set(t.id, t)
    return t
  },
  dispatch: () => { throw new Error('unused') },
  transition: (taskId: string, state: TaskState, _by: string) => {
    const t = memTasks.get(taskId)
    if (t) t.state = state
    return t!
  },
  // 对齐真实 TaskEngine.applyEvent:非 append artifact 落 task.artifacts(终态 harvest 数据源)
  applyEvent: (taskId: string, event: AgentEvent) => {
    const t = memTasks.get(taskId)
    if (t && event.kind === 'artifact') t.artifacts = [...t.artifacts, event.artifact]
  },
  list: () => [...memTasks.values()],
  get: (id: string) => memTasks.get(id),
  complete: () => { throw new Error('unused') },
  reassign: () => { throw new Error('unused') },
  updateTask: () => { throw new Error('unused') },
  cancel: () => { throw new Error('unused') },
  onChildCompleted: () => {},
  redeliverAssign: () => { throw new Error('unused') },
  queueViewOf: (channelId: string, agentId: string): AgentTaskQueueView => ({ agentId, channelId, queued: [], completed: [] }),
}
// workspace stub:EchoImpl 的 completeTask 经 transition 落 COMPLETED(终态判定依赖)
const wsStub = (agentId: string): AgentWorkspace => ({
  completeTask: async (taskId: string, artifacts) => {
    const t = memTasks.get(taskId)
    if (t) {
      t.artifacts = [...t.artifacts, ...artifacts]
      t.progress = 100
      fakeEngine.transition(taskId, 'COMPLETED', agentId)
    }
    return t!
  },
}) as AgentWorkspace
void wsStub

class MemoryEchoImpl implements AgentInterface {
  readonly captured: AgentRunRequest[] = []
  async* run(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    this.captured.push(request)
    const taskId = request.taskId ?? (request.message.metadata?.['x-aw-task-id'] as string | undefined)
    if (taskId && ctx.role === 'worker') {
      yield { kind: 'status', status: { state: 'WORKING', timestamp: new Date().toISOString() } }
      await (ctx.workspace as { completeTask: (id: string, arts: unknown[]) => Promise<unknown> }).completeTask(taskId, [])
      yield { kind: 'artifact', artifact: { artifactId: randomUUID(), name: 'deliverable', parts: [{ text: `memory-seen:${request.memory ?? 'NONE'}` }] }, lastChunk: true, totalChunks: 1 }
      yield { kind: 'done', final: { taskId } }
    }
  }
}

const mkRt = (id: string): { rt: AgentRuntime, echo: MemoryEchoImpl } => {
  const info: AgentInfo = { id, channelId: 'ch-mem', name: id, harness: 'mock', role: 'worker', config: {} }
  const echo = new MemoryEchoImpl()
  const rt = new AgentRuntime(info, echo, {
    mailbox: new Mailbox(createMessageRepo(db), 'ch-mem', id, () => {}),
    taskEngine: fakeEngine,
    bus: memBus,
    workspace: wsStub(id),
    memory: new AgentMemory(repo, { channelId: 'ch-mem', agentId: id }),
  })
  rt.start()
  return { rt, echo }
}
const mkAssign = (task: WorkspaceTask): Part[] => [{ text: task.title }]
const enqueueAssign = (rt: AgentRuntime, task: WorkspaceTask): void => {
  rt.enqueue({ messageId: randomUUID(), contextId: 'ch-mem', role: 'ROLE_AGENT', taskId: task.id, parts: mkAssign(task), metadata: { 'x-aw-from-agent': 'lead', 'x-aw-task-kind': 'assign', 'x-aw-task-id': task.id } })
}

const { rt: rtA, echo: echoA } = mkRt('w-mem')
const taskA = fakeEngine.create({ channelId: 'ch-mem', creatorId: 'lead', assigneeId: 'w-mem', title: '实现登录页面' })
enqueueAssign(rtA, taskA)
await new Promise<void>(r => setTimeout(r, 300))
check('任务 A 首跑无记忆注入', echoA.captured.at(-1)?.memory === undefined)
const aRow = repo.listByAgent('w-mem', 10).find(r => r.taskId === taskA.id)
check('任务 A 完成后沉淀记忆(含 deliverable)', aRow !== undefined && aRow.content.includes('memory-seen:NONE'), aRow?.content.slice(0, 60))
check('任务 A 记忆 importance=0.8(COMPLETED)', aRow?.importance === 0.8)

const taskB = fakeEngine.create({ channelId: 'ch-mem', creatorId: 'lead', assigneeId: 'w-mem', title: '登录模块优化' })
enqueueAssign(rtA, taskB)
await new Promise<void>(r => setTimeout(r, 300))
const secondReq = echoA.captured.at(-1)
check('任务 B 召回注入 A 的记忆(经 title_fts 相关命中)', secondReq?.memory !== undefined && secondReq.memory.includes('实现登录页面'), secondReq?.memory?.slice(0, 80))
check('记忆块带 prompt 标题头', (secondReq?.memory ?? '').startsWith('## 相关记忆'))

const { rt: rtO, echo: echoO } = mkRt('w-other')
const taskC = fakeEngine.create({ channelId: 'ch-mem', creatorId: 'lead', assigneeId: 'w-other', title: '登录鉴权怎么做' })
enqueueAssign(rtO, taskC)
await new Promise<void>(r => setTimeout(r, 300))
check('跨 agent 记忆隔离(w-other 召回不到 w-mem)', echoO.captured.at(-1)?.memory === undefined)

await rtA.stop()
await rtO.stop()

// ═══════════ 团队共享记忆域(manager 策展 + recall 通道隔离)═══════════
console.log('\n--- Team 共享记忆域 ---')

// 最小 manager 装配(照 test-dual-drive.ts;:memory: db;impl 仅占位)
const stubImpl = (_agent: AgentInfo): AgentInterface => {
  throw new Error('impl unused')
}
/** 捕获 AppError code(未抛返回空串) */
function captureCode(fn: () => unknown): string {
  try {
    fn()
  }
  catch (e) {
    return (e as AppError).code
  }
  return ''
}
const tmRepos = {
  channels: createChannelRepo(db),
  agents: createAgentRepo(db),
  teams: createTeamRepo(db),
  teamMembers: createTeamMemberRepo(db),
  channelAgents: createChannelAgentRepo(db),
  messages: createMessageRepo(db),
  subscriptions: createSubscriptionRepo(db),
  tasks: createTaskRepo(db),
  memories: repo,
}
const teamManager = createAgentChannelManager({ repos: tmRepos, implFactory: stubImpl, db })
const chTeam = tmRepos.channels.create({ name: 'ch-team' })
const leadInst = tmRepos.channelAgents.create({ channelId: chTeam.id, templateId: null, name: 'lead', harness: 'mock', role: 'lead' })
const workerInst = tmRepos.channelAgents.create({ channelId: chTeam.id, templateId: null, name: 'worker', harness: 'mock', role: 'worker' })

const teamList = teamManager.addTeamMemory(chTeam.id, leadInst.id, { title: '部署规范', content: '全部使用pnpm并开启strict', dedupKey: 'deploy:pnpm' })
check('lead 写团队记忆成功入列', teamList.length === 1 && teamList[0].agentId === TEAM_AGENT_ID && teamList[0].channelId === chTeam.id)
const teamErrWrite = captureCode(() => teamManager.addTeamMemory(chTeam.id, workerInst.id, { title: 'x', content: 'y' }))
check('worker 写团队记忆抛 SCOPE_VIOLATION', teamErrWrite === 'SCOPE_VIOLATION', `code=${teamErrWrite}`)

teamManager.addTeamMemory(chTeam.id, leadInst.id, { title: '部署规范', content: '改用bun并保留strict', dedupKey: 'deploy:pnpm' })
const refreshed = teamManager.listTeamMemories(chTeam.id)
check('同 dedupKey 二次写幂等刷新(仍 1 条)', refreshed.length === 1 && refreshed[0].content.includes('bun') && !refreshed[0].content.includes('pnpm'))

const workerBlock = await new AgentMemory(repo, { channelId: chTeam.id, agentId: workerInst.id }).recall('部署规范')
check('worker recall 可见团队行', workerBlock !== null && workerBlock.includes('部署规范'))

const teamErrDelWorker = captureCode(() => teamManager.deleteTeamMemory(chTeam.id, workerInst.id, refreshed[0].id))
check('worker 删团队记忆抛 SCOPE_VIOLATION', teamErrDelWorker === 'SCOPE_VIOLATION', `code=${teamErrDelWorker}`)

teamManager.deleteTeamMemory(chTeam.id, leadInst.id, refreshed[0].id)
check('lead 删团队记忆成功', teamManager.listTeamMemories(chTeam.id).length === 0)
const teamErrDelMiss = captureCode(() => teamManager.deleteTeamMemory(chTeam.id, leadInst.id, 'no-such-id'))
check('删不存在团队记忆抛 NOT_FOUND', teamErrDelMiss === 'NOT_FOUND', `code=${teamErrDelMiss}`)

// ---- recall 通道隔离:team 行(FTS 来源)按本 channel 过滤 ----
repo.upsert({ channelId: 'ch-other', agentId: TEAM_AGENT_ID, kind: 'semantic', title: '他通道金丝雀', titleFts: seg('他通道金丝雀'), content: seg('跨通道独占水印金丝雀'), importance: 0.9, taskId: null, dedupKey: 'iso:other' })
repo.upsert({ channelId: 'ch1', agentId: TEAM_AGENT_ID, kind: 'semantic', title: '本通道金丝雀', titleFts: seg('本通道金丝雀'), content: seg('本通道共享金丝雀约定'), importance: 0.9, taskId: null, dedupKey: 'iso:ch1' })
const isoBlock = await new AgentMemory(repo, { channelId: 'ch1', agentId: 'a1' }).recall('金丝雀')
check('recall 不泄漏他通道团队记忆', isoBlock === null || !isoBlock.includes('他通道金丝雀'), isoBlock?.slice(0, 80))
check('recall 可见本通道团队记忆', isoBlock !== null && isoBlock.includes('本通道金丝雀'), isoBlock?.slice(0, 80))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
