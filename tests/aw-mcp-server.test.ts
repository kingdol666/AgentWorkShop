// aw-mcp-server 单元测试:端口自动发现 / JSON-RPC 面 / 鉴权 / 断线重发现 / 逃生舱守卫。
// 全程只打本测试自起的随机端口 mock 上游,绝不触真实实例(显式 defaults:[] + env 隔离)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { buildCandidates, discoverInstance, readLock } from '../mcp/discovery.mjs'
import { apiCall, buildToolDefs, createState, handleMessage } from '../mcp/aw-mcp-server.mjs'

// ── mock 上游(AgentWorkShop 实例替身)─────────────────────────

type Upstream = { port: number, close: () => Promise<void>, hits: string[], sawAuth: () => boolean }

async function startUpstream(): Promise<Upstream> {
  const state = { authSeen: false }
  const hits: string[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      hits.push(`${req.method} ${req.url}`)
      if (req.headers.authorization) state.authSeen = true
      const reply = (code: number, data: unknown, message = 'ok') => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: code === 200 ? 0 : 'ERR', message, data }))
      }
      if (req.url === '/api/health') {
        return reply(200, { status: 'ok', app: 'AgentWorkShop', version: 'test', mode: 'prod:repo', uptimeMs: 1 })
      }
      if (req.url === '/api/users/login' && req.method === 'POST') {
        const body = JSON.parse(raw || '{}')
        if (body.email === 'a@b.c' && body.password === 'pw123') {
          return reply(200, { user: { id: 'u1', name: 'tester', role: 'admin' }, token: 'tok-123' })
        }
        return reply(401, null, '用户名或密码错误')
      }
      if (req.url === '/api/users/setup-status') return reply(200, { needsSetup: false })
      if (req.url === '/api/workshop/dcw/lines' && req.method === 'POST') {
        if (!req.headers.authorization) return reply(401, null, '未鉴权')
        return reply(200, { line: { id: 'line-1', name: JSON.parse(raw || '{}').name } })
      }
      if (req.url === '/api/workshop/dcw/lines' && req.method === 'GET') {
        if (!req.headers.authorization) return reply(401, null, '未鉴权')
        return reply(200, [{ id: 'line-1', name: '测试线', running: false }])
      }
      if (req.url?.startsWith('/api/workshop/plugins')) {
        // 真实平台此端点是裸 defineEventHandler(无统一信封)——按原样返回
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ plugins: [{ name: 'demo', enabled: true }], failures: [] }))
        return
      }
      return reply(404, null, `no route: ${req.method} ${req.url}`)
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    port,
    hits,
    sawAuth: () => state.authSeen,
    close: () => new Promise<void>(r => server.close(() => r())),
  }
}

/** 拿一个确定空闲的端口(起完即关) */
async function closedPort(): Promise<number> {
  const s = createServer()
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as { port: number }).port
  await new Promise<void>(r => s.close(() => r()))
  return port
}

/** 造一个隔离工程目录(带 .AgentWorkShop 配置根、锁文件与 config.yml) */
function makeProj(lockPort?: number | null) {
  const root = mkdtempSync(join(tmpdir(), 'awmcp-test-'))
  const proj = join(root, 'proj')
  mkdirSync(join(proj, '.AgentWorkShop', '.runtime'), { recursive: true })
  if (lockPort != null) {
    writeFileSync(join(proj, '.AgentWorkShop', '.runtime', 'aw.lock'), JSON.stringify({ pid: process.pid, port: lockPort, mode: 'prod:repo', startedAt: new Date().toISOString() }))
  }
  writeFileSync(join(proj, 'config.yml'), 'server:\n  host: 0.0.0.0\n  dev:\n    port: 3000\n  prod:\n    port: 3001\n')
  return { root, proj, lockPath: join(proj, '.AgentWorkShop', '.runtime', 'aw.lock') }
}

// ── 发现 ──────────────────────────────────────────────────

