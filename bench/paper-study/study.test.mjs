import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { initialize, seal, verify, makeSchedule } from './study.mjs'

const fakeHash = 'a'.repeat(64)
const iso = n => new Date(n).toISOString()
const sha = b => createHash('sha256').update(b).digest('hex')
const js = x => JSON.stringify(x, null, 2) + '\n'
function plan() {
  return {
    schema: 'paper-study-plan/v1', scenes: [{ id: 'scene', target: 10, tolerance: 1, unit: 'g', configuration_sha256: fakeHash, disturbance_sha256: fakeHash, guards: [{ id: 'temperature', unit: 'C', min: 0, max: 100 }], initial_tolerances: { pressure: 0.1, mass: 0.2 } }],
    seeds: [42, 43], conditions: ['no_write', 'scripted'], order_seed: 'precommitted-order', horizon_ms: 2000, max_end_delay_ms: 100, sample_interval_ms: 1000, sample_jitter_ms: 100, max_sample_gap_ms: 1000,
    endpoint_window_ms: 1000, minimum_endpoint_samples: 2, initial_freshness_ms: 1000, sample_freshness_ms: 1000, sampling_method: 'fixed-1000ms', endpoint_method: 'arithmetic_mean', scripted_write_budget: 1, scripted_policy_sha256: fakeHash,
    provenance: { observation_kind: 'platform-simulator', platform: { commit: 'b'.repeat(40), source_sha256: fakeHash, dirty: false }, simulator: { commit: 'c'.repeat(40), source_sha256: fakeHash, dirty: false }, runner_sha256: fakeHash },
  }
}
function fixture(t, mutate = () => {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'paper-study-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const dir = join(tmp, 'study')
  const r = initialize(plan(), dir)
  let time = Date.parse(r.registered_at_utc) + 10_000
  for (const s of r.schedule) {
    const episodeDir = join(dir, 'episodes', s.episode_id)
    mkdirSync(episodeDir)
    const start = time + 200
    const e = { schema: 'paper-study-episode/v1', run_id: r.run_id, ...s, status: 'completed', started_at_utc: iso(start), ended_at_utc: iso(start + 2001), horizon_ms: 2000, sample_interval_ms: 1000, endpoint_window_ms: 1000, sampling_method: 'fixed-1000ms', endpoint_method: 'arithmetic_mean', scripted_policy_sha256: s.condition === 'scripted' ? fakeHash : null, provenance: r.plan.provenance }
    const reset = { reset_id: `reset-${s.ordinal}`, scene: s.scene, seed: s.seed, status: 'completed', configuration_sha256: fakeHash, disturbance_sha256: fakeHash, snapshot_sha256: fakeHash, performed_at_utc: iso(time) }
    const initial = { source_at_utc: iso(time + 100), observed_at_utc: iso(time + 100), values: { pressure: 50, mass: 10 } }
    const pv = s.condition === 'no_write' ? 10.5 : 7
    const trajectory = [0, 1000, 2000].map(n => ({ t_ms: n, source_at_utc: iso(start + n), observed_at_utc: iso(start + n), pv, guards: { temperature: 20 } }))
    const writes = s.condition === 'scripted' ? [{ t_ms: 1000, type: 'dispatch' }] : []
    const f = { episode: e, reset, initial, trajectory, writes }
    mutate(f, s)
    for (const [name, content] of [['episode.json', js(f.episode)], ['reset.json', js(f.reset)], ['initial.json', js(f.initial)], ['trajectory.jsonl', f.trajectory.map(x => JSON.stringify(x)).join('\n') + '\n'], ['writes.jsonl', f.writes.map(x => JSON.stringify(x)).join('\n') + (f.writes.length ? '\n' : '')]]) writeFileSync(join(episodeDir, name), content)
    time = start + 3000
  }
  return { dir, registration: r }
}
test('balanced schedule and completed in-band baseline/out-of-band treatment remain qualified', t => {
  const p = plan(), s = makeSchedule(p)
  assert.equal(s.filter(x => x.ordinal % 2 === 1 && x.condition === 'no_write').length, 1)
  const { dir } = fixture(t)
  const m = seal(dir)
  assert.equal(m.missing.length, 0)
  const v = verify(dir)
  assert.equal(v.verdict, 'STRUCTURALLY-CONSISTENT-SOURCE-UNVERIFIED')
  assert.equal(v.paired_differences.length, 2)
  assert.equal(v.paired_differences[0].no_write_in_band, true)
  assert.equal(v.paired_differences[0].scripted_in_band, false)
  assert.equal(v.paired_differences[0].scripted_minus_no_write, -3.5)
  assert.throws(() => seal(dir), /EEXIST/)
  assert.throws(() => initialize(plan(), dir), /EEXIST/)
})
test('synthetic fixture can never qualify as a platform study', t => {
  const tmp = mkdtempSync(join(tmpdir(), 'paper-study-synthetic-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const p = plan(); p.provenance.observation_kind = 'synthetic-fixture'
  const dir = join(tmp, 'study'); initialize(p, dir); seal(dir)
  const result = verify(dir)
  assert.equal(result.verdict, 'NOT-QUALIFIED')
  assert.equal(result.paired_differences, null)
})
test('no-write contamination, missing time coverage and initial mismatches are blocked', t => {
  const { dir } = fixture(t, (f, s) => {
    if (s.seed === 42 && s.condition === 'no_write') f.writes.push({ t_ms: 500, type: 'attempt' })
    if (s.seed === 43 && s.condition === 'scripted') { f.initial.values.mass = 11; f.trajectory.splice(1, 1) }
  })
  seal(dir); const v = verify(dir)
  assert.equal(v.verdict, 'NOT-QUALIFIED'); assert.equal(v.paired_differences, null)
  assert.ok(v.issues.some(x => x.includes('no-write condition contains write')))
  assert.ok(v.issues.some(x => x.includes('sample count differs from fixed schedule')))
})
test('initial mismatch and duplicate reset IDs block pairing', t => {
  const { dir } = fixture(t, (f, s) => { if (s.seed === 42) { f.reset.reset_id = 'same'; if (s.condition === 'scripted') f.initial.values.mass = 11 } })
  seal(dir); const v = verify(dir)
  assert.equal(v.verdict, 'NOT-QUALIFIED'); assert.equal(v.paired_differences, null)
  assert.ok(v.issues.some(x => x.includes('reused reset')))
})
test('old source samples cannot masquerade as fresh post-reset observations', t => {
  const { dir } = fixture(t, (f, s) => {
    if (s.ordinal === 1) f.trajectory[0].source_at_utc = iso(Date.parse(f.reset.performed_at_utc) - 1)
    if (s.ordinal === 2) f.initial.source_at_utc = iso(Date.parse(f.reset.performed_at_utc) - 1)
  })
  seal(dir); const v = verify(dir)
  assert.equal(v.verdict, 'NOT-QUALIFIED')
  assert.ok(v.issues.some(x => x.includes('pre-reset')))
  assert.ok(v.issues.some(x => x.includes('initial-state freshness')))
})
test('configuration and policy must match preregistration even when both arms agree', t => {
  const { dir } = fixture(t, (f, s) => {
    if (s.seed === 42) f.reset.configuration_sha256 = 'd'.repeat(64)
    if (s.condition === 'scripted') f.episode.scripted_policy_sha256 = 'e'.repeat(64)
  })
  seal(dir); const v = verify(dir)
  assert.equal(v.verdict, 'NOT-QUALIFIED')
  assert.ok(v.issues.some(x => x.includes('registered configuration')))
  assert.ok(v.issues.some(x => x.includes('episode policy')))
})
test('non-finite/missing values and duplicate timestamps are rejected', t => {
  const { dir } = fixture(t, (f, s) => {
    if (s.ordinal === 1) f.trajectory[1].pv = null
    if (s.ordinal === 2) f.trajectory[1].t_ms = 0
  })
  seal(dir); const v = verify(dir)
  assert.equal(v.verdict, 'NOT-QUALIFIED')
  assert.ok(v.issues.some(x => x.includes('invalid PV')))
  assert.ok(v.issues.some(x => x.includes('duplicate trajectory time')))
})
test('source timestamps must remain monotonic within the fixed observation schedule', t => {
  const { dir } = fixture(t, (f, s) => {
    if (s.ordinal === 1) f.trajectory[1].source_at_utc = f.trajectory[0].source_at_utc
  })
  seal(dir); const v = verify(dir)
  assert.equal(v.verdict, 'NOT-QUALIFIED')
  assert.ok(v.issues.some(x => x.includes('source timestamps are not strictly increasing')))
})
test('registered jitter and horizon must permit an unambiguous uniform schedule', () => {
  const badJitter = plan(); badJitter.sample_jitter_ms = badJitter.sample_interval_ms / 2
  assert.throws(() => makeSchedule(badJitter), /less than half/)
  const misalignedHorizon = plan(); misalignedHorizon.horizon_ms = 2500
  assert.throws(() => makeSchedule(misalignedHorizon), /align with the fixed sample schedule/)
})
test('failed episode and tampered evidence cannot create a paired result', t => {
  const { dir, registration } = fixture(t, (f, s) => { if (s.ordinal === 2) f.episode.status = 'failed' })
  seal(dir)
  let v = verify(dir)
  assert.equal(v.verdict, 'NOT-QUALIFIED'); assert.ok(v.issues.some(x => x.includes('status failed')))
  assert.equal(v.episodes.find(x => x.ordinal === 2).validation, 'NOT-QUALIFIED')
  const p = join(dir, 'episodes', registration.schedule[0].episode_id, 'trajectory.jsonl')
  writeFileSync(p, 'tampered\n')
  v = verify(dir); assert.equal(v.verdict, 'NOT-QUALIFIED'); assert.ok(v.issues[0].includes('digest mismatch'))
})
test('missing results and legacy raw files cannot qualify', t => {
  const tmp = mkdtempSync(join(tmpdir(), 'paper-study-legacy-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  writeFileSync(join(tmp, 'run.json'), js({ condition: 'C1' }))
  assert.equal(verify(tmp).verdict, 'NOT-QUALIFIED')
  const dir = join(tmp, 'incomplete'); initialize(plan(), dir)
  const m = seal(dir)
  assert.equal(m.missing.length, 20)
  const v = verify(dir); assert.equal(v.verdict, 'NOT-QUALIFIED'); assert.equal(v.paired_differences, null)
})
test('sealed evidence path rejects a symlink to an external file', t => {
  const { dir, registration } = fixture(t)
  const path = join(dir, 'episodes', registration.schedule[0].episode_id, 'writes.jsonl')
  const external = join(tmpdir(), `paper-study-external-${process.pid}.jsonl`)
  writeFileSync(external, '')
  t.after(() => rmSync(external, { force: true }))
  rmSync(path)
  try { symlinkSync(external, path, 'file') } catch (e) { if (e.code === 'EPERM') { t.skip('symlink creation requires Windows developer mode'); return } throw e }
  assert.throws(() => seal(dir), /symlink rejected/)
})
