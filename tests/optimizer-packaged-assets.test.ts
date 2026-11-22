import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { optimizerPythonDir } from '../server/services/workshop/optimization/worker-client'

function writeWorker(dir: string, files = ['worker.py', 'problems.py', 'probe.py']) {
  mkdirSync(dir, { recursive: true })
  for (const file of files) writeFileSync(join(dir, file), '')
}

test('optimizer resolves installed assets from the package, not the runtime working directory', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'aw-optimizer-assets-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const home = join(temp, 'user home')
  const root = join(temp, 'app resources')
  const payload = join(root, '.output', '.AgentWorkShop', 'optimizer-python')
  writeWorker(join(home, 'server', 'services', 'workshop', 'optimization', 'python'))
  writeWorker(payload)
  t.mock.method(process, 'cwd', () => home)
  const env = { ...process.env, AW_PACKAGE_ROOT: root }
  delete (env as NodeJS.ProcessEnv).AW_OPTIMIZER_PYHOME
  t.mock.property(process, 'env', env)

  assert.equal(optimizerPythonDir(), payload)
  rmSync(join(payload, 'probe.py'))
  assert.throws(optimizerPythonDir, { code: 'OPTIMIZER_PYTHON_ASSETS_MISSING' })
  const override = join(temp, 'external worker')
  writeWorker(override)
  process.env.AW_OPTIMIZER_PYHOME = override
  assert.equal(optimizerPythonDir(), override)
})
