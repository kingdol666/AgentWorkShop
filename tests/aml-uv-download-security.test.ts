import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import https from 'node:https'
import { join } from 'node:path'
import { test } from 'node:test'
import { installUv, validateAmlIndex } from '../server/services/workshop/aml/python-runtime'
import type { AmlRuntime } from '../server/services/workshop/aml/runtime'

function runtimeFor(root: string): AmlRuntime {
  return { root, toolsDir: join(root, 'tools'), runtimeDir: join(root, 'runtime') } as AmlRuntime
}

test('only approved HTTPS index URLs with all-public lookups can be passed to a provisioner', async (t) => {
  const oldAllowlist = process.env.AML_PYTHON_INDEX_ALLOWLIST
  t.after(() => {
    if (oldAllowlist === undefined) delete process.env.AML_PYTHON_INDEX_ALLOWLIST
    else process.env.AML_PYTHON_INDEX_ALLOWLIST = oldAllowlist
  })
  const lookup = t.mock.method(dns, 'lookup', async (host: string) => host === 'bad.example'
    ? [{ address: '192.168.1.1', family: 4 }]
    : [{ address: '1.1.1.1', family: 4 }])
  const mirror = 'https://mirror.example/pypi/simple/'
  const privateMirror = 'https://bad.example/pypi/simple/'
  const unsafe = ['http://mirror.example/simple/', 'https://user:password@mirror.example/simple/', 'https://mirror.example/simple/?token=example', 'https://mirror.example:8443/simple/']
  process.env.AML_PYTHON_INDEX_ALLOWLIST = [mirror, privateMirror, ...unsafe].join(',')

  for (const raw of [...unsafe, 'https://unlisted.example/simple/', 'https://mirror.example/other/']) {
    await assert.rejects(validateAmlIndex(raw), { code: 'AML_PYTHON_INDEX_DENIED' })
  }
  assert.equal(lookup.mock.callCount(), 0)
  await assert.rejects(validateAmlIndex(privateMirror), { code: 'PUBLIC_URL_IP_DENIED' })
  assert.equal(await validateAmlIndex(''), 'https://pypi.org/simple/')
  assert.equal(await validateAmlIndex(mirror), mirror)
})

test('invalid official uv bytes are rejected before staging or extraction', async (t) => {
  if (!['win32', 'darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
    t.skip('uv manifest does not support this platform')
    return
  }
  const sizes: Record<string, number> = {
    'uv-aarch64-apple-darwin.tar.gz': 22496145,
    'uv-aarch64-pc-windows-msvc.zip': 23766948,
    'uv-aarch64-unknown-linux-gnu.tar.gz': 24438519,
    'uv-aarch64-unknown-linux-musl.tar.gz': 24292339,
    'uv-x86_64-apple-darwin.tar.gz': 24120839,
    'uv-x86_64-pc-windows-msvc.zip': 25534683,
    'uv-x86_64-unknown-linux-gnu.tar.gz': 26200011,
    'uv-x86_64-unknown-linux-musl.tar.gz': 26396567,
  }
  t.mock.method(dns, 'lookup', async () => [{ address: '1.1.1.1', family: 4 }])
  const request = t.mock.method(https, 'request', (url: URL, _options: https.RequestOptions, respond: (res: EventEmitter) => void) => {
    assert.equal(url.origin, 'https://github.com')
    assert.match(url.pathname, /^\/astral-sh\/uv\/releases\/download\/0\.11\.29\/uv-/)
    const size = sizes[url.pathname.split('/').pop() ?? '']
    assert.ok(size)
    const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-length': size }, complete: true })
    return Object.assign(new EventEmitter(), {
      end: () => queueMicrotask(() => {
        respond(res)
        res.emit('data', Buffer.alloc(size)) // correct length, wrong SHA-256
        res.emit('end')
      }),
    })
  })
  const root = mkdtempSync(join(process.cwd(), '.aml-uv-security-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const rt = runtimeFor(root)
  const result = await installUv(rt)
  assert.equal(request.mock.callCount(), 1)
  assert.equal(result.ok, false)
  assert.match(result.log, /SHA-256/)
  assert.equal(existsSync(rt.toolsDir), false)
  assert.equal(existsSync(rt.runtimeDir), false)
})
