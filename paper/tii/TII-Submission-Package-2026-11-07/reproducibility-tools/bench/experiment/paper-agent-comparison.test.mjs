import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { freeze, makeSchedule, summarize } from './paper-agent-comparison.mjs'

const hash = 'a'.repeat(64)
const script = fileURLToPath(new URL('./paper-agent-comparison.mjs', import.meta.url))
const plan = () => ({
  schema: 'paper-agent-comparison-plan/v1',
  scenes: [{ id: 'injection', task_sha256: hash, configuration_sha256: hash, oracle_sha256: hash }],
  seeds: [42, 43], harnesses: [{ id: 'omp', revision: '1.0' }, { id: 'opencode', revision: '2.0' }],
  models: [{ provider: 'local', id: 'qwen', revision: 'frozen-1' }, { provider: 'ustc', id: 'deepseek', revision: 'frozen-2' }],
  prompt_sha256: hash, permissions_sha256: hash, runner_sha256: hash, platform_build_sha256: hash, simulator_build_sha256: hash,
  budget_ms: 120000, max_tool_calls: 20, horizon_ms: 60000, sample_interval_ms: 1000, order_seed: 'before-outcomes',
})
function setup(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'paper-agent-comparison-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const root = join(tmp, 'study')
  return { tmp, root, registration: freeze(plan(), root) }
}
function episode(reg, scheduled, status) {
  const p = reg.plan, scene = p.scenes.find(item => item.id === scheduled.scene)
  return { run_id: reg.run_id, episode_id: scheduled.episode_id, scene: scheduled.scene, seed: scheduled.seed,
    harness: scheduled.harness, harness_revision: scheduled.harness_revision, model: scheduled.model, status,
    task_sha256: scene.task_sha256, configuration_sha256: scene.configuration_sha256, oracle_sha256: scene.oracle_sha256,
    prompt_sha256: p.prompt_sha256, permissions_sha256: p.permissions_sha256, runner_sha256: p.runner_sha256,
    platform_build_sha256: p.platform_build_sha256, simulator_build_sha256: p.simulator_build_sha256,
    budget_ms: p.budget_ms, max_tool_calls: p.max_tool_calls, horizon_ms: p.horizon_ms, sample_interval_ms: p.sample_interval_ms }
}
function writeEpisode(root, record, traces = true) {
  const dir = join(root, 'episodes', record.episode_id)
  mkdirSync(dir)
  writeFileSync(join(dir, 'episode.json'), JSON.stringify(record))
  if (traces) for (const name of ['task', 'harness', 'model', 'tool', 'approval', 'driver', 'readback', 'daq']) writeFileSync(join(dir, `${name}.jsonl`), JSON.stringify({ event_type: `${name}-event` }) + '\n')
  return dir
}

test('schedule freezes every Harness/model combination per scene and seed in deterministic order', t => {
  const p = plan(), a = makeSchedule(p), b = makeSchedule(p)
  assert.deepEqual(a, b)
  assert.equal(a.length, 8)
  for (const seed of p.seeds) {
    const cases = a.filter(item => item.seed === seed)
    assert.equal(new Set(cases.map(item => `${item.harness}/${item.model.provider}/${item.model.id}`)).size, 4)
  }
  const { root, registration } = setup(t)
  assert.deepEqual(registration.schedule, a)
  assert.throws(() => freeze(p, root), /EEXIST/)
  const bad = plan(); bad.harnesses[1].id = 'omp'
  assert.throws(() => makeSchedule(bad), /exactly omp and opencode/)
  const unsafe = plan(); unsafe.prompt = 'raw prompt or credential'
  assert.throws(() => makeSchedule(unsafe), /unexpected fields/)
})

