import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { isAppUrl } from '../desktop/sidecar.mjs'
import { resolveTuiUrl } from '../tui/lib/discovery.mjs'

const origin = 'http://127.0.0.1:43210'

test('desktop navigation stays on its own HTTP origin', () => {
  assert.equal(isAppUrl(`${origin}/aml?tab=environment`, origin), true)
  for (const url of ['https://127.0.0.1:43210', 'http://127.0.0.1:43211', 'http://localhost:43210', 'file:///tmp/index.html', 'not a URL']) {
    assert.equal(isAppUrl(url, origin), false)
  }
})

test('importing the TUI from another entry with the same basename does not start it', async (t) => {
  t.mock.property(process, 'argv', [process.execPath, 'unrelated/aw-tui.mjs', '--headless'])
  const mod = await import('../tui/aw-tui.mjs')
  assert.equal(typeof mod.main, 'function')
  assert.equal('__tuiSmokeTerminal' in globalThis, false)
})

function discoveryFixture(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), 'aw-tui-discovery-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  mkdirSync(join(cwd, '.AgentWorkShop'))
  const env = { AW_DESKTOP_HOME: cwd }
  const dir = join(cwd, '.runtime')
  mkdirSync(dir)
  const lock = (port: number) => writeFileSync(join(dir, 'aw.lock'), JSON.stringify({
    pid: process.pid, startedAt: 'test-start', mode: 'prod:home', port,
  }))
  return { cwd, env, lock }
}

test('TUI follows the desktop lock instead of a saved port, including while starting', async (t) => {
  const { cwd, env, lock } = discoveryFixture(t)
  // Avoid probing an actual global instance during this test.
  t.mock.method(process, 'kill', () => true)
  const requested: string[] = []
  const probe = t.mock.method(globalThis, 'fetch', async (url: string) => {
    requested.push(url)
    if (requested.length === 1) {
      lock(43212)
      return Response.json({ data: { status: 'ok', workshop: 'not_ready' } })
    }
    return Response.json({ data: { status: 'ok', workshop: 'ready' } })
  })
  lock(43210)
  assert.equal(await resolveTuiUrl({ cwd, env, savedUrl: origin, timeoutMs: 2000 }), 'http://127.0.0.1:43212')
  assert.deepEqual(requested, [`${origin}/api/health`, 'http://127.0.0.1:43212/api/health'])
  assert.equal(await resolveTuiUrl({ cwd, env: { ...env, AW_TUI_URL: origin }, url: 'https://example.test' }), 'https://example.test')
  assert.equal(probe.mock.callCount(), 2)
})

test('TUI does not try an unrelated connection if the selected instance never becomes ready', async (t) => {
  const { cwd, env, lock } = discoveryFixture(t)
  lock(43210)
  t.mock.method(globalThis, 'fetch', async () => Response.json({ data: { status: 'ok', workshop: 'not_ready' } }))
  await assert.rejects(resolveTuiUrl({ cwd, env, savedUrl: 'https://example.test', timeoutMs: 20 }), /尚未就绪/)
})
