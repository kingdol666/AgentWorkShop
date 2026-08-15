/**
 * 记忆系统端到端验证 — 真实 AgentChannelManager(:memory: db)+ echo harness 全链:
 * ① channel + lead/2worker 装配,runtimes started
 * ② 任务完成 → lead/worker 各自记忆落库
 * ③ lead addTeamMemory('团队统一用 pnpm')
 * ④ 相关任务下发 → echo 捕获 worker request.memory 含任务1记忆 + 团队行
 * ⑤ worker 间 peer 消息(require_reply)→ 双方 peer 记忆落库
 * ⑥ REST(h3 toWebHandler 挂真实路由 handler):GET memories / POST team(lead)/ POST agent / DELETE 全 2xx;非 lead 写 team → 403
 * ⑦ runMemoryMaintenanceNow() → 回拨老数据被清(团队行豁免)
 * ⑧ await manager.shutdown() → 干净退出
 * 向量链(hash embedder)已由 test-memory-vector.ts 覆盖;本 E2E 走纯 FTS 路径。
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createRouter, toWebHandler } from 'h3'
import { openWorkshopDb } from '../server/services/workshop/db/database'
import type { MemoryRow } from '../server/services/workshop/db/database'
import { createChannelRepo } from '../server/services/workshop/db/channel.repo'
import { createAgentRepo } from '../server/services/workshop/db/agent.repo'
import { createChannelAgentRepo } from '../server/services/workshop/db/channel-agent.repo'
import { createTaskRepo } from '../server/services/workshop/db/task.repo'
import { createMemoryRepo, TEAM_AGENT_ID } from '../server/services/workshop/db/memory.repo'
import { createTeamRepo } from '../server/services/workshop/db/team.repo'
import { createTeamMemberRepo } from '../server/services/workshop/db/team-member.repo'
import { createMessageRepo } from '../server/services/workshop/db/message.repo'
import { createSubscriptionRepo } from '../server/services/workshop/db/subscription.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'

import type { AgentInfo, AgentInterface, AgentRunContext, AgentRunRequest, AgentEvent } from '../server/services/workshop/agents/agent-interface'
import type { A2AArtifact, Part } from '../server/services/workshop/types/a2a'
// 真实 REST 路由 handler(生产同源;经 globalThis.__workshopManager 接测试 manager)
import teamMemGet from '../server/api/workshop/channels/[id]/memories/index.get'
import teamMemPost from '../server/api/workshop/channels/[id]/memories/index.post'
import teamMemDelete from '../server/api/workshop/channels/[id]/memories/[memoryId].delete'
import agentMemPost from '../server/api/workshop/channels/[id]/agents/[agentId]/memories/index.post'
import agentMemDelete from '../server/api/workshop/channels/[id]/agents/[agentId]/memories/[memoryId].delete'

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

// ═══════════ echo harness:捕获 request.memory + 驱动任务/peer 剧本 ═══════════

/** worker echo:assign → 产 deliverable + completeTask;peer(require-reply)→ 回执(message 事件 + sendMessage) */
class EchoWorkerImpl implements AgentInterface {
  readonly captured: AgentRunRequest[] = []

  async* run(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    this.captured.push(request)
    const kind = request.message.metadata?.['x-aw-task-kind']
    if (kind === 'assign' && request.taskId) {
      yield { kind: 'status', status: { state: 'WORKING', timestamp: new Date().toISOString() } }
      const artifact: A2AArtifact = {
        artifactId: randomUUID(),
        name: 'deliverable',
        parts: [{ text: `echo 完成(${ctx.agentId}):${partsText(request.message.parts).slice(0, 80)}` }],
      }
      yield { kind: 'artifact', artifact, lastChunk: true, totalChunks: 1 }
      await ctx.workspace.completeTask(request.taskId, [artifact])
      yield { kind: 'done', final: { taskId: request.taskId } }
      return
    }
    const fromId = request.fromAgentId
    if (!kind && fromId) {
      if (request.message.metadata?.['x-aw-require-reply'] === 'true') {
        const text = partsText(request.message.parts)
        const reply = `echo 回复(${ctx.agentId}):已处理「${text.slice(0, 60)}」。执行结果:完成。本回复不需要再响应。`
        yield { kind: 'message', message: { messageId: randomUUID(), contextId: ctx.channelId, role: 'ROLE_AGENT', parts: [{ text: reply }] } }
        await ctx.workspace.sendMessage({
          toAgentId: fromId,
          parts: [{ text: reply }],
          metadata: { 'x-aw-in-reply-to': request.message.messageId, 'x-aw-require-reply': 'false' },
        })
      }
      yield { kind: 'done' }
    }
  }
}

