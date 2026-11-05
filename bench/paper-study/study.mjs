#!/usr/bin/env node
/** Offline registration and evidence-integrity checks. No plant/network access. */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, realpathSync, lstatSync } from 'node:fs'
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const hash = x => createHash('sha256').update(x).digest('hex')
const json = x => `${JSON.stringify(x, null, 2)}\n`
const digest = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)
const commit = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x)
const num = x => typeof x === 'number' && Number.isFinite(x)
const integer = x => Number.isSafeInteger(x)
const nonempty = x => typeof x === 'string' && x.trim().length > 0
const validId = x => typeof x === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(x)
function need(v, message) { if (!v) throw new Error(message) }
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }
function utc(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v)) return NaN
  return Date.parse(v)
}
function validatePlan(p) {
  need(p && p.schema === 'paper-study-plan/v1', 'plan schema must be paper-study-plan/v1')
  need(Array.isArray(p.scenes) && p.scenes.length > 0, 'scenes required')
  need(Array.isArray(p.seeds) && p.seeds.length >= 2 && p.seeds.length % 2 === 0, 'a nonempty even number of at least two seeds is required for balanced order')
  need(p.seeds.every(integer) && new Set(p.seeds).size === p.seeds.length, 'seeds must be unique safe integers')
  need(nonempty(p.order_seed), 'order_seed required')
  need(integer(p.horizon_ms) && p.horizon_ms > 0, 'positive integer horizon_ms required')
  need(integer(p.max_end_delay_ms) && p.max_end_delay_ms >= 0, 'invalid max_end_delay_ms')
  need(integer(p.sample_interval_ms) && p.sample_interval_ms > 0 && p.sample_interval_ms <= p.horizon_ms, 'invalid sample_interval_ms')
  need(p.horizon_ms % p.sample_interval_ms === 0, 'horizon_ms must align with the fixed sample schedule')
  need(integer(p.sample_jitter_ms) && p.sample_jitter_ms >= 0 && p.sample_jitter_ms * 2 < p.sample_interval_ms, 'sample_jitter_ms must be less than half the sampling interval')
  need(integer(p.max_sample_gap_ms) && p.max_sample_gap_ms >= p.sample_interval_ms && p.max_sample_gap_ms <= p.horizon_ms, 'invalid max_sample_gap_ms')
  need(integer(p.endpoint_window_ms) && p.endpoint_window_ms > 0 && p.endpoint_window_ms <= p.horizon_ms, 'invalid endpoint_window_ms')
  need(integer(p.minimum_endpoint_samples) && p.minimum_endpoint_samples >= 1, 'invalid minimum_endpoint_samples')
  need(integer(p.initial_freshness_ms) && p.initial_freshness_ms >= 0, 'invalid initial_freshness_ms')
  need(integer(p.sample_freshness_ms) && p.sample_freshness_ms >= 0, 'invalid sample_freshness_ms')
  need(nonempty(p.sampling_method) && nonempty(p.endpoint_method) && p.endpoint_method === 'arithmetic_mean', 'explicit sampling_method and arithmetic_mean endpoint_method required')
  need(p.conditions?.length === 2 && p.conditions[0] === 'no_write' && p.conditions[1] === 'scripted', 'conditions must be [no_write, scripted]')
  need(integer(p.scripted_write_budget) && p.scripted_write_budget >= 0, 'invalid scripted_write_budget')
  need(digest(p.scripted_policy_sha256), 'scripted_policy_sha256 must be frozen before collection')
  need(new Set(p.scenes.map(s => s.id)).size === p.scenes.length, 'duplicate scene id')
  for (const s of p.scenes) {
    need(validId(s.id) && nonempty(s.unit) && num(s.target) && num(s.tolerance) && s.tolerance >= 0 && digest(s.configuration_sha256) && digest(s.disturbance_sha256), 'invalid scene target, unit, id, config or disturbance hash')
    need(s.initial_tolerances && typeof s.initial_tolerances === 'object' && !Array.isArray(s.initial_tolerances) && Object.keys(s.initial_tolerances).length > 0, `initial tolerances required for ${s.id}`)
    for (const [key, value] of Object.entries(s.initial_tolerances)) need(validId(key) && num(value) && value >= 0, `invalid initial tolerance: ${s.id}/${key}`)
    need(Array.isArray(s.guards) && new Set(s.guards.map(g => g.id)).size === s.guards.length, `invalid guards for ${s.id}`)
    for (const g of s.guards) need(validId(g.id) && nonempty(g.unit) && (num(g.min) || num(g.max)) && (g.min === undefined || num(g.min)) && (g.max === undefined || num(g.max)) && (g.min === undefined || g.max === undefined || g.min <= g.max), `invalid guard ${s.id}/${g.id}`)
  }
  for (const key of ['platform', 'simulator']) {
    const v = p.provenance?.[key]
    need(v && commit(v.commit) && digest(v.source_sha256) && typeof v.dirty === 'boolean', `invalid ${key} provenance`)
  }
  need(['platform-simulator', 'synthetic-fixture'].includes(p.provenance?.observation_kind), 'observation_kind must declare platform-simulator or synthetic-fixture')
  need(digest(p.provenance?.runner_sha256), 'runner_sha256 required')
}

