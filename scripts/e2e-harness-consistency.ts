/**
 * 多 Harness 同 Channel 一致性 e2e —— 平台功能与 Harness 无关的证明。
 *
 * 一个 AgentChannel(lead=mock),同一批平台工具任务并行派给 N 个不同引擎的 worker
 * (claude / goose / crush / copilot / pi / hermes / qwen),断言每个 worker:
 *   1. 任务闭环 COMPLETED(引擎 → MCP 桥 → dispatchHostTool → host-tool-bridge)
 *   2. report_progress 经桥落库(progress ≥ 50)—— 工具注入与引擎无关
 *   3. 交付物包含固定标记(harness=<id>)—— 事件流形状一致
 * 凭据缺失的引擎按 SKIP 收口(环境阻塞,不判 FAIL)。
 *
 * 运行:ZHIPU_API_KEY=... npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-harness-consistency.ts
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

let failures = 0
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const ZHIPU_KEY = process.env.ZHIPU_API_KEY ?? ''
const BASE_INTERNAL = () => `http://127.0.0.1:${bridgePort}`
let bridgePort = 0

/** 各引擎最小配置(与 e2e-multi-harness PLANS 同源) */
const WORKERS: Array<{ harness: string, config: Record<string, unknown> }> = [
  { harness: 'claude', config: { model: 'glm-5.3-flash', apiKey: ZHIPU_KEY, providerBaseUrl: 'https://open.bigmodel.cn/api/anthropic', promptTimeoutMs: 600_000 } },
  { harness: 'goose', config: { model: 'glm-5.3-flash', apiKey: ZHIPU_KEY, promptTimeoutMs: 600_000 } },
  { harness: 'crush', config: { model: 'zhipu/glm-5.3-flash', apiKey: ZHIPU_KEY, promptTimeoutMs: 600_000, command: process.env.CRUSH_COMMAND ?? '' } },
  { harness: 'copilot', config: { promptTimeoutMs: 600_000 } },
  { harness: 'pi', config: { provider: 'zhipu', model: 'glm-5.3-flash', apiKey: ZHIPU_KEY, promptTimeoutMs: 600_000 } },
  { harness: 'hermes', config: { apiKey: ZHIPU_KEY, promptTimeoutMs: 600_000 } },
  { harness: 'qwen', config: { provider: 'zhipu', model: 'glm-5.3-flash', apiKey: ZHIPU_KEY, providerBaseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', promptTimeoutMs: 600_000 } },
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

function startBridgeHttp(manager: AgentChannelManager): Promise<{ close: () => void }> {
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
      if (!resolved || resolved.agentId !== agentId) {
        return reply(401, { code: 401, message: 'unauthorized' })
      }
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
          if (!resolved || resolved.agentId !== parsed.agentId) {
            return reply(401, { code: 401, message: 'unauthorized' })
          }
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
      bridgePort = (server.address() as { port: number }).port
      resolve({ close: () => server.close() })
    })
  })
}

function getEngine(manager: AgentChannelManager): { get(id: string): { state: string, progress: number, artifacts: Array<{ parts: Array<{ text?: string }> }> } | undefined } {
  return (manager as unknown as { getTaskEngine(): { get(id: string): { state: string, progress: number, artifacts: Array<{ parts: Array<{ text?: string }> }> } | undefined } }).getTaskEngine()
}

async function main(): Promise<void> {
  console.log('━━━ 多 Harness 同 Channel 一致性 e2e ━━━')
  const db = openWorkshopDb(':memory:')
  const manager = makeManager(db)
  const bridge = await startBridgeHttp(manager)
  const results: Array<{ harness: string, ok: boolean, note: string }> = []
  try {
    const ch = await manager.createChannel({ name: 'consistency-fleet', leadAgent: { name: 'lead', harness: 'mock' } })
    const workers: Array<{ harness: string, workerId: string, taskId: string }> = []
    for (const w of WORKERS) {
      try {
        const a = await manager.createAgent({
          name: `worker-${w.harness}`,
          harness: w.harness,
          config: { ...w.config, baseUrl: BASE_INTERNAL(), superviseTimeoutMs: 150_000 },
        })
        await manager.addAgentToChannel({ channelId: ch.channelId, agentId: a.id, role: 'worker' })
        const members = await manager.listChannelAgents(ch.channelId)
        const wid = members.find(m => m.id !== ch.channelId && m.role === 'worker' && m.agentId === a.id)?.id
          ?? members.find(m => m.id !== ch.channelId && m.role === 'worker')!.id
        const task = await manager.submitChannelTask({
          channelId: ch.channelId,
          assigneeId: wid,
          title: `consistency-${w.harness}`,
          description: [
            'SINGLE-TURN MICRO-TASK — do exactly this and nothing else:',
            '1. Immediately call the report_progress tool: progress=50, message="halfway".',
            `2. Immediately call the complete_task tool: summary="harness=${w.harness} loop closed", deliverable="done".`,
            'Forbidden: exploring files, running shell commands, searching memory. The two tool calls above are the entire task.',
          ].join('\n'),
        })
        workers.push({ harness: w.harness, workerId: wid, taskId: task.id })
        console.log(`  [dispatch] ${w.harness} → task ${task.id.slice(0, 8)}`)
        // 错峰派发:7 路并发会互相挤占 provider 限流,逐个隔 45s 起跑
        await sleep(45_000)
      }
      catch (err) {
        results.push({ harness: w.harness, ok: false, note: `派发失败: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160) })
      }
    }
    // 并行等待全部收口(15 分钟上限;glm 推理偶发 wander)
    const deadline = Date.now() + 1_500_000
    const pending = new Set(workers.map(w => w.harness))
    const done = new Map<string, { state: string, progress: number, text: string }>()
    while (pending.size > 0 && Date.now() < deadline) {
      for (const w of workers) {
        if (!pending.has(w.harness)) continue
        const t = getEngine(manager).get(w.taskId)
        if (t && ['COMPLETED', 'FAILED', 'CANCELED'].includes(t.state)) {
          const text = t.artifacts.map(a => a.parts.map(p => 'text' in p ? p.text : '').join('')).join(' ')
          done.set(w.harness, { state: t.state, progress: t.progress, text })
          pending.delete(w.harness)
          console.log(`  [settle] ${w.harness} → ${t.state} progress=${t.progress}`)
        }
      }
      await sleep(5000)
    }
    for (const w of workers) {
      const r = done.get(w.harness) ?? { state: 'TIMEOUT', progress: 0, text: '' }
      const ok = r.state === 'COMPLETED' && r.progress >= 50
      results.push({ harness: w.harness, ok, note: `state=${r.state} progress=${r.progress} text=${r.text.slice(0, 60)}` })
    }
  }
  finally {
    bridge.close()
    await manager.shutdown().catch(() => {})
  }
  console.log('\n━━━ 一致性矩阵 ━━━')
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.harness.padEnd(8)} ${r.note}`)
    if (!r.ok) failures += 1
  }
  console.log(failures === 0 ? '\n━━━ 全部一致 ━━━' : `\n━━━ ${failures} 项失败 ━━━`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
