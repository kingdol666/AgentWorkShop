// GitHub-only desktop update protocol. Electron is injected through a transport seam.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { pinnedFetch, transportError } from './update-network.mjs'

export const UPDATE_REPO = 'kingdol666/AgentWorkShop'
export const UPDATE_HOSTS = Object.freeze([
  'api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
])
const MAX_INSTALLER = 1_200 * 1024 * 1024
const MAX_JSON = 1_000_000
const MAX_SUMS = 64 * 1024
const MAX_ATTEMPTS = 4
const MAX_REDIRECTS = 6
const ASSET_HEADERS = { 'accept': 'application/octet-stream', 'accept-encoding': 'identity' }
const redirects = new Set([301, 302, 303, 307, 308])
const digestPattern = /^[a-f0-9]{64}$/
const strongETag = /^"[\x21\x23-\x7e]{1,512}"$/
const cachePattern = /^AgentWorkShop-Setup-\d+\.\d+\.\d+-win-x64\.exe(?:\.part|\.update-state\.json(?:\.[a-f0-9-]{36}\.tmp)?)?$/
const busy = new Set()

export function parseVersion(raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i.exec(String(raw ?? '').trim())
  const parts = match?.slice(1).map(Number)
  return parts?.every(Number.isSafeInteger) ? parts : null
}

export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) throw new Error('invalid version')
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1
  }
  return 0
}

export function normalizeVersion(raw) {
  const parts = parseVersion(raw)
  if (!parts) throw new Error('unsupported release tag')
  return parts.join('.')
}

export function validateUpdateUrl(raw, { allowQuery = true } = {}) {
  let url
  try {
    url = new URL(String(raw))
  }
  catch {
    throw new Error('invalid update URL')
  }
  if (url.protocol !== 'https:') throw new Error('update URL must use HTTPS')
  if (url.username || url.password) throw new Error('update URL must not carry credentials')
  if (url.port && url.port !== '443') throw new Error('update URL must use port 443')
  if (!UPDATE_HOSTS.includes(url.hostname)) throw new Error('update host not allowed')
  if (!allowQuery && url.search) throw new Error('update URL must not carry a query')
  if (url.hash) throw new Error('update URL must not carry a fragment')
  return url
}

const reserved = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) reserved.addSubnet(address, prefix)
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  reserved.addSubnet(address, prefix, 'ipv6')
}
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')

export function isPublicAddress(ip) {
  if (typeof ip !== 'string' || ip.includes('%')) return false
  const family = isIP(ip)
  if (family === 4) return !reserved.check(ip)
  return family === 6 && globalV6.check(ip, 'ipv6') && !reserved.check(ip, 'ipv6')
}

export async function assertPublicHost(hostname, lookupImpl = dnsLookup) {
  const answers = await lookupImpl(hostname, { all: true, verbatim: true })
  if (!Array.isArray(answers) || answers.length === 0) throw new Error('update host did not resolve')
  if (answers.some(answer => !isPublicAddress(answer?.address))) throw new Error('update host resolved to a non-public address')
  return answers
}

function checkedRepo(repo) {
  if (typeof repo !== 'string' || !/^[a-z\d_-]+\/[a-z\d_.-]+$/i.test(repo) || /\/\.{1,2}$/.test(repo)) {
    throw new Error('invalid update repository')
  }
  return repo
}

function apiPath(repo) {
  return `/repos/${checkedRepo(repo)}/releases/`
}

function assetUrl(raw, repo, name, tag) {
  const url = validateUpdateUrl(raw, { allowQuery: false })
  const prefix = `${apiPath(repo)}assets/`
  if (url.hostname === 'api.github.com' && url.pathname.toLowerCase().startsWith(prefix.toLowerCase())
    && /^[1-9]\d*$/.test(url.pathname.slice(prefix.length))) return url
  const path = `/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
  if (url.hostname === 'github.com' && url.pathname === path) return url
  throw new Error('update asset is outside the release repository')
}

export function parseRelease(json, { repo = UPDATE_REPO } = {}) {
  checkedRepo(repo)
  const tag = String(json?.tag_name ?? '')
  if (!/^v?\d+\.\d+\.\d+(?:[-+][a-z\d.+-]+)?$/i.test(tag)) throw new Error('unsupported release tag')
  const version = normalizeVersion(tag)
  const exact = `AgentWorkShop-Setup-${version}-win-x64.exe`
  const assets = Array.isArray(json.assets) ? json.assets : []
  const select = (name, limit) => {
    const matches = assets.filter(asset => asset?.name === name)
    if (matches.length !== 1) throw new Error('release is missing the exact installer or SHA256SUMS.txt')
    const asset = matches[0]
    const size = asset.size ?? 0
    if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new Error('invalid release asset size')
    return { name, url: assetUrl(asset.url || asset.browser_download_url, repo, name, tag).href, size }
  }
  const releasePage = `https://github.com/${repo}/releases`
  const supplied = json.html_url ? validateUpdateUrl(json.html_url, { allowQuery: false }).href : releasePage
  if (supplied !== releasePage && supplied !== `${releasePage}/tag/${tag}` && supplied !== `${releasePage}/tag/${encodeURIComponent(tag)}`) {
    throw new Error('update release page is outside the repository')
  }
  return {
    repo, version, tag, notes: String(json.body ?? '').trim().slice(0, 2_000), htmlUrl: supplied,
    installer: select(exact, MAX_INSTALLER), sums: select('SHA256SUMS.txt', MAX_SUMS),
  }
}

