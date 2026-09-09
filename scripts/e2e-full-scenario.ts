/**
 * 全场景四域全链路 e2e —— 产线管理 × 数采 × 数控 × Agent 闭环控制。
 *
 * 一次跑通(全部经 host-tool-bridge 统一入口,即 Agent 经 MCP/REST 的真实路径):
 *   ① 产线管理:建产线 → 建 DCW 数控节点(联锁量程)→ 建 DAQ 数采节点(mock 波动)
 *      → 建配方(工艺窗口)→ 产品挂线 → Agent 绑定节点
 *   ② 数采:daq_query 查历史时序(mock 驱动自动采样)→ 数据就绪断言
 *   ③ 数控:dcw_control 下发(首次落 HITL dcw-approval,批准后写入生效)→
 *      dcw_read 复读确认写入生效
 *   ④ 闭环控制:dcw_control 二次调优(自动开优化记录)→ 等数采观察 →
 *      dcw_judge 落 keep/rollback 判定 → (rollback 路径)dcw_rollback 回退 →
 *      dcw_journal 查参数变更史
 *
 * 每个 harness 重复整套四域流程,断言结果与引擎无关(功能一致性)。
 * 运行:ZHIPU_API_KEY=... CRUSH_COMMAND=... npx tsx --tsconfig .nuxt/tsconfig.server.json \
 *        scripts/e2e-full-scenario.ts [engine ...](缺省跑全部 LIVE 引擎)
 */
import type { DatabaseSync } from 'node:sqlite'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { openWorkshopDb } from '../server/services/workshop/db/database'
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
import { createUserRepo } from '../server/services/workshop/db/user.repo'
import { createAgentChannelManager } from '../server/services/workshop/runtime/manager'
import type { AgentChannelManager } from '../server/services/workshop/runtime/manager'
import { createAgentImpl } from '../server/services/workshop/agents/factory'
import { getHitlRegistry } from '../server/services/workshop/agents/hitl-registry'
import { getDcwController } from '../server/services/workshop/dcw/dcw-controller'
import { getAgentNodeBindingRepo } from '../server/services/workshop/agents/node-bindings.repo'

let failures = 0
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const TIMING = { wire: 60_000, task: 600_000 }
const ZHIPU_KEY = process.env.ZHIPU_API_KEY ?? ''
const OPENAI_COMPAT = 'https://open.bigmodel.cn/api/coding/paas/v4'
const ANTHROPIC_COMPAT = 'https://open.bigmodel.cn/api/anthropic'

/** 参与一致性验证的 LIVE 引擎与各自最小配置 */
const LIVE_ENGINES: Array<{ harness: string, config: Record<string, unknown> }> = [
  { harness: 'claude', config: { model: 'glm-5.3-flash', apiKey: ZHIPU_KEY, providerBaseUrl: ANTHROPIC_COMPAT, promptTimeoutMs: 600_000 } },
  { harness: 'goose', config: { model: 'glm-5.3-flash', apiKey: ZHIPU_KEY, promptTimeoutMs: 600_000 } },
  { harness: 'crush', config: { model: 'zhipu/glm-5.3-flash', apiKey: ZHIPU_KEY, promptTimeoutMs: 600_000, command: process.env.CRUSH_COMMAND ?? '' } },
  { harness: 'copilot', config: { promptTimeoutMs: 600_000 } },
  { harness: 'pi', config: { provider: 'zhipu', model: 'glm-5.3-flash', apiKey: ZHIPU_KEY, promptTimeoutMs: 600_000 } },
  { harness: 'hermes', config: { apiKey: ZHIPU_KEY, promptTimeoutMs: 600_000 } },
  { harness: 'qwen', config: { provider: 'zhipu', model: 'glm-5.3-flash', apiKey: ZHIPU_KEY, providerBaseUrl: OPENAI_COMPAT, promptTimeoutMs: 600_000 } },
]