test('readLock: 正常解析,损坏与越界端口忽略', () => {
  const { proj, lockPath } = makeProj(4321)
  assert.equal(readLock(lockPath)?.port, 4321)
  writeFileSync(lockPath, 'not-json{')
  assert.equal(readLock(lockPath), null)
  writeFileSync(lockPath, JSON.stringify({ pid: 1, port: 99_999 }))
  assert.equal(readLock(lockPath), null)
  rmSync(proj, { recursive: true, force: true })
})

test('buildCandidates: 锁文件 > PORT env > config.yml > 默认,AW_HOME 抑制全局 home 锁', async () => {
  const upstream = await startUpstream()
  const { proj } = makeProj(upstream.port)
  const cands = buildCandidates({ cwd: proj, env: { AW_HOME: join(proj, 'no-such-home'), PORT: '3999' }, defaults: ['3000', '3001'] })
  const sources = cands.map(c => c.source)
  assert.ok(sources[0].startsWith('lock:'), `首候选应是 repo 锁: ${sources[0]}`)
  assert.ok(sources.some(s => s === 'env:PORT'))
  assert.ok(sources.some(s => s.includes('server.dev.port') || s.includes('server.prod.port')))
  const globalHomeLock = join(homedir(), '.AgentWorkShop', '.runtime', 'aw.lock')
  assert.ok(!sources.some(s => s === `lock:${globalHomeLock}`), 'AW_HOME 设置时不得回落全局 home 锁')
  const ports = cands.map(c => c.port)
  assert.equal(new Set(ports).size, ports.length, '同端口只入候选一次(config 已覆盖时默认端口被去重吸收)')

  // 无 config.yml 的裸目录:默认端口兜底必须出现
  const bare = mkdtempSync(join(tmpdir(), 'awmcp-bare-'))
  const cands2 = buildCandidates({ cwd: bare, env: { AW_HOME: join(bare, 'no-such-home') }, defaults: ['3000', '3001'] })
  assert.ok(cands2.map(c => c.source).includes('default:3000'))
  rmSync(bare, { recursive: true, force: true })
  await upstream.close()
})

test('discoverInstance: 锁文件命中随机端口 mock 实例', async () => {
  const upstream = await startUpstream()
  const { proj } = makeProj(upstream.port)
  const found = await discoverInstance({ cwd: proj, env: { AW_HOME: join(proj, 'no-such-home') }, defaults: [] })
  assert.ok(found, '应发现实例')
  assert.equal(found!.port, upstream.port)
  assert.ok(found!.source.startsWith('lock:'))
  assert.equal(found!.health.status, 'ok')
  assert.equal(found!.health.app, 'AgentWorkShop')
  rmSync(proj, { recursive: true, force: true })
})

test('discoverInstance: 锁指向死端口 → 无兜底时干净失败(null)', async () => {
  const dead = await closedPort()
  const { proj } = makeProj(dead)
  const found = await discoverInstance({ cwd: proj, env: { AW_HOME: join(proj, 'no-such-home') }, defaults: [] })
  assert.equal(found, null)
  rmSync(proj, { recursive: true, force: true })
})

test('discoverInstance: 健康形状不对(非 aw 实例)不算命中', async () => {
  const imposter = createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ uptime: 1 })) // 不是 aw 信封
  })
  await new Promise<void>(r => imposter.listen(0, '127.0.0.1', r))
  const port = (imposter.address() as { port: number }).port
  const { proj } = makeProj(port)
  const found = await discoverInstance({ cwd: proj, env: { AW_HOME: join(proj, 'no-such-home') }, defaults: [] })
  assert.equal(found, null)
  imposter.close()
  rmSync(proj, { recursive: true, force: true })
})

// ── JSON-RPC 面 ───────────────────────────────────────────

test('tools/list: ≥30 个工具、名字唯一、schema 均为 object', async () => {
  const state = createState({ env: {} })
  const res = await handleMessage(state, { jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: Array<{ name: string, inputSchema: { type: string } }> } }
  const names = res.result.tools.map(t => t.name)
  assert.ok(names.length >= 30, `工具数 ${names.length} 应 ≥30`)
  assert.equal(new Set(names).size, names.length, '工具名必须唯一')
  for (const t of res.result.tools) assert.equal(t.inputSchema.type, 'object')
  assert.ok(buildToolDefs().every(d => typeof d.run === 'function'))
})

