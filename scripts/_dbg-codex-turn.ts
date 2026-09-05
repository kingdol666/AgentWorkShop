import { StdioJsonRpcClient } from '../server/services/workshop/agents/adapters/stdio-jsonrpc'

async function main() {
  const client = new StdioJsonRpcClient({
    name: 'codex-turn-test',
    command: 'codex',
    args: ['app-server'],
    cwd: process.cwd(),
    requestTimeoutMs: 30_000,
  })
  client.onExit((code) => {
    console.log('[turn-test] EXIT code=', code)
    process.exit(1)
  })
  await client.start()
  await client.request('initialize', { clientInfo: { name: 'aw-probe', title: 'AW', version: '0.0.1' } }, 30_000)
  client.notify('initialized', {})
  const thread = await client.request('thread/start', {
    model: 'glm-5.3-flash',
    cwd: process.cwd(),
    approvalPolicy: 'never',
    sandbox: 'read-only',
  }, 60_000) as Record<string, unknown>
  const threadId = thread as { thread?: { id?: string }, id?: string }
  const tid = threadId?.thread?.id ?? threadId?.id
  console.log('[turn-test] thread:', String(tid).slice(0, 20))
  let sawDelta = false
  let sawCompleted = false
  client.onNotification((method, params) => {
    const p = (params ?? {}) as Record<string, unknown>
    if (method === 'item/agentMessage/delta' && p.delta) {
      if (!sawDelta) console.log('[turn-test] first delta at', new Date().toLocaleTimeString('zh-CN', { hour12: false }))
      sawDelta = true
    }
    else if (method === 'turn/started') console.log('[turn-test] turn/started', new Date().toLocaleTimeString('zh-CN', { hour12: false }))
    else if (method === 'thread/tokenUsage/updated') {
      const u = (p.usage ?? p) as Record<string, unknown>
      console.log('[turn-test] tokenUsage input=', u.input_tokens ?? u.inputTokens ?? '?')
    }
    else if (method === 'turn/completed') {
      const turn = (p.turn ?? {}) as Record<string, unknown>
      console.log('[turn-test] turn/completed status=', turn.status, new Date().toLocaleTimeString('zh-CN', { hour12: false }))
      sawCompleted = true
    }
    else if (method === 'error') console.log('[turn-test] error notice:', JSON.stringify(p).slice(0, 160))
    else if (String(method).includes('item/')) console.log('[turn-test]', method)
  })
  const t0 = Date.now()
  await client.request('turn/start', {
    threadId: tid,
    input: [{ type: 'text', text: '直接回答:1+1等于几?一句话即可。' }],
  }, 60_000)
  console.log('[turn-test] turn/start accepted')
  for (let i = 0; i < 40 && !sawCompleted; i++) {
    await new Promise(r => setTimeout(r, 5000))
    if (i % 6 === 5) console.log('[turn-test] waiting...', Math.round((Date.now() - t0) / 1000) + 's', 'sawDelta=' + sawDelta)
  }
  console.log(sawCompleted ? '[turn-test] PASS: turn completed' : '[turn-test] FAIL: no completion in 200s')
  await client.dispose()
  process.exit(sawCompleted ? 0 : 1)
}
main().catch((err) => {
  console.error('[turn-test] FATAL', err?.message ?? err)
  process.exit(1)
})
