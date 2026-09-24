/**
 * 记忆系统端到端验证 — 真实 AgentChannelManager(:memory: db)+ 生产 mock harness 全链:
 * ① channel + lead/2worker 装配,runtimes started
 * ② 任务完成 → lead/worker 各自记忆落库
 * ③ lead addTeamMemory('团队统一用 pnpm')
 * ④ 相关任务下发 → 捕获 worker request.memory 含任务1记忆 + 团队行
 * ⑤ worker 间 peer 消息(require_reply)→ 双方 peer 记忆落库
 * ⑥ REST(h3 toWebHandler 挂真实路由 handler):GET memories / POST team(lead)/ POST agent / DELETE 全 2xx;非 lead 写 team → 403
 * ⑦ runMemoryMaintenanceNow() → 回拨老数据被清(团队行豁免)
 * ⑧ await manager.shutdown() → 干净退出
 * 向量链(hash embedder)已由 test-memory-vector.ts 覆盖;本 E2E 走纯 FTS 路径。
 *
 * 运行(Node 24 内建类型擦除 + TS 解析钩子;套件 import 了 Nuxt 虚拟模块 #imports 的链路):
 *   node --experimental-transform-types --import ./scripts/_audit/ts-register-hook.mjs scripts/e2e-memory-system.ts
 */
import { createChannelEventRepo } from '../server/services/workshop/db/channel-event.repo'
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
import { createAgentImpl } from '../server/services/workshop/agents/factory'

import type { AgentInfo, AgentInterface, AgentRunContext, AgentRunRequest } from '../server/services/workshop/agents/agent-interface'
import type { Part } from '../server/services/workshop/types/a2a'
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

// ═══════════ 生产 mock harness + 请求捕获 ═══════════
//
// 早先这里自带 echo 剧本(自造 harness 名 'echo' + 自定义 run 剧本)。两条都已失效:
//  - harness 注册表收敛后 'echo' 不再是已知 harness(createAgent 直接 UNKNOWN_HARNESS);
//  - "无 LLM 时的规则调度"(lead 分解/派发、子任务完工收口、失败重派、peer 回执)现在
//    就在 **mock harness 实现本身**(mock-agent.ts),自造剧本反而绕过了它 → 任务永不闭环。
// 因此改为**装配生产 mock**(与其他套件同一 implFactory),只在其外层包一层 run 捕获,
// 供断言检查 request.memory(召回注入)与 peer 内容 —— 测的是真实行为,不是平行实现。

/** run 捕获:agentId → 收到的每个回合请求(按时间序) */
const capturedByAgent = new Map<string, AgentRunRequest[]>()
const recordRun = (agentId: string, request: AgentRunRequest): void => {
  const list = capturedByAgent.get(agentId)
  if (list) list.push(request)
  else capturedByAgent.set(agentId, [request])
}
const runsOf = (agentId: string): AgentRunRequest[] => capturedByAgent.get(agentId) ?? []

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

  channelEvents: createChannelEventRepo(db),
  teams: createTeamRepo(db),
  teamMembers: createTeamMemberRepo(db),
}

