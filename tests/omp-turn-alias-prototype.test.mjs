import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { randomBytes } from 'node:crypto'

// 外部依赖:本用例要真拉起 `omp` 二进制;CI/洁净环境未安装时按纪律带原因 skip(不伪造通过)。
const ompProbe = spawnSync('omp', ['--version'], { stdio: 'ignore', timeout: 10_000 })
const ompMissing = Boolean(ompProbe.error) || ompProbe.status === null

// Standalone experiment: does not import or alter the product OMP adapter.
test('persistent OMP rotates model-visible host tools and rejects stale names', {
  timeout: 90_000,
  skip: ompMissing ? 'omp binary not available in this environment' : false,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-omp-tool-fence-'))
  const home = join(root, 'home')
  const work = join(root, 'work')
  const agentDir = join(root, 'agent')
  await Promise.all([home, work, agentDir].map(path => mkdir(path, { recursive: true })))
  const nonce = () => randomBytes(8).toString('hex')
  const aliases = [`aw_${nonce()}_line_context`, `aw_${nonce()}_line_context`, `aw_${nonce()}_line_context`]
  const modelRequests = []
  const toolResults = []
  const dispatched = []
  let turn = 0
  let modelStep = 0
  let activeAlias = ''
  const route = (frame) => {
    if (frame.toolName !== activeAlias) return { text: 'stale or unregistered tool', isError: true }
    dispatched.push({ turn, name: frame.toolName, args: frame.arguments })
    return { text: `accepted-turn-${turn}` }
  }
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const names = (body.tools ?? []).map(tool => tool.function?.name).filter(Boolean)
      const results = (body.messages ?? []).filter(message => message.role === 'tool')
      modelRequests.push({ turn, names, results: results.map(r => ({ id: r.tool_call_id, content: r.content })) })
      const id = `chat-${turn}-${modelStep}`
      const event = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created: 1, model: 'local-test', choices: [{ index: 0, delta, finish_reason: finish }] })
      const events = modelStep++ === 0
        ? [event({ role: 'assistant' }), event({ tool_calls: [{ index: 0, id: `call-${turn}`, type: 'function', function: { name: turn === 3 ? aliases[0] : aliases[turn - 1], arguments: JSON.stringify({ value: turn }) } }] }), event({}, 'tool_calls')]
        : [event({ role: 'assistant' }), event({ content: `turn ${turn} complete` }), event({}, 'stop')]
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const item of events) res.write(`data: ${JSON.stringify(item)}\n\n`)
      res.end('data: [DONE]\n\n')
    }
    catch (error) {
      res.writeHead(500)
      res.end(String(error))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await writeFile(join(agentDir, 'models.yml'), `providers:\n  fence-fixture:\n    baseUrl: http://127.0.0.1:${port}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: local-test\n        name: Local Test\n        reasoning: false\n        input: [text]\n        contextWindow: 32768\n        maxTokens: 1024\n`)
  const child = spawn('omp', ['--mode', 'rpc', '--model', 'fence-fixture/local-test', '--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-session', '--no-ui', '--auto-approve', '--cwd', work], {
    cwd: work,
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, TEMP: root, TMP: root, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (data) => {
    stderr += data.toString()
  })
  const frames = []
  let frameCursor = 0
  let wake = () => {}
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    try {
      const frame = JSON.parse(line)
      frames.push(frame)
      if (frame.type === 'host_tool_call') {
        const result = route(frame)
        toolResults.push({ id: frame.id, name: frame.toolName, result })
        child.stdin.write(`${JSON.stringify({ type: 'host_tool_result', id: frame.id, result: { content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) } })}\n`)
      }
      wake()
    }
    catch (error) {
      stderr += `\nparse: ${error}`
    }
  })
  const wait = async (predicate, label) => {
    const end = Date.now() + 20_000
    while (!frames.some(predicate)) {
      if (child.exitCode !== null) throw new Error(`OMP exited while waiting for ${label}: ${stderr}`)
      if (Date.now() > end) throw new Error(`timeout waiting for ${label}; frames=${JSON.stringify(frames)} stderr=${stderr}`)
      await Promise.race([
        new Promise((resolve) => {
          wake = resolve
        }),
        new Promise(resolve => setTimeout(resolve, 50)),
      ])
    }
    return frames.find(predicate)
  }
  const send = frame => child.stdin.write(`${JSON.stringify(frame)}\n`)
  const register = async (id, alias) => {
    send({ id, type: 'set_host_tools', tools: [{ name: alias, label: 'line_context', description: 'Read line context', parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } }] })
    const response = await wait(f => f.type === 'response' && f.id === id, id)
    assert.equal(response.success, true, JSON.stringify(response))
    assert.deepEqual(response.data.toolNames, [alias])
  }
  try {
    await wait(f => f.type === 'ready', 'ready')
    for (turn = 1; turn <= 3; turn++) {
      modelStep = 0
      activeAlias = aliases[turn - 1]
      await register(`register-${turn}`, activeAlias)
      if (turn === 2) {
        const staleFrame = { type: 'host_tool_call', id: 'late-old-frame', toolCallId: 'late-old-tool', toolName: aliases[0], arguments: { value: 1 } }
        const before = dispatched.length
        assert.equal(route(staleFrame).isError, true)
        assert.equal(route({ ...staleFrame, toolName: 'line_context' }).isError, true)
        assert.equal(dispatched.length, before)
      }
      frameCursor = frames.length
      send({ id: `prompt-${turn}`, type: 'prompt', message: `Use the available line context tool for turn ${turn}.` })
      const result = await wait(f => f.type === 'prompt_result' && f.id === `prompt-${turn}`, `prompt-${turn}`)
      assert.equal(result.status, 'completed', JSON.stringify(result))
      if (!result.sessionSettled) await wait(f => f.type === 'session_settled' && frames.indexOf(f) >= frameCursor, 'session settled')
      if (turn < 3) assert.ok(toolResults.some(entry => entry.name === activeAlias && !entry.result.isError), JSON.stringify({ frames, stderr }))
      else assert.equal(toolResults.length, 2, 'obsolete name must not invoke any host tool')
      const requests = modelRequests.filter(request => request.turn === turn)
      assert.ok(requests.length >= 2, JSON.stringify({ requests, frames, stderr }))
      assert.ok(requests.every(request => request.names.includes(activeAlias)), JSON.stringify(requests))
      if (turn > 1) assert.ok(requests.every(request => !request.names.includes(aliases[0])), JSON.stringify(requests))
      if (turn < 3) assert.ok(requests.some(request => request.results.some(r => JSON.stringify(r.content).includes(`accepted-turn-${turn}`))), JSON.stringify(requests))
      else assert.ok(requests.some(request => request.results.some(r => r.id === 'call-3')), JSON.stringify(requests))
    }
    assert.deepEqual(dispatched.map(d => d.name), aliases.slice(0, 2))
    console.log(JSON.stringify({ pid: child.pid, aliases, modelRequests, toolResults, staleRejected: true }))
  }
  finally {
    child.stdin.end()
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))])
    if (child.exitCode === null) child.kill()
    lines.close()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
