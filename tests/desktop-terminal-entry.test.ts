import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAppUrl } from '../desktop/sidecar.mjs'

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