export function parseSums(text, name) {
  const digests = new Set()
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (match?.[2].trim() === name) digests.add(match[1].toLowerCase())
  }
  return digests.size === 1 ? digests.values().next().value : null
}

function timeoutError() {
  return new DOMException('update connection timed out', 'TimeoutError')
}

function deadline(parent, ms) {
  const timer = AbortSignal.timeout(ms)
  return parent ? AbortSignal.any([parent, timer]) : timer
}

async function abortable(task, signal) {
  signal.throwIfAborted()
  let onAbort
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })])
  }
  finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function retryable(error) {
  return error?.retryable || error?.name === 'TimeoutError' || /^(?:EAI_AGAIN|ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|UPDATE_NETWORK|ERR_(?:CONNECTION_(?:RESET|CLOSED|TIMED_OUT|ABORTED)|NETWORK_CHANGED|INTERNET_DISCONNECTED|TIMED_OUT|EMPTY_RESPONSE|CONTENT_LENGTH_MISMATCH|HTTP2_PROTOCOL_ERROR))$/.test(error?.code ?? '')
}

async function retry(run, signal, maxAttempts = MAX_ATTEMPTS) {
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted()
    try {
      return await run()
    }
    catch (error) {
      signal.throwIfAborted()
      if (attempt >= maxAttempts || !retryable(error)) throw error
      await wait(250 * 2 ** (attempt - 1), undefined, { signal })
    }
  }
}

function httpError(status, { asset = false } = {}) {
  return Object.assign(new Error(status === 407 ? 'update proxy authentication failed' : `update request failed: HTTP ${status}`), {
    code: `HTTP_${status}`,
    retryable: status === 408 || status === 429 || status >= 500 || (asset && [401, 403, 404].includes(status)),
  })
}

function closeBody(res) {
  void res?.body?.cancel().catch(() => {})
}

async function request(initial, options, { headers, validateHop }) {
  let url = initial
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    options.signal.throwIfAborted()
    const local = new AbortController()
    const signal = AbortSignal.any([options.signal, local.signal])
    const timer = setTimeout(() => local.abort(timeoutError()), options.connectTimeoutMs ?? 15_000)
    let res
    try {
      validateHop(url)
      // Electron chooses the system proxy route. This is only local DNS preflight
      // there, not a claim that an external proxy resolves the same answers.
      const addresses = await abortable(assertPublicHost(url.hostname, options.lookupImpl), signal)
      try {
        res = await abortable((options.fetchImpl ?? pinnedFetch)(url.href, {
          method: 'GET', redirect: 'manual', signal, addresses,
          headers: { 'user-agent': 'AgentWorkShop-updater', ...headers },
        }), signal)
      }
      catch (error) {
        throw transportError(error)
      }
    }
    finally {
      clearTimeout(timer)
    }
    if (!redirects.has(res.status)) return { res, signal, local, cdn: !['github.com', 'api.github.com'].includes(url.hostname) }
    const target = res.headers.get('location')
    closeBody(res)
    if (!target || hop === MAX_REDIRECTS) throw new Error('invalid or excessive update redirects')
    try {
      url = validateUpdateUrl(new URL(target, url))
    }
    catch {
      throw new Error('unsafe update redirect: update URL or host is not allowed')
    }
  }
}

