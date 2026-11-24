import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  assertPublicHost,
  checkForUpdate,
  compareVersions,
  discardUpdate,
  downloadUpdate,
  inspectUpdate,
  isPublicAddress,
  normalizeVersion,
  parseRelease,
  parseSums,
  probeUpdateConnection,
  validateUpdateUrl,
  verifyDownloadedUpdate,
} from '../desktop/update.mjs'
import { createSystemUpdateTransport, manualProxyRules, pinnedFetch } from '../desktop/update-network.mjs'

const publicLookup = async () => [{ address: '140.82.112.3', family: 4 }]
const installerName = 'AgentWorkShop-Setup-9.9.9-win-x64.exe'
const installerBytes = Buffer.from('fake-installer-payload')
const installerSha = createHash('sha256').update(installerBytes).digest('hex')

function releaseFixture(overrides = {}) {
  return {
    tag_name: 'v9.9.9',
    html_url: 'https://github.com/kingdol666/AgentWorkShop/releases/tag/v9.9.9',
    body: 'Desktop chrome and update channel.',
    assets: [
      {
        name: installerName,
        url: 'https://api.github.com/repos/kingdol666/AgentWorkShop/releases/assets/102',
        browser_download_url: `https://github.com/kingdol666/AgentWorkShop/releases/download/v9.9.9/${installerName}`,
        size: installerBytes.length,
      },
      {
        name: 'SHA256SUMS.txt',
        url: 'https://api.github.com/repos/kingdol666/AgentWorkShop/releases/assets/101',
        browser_download_url: 'https://github.com/kingdol666/AgentWorkShop/releases/download/v9.9.9/SHA256SUMS.txt',
        size: 200,
      },
    ],
    ...overrides,
  }
}

test('version parsing and ordering', () => {
  assert.deepEqual(compareVersions('0.17.0', '0.16.9'), 1)
  assert.deepEqual(compareVersions('v0.16.0', '0.16.0'), 0)
  assert.deepEqual(compareVersions('0.16.0-beta.1', '0.16.0'), 0)
  assert.equal(normalizeVersion('v0.17.0'), '0.17.0')
  assert.throws(() => normalizeVersion('latest'))
})

test('manual proxy rules are fixed, credential-free and bounded', () => {
  assert.equal(manualProxyRules({ protocol: 'http', host: '127.0.0.1', port: 7890 }), 'http://127.0.0.1:7890')
  assert.equal(manualProxyRules({ protocol: 'https', host: 'proxy.example', port: 443 }), 'https://proxy.example:443')
  assert.equal(manualProxyRules({ protocol: 'socks5', host: '::1', port: 1080 }), 'socks5://[::1]:1080')
  for (const bad of [
    { protocol: 'http', host: 'user:pass@proxy.example', port: 8080 },
    { protocol: 'http', host: 'proxy.example/path', port: 8080 },
    { protocol: 'ftp', host: 'proxy.example', port: 8080 },
    { protocol: 'http', host: 'proxy.example', port: 0 },
  ]) assert.throws(() => manualProxyRules(bad), /invalid manual proxy/)
})

test('update URLs are HTTPS, allowlisted and credential-free', () => {
  assert.equal(validateUpdateUrl('https://api.github.com/repos/a/b/releases/latest').hostname, 'api.github.com')
  for (const bad of [
    'http://api.github.com/repos/a/b/releases/latest',
    'https://user:pass@api.github.com/x',
    'https://api.github.com:8443/x',
    'https://evil.example.com/x',
    'file:///tmp/x',
  ]) {
    assert.throws(() => validateUpdateUrl(bad), /update (URL|host)/, bad)
  }
  assert.throws(() => validateUpdateUrl('https://api.github.com/x?y=1', { allowQuery: false }), /query/)
})

test('private and reserved addresses are rejected', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '::1', 'fe80::1', 'fd00::1']) {
    assert.equal(isPublicAddress(ip), false, ip)
  }
  assert.equal(isPublicAddress('140.82.112.3'), true)
  assert.equal(isPublicAddress('2606:50c0:8000::153'), true)
  await assert.rejects(assertPublicHost('api.github.com', async () => [{ address: '127.0.0.1' }]), /non-public/)
})