/** lead echo:child-completed → 汇总 summary + completeTask 父任务(终态后 runtime 自动沉淀 lead 记忆);调度走规则引擎兜底 */
class EchoLeadImpl implements AgentInterface {
  readonly captured: AgentRunRequest[] = []

  async* run(request: AgentRunRequest, ctx: AgentRunContext): AsyncGenerator<AgentEvent, void, unknown> {
    this.captured.push(request)
    if (request.message.metadata?.['x-aw-task-kind'] === 'child-completed' && request.taskId) {
      // 规则引擎兜底可能已先收口父任务(调度轮与 child-completed 投递并发)→ 幂等:仅非终态时汇总收口
      const parent = await ctx.workspace.getTask(request.taskId)
      if (parent && parent.state !== 'COMPLETED' && parent.state !== 'FAILED' && parent.state !== 'CANCELED') {
        const summary: A2AArtifact = {
          artifactId: randomUUID(),
          name: 'summary',
          parts: [{ text: `汇总:子任务完成(${partsText(request.message.parts).slice(0, 80)})` }],
        }
        await ctx.workspace.completeTask(request.taskId, [summary])
      }
      yield { kind: 'done' }
    }
  }
}

// ═══════════ 装配 ═══════════

const db = openWorkshopDb(':memory:')
const repos = {
  channels: createChannelRepo(db),
  agents: createAgentRepo(db),
  channelAgents: createChannelAgentRepo(db),
  messages: createMessageRepo(db),
  subscriptions: createSubscriptionRepo(db),
  tasks: createTaskRepo(db),
  memories: createMemoryRepo(db),
  teams: createTeamRepo(db),
  teamMembers: createTeamMemberRepo(db),
}

const echoByAgent = new Map<string, EchoWorkerImpl | EchoLeadImpl>()
const implFactory = (agent: AgentInfo): AgentInterface => {
  const impl = agent.role === 'lead' ? new EchoLeadImpl() : new EchoWorkerImpl()
  echoByAgent.set(agent.id, impl)
  return impl
}
const manager = createAgentChannelManager({ repos, implFactory, db })
// REST 路由 handler 经 getWorkshopManager() 读进程级单例 → 指向测试 manager
globalThis.__workshopManager = manager

const tmpWorkspace = mkdtempSync(join(tmpdir(), 'aw-e2e-memory-'))

