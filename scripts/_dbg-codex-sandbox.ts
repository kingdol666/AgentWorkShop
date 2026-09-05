import { StdioJsonRpcClient } from '../server/services/workshop/agents/adapters/stdio-jsonrpc'

async function main() {
  const client = new StdioJsonRpcClient({
    name: 'codex-sandbox-test',
    command: 'codex',
    args: ['app-server'],
    cwd: process.cwd(),
    requestTimeoutMs: 30_000,
    env: {
      AW_BASE_URL: 'http://127.0.0.1:3001',
      AW_MCP_TOOL_TIMEOUT_MS: '200000',
    },
  })
  client.onExit((code) => {
    console.log('[sbx] EXIT code=', code)
    process.exit(1)
  })
  await client.start()
  await client.request('initialize', { clientInfo: { name: 'aw-probe', title: 'AW', version: '0.0.1' } }, 30_000)
  client.notify('initialized', {})
  const thread = await client.request('thread/start', {
    model: 'glm-5.3-flash',
    cwd: process.cwd(),
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
  }, 60_000) as Record<string, unknown>
  const t0 = Date.now()
  let completed = false
  client.onNotification((method, params) => {
    const p = (params ?? {}) as Record<string, unknown>
    if (method === 'turn/completed') {
      const turn = (p.turn ?? {}) as Record<string, unknown>
      console.log('[sbx] turn/completed status=', turn.status, Math.round((Date.now() - t0) / 1000) + 's')
      completed = true
    }
    else if (method === 'item/agentMessage/delta' && p.delta && !(client as unknown as { _d?: boolean })._d) {
      ;(client as unknown as { _d?: boolean })._d = true
      console.log('[sbx] first delta', Math.round((Date.now() - t0) / 1000) + 's')
    }
    else if (method === 'error') console.log('[sbx] error:', JSON.stringify(p).slice(0, 160))
    else if (String(method).startsWith('item/')) console.log('[sbx]', method, Math.round((Date.now() - t0) / 1000) + 's')
  })
  const threadObj = (thread?.thread ?? thread) as { id?: string }
  await client.request('turn/start', {
    threadId: threadObj?.id,
    input: [{ type: 'text', text: '直接回答:1+1等于几?一句话即可。' }],
  }, 60_000)
  console.log('[sbx] turn/start accepted (workspace-write + AW env)')
  for (let i = 0; i < 24 && !completed; i++) await new Promise(r => setTimeout(r, 5000))
  console.log(completed ? '[sbx] PASS' : '[sbx] FAIL: no completion in 120s')
  await client.dispose()
  process.exit(completed ? 0 : 1)
}
main().catch((err) => {
  console.error('[sbx] FATAL', err?.message ?? err)
  process.exit(1)
})
