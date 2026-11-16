import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProtectedSnapshot } from '../scripts/onboarding/v6-protected-api.mjs'
import { evaluateProtectedFixture } from '../scripts/onboarding/v6-protected-fixture.mjs'

/** 假模拟器:只答 /api/attestation(nonce 绑定)——脚本层验收无需真实五协议端点。 */
async function fakeAttestedSim(nonce) {
  const server = createServer((req, res) => {
    if (req.url === '/api/attestation') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 0, data: { nonce, pid: process.pid, simPort: Number(new URL(req.url, 'http://x').port) } }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    async writeBundle(dir, endpoints = []) {
      const bundlePath = join(dir, 'attestation.json')
      await writeFile(bundlePath, JSON.stringify({ version: 1, nonce, simBase: base, simPort: server.address().port, pid: process.pid, endpoints }))
      return bundlePath
    },
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

const lineId = 'fixture-line'
const limit = 3
const anchor = { id: 'a', lineId, nodeId: 'node', prevValue: null, newValue: 1, source: 'manual', actor: 'test', at: '2026-01-01T00:00:00Z', details: { b: 2, a: 1 } }
const snapshot = (exists, anchors = []) => ({ lines: exists ? [{ id: lineId }] : [], anchors })
const evaluate = (before, after) => evaluateProtectedFixture({ before, after, lineId, limit })

test('V6 decision matrix compares complete canonical anchors', () => {
  const baseline = snapshot(true, [anchor])
  const unchanged = snapshot(true, [{ details: { a: 1, b: 2 }, at: anchor.at, actor: 'test', source: 'manual', newValue: 1, prevValue: null, nodeId: 'node', lineId, id: 'a' }])
  const cases = [
    ['absent', snapshot(false), snapshot(false), 'SKIP'],
    ['created', snapshot(false), baseline, 'FAIL'],
    ['deleted', baseline, snapshot(false), 'FAIL'],
    ['empty baseline', snapshot(true), snapshot(true), 'FAIL'],
    ['unchanged with reordered keys', baseline, unchanged, 'PASS'],
    ['removed baseline', baseline, snapshot(true), 'FAIL'],
    ['changed same ID', baseline, snapshot(true, [{ ...anchor, newValue: 2 }]), 'FAIL'],
    ['added anchor', baseline, snapshot(true, [anchor, { ...anchor, id: 'b' }]), 'FAIL'],
    ['duplicate IDs', baseline, snapshot(true, [anchor, anchor]), 'FAIL'],
    ['missing ID', baseline, snapshot(true, [{ ...anchor, id: null }]), 'FAIL'],
    ['foreign anchor', baseline, snapshot(true, [{ ...anchor, lineId: 'other' }]), 'FAIL'],
    ['capped before', snapshot(true, [anchor, { ...anchor, id: 'b' }, { ...anchor, id: 'c' }]), baseline, 'FAIL'],
    ['capped after', baseline, snapshot(true, [anchor, { ...anchor, id: 'b' }, { ...anchor, id: 'c' }]), 'FAIL'],
    ['read error before', { error: 'unavailable' }, snapshot(false), 'FAIL'],
    ['read error after', snapshot(false), { error: 'unavailable' }, 'FAIL'],
    ['malformed snapshot', { lines: [], anchors: null }, snapshot(false), 'FAIL'],
  ]
  for (const [name, before, after, expected] of cases) assert.equal(evaluate(before, after).status, expected, name)
})

function fakeFetch(replies) {
  let index = 0
  return async () => {
    const reply = replies[index++]
    if (reply instanceof Error) throw reply
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => {
      if (reply.jsonError) throw new Error('invalid JSON')
      return reply.body
    } }
  }
}
const success = data => ({ status: 200, body: { code: 0, data } })

test('V6 checked reads fail closed on HTTP, envelope, shape, network and incomplete responses', async () => {
  const lines = success({ lines: [] })
  const journal = success({ anchors: [] })
  const failures = [
    [new Error('network down')],
    [{ status: 403, body: { code: 0, data: { lines: [] } } }],
    [{ status: 200, jsonError: true }],
    [{ status: 200, body: { code: 1, data: { lines: [] } } }],
    [{ status: 200, body: { code: 0, data: null } }],
    [success({ lines: null })],
    [lines, { status: 500, body: { code: 0, data: { anchors: [] } } }],
    [lines, { status: 200, body: { code: '0', data: { anchors: [] } } }],
    [lines, success({ anchors: null })],
    [lines, success({ anchors: [], hasMore: true })],
    [lines, success({ anchors: [], nextCursor: 'next' })],
    [lines, success({ anchors: [], total: 1 })],
    [lines, success({ anchors: [], total: '0' })],
    [lines, success({ anchors: [], hasMore: null })],
    [lines, success({ anchors: [], truncated: true })],
  ]
  const options = { base: 'http://fake', token: 'test', lineId, limit }
  for (const replies of failures) {
    const before = await readProtectedSnapshot({ ...options, fetchImpl: fakeFetch(replies) })
    assert.ok(before.error)
    assert.equal(evaluate(before, snapshot(false)).status, 'FAIL')
  }
  const valid = await readProtectedSnapshot({ ...options, fetchImpl: fakeFetch([lines, journal]) })
  assert.equal(evaluate(valid, valid).status, 'SKIP')
})

test('verify-line reports V6 status and exits nonzero on failed checked reads', async (t) => {
  const sim = await fakeAttestedSim(`nonce-${Date.now()}`)
  t.after(() => sim.close())
  const attDir = await mkdtemp(join(tmpdir(), 'aw-v6-line-'))
  t.after(() => rm(attDir, { recursive: true, force: true }))
  const bundlePath = await sim.writeBundle(attDir)
  let mode = 'skip'
  let lineReads = 0
  const protectedId = 'ln-d7e0a2a2'
  const server = createServer((req, res) => {
    let data
    if (req.url === '/api/workshop/dcw/lines') {
      lineReads++
      if (mode === 'error' && lineReads === 1) {
        res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 0, data: { lines: [] } }))
        return
      }
      data = { lines: mode === 'skip' ? [] : [{ id: protectedId }] }
    }
    else if (req.url.startsWith('/api/workshop/dcw/journal?lineId=')) data = { anchors: mode === 'skip' ? [] : [{ ...anchor, lineId: protectedId }] }
    else if (req.url === '/api/workshop/dcw') data = { recipes: [{ id: 'recipe', params: [] }] }
    else if (req.url === '/api/workshop/channels/channel') data = { channel: { lineId: 'test-line' } }
    else if (req.url === '/api/workshop/channels/channel/agents') data = [{ id: '1' }, { id: '2' }]
    else {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 0, data }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const script = fileURLToPath(new URL('../scripts/onboarding/verify-line.mjs', import.meta.url))
  for (const [scenario, expectedCode, status] of [['skip', 0, 'SKIP'], ['pass', 0, 'PASS'], ['error', 1, 'FAIL']]) {
    mode = scenario
    lineReads = 0
    const child = spawn(process.execPath, [script, '--stdin'], {
      env: { ...process.env, AW_BASE: `http://127.0.0.1:${server.address().port}`, AW_TOKEN: 'test', AW_ONBOARD_ATTESTATION: bundlePath },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end(JSON.stringify({ lineId: 'test-line', recipeId: 'recipe', channelId: 'channel', dcw: [], daq: [] }))
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    assert.equal(code, expectedCode, output)
    assert.match(output, new RegExp(`V6 受保护线保留 journal 完整性 — ${status}`))
    assert.doesNotMatch(output, /零扰动/)
  }
})

test('onboarding entry points reject unproven ownership before any API request', async (t) => {
  const requests = []
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    res.writeHead(500).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const dir = await mkdtemp(join(tmpdir(), 'aw-safety-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const configFile = join(dir, 'config.json')
  const preload = join(dir, 'deny-spawn.cjs')
  await writeFile(preload, `
    const child = require('node:child_process')
    child.spawnSync = child.execFileSync = child.execSync = child.spawn = () => { throw new Error('unexpected subprocess blocked by test') }
    require('node:module').syncBuiltinESMExports()
    const originalFetch = globalThis.fetch
    globalThis.fetch = (url, options) => {
      if (!String(url).startsWith(process.env.AW_BASE + '/')) throw new Error('unexpected network target blocked by test')
      return originalFetch(url, options)
    }
  `)
  const config = {
    line: { name: 'test', simulated: true },
    lineId: 'test-line', dcw: [], daq: [],
    scenario: 'diagnose', bindings: [], seedTask: null,
    tests: [{ driver: 'mes-rest', driverConfig: { readMap: { method: 'POST', path: '/test' } } }],
    nodes: [{ kind: 'dcw', name: 'SP', driver: 'modbus-tcp', driverConfig: { host: '127.0.0.1', port: 502 } }, { kind: 'daq', name: 'PV' }],
    recipe: { name: 'test', params: [{ node: 'SP', value: 1 }] },
    startLine: true,
    connectivity: { tests: [{ driver: 'modbus-tcp' }] },
    channel: { seedTask: { title: 'start' } },
  }
  for (const [scriptName, extra, startLine] of [
    ['provision-line.mjs', [], true],
    ['provision-line.mjs', [], false],
    ['onboard.mjs', [], undefined],
    ['onboard.mjs', ['--smoke'], false],
    ['onboard.mjs', ['--skip-connectivity'], true],
    ['verify-line.mjs', [], false],
    ['verify-line.mjs', ['--stdin'], false],
    ['forge-channel.mjs', [], false],
    ['test-connection.mjs', [], false],
    ['sim-twin.mjs', ['--from-platform', '--line', 'test-line', '--restart'], false],
    ['sim-twin.mjs', ['--blueprint', configFile, '--restart'], false],
    ['verify-mirror.mjs', ['--node', 'dn-test'], false],
    ['preflight.mjs', ['--probe'], false],
  ]) {
    await writeFile(configFile, JSON.stringify({ ...config, startLine }))
    const script = fileURLToPath(new URL(`../scripts/onboarding/${scriptName}`, import.meta.url))
    const scriptArgs = extra.includes('--stdin') ? ['--stdin'] : [configFile, ...extra]
    const child = spawn(process.execPath, ['--require', preload, script, ...scriptArgs], {
      env: { ...process.env, AW_BASE: `http://127.0.0.1:${server.address().port}`, AW_TOKEN: extra.includes('--smoke') || extra.includes('--stdin') ? '' : 'test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end(JSON.stringify({ lineId: 'test-line', dcw: [], daq: [] }))
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    assert.equal(code, 1, output)
    assert.match(output, /无法证明驱动实现及其端点属于本次隔离模拟器/)
    assert.deepEqual(requests, [], `${scriptName}: ${requests.join(', ')}`)
  }
})

test('fake API matrix gates writes and detects changes around verification', async (t) => {
  const sim = await fakeAttestedSim(`nonce-matrix-${Date.now()}`)
  t.after(() => sim.close())
  const attDir = await mkdtemp(join(tmpdir(), 'aw-v6-matrix-'))
  t.after(() => rm(attDir, { recursive: true, force: true }))
  const bundlePath = await sim.writeBundle(attDir)
  const protectedId = 'ln-d7e0a2a2'
  const protectedAnchor = { ...anchor, lineId: protectedId }
  let scenario
  let journalReads
  let writes
  let requests
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    const reply = (data, status = 200, code = 0) => res.writeHead(status, { 'content-type': 'application/json', 'connection': 'close' }).end(JSON.stringify({ code, data }))
    if (req.url === '/api/workshop/dcw/lines') {
      const after = journalReads > 0
      if (scenario === 'pre-http' && !after) return reply({ lines: [] }, 503)
      if (scenario === 'post-envelope' && after) return reply({ lines: [] }, 200, 1)
      const present = scenario !== 'absent' && !(scenario === 'created' && !after) && !(scenario === 'deleted' && after)
      const targets = ['protected-node', 'node-http', 'node-envelope', 'node-malformed', 'unproven'].includes(scenario)
        ? [{ id: 'test-line', simulated: true }]
        : []
      return reply({ lines: [...(present ? [{ id: protectedId }] : []), ...targets] })
    }
    if (req.url.startsWith('/api/workshop/dcw/journal?lineId=')) {
      const after = journalReads++ > 0
      if (scenario === 'pre-envelope' && !after) return reply({ anchors: [] }, 200, 1)
      if (scenario === 'pre-shape' && !after) return reply({ anchors: null })
      if (scenario === 'pre-capped' && !after) return reply({ anchors: Array.from({ length: 500 }, (_, i) => ({ ...protectedAnchor, id: `a${i}` })) })
      if (scenario === 'pre-incomplete' && !after) return reply({ anchors: [], hasMore: true })
      if (scenario === 'empty' || scenario === 'absent' || (scenario === 'created' && !after) || (scenario === 'deleted' && after) || (scenario === 'removed' && after)) return reply({ anchors: [] })
      if (scenario === 'changed' && after) return reply({ anchors: [{ ...protectedAnchor, newValue: 2 }] })
      if (scenario === 'added' && after) return reply({ anchors: [protectedAnchor, { ...protectedAnchor, id: 'b' }] })
      return reply({ anchors: [protectedAnchor] })
    }
    if (req.url === '/api/workshop/dcw/safe-node') {
      if (scenario === 'node-http') return reply({ node: { id: 'safe-node', lineId: 'test-line' } }, 403)
      if (scenario === 'node-envelope') return reply({ node: { id: 'safe-node', lineId: 'test-line' } }, 200, 1)
      if (scenario === 'node-malformed') return reply({ node: { id: 'safe-node' } })
      return reply({ node: { id: 'safe-node', lineId: scenario === 'protected-node' ? protectedId : 'test-line', driver: 'modbus-tcp', driverConfig: { host: '127.0.0.1' } } })
    }
    if (req.url === '/api/workshop/dcw/safe-node/write') {
      writes++
      return writes % 2 ? reply(null, 400, 'NODE_RANGE_EXCEEDED') : reply({ outcome: { readback: 5 } })
    }
    if (req.url === '/api/workshop/dcw/safe-node/read') return reply({ read: { value: 4 } })
    if (req.url === '/api/workshop/dcw') return reply({ recipes: [{ id: 'recipe', params: [] }] })
    if (req.url === '/api/workshop/channels/channel') return reply({ channel: { lineId: 'test-line' } })
    if (req.url === '/api/workshop/channels/channel/agents') return reply([{ id: '1' }, { id: '2' }])
    return reply(null, 404, 1)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const script = fileURLToPath(new URL('../scripts/onboarding/verify-line.mjs', import.meta.url))
  const cases = [
    ['pass', 0, 0, 'PASS'], ['absent', 0, 0, 'SKIP'],
    ['created', 1, 0, 'FAIL'], ['deleted', 1, 0, 'FAIL'],
    ['removed', 1, 0, 'FAIL'], ['changed', 1, 0, 'FAIL'], ['added', 1, 0, 'FAIL'],
    ['post-envelope', 1, 0, 'FAIL'],
    ['pre-http', 1, 0, 'FAIL'], ['pre-envelope', 1, 0, 'FAIL'], ['pre-shape', 1, 0, 'FAIL'],
    ['pre-capped', 1, 0, 'FAIL'], ['pre-incomplete', 1, 0, 'FAIL'], ['empty', 1, 0, 'FAIL'],
    ['protected-line', 1, 0], ['protected-node', 1, 0], ['node-http', 1, 0],
    ['node-envelope', 1, 0], ['node-malformed', 1, 0], ['unproven', 1, 0],
  ]
  for (const [name, expectedCode, expectedWrites, status] of cases) {
    scenario = name
    journalReads = 0
    writes = 0
    requests = []
    const child = spawn(process.execPath, [script, '--stdin'], {
      env: { ...process.env, AW_BASE: `http://127.0.0.1:${server.address().port}`, AW_TOKEN: 'test', AW_ONBOARD_ATTESTATION: bundlePath },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const readOnly = ['pass', 'absent', 'created', 'deleted', 'removed', 'changed', 'added', 'post-envelope'].includes(name)
    child.stdin.end(JSON.stringify({
      lineId: name === 'protected-line' ? protectedId : 'test-line', recipeId: 'recipe', channelId: 'channel', daq: [],
      dcw: readOnly ? [] : [{ id: 'safe-node', name: 'safe', min: 0, max: 10, stepLimit: 1, probeValue: 5 }],
    }))
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    assert.equal(code, expectedCode, `${name}: ${output}`)
    assert.equal(writes, expectedWrites, `${name}: ${requests.join(', ')}`)
    assert.ok(requests.every(request => request.startsWith('GET ')), `${name}: ${requests.join(', ')}`)
    if (status) assert.match(output, new RegExp(`V6 受保护线保留 journal 完整性 — ${status}`), name)
    if (name === 'unproven') assert.match(output, /无法证明驱动实现及其端点属于本次隔离模拟器/)
    assert.doesNotMatch(output, /零扰动/, name)
  }
})