async function* chunks({ res, signal, local }, idleTimeoutMs = 30_000) {
  if (!res.body) throw new Error('update response had no body')
  const reader = res.body.getReader()
  let done = false
  try {
    while (!done) {
      const timer = setTimeout(() => local.abort(timeoutError()), idleTimeoutMs)
      let item
      try {
        item = await abortable(reader.read(), signal)
      }
      catch (error) {
        throw transportError(error)
      }
      finally {
        clearTimeout(timer)
      }
      done = item.done
      if (!done) yield item.value
    }
  }
  finally {
    if (!done) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function lengthHeader(res) {
  const raw = res.headers.get('content-length')
  if (raw === null) return null
  const length = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(length)) throw new Error('invalid update content length')
  return length
}

async function readText(response, maxBytes, idleTimeoutMs) {
  const { res } = response
  try {
    if (res.status !== 200) throw httpError(res.status, { asset: response.cdn })
    if (lengthHeader(res) > maxBytes) throw new Error('update response exceeded the size limit')
    const buffers = []
    let bytes = 0
    for await (const chunk of chunks(response, idleTimeoutMs)) {
      bytes += chunk.length
      if (bytes > maxBytes) throw new Error('update response exceeded the size limit')
      buffers.push(chunk)
    }
    return Buffer.concat(buffers, bytes).toString('utf8')
  }
  finally {
    closeBody(res)
  }
}

async function latest(repo, options) {
  const url = new URL(`https://api.github.com${apiPath(repo)}latest`)
  return retry(async () => {
    const response = await request(url, options, {
      headers: { 'accept': 'application/vnd.github+json', 'accept-encoding': 'identity' },
      validateHop(hop) {
        if (hop.href !== url.href) throw new Error('update metadata redirect is outside the release repository')
      },
    })
    if (response.res.status === 404) {
      closeBody(response.res)
      return null
    }
    if (response.res.status === 429 || (response.res.status === 403 && response.res.headers.get('x-ratelimit-remaining') === '0')) {
      closeBody(response.res)
      throw Object.assign(new Error('GitHub update API rate limit reached'), { code: 'UPDATE_RATE_LIMITED' })
    }
    return parseRelease(JSON.parse(await readText(response, MAX_JSON, options.idleTimeoutMs)), { repo })
  }, options.signal)
}

export async function checkForUpdate({ currentVersion, repo = UPDATE_REPO, timeoutMs = 20_000, signal, ...options } = {}) {
  if (!parseVersion(currentVersion)) throw new Error('invalid current version')
  const release = await latest(repo, { ...options, signal: deadline(signal, timeoutMs) })
  return { status: release && compareVersions(release.version, currentVersion) > 0 ? 'available' : 'current', currentVersion, release }
}

function requestAsset(release, asset, options, headers) {
  const repo = release.repo ?? UPDATE_REPO
  const tag = release.tag ?? `v${release.version}`
  let cdnHop = false
  return request(assetUrl(asset.url, repo, asset.name, tag), options, {
    headers: { ...ASSET_HEADERS, ...headers },
    validateHop(url) {
      if (url.hostname === 'github.com' || url.hostname === 'api.github.com') {
        if (cdnHop) throw new Error('update asset redirected back from the CDN')
        assetUrl(url, repo, asset.name, tag)
        return
      }
      if (url.hostname !== 'release-assets.githubusercontent.com' || cdnHop || url.pathname === '/') {
        throw new Error('update asset CDN redirect is not bound to the release asset')
      }
      cdnHop = true
    },
  })
}

async function expectedDigest(release, options) {
  return retry(async () => {
    const response = await requestAsset(release, release.sums, options)
    const digest = parseSums(await readText(response, MAX_SUMS, options.idleTimeoutMs), release.installer.name)
    if (!digest) throw new Error('SHA256SUMS.txt does not list a unique digest for the exact installer')
    return digest
  }, options.signal)
}

export async function probeUpdateConnection({ repo = UPDATE_REPO, route = 'direct', signal, timeoutMs = 20_000, ...options } = {}) {
  const start = performance.now()
  const network = { ...options, signal: deadline(signal, timeoutMs) }
  const release = await latest(repo, network)
  if (!release) throw new Error('no update release found')
  // Exercise the real asset/CDN route with a small, separately bounded file.
  await expectedDigest(release, network)
  return { status: 'ok', route, elapsedMs: Math.round(performance.now() - start), releaseVersion: release.version }
}

function cachePaths(release, dir) {
  const version = normalizeVersion(release?.version)
  const name = `AgentWorkShop-Setup-${version}-win-x64.exe`
  if (release.installer?.name !== name || release.sums?.name !== 'SHA256SUMS.txt') throw new Error('invalid release filenames')
  if (!dir) throw new Error('download directory is required')
  const final = join(resolve(dir), name)
  return { name, final, part: `${final}.part`, state: `${final}.update-state.json` }
}

function fingerprint(release) {
  return createHash('sha256').update(JSON.stringify([release.version, release.repo ?? UPDATE_REPO,
    release.installer.url, release.installer.size, release.sums.url])).digest('hex')
}

async function cacheDirectoryExists(path) {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error('invalid update cache directory')
    return true
  }
  catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function fileInfo(path) {
  const info = await lstat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (info && !info.isFile()) throw new Error('invalid update cache file')
  return info
}

async function remove(path) {
  await unlink(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
}

async function readState(release, paths) {
  const info = await fileInfo(paths.state)
  if (!info || info.size > 4096) return null
  const file = await open(paths.state, 'r')
  try {
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await file.read(buffer)
    const state = JSON.parse(buffer.toString('utf8', 0, bytesRead))
    if (state?.id !== fingerprint(release) || !digestPattern.test(state.digest)) return null
    if (!Number.isSafeInteger(state.total) || state.total < 0 || state.total > MAX_INSTALLER) return null
    return state
  }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return null
  }
  finally {
    await file.close()
  }
}

async function writeState(release, paths, state) {
  const temp = `${paths.state}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify({ ...state, id: fingerprint(release) }), { flag: 'wx', mode: 0o600 })
    await rename(temp, paths.state)
  }
  finally {
    await remove(temp)
  }
}

async function pruneCache(paths) {
  for (const entry of await readdir(dirname(paths.final), { withFileTypes: true })) {
    if (!entry.isFile() || !cachePattern.test(entry.name)) continue
    if ([paths.name, `${paths.name}.part`, `${paths.name}.update-state.json`].includes(entry.name)) continue
    await remove(join(dirname(paths.final), entry.name))
  }
}

async function hashFile(path, signal) {
  const before = await fileInfo(path)
  if (!before || before.size === 0 || before.size > MAX_INSTALLER) throw new Error('invalid installer size')
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path, { signal })) {
    bytes += chunk.length
    if (bytes > MAX_INSTALLER) throw new Error('installer exceeded the size limit')
    hash.update(chunk)
  }
  const after = await fileInfo(path)
  if (!after || before.size !== bytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new Error('installer changed during verification')
  }
  return { path, bytes, sha256: hash.digest('hex') }
}

function installerMatches(release, result, expected) {
  return result.sha256 === expected && (!release.installer.size || result.bytes === release.installer.size)
}

const none = () => ({ status: 'none', received: 0, total: 0, path: null, sha256: null, bytes: 0 })

export async function inspectUpdate(release, { dir, signal, timeoutMs = 20_000, ...options } = {}) {
  signal?.throwIfAborted()
  const paths = cachePaths(release, dir)
  if (!(await cacheDirectoryExists(dirname(paths.final)))) return none()
  const state = await readState(release, paths)
  const final = await fileInfo(paths.final)
  if (state?.status === 'ready' && final && final.size === state.total) {
    // The local sidecar is a cache hint, not the source of trust after restart.
    const network = { ...options, signal: deadline(signal, timeoutMs) }
    const expected = await expectedDigest(release, network)
    const result = await hashFile(paths.final, network.signal)
    if (installerMatches(release, result, expected)) {
      return { ...result, status: 'ready', received: result.bytes, total: result.bytes }
    }
  }
  if (state?.status === 'partial' && strongETag.test(state.etag ?? '')) {
    const part = await fileInfo(paths.part)
    if (part?.size > 0 && part.size <= (state.total || MAX_INSTALLER)) {
      return { ...none(), status: 'paused', received: part.size, bytes: part.size, total: state.total, path: paths.part }
    }
  }
  return none()
}

export async function verifyDownloadedUpdate(release, installer, { signal } = {}) {
  const path = installer?.path
  if (!path || !digestPattern.test(installer.sha256)) throw new Error('verified installer path and checksum are required')
  if (resolve(path) !== cachePaths(release, dirname(path)).final) throw new Error('invalid verified installer path')
  const result = await hashFile(path, signal)
  if (!installerMatches(release, result, installer.sha256) || (installer.bytes != null && installer.bytes !== result.bytes)) {
    throw new Error('installer SHA-256 mismatch')
  }
  return result
}

export async function discardUpdate(release, { dir } = {}) {
  const paths = cachePaths(release, dir)
  if (busy.has(dirname(paths.final))) throw new Error('update download is busy')
  if (!(await cacheDirectoryExists(dirname(paths.final)))) return none()
  await Promise.all([remove(paths.state), remove(paths.part), remove(paths.final)])
  return none()
}

function rangeMatches(res, offset, state, published, etag, length) {
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.slice(1).map(Number)
  if (!range || !range.every(Number.isSafeInteger)) return false
  const [start, end, total] = range
  return etag === state.etag && start === offset && start < total && end === total - 1
    && total <= MAX_INSTALLER && (!state.total || state.total === total)
    && (!published || published === total) && (length === null || length === total - start)
    ? total
    : false
}

async function transfer(release, paths, digest, options) {
  const state = await readState(release, paths)
  const part = await fileInfo(paths.part)
  const published = release.installer.size || 0
  const canResume = part?.size > 0 && part.size <= (state?.total || MAX_INSTALLER)
    && state?.status === 'partial' && state.digest === digest && strongETag.test(state.etag ?? '')
  let offset = canResume ? part.size : 0
  let restarted = Boolean(part?.size && !offset)
  if (!offset && part) await remove(paths.part)
  const load = () => requestAsset(release, release.installer, options, offset
    ? { 'range': `bytes=${offset}-`, 'if-range': state.etag }
    : {})
  let response = await load()
  try {
    let { res } = response
    let etag = res.headers.get('etag')
    let length = lengthHeader(res)
    let total
    if (offset) {
      const valid = res.status === 206 && rangeMatches(res, offset, state, published, etag, length)
        && (await fileInfo(paths.part))?.size === offset
      if (valid) total = Number(res.headers.get('content-range').split('/')[1])
      else if ([200, 206, 416].includes(res.status)) {
        await remove(paths.part)
        restarted = true
        offset = 0
        if (res.status !== 200) {
          closeBody(res)
          response = await load()
          res = response.res
          etag = res.headers.get('etag')
          length = lengthHeader(res)
        }
      }
      else throw httpError(res.status, { asset: response.cdn })
    }
    if (!offset) {
      if (res.status !== 200) throw httpError(res.status, { asset: response.cdn })
      if (published && length !== null && length !== published) throw new Error('installer size does not match the published release')
      total = published || length || 0
    }
    if (total > MAX_INSTALLER) throw new Error('download exceeded the size limit')
    if (res.headers.get('content-encoding') && res.headers.get('content-encoding') !== 'identity') {
      throw new Error('update asset used unsupported content encoding')
    }
    await writeState(release, paths, { status: 'partial', digest, total, etag: strongETag.test(etag ?? '') ? etag : null })
    if (restarted) options.onProgress?.(0, total, { restarted: true })
    const file = await open(paths.part, offset ? 'r+' : 'wx', 0o600)
    let received = offset
    try {
      if ((await file.stat()).size !== offset) throw new Error('partial installer changed during download')
      for await (const chunk of chunks(response, options.idleTimeoutMs)) {
        options.signal.throwIfAborted()
        if (received + chunk.length > (total || MAX_INSTALLER)) throw new Error('download exceeded the size limit')
        for (let written = 0; written < chunk.length;) {
          const { bytesWritten } = await file.write(chunk, written, chunk.length - written, received)
          if (!bytesWritten) throw new Error('could not write installer data')
          written += bytesWritten
          received += bytesWritten
        }
        options.onProgress?.(received, total, { resumed: offset > 0 })
      }
      if (received === 0 || (total && received !== total)) {
        throw Object.assign(new Error('installer download ended early'), { retryable: true })
      }
      await file.sync()
    }
    finally {
      await file.close()
    }
  }
  finally {
    closeBody(response.res)
  }
}

export async function downloadUpdate(release, { dir, signal, timeoutMs = 12 * 60 * 60_000, onVerify, ...options } = {}) {
  const paths = cachePaths(release, dir)
  const root = dirname(paths.final)
  if (busy.has(root)) throw new Error('update download is busy')
  busy.add(root)
  const budget = deadline(signal, timeoutMs)
  const network = { ...options, signal: budget }
  try {
    budget.throwIfAborted()
    await mkdir(root, { recursive: true, mode: 0o700 })
    if (!(await lstat(root)).isDirectory()) throw new Error('invalid update cache directory')
    await pruneCache(paths)
    const digest = await expectedDigest(release, network)
    if (await fileInfo(paths.final)) {
      await onVerify?.()
      const result = await hashFile(paths.final, budget)
      if (installerMatches(release, result, digest)) {
        await writeState(release, paths, { status: 'ready', digest, total: result.bytes })
        return result
      }
      await remove(paths.final)
    }
    await retry(() => transfer(release, paths, digest, network), budget)
    await onVerify?.()
    const result = await hashFile(paths.part, budget)
    if (!installerMatches(release, result, digest)) {
      await remove(paths.part)
      await remove(paths.state)
      throw new Error('installer SHA-256 mismatch')
    }
    budget.throwIfAborted()
    await rename(paths.part, paths.final)
    await writeState(release, paths, { status: 'ready', digest, total: result.bytes })
    return { ...result, path: paths.final }
  }
  finally {
    busy.delete(root)
  }
}