async function main(): Promise<void> {
  // ── ① channel + lead + 2 worker 装配,runtimes started ──
  console.log('\n=== ① channel + agents 装配 ===')
  const ch = await manager.createChannel({ name: 'memory-e2e', workspace: tmpWorkspace })
  const channelId = ch.channelId
  const leadTpl = await manager.createAgent({ name: 'lead', harness: 'echo' })
  const lead = await manager.addAgentToChannel({ channelId, agentId: leadTpl.id, role: 'lead' })
  const mkWorker = async (name: string) => {
    const tpl = await manager.createAgent({ name, harness: 'echo' })
    return manager.addAgentToChannel({ channelId, agentId: tpl.id, role: 'worker' })
  }
  const w1 = await mkWorker('w1')
  const w2 = await mkWorker('w2')

  manager.ensureChannelActive(channelId, { tickMs: 50 })
  const status1 = manager.runtimeStatus()
  check('channel 装配 3 实例', (await manager.listChannelAgents(channelId)).length === 3)
  check('lead runtime started(activeChannels + wired)', status1.activeChannels.includes(channelId) && status1.wiredAgents.includes(lead.id))

  // ── ② 登录任务完成 → lead/worker 各自记忆落库 ──
  console.log('\n=== ② 任务完成记忆落库(lead/worker) ===')
  const submit = (title: string, description: string) => manager.submitChannelTask({ channelId, title, description })
  const waitDone = (title: string) => waitUntil(async () =>
    (await manager.listTasks(channelId, lead.id)).some(t => t.title === title && t.state === 'COMPLETED'), 10_000)
  const rowsOf = (agentId: string): MemoryRow[] => repos.memories.listByAgent(agentId, 50)

  await submit('实现登录页面', '为管理后台实现登录页面,含表单校验与错误提示')
  check('任务1(登录)闭环 COMPLETED', await waitDone('实现登录页面'))

  // 两个登录族任务保证两个 worker 各自有可召回的任务记忆(分发由规则引擎按负载/空闲决定)
  await submit('实现登录页面表单校验', '补充登录页面表单校验规则')
  check('任务1b(登录族)闭环 COMPLETED', await waitDone('实现登录页面表单校验'))

  const leadRows = await waitUntil(() => rowsOf(lead.id).some(r => r.kind === 'episodic-task' && r.title === '实现登录页面'), 3000)
    ? rowsOf(lead.id)
    : []
  const leadRow = leadRows.find(r => r.kind === 'episodic-task' && r.title === '实现登录页面')
  // 汇总 summary 与规则引擎兜底收口并发(谁先收口均可)→ 断言落库本身,不强求 content 来源
  check('lead 记忆落库(父任务终态 harvest)', leadRow !== undefined && leadRow.importance === 0.8, leadRow?.title ?? '-')
  const w1Row = rowsOf(w1.id).find(r => r.kind === 'episodic-task' && r.title.includes('登录页面'))
  const w2Row = rowsOf(w2.id).find(r => r.kind === 'episodic-task' && r.title.includes('登录页面'))
  check('worker 各自记忆落库(两 worker 均有登录族任务记忆)', w1Row !== undefined && w2Row !== undefined,
    `w1=${w1Row?.title ?? '-'} w2=${w2Row?.title ?? '-'}`)

  // ── ③ lead 策展团队共享记忆 ──
  console.log('\n=== ③ lead addTeamMemory ===')
  const teamList = manager.addTeamMemory(channelId, lead.id, {
    title: '团队工程规范',
    content: '团队统一用 pnpm 管理依赖,禁止 npm/yarn',
    dedupKey: 'team:pnpm',
  })
  check('团队记忆入列(__team__ 域)', teamList.length === 1 && teamList[0].agentId === TEAM_AGENT_ID && teamList[0].channelId === channelId)

  // ── ④ 相关任务 → worker request.memory 含任务1记忆 + 团队行 ──
  console.log('\n=== ④ 相关任务召回注入 ===')
  await submit('统一登录交互规范', '把统一用 pnpm 的工程规范落实到登录页面交互')
  check('任务2(相关)闭环 COMPLETED', await waitDone('统一登录交互规范'))
  const executorReq = [w1, w2]
    .flatMap(w => (echoByAgent.get(w.id) as EchoWorkerImpl).captured)
    .reverse()
    .find(r => partsText(r.message.parts).includes('统一登录交互规范') && r.memory !== undefined)
  check('worker request.memory 含任务1记忆 + 团队行',
    executorReq !== undefined && executorReq.memory!.includes('登录页面') && executorReq.memory!.includes('pnpm'),
    executorReq?.memory?.slice(0, 100))

  // ── ⑤ worker 间 peer 消息(require_reply)→ 双方 peer 记忆落库 ──
  console.log('\n=== ⑤ peer 消息双向记忆 ===')
  await manager.sendA2A(channelId, w1.id, {
    toAgentId: w2.id,
    parts: [{ text: '登录页面的错误提示请统一文案,处理完回我' }],
    metadata: { 'x-aw-require-reply': 'true' },
  })
  const peerDone = await waitUntil(() =>
    rowsOf(w1.id).some(r => r.kind === 'episodic-peer') && rowsOf(w2.id).some(r => r.kind === 'episodic-peer'), 5000)
  const w1Peer = rowsOf(w1.id).find(r => r.kind === 'episodic-peer')
  const w2Peer = rowsOf(w2.id).find(r => r.kind === 'episodic-peer')
  check('双方 peer 记忆落库', peerDone && w1Peer !== undefined && w2Peer !== undefined,
    `w1=${w1Peer?.title ?? '-'} w2=${w2Peer?.title ?? '-'}`)
  check('peer 记忆含问答内容(回执文本进 content;存储侧已 CJK 切分,断言用未切分片段)',
    w2Peer !== undefined && w2Peer.content.includes('echo') && w2Peer.content.includes('答'),
    w2Peer?.content.slice(0, 60))

  // ── ⑥ REST 端点(h3 toWebHandler + 生产路由 handler) ──
  console.log('\n=== ⑥ REST 记忆端点 ===')
  const router = createRouter()
  router.get('/api/workshop/channels/:id/memories', teamMemGet)
  router.post('/api/workshop/channels/:id/memories', teamMemPost)
  router.delete('/api/workshop/channels/:id/memories/:memoryId', teamMemDelete)
  router.post('/api/workshop/channels/:id/agents/:agentId/memories', agentMemPost)
  router.delete('/api/workshop/channels/:id/agents/:agentId/memories/:memoryId', agentMemDelete)
  const app = createApp()
  app.use(router)
  const webHandler = toWebHandler(app)
  const rest = async (method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number, code: number | string }> => {
    const res = await webHandler(new Request(`http://localhost/api/workshop${path}`, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    const json = await res.json().catch(() => ({ code: -1 })) as { code: number | string }
    return { status: res.status, code: json.code }
  }

  const leadToken = lead.token!
  const w1Token = w1.token!
  check('REST token 有效(findByToken)', manager.findByToken(leadToken)?.id === lead.id && manager.findByToken(w1Token)?.id === w1.id)

  const get1 = await rest('GET', `/channels/${channelId}/memories`, w1Token)
  check('GET team memories(worker token)→ 200 + code 0', get1.status === 200 && get1.code === 0, `status=${get1.status} code=${get1.code}`)
  const postTeam = await rest('POST', `/channels/${channelId}/memories`, leadToken,
    { title: 'REST 策展行', content: 'REST 写入的团队记忆', dedupKey: 'team:rest' })
  check('POST team memory(lead token)→ 200', postTeam.status === 200 && postTeam.code === 0, `status=${postTeam.status}`)
  const postTeamDenied = await rest('POST', `/channels/${channelId}/memories`, w1Token, { title: 'x', content: 'y' })
  check('POST team memory(非 lead)→ 403 SCOPE_VIOLATION', postTeamDenied.status === 403 && postTeamDenied.code === 'SCOPE_VIOLATION',
    `status=${postTeamDenied.status} code=${postTeamDenied.code}`)
  const postAgent = await rest('POST', `/channels/${channelId}/agents/${w1.id}/memories`, leadToken,
    { title: 'REST 代写规范', content: '提交信息用中文', dedupKey: 'agent:rest' })
  check('POST agent memory(lead 代写)→ 200', postAgent.status === 200 && postAgent.code === 0, `status=${postAgent.status}`)
  const restTeamRow = repos.memories.listByAgentChannel(channelId, TEAM_AGENT_ID, 50).find(r => r.dedupKey === undefined ? r.title === 'REST 策展行' : false)
    ?? manager.listTeamMemories(channelId, 50).find(r => r.title === 'REST 策展行')
  const delTeam = await rest('DELETE', `/channels/${channelId}/memories/${restTeamRow!.id}`, leadToken)
  check('DELETE team memory(lead)→ 200', delTeam.status === 200 && manager.listTeamMemories(channelId, 50).every(r => r.id !== restTeamRow!.id),
    `status=${delTeam.status}`)
  const restAgentRow = rowsOf(w1.id).find(r => r.title === 'REST 代写规范')!
  const delAgent = await rest('DELETE', `/channels/${channelId}/agents/${w1.id}/memories/${restAgentRow.id}`, leadToken)
  check('DELETE agent memory(lead)→ 200', delAgent.status === 200 && !rowsOf(w1.id).some(r => r.id === restAgentRow.id), `status=${delAgent.status}`)

  // ── ⑦ 维护:回拨老数据 → runMemoryMaintenanceNow 清理(团队行豁免) ──
  console.log('\n=== ⑦ 记忆维护清理 ===')
  const oldIso = new Date(Date.now() - 400 * 86_400_000).toISOString()
  const agedLeadRow = rowsOf(lead.id).find(r => r.kind === 'episodic-task')!
  db.prepare(`UPDATE agent_memories SET created_at = ?, last_accessed_at = ? WHERE id = ?`).run(oldIso, oldIso, agedLeadRow.id)
  const before = manager.listTeamMemories(channelId, 50)
  const maint = manager.runMemoryMaintenanceNow()
  check('老数据(400 天前)被过期清理', maint.deletedExpired >= 1 && !rowsOf(lead.id).some(r => r.id === agedLeadRow.id),
    `deletedExpired=${maint.deletedExpired} evicted=${maint.evicted}`)
  check('团队行(策展)豁免清理', before.length > 0 && manager.listTeamMemories(channelId, 50).length === before.length)

  // ── ⑧ shutdown 干净退出 ──
  console.log('\n=== ⑧ shutdown ===')
  await manager.shutdown()
  const status8 = manager.runtimeStatus()
  check('shutdown 后 runtime 全卸载', status8.wiredAgents.length === 0 && status8.activeChannels.length === 0)
  globalThis.__workshopManager = undefined // 还原 REST 单例,不泄漏测试 manager

  rmSync(tmpWorkspace, { recursive: true, force: true })
  db.close()
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('E2E 异常:', e)
  try {
    await manager.shutdown()
  }
  catch { /* 尽力清理 */
  }
  rmSync(tmpWorkspace, { recursive: true, force: true })
  process.exit(1)
})
