import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, lstatSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const collector = join(root, 'bench/tools/collect-paper-evidence.mjs')
const run = (args, cwd) => spawnSync(process.execPath, [collector, ...args], {
  cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true,
})

for (const qualifier of [
  { schema: 'agent-sandbox-preflight/v2', status: 'READY_FOR_SANDBOX_PILOT', scope: 'PRECHECK_ONLY_NOT_PAPER_EVIDENCE', checks: [] },
  { verdict: 'QUALIFIED', checks: [] },
]) {
  test(`preflight ${qualifier.status ?? qualifier.verdict} cannot pass paper evidence collection`, t => {
    const temp = mkdtempSync(join(tmpdir(), 'aw-paper-evidence-collector-'))
    t.after(() => rmSync(temp, { recursive: true, force: true }))
    const input = join(temp, 'preflight')
    const output = join(temp, 'bundle')
    mkdirSync(input)
    writeFileSync(join(input, 'qualify.json'), `${JSON.stringify(qualifier)}\n`)

    const result = run(['--runs', input, '--out', output], root)

    assert.equal(result.status, 1, result.stderr)
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))
    assert.equal(manifest.runs[0].kind, 'agent-preflight')
    assert.equal(manifest.allPass, false)
    assert.equal(manifest.containsPreflight, true)
    assert.equal(manifest.paperEvidenceQualification, 'NOT_ASSESSED')
    assert.match(readFileSync(join(output, 'report.md'), 'utf8'), /论文证据资格: \*\*NOT_ASSESSED\*\*/)
  })
}

test('publishes a complete bundle and keeps evidence qualification unassessed', t => {
  const temp = mkdtempSync(join(tmpdir(), 'aw-paper-evidence-complete-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const input = join(temp, 'passing-run')
  const output = join(temp, 'bundle')
  mkdirSync(input)
  writeFileSync(join(input, 'run.json'), '{"pass":true}\n')
  writeFileSync(join(input, 'result.csv'), 'a,b\n1,2\n')

  const result = run(['--runs', input, '--out', output], root)
  assert.equal(result.status, 0, result.stderr)
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))
  assert.equal(manifest.allPass, true)
  assert.equal(manifest.paperEvidenceQualification, 'NOT_ASSESSED')
  const sums = readFileSync(join(output, 'SHA256SUMS.txt'), 'utf8')
  assert.match(sums, /result\.csv\s+\(passing-run\)/)
  assert.match(readFileSync(join(output, 'report.md'), 'utf8'), /论文证据资格: \*\*NOT_ASSESSED\*\*/)
})

for (const pass of ['false', 1]) {
  test(`malformed pass=${JSON.stringify(pass)} is UNKNOWN and cannot pass collection`, t => {
    const temp = mkdtempSync(join(tmpdir(), 'aw-paper-evidence-malformed-pass-'))
    t.after(() => rmSync(temp, { recursive: true, force: true }))
    const input = join(temp, 'run')
    const output = join(temp, 'bundle')
    mkdirSync(input)
    writeFileSync(join(input, 'run.json'), `${JSON.stringify({ pass, verdict: 'PASS' })}\n`)

    const result = run(['--runs', input, '--out', output], root)
    assert.equal(result.status, 1, result.stderr)
    const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))
    assert.equal(manifest.runs[0].verdict, 'UNKNOWN')
    assert.equal(manifest.allPass, false)
  })
}

test('valid boolean false is a failed run', t => {
  const temp = mkdtempSync(join(tmpdir(), 'aw-paper-evidence-false-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const input = join(temp, 'run')
  const output = join(temp, 'bundle')
  mkdirSync(input)
  writeFileSync(join(input, 'run.json'), '{"pass":false,"verdict":"PASS"}\n')

  const result = run(['--runs', input, '--out', output], root)
  assert.equal(result.status, 1, result.stderr)
  const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))
  assert.equal(manifest.runs[0].verdict, 'FAIL')
  assert.equal(manifest.allPass, false)
})

test('requires an output path and does not write into the working directory', t => {
  const temp = mkdtempSync(join(tmpdir(), 'aw-paper-evidence-no-out-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const input = join(temp, 'run')
  mkdirSync(input)
  writeFileSync(join(input, 'run.json'), '{}\n')

  const result = run(['--runs', input], temp)
  assert.equal(result.status, 1)
  assert.throws(() => lstatSync(join(temp, 'manifest.json')), { code: 'ENOENT' })
})

test('rejects output paths that exist or overlap an input run', t => {
  const temp = mkdtempSync(join(tmpdir(), 'aw-paper-evidence-paths-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const input = join(temp, 'run')
  mkdirSync(input)
  writeFileSync(join(input, 'run.json'), '{}\n')

  const existing = join(temp, 'existing')
  mkdirSync(existing)
  const sentinel = join(existing, 'keep.txt')
  writeFileSync(sentinel, 'preserve')
  const existingResult = run(['--runs', input, '--out', existing], root)
  assert.equal(existingResult.status, 1)
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve')

  // Exercise the atomic final reservation with an empty directory: POSIX
  // rename can replace an empty destination, but mkdir must reject it.
  const emptyExisting = join(temp, 'empty-existing')
  mkdirSync(emptyExisting)
  const collisionResult = run(['--runs', input, '--out', emptyExisting], root)
  assert.equal(collisionResult.status, 1)
  assert.deepEqual(readdirSync(emptyExisting), [])

  const overlapping = join(input, 'nested-output')
  const overlapResult = run(['--runs', input, '--out', overlapping], root)
  assert.equal(overlapResult.status, 1)
  assert.throws(() => lstatSync(overlapping), { code: 'ENOENT' })
})

test('rejects distinct run folders with the same basename', t => {
  const temp = mkdtempSync(join(tmpdir(), 'aw-paper-evidence-duplicate-names-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const first = join(temp, 'first', 'run')
  const second = join(temp, 'second', 'run')
  const output = join(temp, 'bundle')
  mkdirSync(first, { recursive: true })
  mkdirSync(second, { recursive: true })
  writeFileSync(join(first, 'run.json'), '{}\n')
  writeFileSync(join(second, 'run.json'), '{}\n')

  const result = run(['--runs', `${first},${second}`, '--out', output], root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unique names/)
  assert.throws(() => lstatSync(output), { code: 'ENOENT' })
})

test('rejects malformed input manifests before publishing any output', t => {
  const temp = mkdtempSync(join(tmpdir(), 'aw-paper-evidence-invalid-json-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const input = join(temp, 'run')
  const output = join(temp, 'bundle')
  mkdirSync(input)
  writeFileSync(join(input, 'qualify.json'), '{broken json\n')
  writeFileSync(join(input, 'run.json'), '{"pass":true}\n')

  const result = run(['--runs', input, '--out', output], root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /invalid qualify\.json/)
  assert.throws(() => lstatSync(output), { code: 'ENOENT' })
})

test('rejects symlinked evidence entries instead of sealing a partial checksum list', t => {
  const temp = mkdtempSync(join(tmpdir(), 'aw-paper-evidence-symlink-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const input = join(temp, 'run')
  const external = join(temp, 'outside.txt')
  const output = join(temp, 'bundle')
  mkdirSync(input)
  writeFileSync(join(input, 'run.json'), '{}\n')
  writeFileSync(external, 'outside evidence')
  try { symlinkSync(external, join(input, 'linked.txt'), 'file') }
  catch (error) { return t.skip(`symlink creation unavailable: ${error.code ?? error.message}`) }

  const result = run(['--runs', input, '--out', output], root)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /symlink rejected/)
  assert.throws(() => lstatSync(output), { code: 'ENOENT' })
})
