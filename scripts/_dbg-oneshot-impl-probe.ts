/**
 * one-shot 家族 impl 隔离探针:直接驱动 GooseAgentImpl/CrushAgentImpl.run(),
 * 脱离 e2e/manager 打印真实事件流,定位「静默无输出」问题。
 * 运行:ZHIPU_API_KEY=... npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/_dbg-oneshot-impl-probe.ts goose|crush
 */
import type { AgentEvent, AgentRunContext, AgentRunRequest } from '../server/services/workshop/agents/agent-interface'
import { GooseAgentImpl } from '../server/services/workshop/agents/goose-agent'
import { CrushAgentImpl } from '../server/services/workshop/agents/crush-agent'
import { QwenAgentImpl } from '../server/services/workshop/agents/qwen-agent'
import { PiAgentImpl } from '../server/services/workshop/agents/pi-agent'
import { HermesAgentImpl } from '../server/services/workshop/agents/hermes-agent'

const which = process.argv[2] ?? 'goose'
const key = process.env.ZHIPU_API_KEY ?? ''

const fakeWorkspace = {
  listAgents: async () => [],
} as unknown as AgentRunContext['workspace']

const ctx: AgentRunContext = {
  agentId: 'probe-agent',
  channelId: 'probe-channel',
  role: 'worker',
  workspace: fakeWorkspace,
  signal: new AbortController().signal,
}

const request: AgentRunRequest = {
  message: {
    messageId: 'probe-msg',
    contextId: 'probe-channel',
    role: 'ROLE_USER',
    parts: [{ text: 'Reply with exactly: ok' }],
    metadata: { 'x-aw-task-kind': 'assign', 'x-aw-task-id': 'probe-task' },
  } as AgentRunRequest['message'],
  taskId: 'probe-task',
  contextId: 'probe-channel',
  fromAgentId: null,
  toAgentId: 'probe-agent',
}

async function main(): Promise<void> {
  const common = { agentId: 'probe-agent', name: 'probe', role: 'worker' as const, channelId: 'probe-channel', token: 'probe-token', baseUrl: 'http://127.0.0.1:59999' }
  const impl = which === 'crush'
    ? new CrushAgentImpl({ ...common, apiKey: key, model: 'zhipu/glm-5.3-flash', command: process.env.CRUSH_COMMAND ?? '' })
    : which === 'qwen'
      ? new QwenAgentImpl({ ...common, apiKey: key, providerBaseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3-flash' })
      : which === 'pi'
        ? new PiAgentImpl({ ...common, apiKey: key })
        : which === 'hermes'
          ? new HermesAgentImpl({ ...common, apiKey: key })
          : new GooseAgentImpl({ ...common, apiKey: key, model: 'glm-5.3-flash' })
  for await (const e of impl.run(request, ctx) as AsyncIterable<AgentEvent>) {
    if (e.kind === 'delta') process.stdout.write(`[delta] ${e.delta.text.slice(0, 80)}\n`)
    else if (e.kind === 'status') console.log(`[status] ${e.status.message?.parts.map(p => 'text' in p ? p.text : '').join('')?.slice(0, 120)}`)
    else if (e.kind === 'artifact') console.log(`[artifact] ${e.artifact.parts.map(p => 'text' in p ? p.text : '').join('').slice(0, 200)}`)
    else if (e.kind === 'error') console.log(`[error] ${e.error.code}: ${e.error.message.slice(0, 300)}`)
    else if (e.kind === 'done') console.log('[done]')
    else console.log('[?]', JSON.stringify(e).slice(0, 120))
  }
  await impl.dispose?.()
}

void main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
