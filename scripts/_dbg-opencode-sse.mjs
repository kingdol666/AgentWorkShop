/**
 * opencode serve SSE 裸探针:复现 impl 的调用形状,原样打印事件流。
 * 运行:node scripts/_dbg-opencode-sse.mjs
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const dataDir = mkdtempSync(join(tmpdir(), 'aw-oc-data-'))
const configDir = mkdtempSync(join(tmpdir(), 'aw-oc-cfg-'))
mkdirSync(join(dataDir, 'opencode'), { recursive: true })
try { copyFileSync(join(homedir(), '.local', 'share', 'opencode', 'auth.json'), join(dataDir, 'opencode', 'auth.json')) } catch (e) { console.log('auth copy fail', e.message) }
console.log('dataDir=', dataDir)

const port = 20000 + Math.floor(Math.random() * 20000)
const pw = randomUUID()
const child = spawn('opencode', ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: pw, XDG_DATA_HOME: dataDir, XDG_CONFIG_HOME: configDir },
  stdio: ['ignore', 'pipe', 'pipe'], shell: false,
})
child.stderr.on('data', (d) => process.stderr.write('[err] ' + d))

const auth = { headers: { authorization: `Basic ${Buffer.from(`opencode:${pw}`).toString('base64')}`, 'content-type': 'application/json' } }

setTimeout(async () => {
  // 健康探测
  let healthy = false
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/global/health`, { headers: { authorization: auth.headers.authorization }, signal: AbortSignal.timeout(2000) })
      if (r.ok) { healthy = true; break }
    }
    catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  console.log('healthy=', healthy)
  if (!healthy) process.exit(1)

  // MCP 桥注册(与 impl 同形状)
  const bridge = process.env.AW_BRIDGE_PATH ?? join(process.cwd(), 'server', 'harness', 'aw-mcp-bridge.mjs')
  const mcpRes = await fetch(`http://127.0.0.1:${port}/mcp`, { ...auth, method: 'POST', body: JSON.stringify({
    name: 'aw-host-tools',
    config: { type: 'local', command: [process.execPath, bridge], environment: { AW_BASE_URL: 'http://127.0.0.1:1', AW_AGENT_ID: 'x', AW_AGENT_TOKEN: 'y' } },
  }) })
  console.log('mcp register:', mcpRes.status, (await mcpRes.text()).slice(0, 120))

  // 建会话(带权限规则)
  const sesRes = await fetch(`http://127.0.0.1:${port}/session`, { ...auth, method: 'POST', body: JSON.stringify({
    title: 'probe',
    permission: [{ permission: 'edit', action: 'ask' }, { permission: 'bash', pattern: '*', action: 'ask' }],
  }) })
  const ses = await sesRes.json()
  console.log('session:', sesRes.status, JSON.stringify(ses).slice(0, 200))
  const sid = ses.id

  // 事件流
  const es = await fetch(`http://127.0.0.1:${port}/event`, { headers: auth.headers })
  const reader = es.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const events = []
  ;(async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n\n'); buf = parts.pop()
      for (const chunk of parts) for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue
        try { events.push(JSON.parse(line.slice(5))) } catch {}
      }
    }
  })()

  // 投递
  const pr = await fetch(`http://127.0.0.1:${port}/session/${sid}/prompt_async`, { ...auth, method: 'POST', body: JSON.stringify({
    model: { providerID: 'zhipuai-coding-plan', modelID: 'glm-5.3-flash' },
    parts: [{ type: 'text', text: 'Reply with exactly: OK' }],
  }) })
  console.log('prompt_async:', pr.status)

  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500))
    const err = events.find(e => e.type === 'session.error')
    const idle = events.find(e => e.type === 'session.idle')
    if (err || idle) break
  }
  console.log('--- events (deduped by type) ---')
  const seen = new Map()
  for (const e of events) {
    const key = e.type + ':' + (e.properties?.part?.type ?? '')
    if (!seen.has(key)) { seen.set(key, 1); console.log(e.type, JSON.stringify(e.properties ?? {}).slice(0, 260)) }
    else seen.set(key, seen.get(key) + 1)
  }
  for (const [k, n] of seen) if (n > 1) console.log(`(${k} x${n})`)
  child.kill('SIGKILL')
  process.exit(0)
}, 3000)
