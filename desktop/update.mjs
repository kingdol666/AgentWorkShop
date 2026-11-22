// Desktop update channel: GitHub Releases only, fixed host allowlist, SHA-256 verified.
// No Electron import here so the pure logic can be unit-tested in Node.
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { lookup as dnsLookup } from 'node:dns/promises'
import { once } from 'node:events'
import { join, win32 } from 'node:path'

export const UPDATE_REPO = 'kingdol666/AgentWorkShop'
export const UPDATE_HOSTS = Object.freeze([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])
const MAX_JSON_BYTES = 1_000_000
const MAX_SUMS_BYTES = 64 * 1024
const MAX_INSTALLER_BYTES = 1_200 * 1024 * 1024
const MAX_REDIRECTS = 6

/** Parse 1.2.3 (an optional v prefix and prerelease suffix are ignored for ordering). */
export function parseVersion(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i.exec(String(raw ?? '').trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) throw new Error('invalid version')
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

export function normalizeVersion(raw) {
  const m = /^v?(\d+\.\d+\.\d+)(?:[-+].*)?$/i.exec(String(raw ?? '').trim())
  if (!m) throw new Error(`unsupported release tag: ${raw}`)
  return m[1]
}

/** Reject non-HTTPS, credentials, non-443 ports and hosts outside the release allowlist. */
export function validateUpdateUrl(raw, { allowQuery = true } = {}) {
  const url = new URL(String(raw))
  if (url.protocol !== 'https:') throw new Error('update URL must use HTTPS')
  if (url.username || url.password) throw new Error('update URL must not carry credentials')
  if (url.port && url.port !== '443') throw new Error('update URL must use port 443')
  if (!UPDATE_HOSTS.includes(url.hostname.toLowerCase())) throw new Error(`update host not allowed: ${url.hostname}`)
  if (!allowQuery && url.search) throw new Error('update URL must not carry a query')
  return url
}

function ipv4Parts(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  return m ? m.slice(1).map(Number) : null
}

/** Public IPv4/IPv6 only. Mirrors the server-side egress policy. */
export function isPublicAddress(ip) {
  const address = String(ip).toLowerCase()
  const v4 = ipv4Parts(address)
  if (v4) {
    const [a, b, c] = v4
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
    if (a === 198 && (b === 18 || b === 19)) return false
    if (a === 198 && b === 51 && c === 100) return false
    if (a === 203 && b === 0 && c === 113) return false
    if (a >= 224) return false
    return true
  }
  if (address === '::' || address === '::1') return false
  if (address.startsWith('fe80:') || address.startsWith('fe80::')) return false
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return false
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address)
  if (mapped) return isPublicAddress(mapped[1])
  return address.includes(':')
}

/** All DNS answers must be public before a request leaves the process. */
export async function assertPublicHost(hostname, lookupImpl = dnsLookup) {
  const answers = await lookupImpl(hostname, { all: true, verbatim: true })
  if (!Array.isArray(answers) || answers.length === 0) throw new Error(`update host did not resolve: ${hostname}`)
  for (const answer of answers) {
    if (!isPublicAddress(answer.address)) throw new Error(`update host resolved to a non-public address: ${hostname}`)
  }
}

async function request(rawUrl, { fetchImpl = fetch, timeoutMs, headers = {}, lookupImpl } = {}) {
  let url = validateUpdateUrl(rawUrl)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url.hostname, lookupImpl)
    const res = await fetchImpl(url.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'AgentWorkShop-updater', ...headers },
    })
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location')
      if (!location) throw new Error(`update redirect without location (${res.status})`)
      url = validateUpdateUrl(new URL(location, url).toString())
      continue
    }
    return res
  }
  throw new Error('too many update redirects')
}

/** Pick the exact installer and SHA256SUMS.txt assets from a GitHub latest-release payload. */
export function parseRelease(json, { repo = UPDATE_REPO } = {}) {
  const version = normalizeVersion(json?.tag_name)
  const assets = Array.isArray(json?.assets) ? json.assets : []
  const exact = `AgentWorkShop-Setup-${version}-win-x64.exe`
  const installer = assets.find(a => a.name === exact)
    ?? assets.find(a => /^AgentWorkShop-Setup-.+-win-x64\.exe$/.test(a.name ?? ''))
  const sums = assets.find(a => a.name === 'SHA256SUMS.txt')
    ?? assets.find(a => /sha256sums.*\.txt$/i.test(a.name ?? ''))
  if (!installer || !sums) throw new Error('release is missing the installer or SHA256SUMS.txt')
  const htmlUrl = typeof json.html_url === 'string' ? validateUpdateUrl(json.html_url, { allowQuery: false }).toString() : `https://github.com/${repo}/releases`
  // Prefer the API asset endpoint: `browser_download_url` starts on github.com,
  // which is blocked in some restricted networks while api.github.com works.
  const assetUrl = asset => (typeof asset.url === 'string' && asset.url) || asset.browser_download_url
  return {
    version,
    tag: String(json.tag_name),
    notes: String(json.body ?? '').trim().slice(0, 2_000),
    htmlUrl,
    installer: { name: String(installer.name), url: String(assetUrl(installer)), size: Number(installer.size) || 0 },
    sums: { name: String(sums.name), url: String(assetUrl(sums)), size: Number(sums.size) || 0 },
  }
}