test('initialize / ping / 通知 / 未知方法', async () => {
  const state = createState({ env: { AW_MCP_ENABLED: 'true' } })
  const init = await handleMessage(state, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) as { result: { protocolVersion: string, serverInfo: { name: string } } }
  assert.equal(init.result.protocolVersion, '2025-03-26')
  assert.equal(init.result.serverInfo.name, 'aw-industrial-mcp')
  assert.ok(await handleMessage(state, { jsonrpc: '2.0', id: 2, method: 'ping' }))
  assert.equal(await handleMessage(state, { jsonrpc: '2.0', method: 'notifications/initialized' }), null)
  const unknown = await handleMessage(state, { jsonrpc: '2.0', id: 3, method: 'no/such' }) as { error: { code: number } }
  assert.equal(unknown.error.code, -32601)
  const unknownTool = await handleMessage(state, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } }) as { error: { code: number } }
  assert.equal(unknownTool.error.code, -32602)
})

test('工具全链:懒登录 → 带鉴权调用 → 数据返回', async () => {
  const upstream = await startUpstream()
  const state = createState({ env: { AW_BASE_URL: `http://127.0.0.1:${upstream.port}`, AW_EMAIL: 'a@b.c', AW_PASSWORD: 'pw123', AW_MCP_ENABLED: 'true' } })
  const login = await handleMessage(state, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aw_login', arguments: {} } }) as { result: { content: Array<{ text: string }>, isError?: boolean } }
  assert.ok(!login.result.isError, `登录应成功: ${login.result.content[0].text}`)
  assert.equal(state.token, 'tok-123')

  const create = await handleMessage(state, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aw_line_create', arguments: { name: '测试线' } } }) as { result: { content: Array<{ text: string }>, isError?: boolean } }
  assert.ok(!create.result.isError, `建线应成功: ${create.result.content[0].text}`)
  const data = JSON.parse(create.result.content[0].text)
  assert.equal(data.line.name, '测试线')
  assert.ok(upstream.sawAuth(), '上游应看到 Authorization 头')

  const list = await handleMessage(state, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aw_line_list', arguments: {} } }) as { result: { content: Array<{ text: string }>, isError?: boolean } }
  assert.ok(!list.result.isError)
  assert.ok(JSON.parse(list.result.content[0].text)[0].name.includes('测试'))
  await upstream.close()
})

test('未鉴权:错误文本给出可执行的补救指引', async () => {
  const upstream = await startUpstream()
  const state = createState({ env: { AW_BASE_URL: `http://127.0.0.1:${upstream.port}`, AW_MCP_ENABLED: 'true' } })
  const res = await handleMessage(state, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aw_line_list', arguments: {} } }) as { result: { isError: boolean, content: Array<{ text: string }> } }
  assert.equal(res.result.isError, true)
  assert.match(res.result.content[0].text, /aw_login|AW_EMAIL/)
  await upstream.close()
})

test('断线重发现:实例换端口后下一次调用自动接上', async () => {
  const u1 = await startUpstream()
  const { proj, lockPath } = makeProj(u1.port)
  const state = createState({ env: { AW_HOME: join(proj, 'no-such-home'), AW_EMAIL: 'a@b.c', AW_PASSWORD: 'pw123', AW_MCP_ENABLED: 'true' }, cwd: proj })
  const r1 = await handleMessage(state, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aw_status', arguments: {} } }) as { result: { isError?: boolean, content: Array<{ text: string }> } }
  assert.ok(!r1.result.isError, `首次 aw_status 应命中: ${r1.result.content[0].text.slice(0, 300)}`)

  await u1.close()
  const u2 = await startUpstream()
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, port: u2.port, mode: 'prod:repo' }))

  const r2 = await handleMessage(state, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aw_line_list', arguments: {} } }) as { result: { isError?: boolean, content: Array<{ text: string }> } }
  assert.ok(!r2.result.isError, `换端口后应自动重连: ${r2.result.content[0].text.slice(0, 300)}`)
  assert.ok(u2.hits.some(h => h.includes('/api/workshop/dcw/lines')), '请求应落到新实例')
  await u2.close()
  rmSync(proj, { recursive: true, force: true })
})

test('aw_request 逃生舱:仅放行 /api/ 前缀', async () => {
  const upstream = await startUpstream()
  const state = createState({ env: { AW_BASE_URL: `http://127.0.0.1:${upstream.port}`, AW_TOKEN: 'tok-123', AW_MCP_ENABLED: 'true' } })
  const evil = await handleMessage(state, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aw_request', arguments: { method: 'GET', path: 'http://evil.example/api/x' } } }) as { result: { isError: boolean } }
  assert.equal(evil.result.isError, true)
  const good = await handleMessage(state, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aw_request', arguments: { method: 'GET', path: '/api/workshop/plugins' } } }) as { result: { isError?: boolean, content: Array<{ text: string }> } }
  assert.ok(!good.result.isError, `应放行 /api/ 路径: ${good.result.content[0].text.slice(0, 200)}`)
  // 裸 defineEventHandler(无信封)端点的载荷须原样透出(信封嗅探)
  const raw = JSON.parse(good.result.content[0].text)
  assert.equal(raw.plugins?.[0]?.name, 'demo')
  await upstream.close()
})

test('凭据错误:抛登录失败且不缓存 token(不触发端口重发现)', async () => {
  const upstream = await startUpstream()
  const state = createState({ env: { AW_BASE_URL: `http://127.0.0.1:${upstream.port}`, AW_EMAIL: 'a@b.c', AW_PASSWORD: 'wrong' } })
  await assert.rejects(
    () => apiCall(state, 'GET', '/api/workshop/dcw/lines', undefined),
    /登录失败/,
  )
  assert.equal(state.token, null, '登录失败后不得缓存 token')
  await upstream.close()
})

test('MCP 集成开关:停用时除 aw_status 外全部工具被拒(指引去系统设置)', async () => {
  const upstream = await startUpstream()
  const state = createState({ env: { AW_BASE_URL: `http://127.0.0.1:${upstream.port}`, AW_HOME: join(tmpdir(), `no-home-${Date.now()}`) } }) // AW_HOME 指向空配置根 → 停用
  const status = await handleMessage(state, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aw_status', arguments: {} } }) as { result: { isError?: boolean, content: Array<{ text: string }> } }
  assert.ok(!status.result.isError, 'aw_status 必须始终放行(自诊断)')
  assert.equal(JSON.parse(status.result.content[0].text).mcpEnabled, false)
  const blocked = await handleMessage(state, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aw_line_list', arguments: {} } }) as { result: { isError: boolean, content: Array<{ text: string }> } }
  assert.equal(blocked.result.isError, true)
  assert.match(blocked.result.content[0].text, /系统设置|AW_MCP_ENABLED/)
  await upstream.close()
})

test('MCP 集成开关:runtime-settings.json 文件路径生效(env AW_HOME=配置根)', async () => {
  const upstream = await startUpstream()
  const { proj } = makeProj(upstream.port)
  writeFileSync(join(proj, 'runtime-settings.json'), JSON.stringify({ version: 1, overrides: { 'mcp.enabled': true } }))
  const state = createState({ env: { AW_BASE_URL: `http://127.0.0.1:${upstream.port}`, AW_HOME: proj, AW_TOKEN: 'tok-123' }, cwd: proj })
  const st = await handleMessage(state, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aw_status', arguments: {} } }) as { result: { content: Array<{ text: string }> } }
  assert.equal(JSON.parse(st.result.content[0].text).mcpEnabled, true, '文件配置应生效')
  const list = await handleMessage(state, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aw_line_list', arguments: {} } }) as { result: { isError?: boolean } }
  assert.ok(!list.result.isError, '启用后工具应放行')
  rmSync(proj, { recursive: true, force: true })
  await upstream.close()
})