const implFactory = (agent: AgentInfo): AgentInterface => {
  const impl = createAgentImpl(agent)
  // 必须是 Proxy 而非手写对象字面量:AgentInterface 还有 supervise?(lead 调度决策的
  // 唯一入口)、steer?、dispose? 等成员 —— 只转发 run 会让 lead 永远不做派发决策
  // (任务停在 SUBMITTED),这是"包装即失能"的经典陷阱。
  return new Proxy(impl, {
    get(target, prop, receiver) {
      if (prop === 'run') {
        return (request: AgentRunRequest, ctx: AgentRunContext) => {
          recordRun(agent.id, request)
          return target.run(request, ctx)
        }
      }
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
}
// C1:env 向量 provider 接线验证(127.0.0.1:1 立即拒连 → 熔断 → 全链 FTS 降级不崩)
const savedEmbedBase = process.env.AW_MEMORY_EMBED_BASE_URL
const savedEmbedModel = process.env.AW_MEMORY_EMBED_MODEL
process.env.AW_MEMORY_EMBED_BASE_URL = 'http://127.0.0.1:1'
process.env.AW_MEMORY_EMBED_MODEL = 'e2e-unreachable'
const manager = createAgentChannelManager({ repos, implFactory, db })
// REST 路由 handler 经 getWorkshopManager() 读进程级单例 → 指向测试 manager
globalThis.__workshopManager = manager

const tmpWorkspace = mkdtempSync(join(tmpdir(), 'aw-e2e-memory-'))

async function main(): Promise<void> {
  // ── ① channel + lead + 2 worker 装配,runtimes started ──
  console.log('\n=== ① channel + agents 装配 ===')
  const ch = await manager.createChannel({ name: 'memory-e2e', workspace: tmpWorkspace })
  const channelId = ch.channelId
  const leadTpl = await manager.createAgent({ name: 'lead', harness: 'mock' })
  const lead = await manager.addAgentToChannel({ channelId, agentId: leadTpl.id, role: 'lead' })
  const mkWorker = async (name: string) => {
    const tpl = await manager.createAgent({ name, harness: 'mock' })
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
  // 团队域在任务终态还会沉淀 canonical summary / 编年史 / lead 决策行,因此**不能**断言
  // "列表长度 === 1";判据是策展行本身落进 __team__ 哨兵域。
  const curated = teamList.find(r => r.title === '团队工程规范')
  check('团队记忆入列(__team__ 域)', curated !== undefined && curated.agentId === TEAM_AGENT_ID && curated.channelId === channelId,
    `rows=${teamList.length}`)

  // ── ④ 相关任务 → worker request.memory 含任务1记忆 + 团队行 ──
  // 任务文案必须命中 mock lead 的**分解判据**(否则简单任务由 lead 直接收口,worker 永不执行,
  // 观测点为空):这里用"实现/端到端"触发分解。
  console.log('\n=== ④ 相关任务召回注入 ===')
  await submit('统一登录交互规范', '把统一用 pnpm 的工程规范落实为登录页面交互的端到端实现')
  check('任务2(相关)闭环 COMPLETED', await waitDone('统一登录交互规范'))
  const relatedRuns = [w1, w2]
    .flatMap(w => runsOf(w.id))
    .filter(r => partsText(r.message.parts).includes('统一登录交互规范'))
  const executorReq = relatedRuns.filter(r => r.memory !== undefined).reverse()
    .find(r => r.memory!.includes('登录页面') && r.memory!.includes('pnpm'))
  check('worker request.memory 含任务1记忆 + 团队行',
    executorReq !== undefined,
    executorReq ? executorReq.memory!.slice(0, 80).replace(/\n/g, ' ') : `related=${relatedRuns.length} mem=${relatedRuns.filter(r => r.memory !== undefined).length}`)

  // ── ④b env provider 接线:embed 全失败(拒连)→ 熔断 → FTS 降级不裸奔 ──
  console.log('\n=== ④b env provider 接线降级(C1)===')
  await submit('登录错误提示规范', '登录错误提示统一红字展示并联动表单校验的端到端实现')
  check('embedder 不可达不阻任务闭环', await waitDone('登录错误提示规范'))
  const degradedRuns = [w1, w2]
    .flatMap(w => runsOf(w.id))
    .filter(r => partsText(r.message.parts).includes('登录错误提示规范'))
  const degradedReq = degradedRuns.filter(r => r.memory !== undefined).reverse()
    .find(r => r.memory!.includes('登录'))
  check('熔断后召回仍注入记忆(纯 FTS 降级)', degradedReq !== undefined,
    degradedReq ? degradedReq.memory!.slice(0, 60).replace(/\n/g, ' ') : `related=${degradedRuns.length}`)

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
  check('peer 记忆含问答内容(接收侧=提问原文、发送侧=回执;存储侧已 CJK 切分)',
    w2Peer !== undefined && w1Peer !== undefined && w1Peer.content.includes('mock') && w2Peer.content.includes('登'),
    `w1=${w1Peer?.content.slice(0, 40)} | w2=${w2Peer?.content.slice(0, 40)}`)

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
  const restTeamRow = manager.listTeamMemories(channelId, 50).find(r => r.title === 'REST 策展行')
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
  const restoreEmbedEnv = (name: string, value: string | undefined): void => {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
  restoreEmbedEnv('AW_MEMORY_EMBED_BASE_URL', savedEmbedBase)
  restoreEmbedEnv('AW_MEMORY_EMBED_MODEL', savedEmbedModel)

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