test('inventory preserves missing, failed, timeout, cancelled, zero-write and mismatched episodes', t => {
  const { root, registration: reg } = setup(t)
  const statuses = ['completed', 'failed', 'timeout', 'cancelled', 'zero_write', 'invalid']
  statuses.forEach((status, i) => {
    const record = episode(reg, reg.schedule[i], status)
    if (i === 1) record.permissions_sha256 = 'b'.repeat(64)
    const dir = writeEpisode(root, record, i !== 4)
    if (i === 2) writeFileSync(join(dir, 'tool.jsonl'), '{broken\n')
  })
  writeEpisode(root, episode(reg, reg.schedule[6], 'failed'))
  const report = summarize(root)
  assert.equal(report.status, 'NOT_QUALIFIED')
  assert.equal(report.acquisition, 'NOT_IMPLEMENTED')
  assert.equal(report.episodes.length, reg.schedule.length)
  assert.deepEqual(report.episodes.slice(0, 6).map(item => item.declared_status), statuses)
  assert.equal(report.episodes[0].record_state, 'PRESENT_UNVERIFIED')
  assert.equal(report.episodes[0].qualification, 'NOT_QUALIFIED')
  assert.equal(report.episodes[1].record_state, 'INVALID')
  assert.ok(report.episodes[1].issues.some(item => item.includes('permissions_sha256')))
  assert.equal(report.episodes[2].traces.tool.state, 'INVALID')
  assert.equal(report.episodes[4].traces.driver.state, 'MISSING')
  assert.equal(report.episodes[6].declared_status, 'failed')
  assert.equal(report.episodes[7].record_state, 'NOT_RUN')
  assert.equal(report.status_denominator, 8)
  assert.deepEqual(report.declared_status_counts, { NOT_RUN: 1, COMPLETED: 1, FAILED: 1, TIMEOUT: 1, CANCELLED: 1, ZERO_WRITE: 1, INVALID: 2 })
  assert.equal(Object.values(report.declared_status_counts).reduce((sum, count) => sum + count, 0), report.status_denominator)
  assert.match(report.status_count_note, /COMPLETED is unverified/)
})

test('untrusted, non-object episode records and trace symlinks cannot qualify', t => {
  const { tmp, root, registration: reg } = setup(t)
  const dir = writeEpisode(root, episode(reg, reg.schedule[0], 'completed'))
  writeFileSync(join(dir, 'episode.json'), 'null\n')
  assert.equal(summarize(root).episodes[0].record_state, 'INVALID')
  writeFileSync(join(dir, 'episode.json'), JSON.stringify(episode(reg, reg.schedule[0], 'completed')))
  const external = join(tmp, 'external.jsonl'); writeFileSync(external, '{}\n')
  const path = join(dir, 'driver.jsonl'); rmSync(path)
  try { symlinkSync(external, path, 'file') } catch (error) { if (error.code === 'EPERM') { t.skip('symlink creation requires Windows developer mode'); return } throw error }
  const result = summarize(root).episodes[0]
  assert.equal(result.traces.driver.state, 'INVALID')
  assert.equal(result.qualification, 'NOT_QUALIFIED')
  const rootLink = join(tmp, 'linked-study')
  try { symlinkSync(root, rootLink, 'dir') } catch (error) { if (error.code === 'EPERM') { t.skip('directory symlinks require Windows developer mode'); return } throw error }
  assert.throws(() => summarize(`${rootLink}${sep}`), /registration root.*symlink/)
})

test('tampered registration fails; acquire and in-tree inventory cannot create output', t => {
  const { tmp, root } = setup(t)
  const reportDir = join(tmp, 'report')
  const inventory = spawnSync(process.execPath, [script, 'inventory', '--registration', root, '--out', reportDir], { encoding: 'utf8' })
  assert.equal(inventory.status, 1)
  const reportPath = join(reportDir, 'inventory.json')
  const original = readFileSync(reportPath, 'utf8')
  assert.equal(JSON.parse(original).status, 'NOT_QUALIFIED')
  const repeat = spawnSync(process.execPath, [script, 'inventory', '--registration', root, '--out', reportDir], { encoding: 'utf8' })
  assert.notEqual(repeat.status, 0)
  assert.equal(readFileSync(reportPath, 'utf8'), original)
  const nested = join(root, 'report')
  const nestedRun = spawnSync(process.execPath, [script, 'inventory', '--registration', root, '--out', nested], { encoding: 'utf8' })
  assert.notEqual(nestedRun.status, 0)
  assert.match(nestedRun.stderr, /outside the registration directory/)
  assert.equal(existsSync(nested), false)
  const acquireOut = join(tmp, 'acquire')
  const acquire = spawnSync(process.execPath, [script, 'acquire', '--out', acquireOut], { encoding: 'utf8' })
  assert.notEqual(acquire.status, 0)
  assert.match(acquire.stderr, /NOT_IMPLEMENTED.*NOT_QUALIFIED/)
  assert.equal(existsSync(acquireOut), false)
  const path = join(root, 'registration.json')
  writeFileSync(path, readFileSync(path, 'utf8') + ' ')
  assert.throws(() => summarize(root), /digest mismatch/)
})