test('release assets select the exact installer and checksum file', () => {
  const release = parseRelease(releaseFixture())
  assert.equal(release.version, '9.9.9')
  assert.equal(release.installer.name, installerName)
  assert.equal(release.sums.name, 'SHA256SUMS.txt')
  assert.match(release.installer.url, /\/releases\/assets\/102$/)
  assert.match(release.sums.url, /\/releases\/assets\/101$/)
  assert.throws(() => parseRelease(releaseFixture({ assets: [] })), /missing/)
})

test('SHA256SUMS parsing requires the exact filename', () => {
  const text = `${installerSha}  ${installerName}\n${'a'.repeat(64)}  other.exe\n`
  assert.equal(parseSums(text, installerName), installerSha)
  assert.equal(parseSums(text, 'other.exe'), 'a'.repeat(64))
  assert.equal(parseSums(text, 'missing.exe'), null)
})

test('checkForUpdate compares the release against the running version', async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /^https:\/\/api\.github\.com\/repos\/kingdol666\/AgentWorkShop\/releases\/latest$/)
    return Response.json(releaseFixture())
  }
  const newer = await checkForUpdate({ currentVersion: '0.16.0', fetchImpl, lookupImpl: publicLookup })
  assert.equal(newer.status, 'available')
  assert.equal(newer.release.version, '9.9.9')
  const same = await checkForUpdate({ currentVersion: '9.9.9', fetchImpl, lookupImpl: publicLookup })
  assert.equal(same.status, 'current')
})

test('downloadUpdate verifies SHA-256 and streams progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-update-test-'))
  try {
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/101')) {
        return new Response(`${installerSha}  ${installerName}\n`, { status: 200 })
      }
      return new Response(installerBytes, {
        status: 200,
        headers: { 'content-length': String(installerBytes.length) },
      })
    }
    const release = parseRelease(releaseFixture())
    let progress = 0
    const result = await downloadUpdate(release, {
      dir,
      fetchImpl,
      lookupImpl: publicLookup,
      onProgress: (received) => { progress = received },
    })
    assert.equal(result.sha256, installerSha)
    assert.equal(progress, installerBytes.length)
    assert.deepEqual(readFileSync(result.path), installerBytes)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('downloadUpdate deletes a hash-mismatched installer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-update-test-'))
  try {
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/101')) {
        return new Response(`${'0'.repeat(64)}  ${installerName}\n`, { status: 200 })
      }
      return new Response(installerBytes, { status: 200 })
    }
    const release = parseRelease(releaseFixture())
    await assert.rejects(downloadUpdate(release, { dir, fetchImpl, lookupImpl: publicLookup }), /SHA-256 mismatch/)
    assert.equal(existsSync(join(dir, installerName)), false)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('release metadata rejects wrong-version and cross-repository assets', () => {
  const fixture = releaseFixture()
  fixture.assets[0]!.name = 'AgentWorkShop-Setup-9.9.8-win-x64.exe'
  assert.throws(() => parseRelease(fixture), /exact installer/)
  fixture.assets[0]!.name = installerName
  fixture.assets[0]!.url = 'https://api.github.com/repos/other/project/releases/assets/102'
  assert.throws(() => parseRelease(fixture), /outside the release repository/)
  for (const ip of ['999.0.0.1', '::ffff:7f00:1', '2001:db8::1', 'fe90::1', 'ff00::1', '64:ff9b::7f00:1']) {
    assert.equal(isPublicAddress(ip), false, ip)
  }
})

const sumsResponse = () => new Response(`${installerSha}  ${installerName}\n`)
const CDNA = 'https://release-assets.githubusercontent.com/example/sums?signature=private'

function fixtureOptions(dir: string) {
  return { dir, lookupImpl: publicLookup }
}

test('connection probe validates redirects and reads only metadata and checksums', async () => {
  const calls: string[] = []
  const result = await probeUpdateConnection({
    lookupImpl: publicLookup,
    fetchImpl: async (url: string) => {
      calls.push(url)
      if (url.endsWith('/latest')) return Response.json(releaseFixture())
      if (url.endsWith('/101')) return Response.redirect(CDNA, 302)
      assert.equal(url, CDNA)
      return sumsResponse()
    },
  })
  assert.equal(calls.length, 3)
  assert.equal(result.releaseVersion, '9.9.9')
  assert.doesNotMatch(JSON.stringify(result), /signature|githubusercontent/)
  await assert.rejects(probeUpdateConnection({
    lookupImpl: publicLookup,
    fetchImpl: async (url: string) => {
      if (url.endsWith('/latest')) return Response.json(releaseFixture())
      assert.ok(url.endsWith('/101'))
      return Response.redirect('https://api.github.com/repos/other/project/releases/assets/101', 302)
    },
  }), /outside the release repository/)
  await assert.rejects(probeUpdateConnection({
    lookupImpl: async (host: string) => host === 'api.github.com'
      ? publicLookup()
      : [
          ...await publicLookup(), { address: '10.0.0.2', family: 4 },
        ],
    fetchImpl: async (url: string) => {
      if (url.endsWith('/latest')) return Response.json(releaseFixture())
      assert.ok(url.endsWith('/101'))
      return Response.redirect(CDNA, 302)
    },
  }), /non-public address/)
})

