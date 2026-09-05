import { StdioJsonRpcClient } from '../server/services/workshop/agents/adapters/stdio-jsonrpc'

async function main() {
  const client = new StdioJsonRpcClient({
    name: 'codex-test',
    command: 'codex',
    args: ['app-server'],
    cwd: process.cwd(),
    requestTimeoutMs: 20_000,
  })
  client.onExit((code) => {
    console.log('[test] app-server EXIT code=', code)
    process.exit(1)
  })
  await client.start()
  console.log('[test] spawned pid=', client.pid)
  const res = await client.request('initialize', { clientInfo: { name: 'aw-probe', title: 'AW', version: '0.0.1' } }, 20_000)
  console.log('[test] initialize OK, userAgent =', (res as { userAgent?: string }).userAgent)
  client.notify('initialized', {})
  const models = await client.request('model/list', {}, 20_000) as { data?: Array<{ model?: string }> }
  console.log('[test] models:', (models?.data ?? []).map(m => m.model).slice(0, 5).join(','))
  await new Promise(r => setTimeout(r, 10_000))
  console.log('[test] alive 10s after handshake')
  await client.dispose()
  process.exit(0)
}
main().catch((err) => {
  console.error('[test] FATAL', err?.message ?? err)
  process.exit(1)
})