export function parseSums(text, name) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (m && m[2].trim() === name) return m[1].toLowerCase()
  }
  return null
}

async function readText(res, maxBytes) {
  if (!res.ok) throw new Error(`update request failed: HTTP ${res.status}`)
  const length = Number(res.headers.get('content-length') ?? 0)
  if (length > maxBytes) throw new Error('update response exceeded the size limit')
  const text = await res.text()
  if (Buffer.byteLength(text) > maxBytes) throw new Error('update response exceeded the size limit')
  return text
}

export async function checkForUpdate({ currentVersion, repo = UPDATE_REPO, fetchImpl = fetch, timeoutMs = 20_000, lookupImpl } = {}) {
  if (!parseVersion(currentVersion)) throw new Error('invalid current version')
  const api = `https://api.github.com/repos/${repo}/releases/latest`
  const res = await request(api, { fetchImpl, timeoutMs, headers: { accept: 'application/vnd.github+json' }, lookupImpl })
  if (res.status === 404) return { status: 'current', currentVersion, release: null }
  const json = JSON.parse(await readText(res, MAX_JSON_BYTES))
  const release = parseRelease(json, { repo })
  return {
    status: compareVersions(release.version, currentVersion) > 0 ? 'available' : 'current',
    currentVersion,
    release,
  }
}

async function download(rawUrl, dest, { fetchImpl = fetch, timeoutMs, maxBytes, onProgress, lookupImpl, headers }) {
  const res = await request(rawUrl, { fetchImpl, timeoutMs, lookupImpl, headers })
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0) || maxBytes
  if (total > maxBytes) throw new Error('download exceeded the size limit')
  const hash = createHash('sha256')
  const file = createWriteStream(dest, { flags: 'wx' })
  let received = 0
  try {
    for await (const chunk of res.body) {
      received += chunk.length
      if (received > maxBytes) throw new Error('download exceeded the size limit')
      hash.update(chunk)
      if (!file.write(chunk)) await once(file, 'drain')
      onProgress?.(received, total)
    }
    await new Promise((resolve, reject) => file.end(err => err ? reject(err) : resolve()))
  }
  catch (err) {
    file.destroy()
    await unlink(dest).catch(() => {})
    throw err
  }
  return { bytes: received, sha256: hash.digest('hex') }
}

/** Download the installer next to its SHA256SUMS.txt, verify the exact filename, and return the path.
 *  A full installer is ~500 MB; the request budget must cover the whole body at slow links. */
export async function downloadUpdate(release, { dir, fetchImpl = fetch, timeoutMs = 30 * 60_000, onProgress, lookupImpl } = {}) {
  if (!dir) throw new Error('download directory is required')
  const assetHeaders = { accept: 'application/octet-stream' }
  const sumsRes = await request(release.sums.url, { fetchImpl, timeoutMs, lookupImpl, headers: assetHeaders })
  const sumsText = await readText(sumsRes, MAX_SUMS_BYTES)
  const expected = parseSums(sumsText, release.installer.name)
  if (!expected) throw new Error('SHA256SUMS.txt does not list the installer')
  const dest = join(dir, release.installer.name)
  const { sha256, bytes } = await download(release.installer.url, dest, {
    fetchImpl,
    timeoutMs,
    maxBytes: MAX_INSTALLER_BYTES,
    onProgress,
    lookupImpl,
    headers: assetHeaders,
  })
  if (sha256 !== expected) {
    await unlink(dest).catch(() => {})
    throw new Error('installer SHA-256 mismatch')
  }
  return { path: dest, sha256, bytes }
}

// The installer must run after this process exits (its files are locked while we
// live), so a detached console-free WSH helper waits, installs silently, then
// restarts the app. Paths travel through the environment: cmd.exe mangles Node's
// \" quoting, and Windows PowerShell exits immediately when spawned with
// DETACHED_PROCESS (verified on Windows 11). wscript.exe needs no console.
export const INSTALL_HELPER_SCRIPT = [
  'Set sh = CreateObject("WScript.Shell")',
  'Set env = sh.Environment("PROCESS")',
  'WScript.Sleep 6000',
  'sh.Run """" & env("AW_UPDATE_INSTALLER") & """ /S", 0, True',
  'sh.Run """" & env("AW_UPDATE_EXE") & """", 1, False',
  '',
].join('\r\n')

/** Fixed helper invocation for the silent install + relaunch step. */
export function buildInstallHelper({ installer, executable, scriptPath, env = process.env } = {}) {
  if (typeof installer !== 'string' || !installer) throw new Error('installer path is required')
  if (typeof executable !== 'string' || !executable) throw new Error('executable path is required')
  if (typeof scriptPath !== 'string' || !scriptPath) throw new Error('helper script path is required')
  const root = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
  return {
    // Windows executable path: keep win32 separators even when tests run on another OS.
    file: win32.join(root, 'System32', 'wscript.exe'),
    args: ['//B', '//NoLogo', scriptPath],
    env: { ...env, AW_UPDATE_INSTALLER: installer, AW_UPDATE_EXE: executable },
  }
}