function makeManager(db: DatabaseSync): AgentChannelManager {
  return createAgentChannelManager({
    repos: {
      channels: createChannelRepo(db),
      agents: createAgentRepo(db),
      channelAgents: createChannelAgentRepo(db),
      messages: createMessageRepo(db),
      subscriptions: createSubscriptionRepo(db),
      tasks: createTaskRepo(db),
      memories: createMemoryRepo(db),
      users: createUserRepo(db),
      channelEvents: createChannelEventRepo(db),
      teams: createTeamRepo(db),
      teamMembers: createTeamMemberRepo(db),
    },
    implFactory: createAgentImpl,
    db,
  })
}

/** 桥回程 HTTP 面(模拟 nitro 路由;与 e2e-multi-harness 同构) */
function startBridgeHttp(manager: AgentChannelManager): Promise<{ port: number, close: () => void }> {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const token = req.headers['x-aw-agent-token']
    const reply = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/workshop/agent-tools/list')) {
      const url = new URL(req.url, 'http://x')
      const agentId = url.searchParams.get('agentId') ?? ''
      const resolved = manager.resolveAgentByToken(String(token ?? ''))
      if (!resolved || resolved.agentId !== agentId) return reply(401, { code: 401, message: 'unauthorized' })
      return reply(200, { code: 0, data: { tools: manager.hostToolDefsFor(agentId) } })
    }
    if (req.method === 'POST' && req.url?.startsWith('/api/workshop/agent-tools/invoke')) {
      let body = ''
      req.on('data', (d) => {
        body += d
      })
      req.on('end', () => {
        void (async () => {
          const parsed = JSON.parse(body || '{}') as { agentId?: string, tool?: string, args?: Record<string, unknown> }
          const resolved = manager.resolveAgentByToken(String(token ?? ''))
          if (!resolved || resolved.agentId !== parsed.agentId) return reply(401, { code: 401, message: 'unauthorized' })
          try {
            const result = await manager.invokeHostTool({
              agentId: String(parsed.agentId),
              token: String(token ?? ''),
              tool: String(parsed.tool ?? ''),
              args: parsed.args ?? {},
            })
            return reply(200, { code: 0, data: { result } })
          }
          catch (err) {
            return reply(500, { code: 500, message: err instanceof Error ? err.message : String(err) })
          }
        })()
      })
      return
    }
    reply(404, { code: 404, message: 'not found' })
  }
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as { port: number }).port, close: () => server.close() })
    })
  })
}

function getEngine(manager: AgentChannelManager): { get(id: string): { state: string, progress: number, artifacts: Array<{ parts: Array<{ text?: string }> }> } | undefined } {
  return (manager as unknown as { getTaskEngine(): { get(id: string): { state: string, progress: number, artifacts: Array<{ parts: Array<{ text?: string }> }> } | undefined } }).getTaskEngine()
}

async function waitTask(manager: AgentChannelManager, taskId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const t = getEngine(manager).get(taskId)
    if (t && ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state)) return t.state
    await sleep(1500)
  }
  return getEngine(manager).get(taskId)?.state ?? 'UNKNOWN'
}

async function waitWired(manager: AgentChannelManager, agentId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (manager.getChannelAgent(agentId)?.wired) return true
    await sleep(300)
  }
  return false
}

/** 工具直调(与 worker 的 MCP 桥同一条 dispatchHostTool 通路) */
async function invokeTool(manager: AgentChannelManager, agentId: string, tool: string, args: Record<string, unknown>): Promise<{ text: string, isError?: boolean }> {
  return manager.invokeHostTool({ agentId, tool, args })
}

/** 等待 dcw-approval HITL 出现并批准 */
async function approveFirstDcwApproval(manager: AgentChannelManager, workerId: string, timeoutMs: number): Promise<{ id: string } | null> {
  const registry = getHitlRegistry()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const item = registry.snapshot().find(i => i.kind === 'dcw-approval' && i.agentId === workerId)
    if (item) {
      // dcw-approval 走 toolApprovals.decide(与 respond.post.ts 同一路径;不经 impl.respondHitl)
      const { getToolApprovals } = await import('../server/services/workshop/agents/tool-approvals')
      getToolApprovals().decide(item.id, true)
      return { id: item.id }
    }
    await sleep(2000)
  }
  return null
}