/** Balanced order within each scene, randomized deterministically before data collection. */
export function makeSchedule(plan) {
  validatePlan(plan)
  const result = []
  for (const scene of plan.scenes) {
    const ordered = [...plan.seeds].sort((a, b) => hash(`${plan.order_seed}\0${scene.id}\0${a}`).localeCompare(hash(`${plan.order_seed}\0${scene.id}\0${b}`)))
    const flip = parseInt(hash(`${plan.order_seed}\0${scene.id}\0flip`).slice(0, 2), 16) % 2
    ordered.forEach((seed, i) => {
      const arms = ((i + flip) % 2 === 0) ? plan.conditions : [...plan.conditions].reverse()
      for (const condition of arms) result.push({ ordinal: result.length + 1, episode_id: `${scene.id}-${seed}-${condition}`, scene: scene.id, seed, condition })
    })
  }
  return result
}
export function initialize(plan, outDir) {
  validatePlan(plan)
  // Exclusive directory creation prevents accidental reuse and overwriting.
  mkdirSync(outDir, { recursive: false })
  const registration = { schema: 'paper-study-registration/v1', run_id: randomUUID(), registered_at_utc: new Date().toISOString(), plan, schedule: makeSchedule(plan) }
  const bytes = json(registration)
  writeFileSync(resolve(outDir, 'registration.json'), bytes, { flag: 'wx' })
  writeFileSync(resolve(outDir, 'registration.sha256'), `${hash(bytes)}\n`, { flag: 'wx' })
  mkdirSync(resolve(outDir, 'episodes'))
  return registration
}

/** Freeze a file inventory; incomplete episodes remain explicitly missing. */
export function seal(root) {
  const bytes = readFileSync(safeFile(root, 'registration.json'))
  const registrationSha256 = readFileSync(safeFile(root, 'registration.sha256'), 'utf8').trim()
  need(digest(registrationSha256) && hash(bytes) === registrationSha256, 'registration digest mismatch')
  const registration = JSON.parse(bytes)
  need(registration.schema === 'paper-study-registration/v1' && JSON.stringify(registration.schedule) === JSON.stringify(makeSchedule(registration.plan)), 'invalid registration')
  const files = {}, missing = []
  for (const e of registration.schedule) for (const filename of ['episode.json', 'reset.json', 'initial.json', 'trajectory.jsonl', 'writes.jsonl']) {
    const path = `episodes/${e.episode_id}/${filename}`
    try { files[path] = hash(readFileSync(safeFile(root, path))) }
    catch (err) {
      if (err.code === 'ENOENT') missing.push(path)
      else throw err
    }
  }
  const manifest = { schema: 'paper-study-evidence/v1', run_id: registration.run_id, registration_sha256: registrationSha256, sealed_at_utc: new Date().toISOString(), files, missing }
  writeFileSync(resolve(root, 'manifest.json'), json(manifest), { flag: 'wx' })
  return manifest
}

/** Resolve only regular files inside the evidence root; do not follow symlinks. */
function safeFile(root, name) {
  need(typeof name === 'string' && name.length > 0 && !isAbsolute(name) && !name.includes('\\') && !name.split('/').includes('..') && !name.split('/').includes('.'), `unsafe evidence path: ${name}`)
  const base = realpathSync(root)
  let current = base
  for (const part of name.split('/')) {
    need(part.length > 0, `unsafe evidence path: ${name}`)
    current = resolve(current, part)
    need(!lstatSync(current).isSymbolicLink(), `symlink rejected: ${name}`)
  }
  const rel = relative(base, current)
  need(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `evidence escapes root: ${name}`)
  need(lstatSync(current).isFile(), `not a file: ${name}`)
  return current
}
function lines(bytes, path) {
  const raw = bytes.toString('utf8')
  if (!raw.trim()) return []
  return raw.split(/\r?\n/).filter(s => s.trim()).map((s, i) => {
    try { return JSON.parse(s) } catch { throw new Error(`${path}: invalid JSON line ${i + 1}`) }
  })
}