test('pause preserves written bytes; invalid range restarts; cache is independently verified', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-update-resume-'))
  const release = parseRelease(releaseFixture())
  const prefix = 5
  const etag = '"update-1"'
  const total = installerBytes.length
  for (const invalidRange of [false, true]) {
    const controller = new AbortController()
    let cancelled = false
    const common = fixtureOptions(dir)
    try {
      await assert.rejects(downloadUpdate(release, {
        ...common,
        signal: controller.signal,
        fetchImpl: async (url: string) => url.endsWith('/101')
          ? sumsResponse()
          : new Response(new ReadableStream({
              start(stream) { stream.enqueue(installerBytes.subarray(0, prefix)) },
              cancel() { cancelled = true },
            }), { headers: { etag } }),
        onProgress: () => controller.abort(),
      }), { name: 'AbortError' })
      assert.equal(cancelled, true)
      const paused = await inspectUpdate(release, common)
      assert.equal(paused.status, 'paused')
      assert.equal(paused.received, prefix)
      const ranges: (string | null)[] = []
      let restarted = false
      let verifying = false
      const fetchImpl = async (url: string, init?: RequestInit) => {
        if (url.endsWith('/101')) return sumsResponse()
        const headers = new Headers(init?.headers)
        const range = headers.get('range')
        ranges.push(range)
        if (range) {
          assert.equal(headers.get('if-range'), etag)
          return new Response(installerBytes.subarray(prefix), {
            status: 206,
            headers: { etag, 'content-range': `bytes ${prefix}-${total - (invalidRange ? 2 : 1)}/${total}` },
          })
        }
        return new Response(installerBytes, { headers: { etag } })
      }
      const downloaded = await downloadUpdate(release, {
        ...common,
        fetchImpl,
        onProgress: (_received: number, _total: number, detail: { restarted?: boolean }) => { restarted ||= Boolean(detail.restarted) },
        onVerify: () => {
          assert.equal(existsSync(join(dir, installerName)), false)
          verifying = true
        },
      })
      assert.deepEqual(ranges, invalidRange ? [`bytes=${prefix}-`, null] : [`bytes=${prefix}-`])
      assert.equal(restarted, invalidRange)
      assert.equal(verifying, true)
      assert.equal((await inspectUpdate(release, { ...common, fetchImpl })).status, 'ready')
      assert.equal((await verifyDownloadedUpdate(release, downloaded)).sha256, installerSha)
      const tampered = Buffer.alloc(total, 1)
      writeFileSync(downloaded.path, tampered)
      const statePath = `${downloaded.path}.update-state.json`
      const metadata = JSON.parse(readFileSync(statePath, 'utf8'))
      metadata.digest = createHash('sha256').update(tampered).digest('hex')
      writeFileSync(statePath, JSON.stringify(metadata))
      assert.equal((await inspectUpdate(release, { ...common, fetchImpl })).status, 'none')
      await assert.rejects(verifyDownloadedUpdate(release, downloaded), /SHA-256 mismatch/)
      const unrelated = join(dir, 'leave-me.txt')
      writeFileSync(unrelated, 'untouched')
      await discardUpdate(release, { dir })
      assert.equal(existsSync(downloaded.path), false)
      assert.equal(existsSync(unrelated), true)
    }
    finally {
      if (invalidRange) rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('idle timeout closes the stalled stream and retries without a weak validator', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-update-idle-'))
  const release = parseRelease(releaseFixture())
  let attempts = 0
  let cancelled = false
  try {
    const result = await downloadUpdate(release, {
      ...fixtureOptions(dir), idleTimeoutMs: 15,
      fetchImpl: async (url: string, init?: RequestInit) => {
        if (url.endsWith('/101')) return sumsResponse()
        assert.equal(new Headers(init?.headers).has('range'), false)
        if (++attempts > 1) return new Response(installerBytes)
        return new Response(new ReadableStream({
          start(stream) { stream.enqueue(installerBytes.subarray(0, 2)) },
          cancel() { cancelled = true },
        }), { headers: { etag: 'W/"weak"' } })
      },
    })
    assert.equal(attempts, 2)
    assert.equal(cancelled, true)
    assert.equal(result.sha256, installerSha)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

class MockNetRequest extends EventEmitter {
  aborted = false
  headers = new Headers()
  constructor(private deliver: (request: MockNetRequest) => void) { super() }
  abort() { this.aborted = true }
  setHeader(name: string, value: string) { this.headers.set(name, value) }
  end() { this.deliver(this) }
}

function incoming(statusCode: number) {
  return Object.assign(new PassThrough(), { statusCode, headers: {} })
}

test('system transport does not follow redirects or forward browser credentials', async () => {
  const isolated = {}
  const request = new MockNetRequest(req => req.emit('redirect', 302, 'GET', CDNA))
  const { fetchImpl } = createSystemUpdateTransport({
    session: isolated,
    net: { request: (options: Record<string, unknown>) => {
      assert.equal(options.session, isolated)
      assert.equal(options.redirect, 'manual')
      assert.equal(options.useSessionCookies, false)
      return request
    } },
  })
  const result = await fetchImpl('https://api.github.com/example', {
    headers: { Cookie: 'private', Authorization: 'private', Accept: '*/*' },
  })
  assert.equal(result.status, 302)
  assert.equal(result.headers.get('location'), CDNA)
  assert.deepEqual([...request.headers.keys()], ['accept'])
  assert.equal(request.aborted, true)
})

test('system transport abort wakes a blocked response and preserves proxy auth diagnostics', async () => {
  const response = incoming(200)
  const request = new MockNetRequest(req => req.emit('response', response))
  const { fetchImpl } = createSystemUpdateTransport({ session: {}, net: { request: () => request } })
  const controller = new AbortController()
  const result = await fetchImpl('https://api.github.com/example', { signal: controller.signal })
  const waiting = result.body!.getReader().read()
  controller.abort()
  await assert.rejects(waiting, { name: 'AbortError' })
  assert.equal(request.aborted, true)
  const auth = new MockNetRequest(req => req.emit('login', { isProxy: true }, () => {}))
  const transport = createSystemUpdateTransport({ session: {}, net: { request: () => auth } })
  await assert.rejects(transport.fetchImpl('https://api.github.com/example'), { code: 'ERR_PROXY_AUTH_REQUESTED' })
  const noBody = new MockNetRequest(req => req.emit('response', incoming(304).end()))
  const notModified = createSystemUpdateTransport({ session: {}, net: { request: () => noBody } })
  assert.equal((await notModified.fetchImpl('https://api.github.com/example')).body, null)
})

test('pinned direct transport preserves hostname and TLS while using only the preflight IP', async () => {
  const rawUrl = 'https://api.github.com/repos/kingdol666/AgentWorkShop/releases/latest'
  const result = await pinnedFetch(rawUrl, {
    addresses: await publicLookup(),
    httpsRequestImpl: (url: URL, options: {
      servername: string
      agent: boolean
      rejectUnauthorized: boolean
      lookup: (hostname: string, options: { all: boolean }, callback: (err: unknown, answers: unknown) => void) => void
    }, finish: (res: unknown) => void) => {
      assert.equal(url.href, rawUrl)
      assert.equal(options.servername, url.hostname)
      assert.equal(options.rejectUnauthorized, true)
      assert.equal(options.agent, false)
      options.lookup(url.hostname, { all: true }, (err: unknown, answers: unknown) => {
        assert.equal(err, null)
        assert.deepEqual(answers, [{ address: '140.82.112.3', family: 4 }])
      })
      return new MockNetRequest(() => finish(incoming(200).end('ok')))
    },
  })
  assert.equal(await result.text(), 'ok')
})

test('GitHub rate limiting is surfaced without retrying the exhausted route', async () => {
  let calls = 0
  await assert.rejects(checkForUpdate({
    currentVersion: '0.19.0',
    lookupImpl: publicLookup,
    fetchImpl: async () => {
      calls++
      return new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
    },
  }), { code: 'UPDATE_RATE_LIMITED' })
  assert.equal(calls, 1)
})
