import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import { test, type TestContext } from 'node:test'
import { fetchPublicBuffer, isPublicAddress, validatePublicUrl } from '../server/services/workshop/net/public-egress'

const origins = new Set(['download.example', 'cdn.example'])

type Reply = { statusCode: number, locations?: string[], body?: string, contentLength?: string }

function stubHttps(t: TestContext, replies: Reply[]) {
  const connections: { url: string, address: string, family: number }[] = []
  t.mock.method(https, 'request', (url: URL, options: https.RequestOptions, respond: (res: EventEmitter) => void) => {
    const req = new EventEmitter()
    assert.ok(options.agent instanceof https.Agent)
    assert.notEqual(options.agent, https.globalAgent)
    assert.equal(options.rejectUnauthorized, true)
    assert.equal(options.method, 'GET')
    assert.equal(options.headers, undefined)
    assert.ok(options.lookup)
    options.lookup(url.hostname, {}, (err: unknown, address: string, family: number) => {
      assert.ifError(err)
      connections.push({ url: url.href, address, family })
    })
    const reply = replies.shift()
    assert.ok(reply)
    let destroyed = false
    const res = Object.assign(new EventEmitter(), {
      statusCode: reply.statusCode,
      headersDistinct: { location: reply.locations },
      headers: { 'content-length': reply.contentLength },
      complete: true,
      destroy: () => { destroyed = true },
    })
    return Object.assign(req, {
      end: () => queueMicrotask(() => {
        respond(res)
        if (!destroyed && reply.body) res.emit('data', Buffer.from(reply.body))
        if (!destroyed) res.emit('end')
      }),
    })
  })
  return connections
}

test('classifies IPv4 and native IPv6 conservatively', () => {
  for (const ip of ['1.1.1.1', '140.82.112.3', '2606:4700::1111']) assert.equal(isPublicAddress(ip), true, ip)
  for (const ip of [
    'invalid', '0.0.0.0', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.168.0.1',
    '192.88.99.1', '198.18.0.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '::ffff:8.8.8.8',
    '64:ff9b::a00:1', '100::1', '2001:10::1', '2001:db8::1', '2002::1', '2620:4f:8000::1',
    '3fff:1::1', 'fc00::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff00::1',
  ]) assert.equal(isPublicAddress(ip), false, ip)
})

test('rejects unsafe URL shapes without invoking DNS', async (t) => {
  const lookup = t.mock.method(dns, 'lookup', () => {
    throw new Error('unexpected lookup')
  })
  for (const raw of [
    'http://download.example/', 'https://download.example:8443/', 'https://user:password@download.example/',
    'https://download.example./', 'https://download.example/#fragment', 'https://localhost/',
  ]) await assert.rejects(validatePublicUrl(raw, { allowedHosts: origins }))
  await assert.rejects(validatePublicUrl('https://[::ffff:a00:1]/'), { code: 'PUBLIC_URL_IP_DENIED' })
  assert.equal(lookup.mock.callCount(), 0)
})

test('each hop uses its own validated address, keeping the original HTTPS identity', async (t) => {
  const lookup = t.mock.method(dns, 'lookup', async (host: string) => host === 'download.example'
    ? [{ address: '1.1.1.1', family: 4 }]
    : [{ address: '2606:4700::1111', family: 6 }])
  const connections = stubHttps(t, [
    { statusCode: 302, locations: ['https://cdn.example/asset?signature=opaque'] },
    { statusCode: 200, body: 'asset' },
  ])
  const response = await fetchPublicBuffer('https://download.example/start', { allowedHosts: origins })
  assert.equal(response.toString(), 'asset')
  assert.deepEqual(lookup.mock.calls.map(call => call.arguments[0]), ['download.example', 'cdn.example'])
  assert.deepEqual(connections, [
    { url: 'https://download.example/start', address: '1.1.1.1', family: 4 },
    { url: 'https://cdn.example/asset?signature=opaque', address: '2606:4700::1111', family: 6 },
  ])
})

test('rejects an entire DNS result set with a nonpublic address on a redirect', async (t) => {
  t.mock.method(dns, 'lookup', async (host: string) => host === 'download.example'
    ? [{ address: '1.1.1.1', family: 4 }]
    : [{ address: '1.1.1.1', family: 4 }, { address: '::ffff:a00:1', family: 6 }])
  const connections = stubHttps(t, [{ statusCode: 302, locations: ['https://cdn.example/asset'] }])
  await assert.rejects(fetchPublicBuffer('https://download.example/start', { allowedHosts: origins }), { code: 'PUBLIC_URL_IP_DENIED' })
  assert.equal(connections.length, 1)
})

test('redirects apply scheme, origin and credential checks before DNS', async (t) => {
  const lookup = t.mock.method(dns, 'lookup', async () => [{ address: '1.1.1.1', family: 4 }])
  const connections = stubHttps(t, [
    { statusCode: 302, locations: ['http://cdn.example/asset'] },
    { statusCode: 302, locations: ['https://unlisted.example/asset'] },
    { statusCode: 302, locations: ['https://user:password@cdn.example/asset'] },
    { statusCode: 302, locations: ['https://cdn.example:8443/asset'] },
    { statusCode: 302, locations: ['https://cdn.example/asset', 'https://cdn.example/other'] },
  ])
  for (const code of ['PUBLIC_URL_PROTOCOL_DENIED', 'PUBLIC_URL_HOST_DENIED', 'PUBLIC_URL_CREDENTIALS_DENIED', 'PUBLIC_URL_PROTOCOL_DENIED', 'PUBLIC_REDIRECT_INVALID']) {
    await assert.rejects(fetchPublicBuffer('https://download.example/start', { allowedHosts: origins }), { code })
  }
  assert.equal(connections.length, 5)
  assert.ok(lookup.mock.calls.every(call => call.arguments[0] === 'download.example'))
})

test('caps body bytes on the wire, redirects and time spent resolving DNS', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '1.1.1.1', family: 4 }])
  const connections = stubHttps(t, [
    { statusCode: 200, body: 'too big' },
    { statusCode: 200, contentLength: '7' },
    ...Array.from({ length: 5 }, () => ({ statusCode: 302, locations: ['/more'] })),
  ])
  for (let i = 0; i < 2; i++) {
    await assert.rejects(fetchPublicBuffer('https://download.example/asset', { maxBytes: 3 }), { code: 'PUBLIC_RESPONSE_TOO_LARGE' })
  }
  await assert.rejects(fetchPublicBuffer('https://download.example/start'), { code: 'PUBLIC_REDIRECT_LIMIT' })
  assert.equal(connections.length, 7)
  t.mock.method(dns, 'lookup', () => new Promise(() => {}))
  const controller = new AbortController()
  const pending = fetchPublicBuffer('https://download.example/start', { signal: controller.signal })
  controller.abort()
  await assert.rejects(pending, { code: 'PUBLIC_FETCH_ABORTED' })
  assert.equal(connections.length, 7)
})