/** Check a sealed evidence bundle. Records are claims, not authenticated hardware facts. */
export function verify(root) {
  const issues = [], episodes = [], pairs = []
  let reg, manifest, files
  try {
    const bytes = readFileSync(safeFile(root, 'registration.json'))
    const recorded = readFileSync(safeFile(root, 'registration.sha256'), 'utf8').trim()
    need(digest(recorded) && recorded === hash(bytes), 'registration digest mismatch')
    reg = JSON.parse(bytes)
    need(reg.schema === 'paper-study-registration/v1' && nonempty(reg.run_id) && Number.isFinite(utc(reg.registered_at_utc)), 'invalid registration')
    validatePlan(reg.plan)
    need(JSON.stringify(reg.schedule) === JSON.stringify(makeSchedule(reg.plan)), 'schedule differs from frozen plan')
    manifest = readJson(safeFile(root, 'manifest.json'))
    need(manifest.schema === 'paper-study-evidence/v1' && manifest.run_id === reg.run_id && manifest.registration_sha256 === recorded, 'manifest does not bind registration')
    need(manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files), 'manifest.files required')
    files = new Map()
    const expected = reg.schedule.flatMap(e => ['episode.json', 'reset.json', 'initial.json', 'trajectory.jsonl', 'writes.jsonl'].map(n => `episodes/${e.episode_id}/${n}`))
    const absent = expected.filter(k => !Object.hasOwn(manifest.files, k))
    const extra = Object.keys(manifest.files).filter(k => !expected.includes(k))
    need(absent.length === 0 && extra.length === 0 && Array.isArray(manifest.missing) && manifest.missing.length === 0, `missing or extra manifest files: ${[...absent, ...extra].join(', ')}`)
    for (const path of expected) {
      need(digest(manifest.files[path]), `invalid digest: ${path}`)
      const bytes = readFileSync(safeFile(root, path))
      need(hash(bytes) === manifest.files[path], `digest mismatch: ${path}`)
      files.set(path, bytes)
    }
  } catch (e) {
    return { schema: 'paper-study-verdict/v1', verdict: 'NOT-QUALIFIED', run_id: reg?.run_id ?? null, issues: [e.message], episodes, paired_differences: null, limitations: LIMITATIONS }
  }
  const p = reg.plan
  if (p.provenance.observation_kind !== 'platform-simulator') issues.push('synthetic fixture is not an actual platform-simulator observation')
  const resetIds = new Set()
  let precedingEnd = -Infinity
  for (const expected of reg.schedule) {
    const prefix = `episodes/${expected.episode_id}/`
    try {
      const e = JSON.parse(files.get(`${prefix}episode.json`))
      const r = JSON.parse(files.get(`${prefix}reset.json`))
      const initial = JSON.parse(files.get(`${prefix}initial.json`))
      const trajectory = lines(files.get(`${prefix}trajectory.jsonl`), `${prefix}trajectory.jsonl`)
      const writes = lines(files.get(`${prefix}writes.jsonl`), `${prefix}writes.jsonl`)
      need(e.schema === 'paper-study-episode/v1' && e.run_id === reg.run_id, 'episode schema/run mismatch')
      for (const k of ['ordinal', 'episode_id', 'scene', 'seed', 'condition']) need(e[k] === expected[k], `${k} differs from registration`)
      need(e.status === 'completed', `episode status ${String(e.status)}; retain but cannot compare`)
      need(JSON.stringify(e.provenance) === JSON.stringify(p.provenance), 'source provenance differs from registration')
      need(e.horizon_ms === p.horizon_ms && e.sample_interval_ms === p.sample_interval_ms && e.endpoint_window_ms === p.endpoint_window_ms && e.sampling_method === p.sampling_method && e.endpoint_method === p.endpoint_method, 'measurement protocol mismatch')
      need(typeof r.reset_id === 'string' && r.reset_id.length > 0 && !resetIds.has(r.reset_id), 'missing or reused reset ID')
      resetIds.add(r.reset_id)
      const scene = p.scenes.find(s => s.id === e.scene)
      need(r.scene === e.scene && r.seed === e.seed && r.status === 'completed' && r.configuration_sha256 === scene.configuration_sha256 && r.disturbance_sha256 === scene.disturbance_sha256 && digest(r.snapshot_sha256), 'invalid reset, registered configuration or disturbance')
      need((e.condition === 'scripted' && e.scripted_policy_sha256 === p.scripted_policy_sha256) || (e.condition === 'no_write' && e.scripted_policy_sha256 === null), 'episode policy differs from registered condition')
      const resetAt = utc(r.performed_at_utc), observedAt = utc(initial.observed_at_utc), initialSource = utc(initial.source_at_utc), start = utc(e.started_at_utc), end = utc(e.ended_at_utc)
      need([resetAt, observedAt, initialSource, start, end].every(Number.isFinite) && resetAt >= utc(reg.registered_at_utc), 'invalid timestamp or reset before registration')
      need(resetAt >= precedingEnd && initialSource >= resetAt && initialSource <= observedAt && observedAt <= start && start - initialSource <= p.initial_freshness_ms, 'order or initial-state freshness failure')
      need(end - start >= p.horizon_ms && end - start <= p.horizon_ms + p.max_end_delay_ms, 'actual termination outside registered horizon/delay')
      precedingEnd = end
      need(initial.values && typeof initial.values === 'object' && !Array.isArray(initial.values), 'missing initial values')
      need(Object.keys(initial.values).sort().join('|') === Object.keys(scene.initial_tolerances).sort().join('|'), 'initial state fields differ from registered set')
      for (const v of Object.values(initial.values)) need(num(v), 'non-finite initial state')
      need(trajectory.length >= 2, 'trajectory missing or incomplete')
      need(trajectory.length === p.horizon_ms / p.sample_interval_ms + 1, 'trajectory sample count differs from fixed schedule')
      let prev = -Infinity, prevObservedAt = -Infinity, prevSourceAt = -Infinity
      for (const sample of trajectory) {
        need(integer(sample.t_ms) && sample.t_ms >= 0 && sample.t_ms <= p.horizon_ms && sample.t_ms > prev, 'invalid/duplicate trajectory time')
        const scheduledAt = prev === -Infinity ? 0 : prev + p.sample_interval_ms
        need(Math.abs(sample.t_ms - scheduledAt) <= p.sample_jitter_ms, 'trajectory deviates from fixed sample schedule')
        need(prev === -Infinity || sample.t_ms - prev <= p.max_sample_gap_ms, 'trajectory sampling gap exceeds limit')
        const sampleAt = utc(sample.observed_at_utc), sourceAt = utc(sample.source_at_utc)
        need(Number.isFinite(sampleAt) && Number.isFinite(sourceAt) && sampleAt >= start && sampleAt <= start + p.horizon_ms && Math.abs(sampleAt - (start + sample.t_ms)) <= p.sample_jitter_ms, 'trajectory timestamps disagree with registered analysis window')
        need(sampleAt > prevObservedAt, 'observation timestamps are not strictly increasing')
        need(sourceAt > prevSourceAt, 'source timestamps are not strictly increasing')
        need(sourceAt >= resetAt && sourceAt <= sampleAt && sampleAt - sourceAt <= p.sample_freshness_ms, 'trajectory source timestamp stale, future or pre-reset')
        need(num(sample.pv) && sample.guards && typeof sample.guards === 'object' && !Array.isArray(sample.guards), 'invalid PV/guards')
        need(Object.keys(sample.guards).sort().join('|') === scene.guards.map(g => g.id).sort().join('|'), 'guard fields differ from registration')
        for (const value of Object.values(sample.guards)) need(num(value), 'non-finite guard value')
        prev = sample.t_ms
        prevObservedAt = sampleAt
        prevSourceAt = sourceAt
      }
      need(trajectory[0].t_ms <= p.max_sample_gap_ms && p.horizon_ms - trajectory.at(-1).t_ms <= p.max_sample_gap_ms, 'trajectory does not cover the horizon')
      const tail = trajectory.filter(s => s.t_ms >= p.horizon_ms - p.endpoint_window_ms)
      need(tail.length >= p.minimum_endpoint_samples, 'endpoint sample count too small')
      for (const w of writes) need(integer(w.t_ms) && w.t_ms >= 0 && w.t_ms <= p.horizon_ms && ['attempt', 'dispatch', 'receipt', 'readback'].includes(w.type), 'invalid write event')
      need(e.condition !== 'no_write' || writes.length === 0, 'no-write condition contains write events')
      const dispatches = writes.filter(w => w.type === 'dispatch').length
      need(e.condition !== 'scripted' || dispatches <= p.scripted_write_budget, 'scripted dispatch budget exceeded')
      const endpoint = tail.reduce((sum, s) => sum + s.pv, 0) / tail.length
      const guardViolations = trajectory.reduce((total, sample) => total + scene.guards.filter(g => (g.min !== undefined && sample.guards[g.id] < g.min) || (g.max !== undefined && sample.guards[g.id] > g.max)).length, 0)
      episodes.push({ ...expected, validation: 'VALIDATED', endpoint, in_band: Math.abs(endpoint - scene.target) <= scene.tolerance, guard_violation_observations: guardViolations, dispatches, initial_values: initial.values, reset_id: r.reset_id, configuration_sha256: r.configuration_sha256, snapshot_sha256: r.snapshot_sha256 })
    } catch (err) {
      issues.push(`${expected.episode_id}: ${err.message}`)
      episodes.push({ ...expected, validation: 'NOT-QUALIFIED', reason: err.message })
    }
  }
  for (const scene of p.scenes) for (const seed of p.seeds) {
    const a = episodes.find(e => e.scene === scene.id && e.seed === seed && e.condition === 'no_write' && e.validation === 'VALIDATED')
    const b = episodes.find(e => e.scene === scene.id && e.seed === seed && e.condition === 'scripted' && e.validation === 'VALIDATED')
    if (!a || !b) { issues.push(`${scene.id}/${seed}: incomplete pair`); continue }
    if (a.configuration_sha256 !== b.configuration_sha256 || a.snapshot_sha256 !== b.snapshot_sha256) issues.push(`${scene.id}/${seed}: initial snapshot/config fingerprint mismatch`)
    for (const [key, tolerance] of Object.entries(scene.initial_tolerances)) if (Math.abs(a.initial_values[key] - b.initial_values[key]) > tolerance) issues.push(`${scene.id}/${seed}: initial ${key} differs beyond tolerance`)
    pairs.push({ scene: scene.id, seed, no_write_endpoint: a.endpoint, scripted_endpoint: b.endpoint, scripted_minus_no_write: b.endpoint - a.endpoint, no_write_in_band: a.in_band, scripted_in_band: b.in_band })
  }
  return { schema: 'paper-study-verdict/v1', verdict: issues.length ? 'NOT-QUALIFIED' : 'STRUCTURALLY-CONSISTENT-SOURCE-UNVERIFIED', run_id: reg.run_id, issues, episodes, paired_differences: issues.length ? null : pairs, assessed_metrics: ['endpoint_mean', 'in_band', 'scripted_minus_no_write_endpoint'], unassessed_metrics: ['IAE', 'causal_effect', 'statistical_uncertainty'], source_independence: 'NOT_ASSESSED', event_completeness: 'NOT_ASSESSED', limitations: LIMITATIONS }
}

