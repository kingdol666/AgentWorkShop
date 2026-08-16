/**
 * 记忆持久化跨重启端到端验证 — 文件型 sqlite + 双 manager 生命周期:
 * ① 并行创建两个 Channel(A: 记忆链路 / B: 隔离对照),各 lead + 2 worker
 * ② 双 Channel 交错提交任务并行闭环 → 各 agent 记忆自动落库(私有)
 * ③ Channel A 的 worker 经 workspace.saveMemory 沉淀 shared 公共记忆
 * ④ 注入验证(重启前):A 相关任务 request.memory 含 A 私有 + A 公共;B 不含 A 的任何内容
 * ⑤ 中断卸载:manager.shutdown() + db.close() → 全新 manager 同一 DB 文件 restore()(模拟进程重启)
 * ⑥ 重启后各 Channel 重新下发相关任务:
 *    - request.memory(记忆引子)仍召回重启前的私有/公共记忆
 *    - echo 执行中主动调 ctx.workspace.recallMemory(动态抓取工具桥)→ deliverable 携带命中内容
 * ⑦ Channel 隔离:重启后 A 仍看不到 B 的私有记忆,B 看不到 A 的公共记忆
 * 向量链已由 test-memory-vector 覆盖;本 E2E 纯 FTS 路径。
 * 运行: npx tsx scripts/e2e-memory-persistence.ts
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import type { DatabaseSync } from 'node:sqlite'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMemoryRepo } from '../server/services/workshop/db/memory.repo'
import { createChannelEventRepo } from '../server/services/workshop/db/channel-event.repo'
import { createTeamRepo } from '../server/services/workshop/db/team.repo'
import { createTeamMemberRepo } from '../server/services/workshop/db/team-member.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { AgentChannelManager, AllRepos } from '../server/services/workshop/runtime/manager'
import type { AgentInfo, AgentInterface, AgentRunContext, AgentRunRequest, AgentEvent } from '../server/services/workshop/agents/agent-interface'
import type { A2AArtifact, Part } from '../server/services/workshop/types/a2a'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

async function waitUntil(cond: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await sleep(50)
  }
  return false
}

function partsText(parts: Part[]): string {
  return parts.map(p => ('text' in p ? p.text : '')).filter(Boolean).join('\n')
}

// ═══════════ echo harness ═══════════

interface EchoOptions {
  /** 重启后的 worker:执行中主动调 recallMemory 工具桥,把命中放进 deliverable */
  useMemoryTools?: boolean
}

class EchoWorkerImpl implements AgentInterface {
  readonly captured: AgentRunRequest[] = []
  constructor(private opts: EchoOptions = {}) {}

  async* run(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    this.captured.push(request)
    const kind = request.message.metadata?.['x-aw-task-kind']
    if (kind === 'assign' && request.taskId) {
      yield { kind: 'status', status: { state: 'WORKING', timestamp: new Date().toISOString() } }
      const taskText = partsText(request.message.parts)
      // 动态记忆抓取工具桥(search_memory 路径同源):执行中按任务内容检索记忆(仅重启后轮开启)
      let toolRecall = ''
      if (this.opts.useMemoryTools) {
        const snippets = await ctx.workspace.recallMemory({ query: taskText.slice(0, 60), scope: 'auto', limit: 5 })
        toolRecall = snippets.map(s => `[${s.source}]${s.title}:${s.content.slice(0, 60)}`).join(' | ')
      }
      const artifact: A2AArtifact = {
        artifactId: randomUUID(),
        name: 'deliverable',
        parts: [{ text: `echo 完成(${ctx.agentId}):${taskText.slice(0, 60)}${toolRecall || this.opts.useMemoryTools ? `;记忆抓取=${toolRecall || '(无)'}` : ''}` }],
      }
      yield { kind: 'artifact', artifact, lastChunk: true, totalChunks: 1 }
      await ctx.workspace.completeTask(request.taskId, [artifact])
      yield { kind: 'done', final: { taskId: request.taskId } }
      return
    }
    yield { kind: 'done' }
  }
}

class EchoLeadImpl implements AgentInterface {
  readonly captured: AgentRunRequest[] = []

