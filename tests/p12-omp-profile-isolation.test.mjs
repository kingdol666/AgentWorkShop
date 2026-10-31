import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { effectiveOmpCommand, ompProfileName, pathEntryExists } from '../bench/PIPELINE/run-agentteam.mjs'

test('P12 OMP profile names are deterministic and distinct by run and role', () => {
  const roles = ['lead', 'worker-a', 'worker-b']
  const firstRun = roles.map(role => ompProfileName('p12-omp-check-20261029', role))
  const repeatedRun = roles.map(role => ompProfileName('p12-omp-check-20261029', role))
  const secondRun = roles.map(role => ompProfileName('p12-omp-check-20261030', role))

  assert.deepEqual(firstRun, repeatedRun)
  assert.equal(new Set(firstRun).size, roles.length)
  assert.equal(new Set(secondRun).size, roles.length)
  assert.ok(firstRun.every((profile, index) => profile !== secondRun[index]))
})

test('OMP command defaults consistently and honors an explicit executable', () => {
  assert.equal(effectiveOmpCommand(undefined), 'omp')
  assert.equal(effectiveOmpCommand('  omp-custom  '), 'omp-custom')
})

test('P12 MCP config entry check sees regular files and dangling symlinks', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'p12-omp-profile-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'mcp.json')
  const danglingLink = join(dir, 'dangling-mcp.json')
  writeFileSync(file, '{}\n')

  assert.equal(pathEntryExists(file), true)
  assert.equal(pathEntryExists(join(dir, 'missing.json')), false)
  try {
    symlinkSync(join(dir, 'absent-target.json'), danglingLink, 'file')
  }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error?.code)) {
      t.skip('filesystem does not permit creating a dangling symlink in this environment')
      return
    }
    throw error
  }
  assert.equal(pathEntryExists(danglingLink), true)
})
