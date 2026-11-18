import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OmpRpcAgentImpl } from '../server/services/workshop/agents/omp-agent'
import { OmpRpcClient } from '../server/services/workshop/agents/adapters/omp-rpc-client'
import type { AgentEvent, AgentRunContext } from '../server/services/workshop/agents/agent-interface'
import type { ExecutionScope } from '../server/services/workshop/agents/execution-scope'

// Live omp binary required: skip on environments without it (CI/fresh machines).
// 保持默认收集,但在 omp 不可用时跳过 —— 与 opt-in 集成测试同纪律。
const ompAvailable = spawnSync('omp', ['--version'], { timeout: 15_000 }).status === 0

class LiveAgent extends OmpRpcAgentImpl {
  dispatched: string[] = []

  bind(client: OmpRpcClient): void {
    this.client = client
    client.onHostToolCall(req => this.handleHostTool(req, client))
  }

  protected override async contextGate(): Promise<void> {}

  protected override async dispatchTurnHostTool(name: string, _args: Record<string, unknown>, scope: ExecutionScope): Promise<{ text: string }> {
    scope.assertActive()
    this.dispatched.push(name)
    return { text: 'local result' }
  }

  async turn(): Promise<AgentEvent[]> {
    const signal = new AbortController().signal
    const scope = this.beginTurnScope({ agentId: 'live', channelId: '', role: 'worker', workspace: {} as never, signal } as AgentRunContext)
    try {
      const events: AgentEvent[] = []
      for await (const event of this.promptAndStream('Invoke poll_messages.', undefined, signal)) events.push(event)
      return events
    }
    finally {
      this.endTurnScope(scope)
    }
  }
}

test('product OMP agent rotates aliases across persistent live turns', { timeout: 60_000 }, async (t) => {
  if (!ompAvailable) {
    // t.skip() marks the test skipped but does NOT stop execution — without an explicit
    // return the body still spawns omp and fails with ENOENT on CI/fresh machines.
    t.skip('omp binary unavailable (CI/fresh machine); live alias rotation requires it')
    return
  }
  const root = await mkdtemp(join(tmpdir(), 'aw-omp-product-alias-'))
  const agentDir = join(root, 'agent')
  const work = join(root, 'work')
  await Promise.all([mkdir(agentDir), mkdir(work)])
  const seenNames: string[] = []
  const seenPrompts: string[] = []
  let requestCount = 0
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const tools = body.tools as Array<{ function: { name: string, description: string } }>
    const target = tools.find(tool => tool.function.description.includes('Canonical tool: poll_messages.'))
    if (!target) {
      res.writeHead(400).end('missing canonical poll_messages')
      return
    }
    const name = target.function.name
    seenNames.push(name)
    seenPrompts.push(JSON.stringify(body.messages))
    const step = requestCount++
    const chunk = (delta: object, finish: string | null = null) => ({ id: `local-${step}`, object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [{ index: 0, delta, finish_reason: finish }] })
    const events = step % 2 === 0
      ? [chunk({ role: 'assistant' }), chunk({ tool_calls: [{ index: 0, id: `call-${step}`, type: 'function', function: { name, arguments: '{}' } }] }), chunk({}, 'tool_calls')]
      : [chunk({ role: 'assistant' }), chunk({ content: 'complete' }), chunk({}, 'stop')]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await writeFile(join(agentDir, 'models.yml'), `providers:\n  local-fence:\n    baseUrl: http://127.0.0.1:${address.port}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: local-test\n        name: Local Test\n        reasoning: false\n        input: [text]\n        contextWindow: 32768\n        maxTokens: 1024\n`)
  const client = new OmpRpcClient({ command: 'omp', mode: 'rpc', cwd: work, args: ['--model', 'local-fence/local-test', '--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-session', '--no-ui', '--auto-approve'], env: { PI_CODING_AGENT_DIR: agentDir, HOME: root, USERPROFILE: root, TEMP: root, TMP: root } })
  const agent = new LiveAgent({ agentId: 'live', role: 'worker', promptTimeoutMs: 20_000 })
  try {
    await client.start()
    agent.bind(client)
    const pid = client.pid
    const first = await agent.turn()
    const second = await agent.turn()
    assert.equal(client.pid, pid)
    assert.equal(client.alive, true)
    assert.equal(seenNames.length, 4)
    assert.equal(seenNames[0], seenNames[1])
    assert.equal(seenNames[2], seenNames[3])
    assert.notEqual(seenNames[0], seenNames[2])
    assert.ok(seenNames.every(name => name.length <= 64))
    assert.ok(seenPrompts[0]!.includes(`poll_messages -> ${seenNames[0]}`))
    assert.ok(seenPrompts[2]!.includes(`poll_messages -> ${seenNames[2]}`))
    assert.deepEqual(agent.dispatched, ['poll_messages', 'poll_messages'])
    for (const events of [first, second]) {
      const text = JSON.stringify(events)
      assert.match(text, /poll_messages/)
      assert.doesNotMatch(text, /aw_[0-9a-f]{32}/)
    }
  }
  finally {
    await client.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
