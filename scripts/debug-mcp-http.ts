/**
 * 真实 HTTP MCP 调试脚本 — 连运行中的 dev server 的 /api/mcp/workshop。
 * 验证: initialize → tools/list → channel.create → agent.create(取 token)
 *       → 带 token 的 a2a.send / task.list → 无 token UNAUTHORIZED。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const BASE = process.env.MCP_URL ?? 'http://localhost:3000/api/mcp/workshop'
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function main(): Promise<void> {
  console.log(`\n=== 真实 HTTP MCP 调试(${BASE})===`)
  const client = new Client({ name: 'debug-client', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(BASE)))

  const tools = await client.listTools()
  check('initialize + tools/list(16 工具)', tools.tools.length === 16, `got=${tools.tools.length}`)

  const ch = await client.callTool({
    name: 'workshop.channel.create',
    arguments: { name: `debug-${Date.now()}`, leadAgent: { name: 'dbg-lead', harness: 'mock', config: { delayMs: 50 } } },
  })
  const channelId = JSON.parse((ch.content as { text: string }[])[0].text).channelId as string
  check('channel.create', channelId.length > 0, channelId.slice(0, 12))

  const w = await client.callTool({
    name: 'workshop.agent.create',
    arguments: { channelId, name: 'dbg-worker', harness: 'mock', role: 'worker', config: { delayMs: 50 } },
  })
  const worker = JSON.parse((w.content as { text: string }[])[0].text)
  check('agent.create 返回 token', typeof worker.token === 'string' && worker.token.length > 0)

  // 带 worker token 的 client(作业面工具)
  const authed = new Client({ name: 'debug-worker', version: '1.0.0' })
  await authed.connect(new StreamableHTTPClientTransport(new URL(BASE), {
    requestInit: { headers: { Authorization: `Bearer ${worker.token}` } },
  }))

  const tasks = await authed.callTool({ name: 'workshop.task.list', arguments: {} })
  check('带 token task.list 成功', tasks.isError !== true, JSON.stringify(tasks.content).slice(0, 60))

  const chs = await client.callTool({ name: 'workshop.channel.list', arguments: {} })
  check('channel.list(无 token 管理面)成功', chs.isError !== true)

  // 无 token 调作业面 → UNAUTHORIZED
  const denied = await client.callTool({ name: 'workshop.a2a.send', arguments: { toAgentId: worker.id, parts: [{ text: 'x' }] } })
  const deniedText = ((denied.content as { text: string }[])[0]?.text ?? '')
  check('无 token a2a.send → UNAUTHORIZED', denied.isError === true && deniedText.includes('UNAUTHORIZED'), deniedText.slice(0, 80))

  await client.close()
  await authed.close()
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('MCP 调试异常:', e)
  process.exit(1)
})
