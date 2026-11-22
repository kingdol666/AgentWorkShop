import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  assertPublicHost,
  buildInstallHelper,
  checkForUpdate,
  compareVersions,
  downloadUpdate,
  INSTALL_HELPER_SCRIPT,
  isPublicAddress,
  normalizeVersion,
  parseRelease,
  parseSums,
  validateUpdateUrl,
} from '../desktop/update.mjs'

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

test('install helper passes paths through the environment, not the command line', () => {
  const installer = 'C:\\Temp\\ai build\\AgentWorkShop-Setup-9.9.9-win-x64.exe'
  const executable = 'C:\\Program Files\\AgentWorkShop\\AgentWorkShop.exe'
  const scriptPath = 'C:\\Users\\u\\AppData\\Local\\Temp\\agentworkshop-update-helper.vbs'
  const helper = buildInstallHelper({
    installer,
    executable,
    scriptPath,
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows' },
  })
  assert.equal(helper.file, 'C:\\Windows\\System32\\wscript.exe')
  assert.deepEqual(helper.args, ['//B', '//NoLogo', scriptPath])
  assert.match(INSTALL_HELPER_SCRIPT, /WScript\.Sleep 6000/)
  assert.match(INSTALL_HELPER_SCRIPT, /env\("AW_UPDATE_INSTALLER"\) & """ \/S", 0, True/)
  assert.match(INSTALL_HELPER_SCRIPT, /env\("AW_UPDATE_EXE"\) & """", 1, False/)
  assert.equal(helper.env.AW_UPDATE_INSTALLER, installer)
  assert.equal(helper.env.AW_UPDATE_EXE, executable)
  // Paths must never enter a command string: cmd.exe mangles Node's \" escaping and
  // PowerShell exits immediately when detached, so both would silently never install.
  assert.doesNotMatch(INSTALL_HELPER_SCRIPT, /[A-Za-z]:\\/)
})

test('install helper rejects missing paths', () => {
  const base = { installer: 'C:\\setup.exe', executable: 'C:\\app.exe', scriptPath: 'C:\\h.vbs' }
  assert.throws(() => buildInstallHelper({ ...base, installer: '' }), /installer path/)
  assert.throws(() => buildInstallHelper({ ...base, executable: '' }), /executable path/)
  assert.throws(() => buildInstallHelper({ ...base, scriptPath: '' }), /helper script path/)
})