const LIMITATIONS = [
  'Offline structural and consistency checks only: hashes do not establish the truth or completeness of the originating service, driver, reset, or trajectory records.',
  'Qualification is not a causal, statistical-significance, safety, physical-plant, or publication claim; independent source review remains required.',
  'Failed or missing episodes remain non-qualified; their records must be preserved and their exclusions disclosed.',
]

function cli() {
  const [command, ...args] = process.argv.slice(2)
  const get = key => { const i = args.indexOf(`--${key}`); return i < 0 ? null : args[i + 1] }
  if (command === 'init') {
    need(get('plan') && get('out'), 'usage: study.mjs init --plan PLAN.json --out NEW_DIRECTORY')
    const r = initialize(readJson(get('plan')), get('out'))
    console.log(`FROZEN ${r.run_id}: ${resolve(get('out'))}`)
  } else if (command === 'seal') {
    need(get('bundle'), 'usage: study.mjs seal --bundle DIRECTORY')
    const m = seal(resolve(get('bundle')))
    console.log(`SEALED ${m.run_id}; missing files: ${m.missing.length}`)
    if (m.missing.length) process.exitCode = 1
  } else if (command === 'verify') {
    need(get('bundle') && get('out'), 'usage: study.mjs verify --bundle DIRECTORY --out NEW_REPORT.json')
    const report = verify(resolve(get('bundle')))
    writeFileSync(resolve(get('out')), json(report), { flag: 'wx' })
    console.log(`${report.verdict}: ${resolve(get('out'))}`)
    if (report.verdict === 'NOT-QUALIFIED') process.exitCode = 1
  } else throw new Error('commands: init, seal, verify')
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { cli() } catch (e) { console.error(`ERROR: ${e.message}`); process.exitCode = 2 }
}