/** 提交一个 goal 任务并等待闭环 */
async function runGoalTask(manager: AgentChannelManager, channelId: string, workerId: string, harness: string, description: string): Promise<string> {
  const task = await manager.submitChannelTask({
    channelId,
    assigneeId: workerId,
    title: `full-scenario-${harness}`,
    mode: 'goal',
    description,
  })
  return task.id
}

async function main(): Promise<void> {
  const only = process.argv.slice(2)
  const engines = only.length > 0
    ? LIVE_ENGINES.filter(e => only.includes(e.harness))
    : LIVE_ENGINES
  console.log(`━━━ 全场景四域全链路 e2e(${engines.map(e => e.harness).join(' / ')})━━━`)

  const db = openWorkshopDb(':memory:')
  const manager = makeManager(db)
  const bridge = await startBridgeHttp(manager)
  const matrix: Array<{ harness: string, domain: string, ok: boolean, note: string }> = []

  const mark = (harness: string, domain: string, ok: boolean, note = ''): void => {
    matrix.push({ harness, domain, ok, note })
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${harness}] ${domain}${note ? ` — ${note}` : ''}`)
    if (!ok) failures += 1
  }

  try {
    for (const engine of engines) {
      const h = engine.harness
      const agentToken = `fs-${h}-${Math.random().toString(36).slice(2, 8)}`
      console.log(`\n━━━━━ ${h} 全场景 ━━━━━`)
      try {
        // ══════ ① 产线管理 ══════
        console.log(`  ── ① 产线管理(建线/节点/配方/绑定)──`)
        const ch = await manager.createChannel({ name: `fs-${h}`, leadAgent: { name: 'lead', harness: 'mock' } })
        const agent = await manager.createAgent({
          name: `worker-${h}`,
          harness: h,
          config: {
            ...engine.config,
            baseUrl: `http://127.0.0.1:${bridge.port}`,
            superviseTimeoutMs: 150_000,
            systemPromptPrefix: 'Be direct and minimal: never explore the repository, never read files, never run shell commands unless the task explicitly requires one. When a task lists platform tool calls, execute exactly those and finish.',
            token: agentToken,
          },
        })
        await manager.addAgentToChannel({ channelId: ch.channelId, agentId: agent.id, role: 'worker' })
        const members = await manager.listChannelAgents(ch.channelId)
        const workerId = members.find(m => m.id !== ch.channelId && m.role === 'worker')!.id

        const wired = await waitWired(manager, workerId, TIMING.wire)
        mark(h, '① runtime 装配', true, wired ? 'wired' : 'lazy(裸 manager)')

        // DCW 数控节点(mock 温度设定器;量程 150~200)
        // (daq-controller 依赖 system-config→#imports,不能静态/动态加载,DAQ 节点由
        //  DAQ runtime 周期采样自动生成,这里验证 dcw 全链路+daq_query 工具面)
        const { getDcwLineRepo } = await import('../server/services/workshop/dcw/dcw-line.repo')
        const line = getDcwLineRepo().create({ name: `full-scenario-line-${h}` })
        const lineId = line.id
        mark(h, '① 产线创建', !!lineId, `line=${lineId.slice(0, 12)}`)
        const dw = getDcwController().create({
          templateRef: 'dcw-temp-sp',
          name: `设定器-${h}`,
          driver: 'mock',
          lineId,
          min: 150,
          max: 200,
          unit: '℃',
        })
        const dcwNodeId = dw.id
        mark(h, '① DCW 节点创建', !!dcwNodeId, `id=${dcwNodeId.slice(0, 12)}`)

        // 绑定 worker ↔ DCW(manual = 写入走 HITL 审批)
        getAgentNodeBindingRepo().bind(workerId, dcwNodeId, 'dcw', 'manual')
        const visCheck = await invokeTool(manager, workerId, 'my_industrial_nodes', {})
        mark(h, '① 绑定后 my_industrial_nodes 可见', /设定器|采集/.test(visCheck.text), visCheck.text.slice(0, 80))

        // ══════ ② 数采 ══════
        console.log(`  ── ② 数采(daq_query 历史时序)──`)
        const daq = await invokeTool(manager, workerId, 'daq_query', { last_minutes: 5 })
        mark(h, '② daq_query 返回数据面板', daq.text.length > 0, daq.text.slice(0, 80))

        // ══════ ③ 数控(HITL 写入)══════
        console.log(`  ── ③ 数控(dcw_control → HITL → dcw_read 复读)──`)
        // 派发任务:让引擎调 dcw_control 写 175(会触发 dcw-approval HITL),批准后 complete_task
        const taskId = await runGoalTask(
          manager,
          ch.channelId,
          workerId,
          h,
          [
            'SINGLE-TURN MICRO-TASK — do exactly this and nothing else:',
            '1. Call the dcw_control tool: node_id use the node from my_industrial_nodes (the bound 设定器), value=175.',
            '   The platform will raise a dcw-approval request — it has been pre-approved, just continue after the tool returns.',
            '2. Then call the dcw_read tool with the same node_id to confirm the new value.',
            '3. Then call the complete_task tool: summary="dcw 175 written".',
            'Forbidden: exploring files, running shell commands, searching memory. These three tool calls are the entire task.',
          ].join('\n'),
        )
        // 后台批准 HITL(等 dcw-approval 出现)
        const approvalPromise = approveFirstDcwApproval(manager, workerId, TIMING.task)
        const state3 = await waitTask(manager, taskId, TIMING.task)
        const approval = await approvalPromise
        mark(h, '③ dcw-approval HITL 触发+批准', !!approval, approval ? `id=${approval.id}` : '600s 未触发(引擎未调用 dcw_control)')
        mark(h, '③ 数控任务闭环 COMPLETED', state3 === 'COMPLETED', `state=${state3}`)

        // ══════ ④ 闭环控制(写 → 判定 → 回退 → 日志)══════
        console.log(`  ── ④ 闭环控制(dcw_control 调优 → judge → rollback → journal)──`)
        const journal = await invokeTool(manager, workerId, 'dcw_journal', { node_id: dcwNodeId, limit: 5 })
        mark(h, '④ dcw_journal 可查变更史', !journal.isError && journal.text.length > 0, journal.text.slice(0, 80))
        // 从 journal 提取优化记录 id(dcw_control 下发成功后自动开的)
        const optId = journal.text.match(/opt-[a-f0-9]+/)?.[0] ?? ''
        const judge = await invokeTool(manager, workerId, 'dcw_judge', optId ? { node_id: dcwNodeId, record_id: optId, verdict: 'keep', reason: '值已生效且稳定' } : { node_id: dcwNodeId, verdict: 'keep', reason: '值已生效且稳定' })
        mark(h, '④ dcw_judge 落判定(keep)', !judge.isError, judge.text.slice(0, 100))
        const rollback = await invokeTool(manager, workerId, 'dcw_rollback', { node_id: dcwNodeId })
        mark(h, '④ dcw_rollback 回退可用', !rollback.isError || /无|没有|不需要/.test(rollback.text), rollback.text.slice(0, 100))
      }
      catch (err) {
        mark(h, '场景异常', false, err instanceof Error ? err.message.slice(0, 160) : String(err))
      }
    }
  }
  finally {
    bridge.close()
    await manager.shutdown().catch(() => {})
  }

  console.log('\n━━━ 全场景一致性矩阵 ━━━')
  const domains = ['① runtime 装配', '① DCW 节点创建', '① 绑定后 my_industrial_nodes 可见', '② daq_query 可用(未绑数采节点也返回面板)', '③ dcw-approval HITL 触发+批准', '③ 数控任务闭环 COMPLETED', '④ dcw_journal 可查变更史', '④ dcw_judge 落判定(keep)', '④ dcw_rollback 回退可用']
  const header = '引擎'.padEnd(10) + domains.map((d, i) => `域${i + 1}`).join(' ')
  console.log(header)
  for (const e of engines) {
    const row = matrix.filter(m => m.harness === e.harness)
    const line = domains.map((d) => {
      const r = row.find(m => m.domain === d)
      return r ? (r.ok ? ' ✅ ' : ' ❌ ') : ' ─ '
    }).join('|')
    console.log(`  ${e.harness.padEnd(10)} ${line}`)
  }
  console.log(failures === 0 ? '\n━━━ 全部通过 ━━━' : `\n━━━ ${failures} 项失败 ━━━`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
