#!/usr/bin/env node
/**
 * MCP 桥探针:验证 aw-mcp-bridge.mjs 的 MCP stdio ↔ HTTP 回程转译(不依赖真实引擎)。
 * 运行:node scripts/_dbg-mcp-bridge-probe.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE = join(ROOT, 'server', 'harness', 'aw-mcp-bridge.mjs')
const AGENT_ID = `a-${randomUUID().slice(0, 8)}`
const TOKEN = `t-${randomUUID()}`

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const seen = { listToken: null, invokeToken: null, invokeBody: null }

/** HTTP stub:模拟平台 agent-tools 面 */
const server = createServer((req, res) => {
  const token = req.headers['x-aw-agent-token']
  if (req.method === 'GET' && req.url?.startsWith('/api/workshop/agent-tools/list')) {
    seen.listToken = token
    if (token !== TOKEN) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 401, message: 'bad token' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      code: 0,
      data: {
        tools: [
          { name: 'report_progress', description: 'Report progress', parameters: { type: 'object', properties: { progress: { type: 'number' } }, required: ['progress'] } },
          { name: 'probe_tool', description: 'Probe tool', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
        ],
      },
    }))
    return
  }
  if (req.method === 'POST' && req.url?.startsWith('/api/workshop/agent-tools/invoke')) {
    seen.invokeToken = token
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      seen.invokeBody = JSON.parse(body || '{}')
      if (token !== TOKEN) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 401, message: 'bad token' }))
        return
      }
      const tool = seen.invokeBody.tool
      res.writeHead(200, { 'content-type': 'application/json' })
      if (tool === 'boom') {
        res.end(JSON.stringify({ code: 0, data: { result: { text: '模拟工具失败', isError: true } } }))
      }
      else {
        res.end(JSON.stringify({ code: 0, data: { result: { text: `OK ${tool} q=${seen.invokeBody.args?.q ?? ''}` } } }))
      }
    })
    return
  }
  res.writeHead(404)
  res.end()
})

await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
const port = server.address().port

function rpc(child, msg, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC 超时: ${msg.method ?? msg.id}`)), timeoutMs)
    const rl = child.rl
    const onLine = (line) => {
      try {
        const frame = JSON.parse(line)
        if (frame.id === msg.id) {
          clearTimeout(timer)
          rl.removeListener('line', onLine)
          resolve(frame)
        }
      }
      catch { /* 忽略非 JSON 行 */ }
    }
    rl.on('line', onLine)
    child.stdin.write(JSON.stringify(msg) + '\n')
  })
}

console.log('━━━ MCP 桥探针(aw-mcp-bridge.mjs)━━━')
try {
  const proc = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, AW_BASE_URL: `http://127.0.0.1:${port}`, AW_AGENT_ID: AGENT_ID, AW_AGENT_TOKEN: TOKEN },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  proc.rl = createInterface({ input: proc.stdout })
  let stderr = ''
  proc.stderr.on('data', (d) => { stderr += d })

  // 1. initialize
  const init = await rpc(proc, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  check('initialize 握手', init.result?.serverInfo?.name === 'aw-host-tools', `serverInfo=${JSON.stringify(init.result?.serverInfo)}`)

  // 2. tools/list(验证 token 头与工具面透传)
  const list = await rpc(proc, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const names = (list.result?.tools ?? []).map(t => t.name)
  check('tools/list 携带 agent token', seen.listToken === TOKEN)
  check('tools/list 透传平台工具面', names.includes('report_progress') && names.includes('probe_tool'), `names=${names.join(',')}`)
  const probe = (list.result?.tools ?? []).find(t => t.name === 'probe_tool')
  check('inputSchema = parameters', JSON.stringify(probe?.inputSchema ?? {}).includes('q'))

  // 3. tools/call 成功路径
  const call = await rpc(proc, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'probe_tool', arguments: { q: 'hello' } } })
  check('tools/call 回程 HTTP', seen.invokeBody?.tool === 'probe_tool' && seen.invokeBody?.agentId === AGENT_ID)
  check('tools/call 结果转译', call.result?.content?.[0]?.text === 'OK probe_tool q=hello', `text=${call.result?.content?.[0]?.text}`)
  check('tools/call 携带 agent token', seen.invokeToken === TOKEN)

  // 4. isError 透传
  const boom = await rpc(proc, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } })
  check('isError 透传', boom.result?.isError === true, `text=${boom.result?.content?.[0]?.text}`)

  proc.kill('SIGKILL')
}
catch (err) {
  check('桥进程往返', false, err.message)
}

// 5. 缺 token → 桥拒绝启动
const bad = spawn(process.execPath, [BRIDGE], {
  env: { ...process.env, AW_BASE_URL: `http://127.0.0.1:${port}`, AW_AGENT_ID: '', AW_AGENT_TOKEN: '' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let badStderr = ''
bad.stderr.on('data', (d) => { badStderr += d })
const badExit = await new Promise((resolve) => { bad.on('exit', (code) => resolve(code)) })
check('缺 AW_AGENT_ID 拒绝启动', badExit === 1, `exit=${badExit} stderr=${badStderr.trim().slice(0, 80)}`)

server.close()
console.log(failures === 0 ? '\n━━━ 全部通过 ━━━' : `\n━━━ ${failures} 项失败 ━━━`)
process.exit(failures === 0 ? 0 : 1)