  async* run(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    this.captured.push(request)
    if (request.message.metadata?.['x-aw-task-kind'] === 'child-completed' && request.taskId) {
      const parent = await ctx.workspace.getTask(request.taskId)
      if (parent && parent.state !== 'COMPLETED' && parent.state !== 'FAILED' && parent.state !== 'CANCELED') {
        const summary: A2AArtifact = {
          artifactId: randomUUID(),
          name: 'summary',
          parts: [{ text: `汇总:子任务完成(${partsText(request.message.parts).slice(0, 60)})` }],
        }
        await ctx.workspace.completeTask(request.taskId, [summary])
      }
      yield { kind: 'done' }
    }
  }
}

// ═══════════ 装配 ═══════════

const tmpDir = mkdtempSync(join(tmpdir(), 'aw-e2e-mem-persist-'))
const dbFile = join(tmpDir, 'workshop.sqlite')

function openRepos(db: DatabaseSync): AllRepos {
  return {
    channels: createChannelRepo(db),
    agents: createAgentRepo(db),
    channelAgents: createChannelAgentRepo(db),
    messages: createMessageRepo(db),
    subscriptions: createSubscriptionRepo(db),
    tasks: createTaskRepo(db),
    memories: createMemoryRepo(db),

    channelEvents: createChannelEventRepo(db),
    teams: createTeamRepo(db),
    teamMembers: createTeamMemberRepo(db),
  }
}

const echoByAgent = new Map<string, EchoWorkerImpl | EchoLeadImpl>()

function makeManager(db: DatabaseSync, opts?: { workerOpts?: EchoOptions }): AgentChannelManager {
  echoByAgent.clear()
  const repos = openRepos(db)
  const implFactory = (agent: AgentInfo): AgentInterface => {
    const impl = agent.role === 'lead'
      ? new EchoLeadImpl()
      : new EchoWorkerImpl({ ...(opts?.workerOpts ?? {}) })
    echoByAgent.set(agent.id, impl)
    return impl
  }
  return createAgentChannelManager({ repos, implFactory, db })
}

let db = openWorkshopDb(dbFile)
let manager = makeManager(db)

interface Ch {
  id: string
  lead: AgentInfo
  workers: AgentInfo[]
}

async function setupChannel(name: string, workerCount: number): Promise<Ch> {
  const ch = await manager.createChannel({ name, workspace: join(tmpDir, name) })
  const leadTpl = await manager.createAgent({ name: `${name}-lead`, harness: 'echo' })
  const lead = await manager.addAgentToChannel({ channelId: ch.channelId, agentId: leadTpl.id, role: 'lead' })
  const workers: AgentInfo[] = []
  for (let i = 1; i <= workerCount; i++) {
    const tpl = await manager.createAgent({ name: `${name}-w${i}`, harness: 'echo' })
    workers.push(await manager.addAgentToChannel({ channelId: ch.channelId, agentId: tpl.id, role: 'worker' }))
  }
  manager.ensureChannelActive(ch.channelId, { tickMs: 50 })
  return { id: ch.channelId, lead, workers }
}

function submit(chId: string, title: string, description: string): Promise<unknown> {
  return manager.submitChannelTask({ channelId: chId, title, description })
}

function waitDone(chId: string, leadId: string, title: string): Promise<boolean> {
  return waitUntil(async () =>
    (await manager.listTasks(chId, leadId)).some(t => t.title === title && t.state === 'COMPLETED'), 15_000)
}

function workerRequests(agentId: string): AgentRunRequest[] {
  return (echoByAgent.get(agentId) as EchoWorkerImpl | undefined)?.captured ?? []
}

/** 找标题匹配的任务请求中最近一个带记忆块的 */
function lastMemoryReq(agentIds: string[], title: string): AgentRunRequest | undefined {
  return agentIds
    .flatMap(id => workerRequests(id))
    .reverse()
    .find(r => partsText(r.message.parts).includes(title) && r.memory !== undefined)
}

async function main(): Promise<void> {
  // ── ① 并行创建两个 Channel(各 lead + 2 worker)──
  console.log('=== ① 并行双 Channel 装配(A: 记忆链路 / B: 隔离对照) ===')
  const [chA, chB] = await Promise.all([setupChannel('alpha', 2), setupChannel('beta', 2)])
  check('双 Channel 各装配 3 实例',
    (await manager.listChannelAgents(chA.id)).length === 3 && (await manager.listChannelAgents(chB.id)).length === 3)
  const st = manager.runtimeStatus()
  // worker 懒装配:任务分发时才接线,此处仅要求两 channel 激活 + 双 lead 在线
  check('两 Channel 激活且双 lead runtime 在线',
    st.activeChannels.includes(chA.id) && st.activeChannels.includes(chB.id)
    && st.wiredAgents.includes(chA.lead.id) && st.wiredAgents.includes(chB.lead.id),
    `wired=${st.wiredAgents.length}`)

  // ── ② 交错并行提交任务 → 记忆自动落库 ──
  console.log('\n=== ② 双 Channel 交错并行任务(记忆自动落库) ===')
  await Promise.all([
    submit(chA.id, '实现支付网关对接', '为订单系统对接支付宝网关,完成签名与回调验签'),
    submit(chB.id, '实现报表导出', '为运营后台实现CSV报表导出功能'),
    submit(chA.id, '支付网关签名算法', '实现支付网关的RSA2签名算法与验签'),
    submit(chB.id, '报表分页优化', '优化大报表导出的分页查询性能'),
  ])
  check('A 任务1 闭环', await waitDone(chA.id, chA.lead.id, '实现支付网关对接'))
  check('A 任务2 闭环', await waitDone(chA.id, chA.lead.id, '支付网关签名算法'))
  check('B 任务1 闭环', await waitDone(chB.id, chB.lead.id, '实现报表导出'))
  check('B 任务2 闭环', await waitDone(chB.id, chB.lead.id, '报表分页优化'))

  const memRepo = openRepos(db).memories
  const hasMem = (agentId: string, kw: string): boolean =>
    memRepo.listByAgent(agentId, 50).some(r => r.title.includes(kw))
  check('A 两个 worker 均有任务记忆落库',
    await waitUntil(() => chA.workers.every(w => hasMem(w.id, '支付')), 5000),
    chA.workers.map(w => `${w.name}:${memRepo.listByAgent(w.id, 50).length}`).join(' '))
  check('B 两个 worker 均有任务记忆落库',
    await waitUntil(() => chB.workers.every(w => hasMem(w.id, '报表')), 5000),
    chB.workers.map(w => `${w.name}:${memRepo.listByAgent(w.id, 50).length}`).join(' '))

  // ── ③ A 公共记忆入 Channel 共享域(save_memory(scope=shared) 同一存储域;
  //     工具桥的私有/共享分流动作已由 test-memory-dynamic.ts 全覆盖,此处注入 A 专属公共记忆供隔离验证) ──
  console.log('\n=== ③ A 公共记忆写入 Channel 共享域 ===')
  manager.addTeamMemory(chA.id, chA.lead.id, {
    title: '支付网关接入规范',
    content: '所有支付相关代码必须使用 RSA2 签名并在沙箱环境验证',
    dedupKey: 'team:pay-conv',
  })
  const teamRows = manager.listTeamMemories(chA.id, 50)
  const teamRowsB = manager.listTeamMemories(chB.id, 50)
  check('A 公共记忆入列(__team__@A)', teamRows.some(r => r.title === '支付网关接入规范'))
  check('B 公共域无 A 的记忆(隔离)', !teamRowsB.some(r => r.title === '支付网关接入规范'))

  // ── ④ 重启前注入验证(记忆引子) ──
  console.log('\n=== ④ 重启前记忆引子注入 ===')
  await submit(chA.id, '支付回调验签补全', '补全支付网关回调验签逻辑,遵循支付网关接入规范')
  check('A 相关任务闭环', await waitDone(chA.id, chA.lead.id, '支付回调验签补全'))
  const aReq = lastMemoryReq(chA.workers.map(w => w.id), '支付回调验签补全')
  check('A worker 引子含自身私有记忆(支付)', aReq?.memory?.includes('支付') === true, aReq?.memory?.slice(0, 80))
  check('A worker 引子含 A 公共记忆(RSA2)', aReq?.memory?.includes('RSA2') === true)
  check('A worker 引子不含 B 的记忆(报表)', aReq?.memory?.includes('报表') === false)

  await submit(chB.id, '报表导出字段调整', '调整CSV报表导出的字段顺序')
  check('B 相关任务闭环', await waitDone(chB.id, chB.lead.id, '报表导出字段调整'))
  const bReq = lastMemoryReq(chB.workers.map(w => w.id), '报表导出字段调整')
  check('B worker 引子含自身私有记忆(报表)', bReq?.memory?.includes('报表') === true, bReq?.memory?.slice(0, 80))
  check('B worker 引子不含 A 的公共记忆(RSA2/支付)', bReq?.memory?.includes('RSA2') === false && bReq?.memory?.includes('支付网关接入规范') === false)

  // ── ⑤ 中断 + 卸载 Channel(db.close 模拟进程重启) ──
  console.log('\n=== ⑤ 中断卸载(shutdown + db.close → 全新 manager 同 DB restore) ===')
  await manager.shutdown()
  check('shutdown 后 runtime 全卸载', manager.runtimeStatus().wiredAgents.length === 0)
  db.close()
  db = openWorkshopDb(dbFile)
  manager = makeManager(db, { workerOpts: { useMemoryTools: true } })
  await manager.restore()
  check('重启后 manager 就绪(0 wired,lazy)', manager.runtimeStatus().wiredAgents.length === 0)
  check('重启后记忆仍在文件库',
    openRepos(db).memories.listByAgent(chA.workers[0].id, 50).some(r => r.title.includes('支付')))

  // ── ⑥ 重启后重新下发任务:引子召回 + 动态抓取工具桥 ──
  console.log('\n=== ⑥ 重启后任务重发(引子 + recallMemory 工具桥) ===')
  await Promise.all([
    submit(chA.id, '支付网关重试机制', '为支付网关对接增加失败重试机制,遵循既有签名规范'),
    submit(chB.id, '报表模板定制', '为CSV报表导出增加自定义模板'),
  ])
  check('A 重启后任务闭环', await waitDone(chA.id, chA.lead.id, '支付网关重试机制'))
  check('B 重启后任务闭环', await waitDone(chB.id, chB.lead.id, '报表模板定制'))

  const aReq2 = lastMemoryReq(chA.workers.map(w => w.id), '支付网关重试机制')
  check('重启后 A 引子召回重启前私有记忆(支付)', aReq2?.memory?.includes('支付') === true, aReq2?.memory?.slice(0, 80))
  check('重启后 A 引子召回 A 公共记忆(RSA2)', aReq2?.memory?.includes('RSA2') === true)

  const bReq2 = lastMemoryReq(chB.workers.map(w => w.id), '报表模板定制')
  check('重启后 B 引子召回重启前私有记忆(报表)', bReq2?.memory?.includes('报表') === true, bReq2?.memory?.slice(0, 80))
  check('重启后 B 引子仍不见 A 记忆', bReq2?.memory?.includes('支付') === false && bReq2?.memory?.includes('RSA2') === false)

  // 动态抓取工具桥:重启后 echo 执行中主动 recallMemory → deliverable 携带命中(deliverable 在子任务上)
  const deliverableTextOf = async (chId: string, leadId: string, title: string): Promise<string> => {
    const tasks = await manager.listTasks(chId, leadId)
    const hits = tasks
      .filter(t => t.title === title || t.parentId !== undefined)
      .flatMap(t => t.artifacts.filter(a => a.name === 'deliverable'))
      .map(a => partsText(a.parts))
    return hits.find(t => t.includes('记忆抓取=')) ?? hits.join('\n') ?? ''
  }
  const toolText = await deliverableTextOf(chA.id, chA.lead.id, '支付网关重试机制')
  check('重启后 recallMemory 工具桥抓到私有记忆(支付)', toolText.includes('[private]') && toolText.includes('支付'), toolText.slice(0, 160))
  check('重启后 recallMemory 工具桥抓到公共记忆(RSA2,source=shared)', toolText.includes('[shared]') && toolText.includes('RSA2'))

  const bToolText = await deliverableTextOf(chB.id, chB.lead.id, '报表模板定制')
  check('重启后 B 工具桥只见 B 域记忆', bToolText.includes('报表') && !bToolText.includes('RSA2') && !bToolText.includes('支付网关接入规范'), bToolText.slice(0, 160))

  // ── ⑦ 收尾:第二次 shutdown 干净退出 ──
  console.log('\n=== ⑦ 最终 shutdown ===')
  await manager.shutdown()
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('E2E 异常:', e)
  try {
    await manager.shutdown()
    db.close()
  }
  catch { /* 尽力清理 */ }
  rmSync(tmpDir, { recursive: true, force: true })
  process.exit(1)
})
