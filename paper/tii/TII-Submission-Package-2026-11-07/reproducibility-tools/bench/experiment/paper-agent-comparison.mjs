#!/usr/bin/env node
/** Offline E7 schedule and evidence inventory; no acquisition implementation. */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => `${JSON.stringify(value, null, 2)}\n`
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,127}$/.test(value)
const sceneId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)
const need = (value, message) => { if (!value) throw new Error(message) }
const declaredStatuses = new Set(['completed', 'failed', 'timeout', 'cancelled', 'zero_write', 'invalid'])
const traceNames = ['task', 'harness', 'model', 'tool', 'approval', 'driver', 'readback', 'daq']
const maxTraceBytes = 20 * 1024 * 1024

function exactKeys(value, keys, name) {
  need(value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${name} has missing or unexpected fields`)
}

/** The registration stores hashes and identifiers, not prompts or credentials. */
export function validatePlan(plan) {
  exactKeys(plan, ['schema', 'scenes', 'seeds', 'harnesses', 'models', 'prompt_sha256', 'permissions_sha256', 'runner_sha256', 'platform_build_sha256', 'simulator_build_sha256', 'budget_ms', 'max_tool_calls', 'horizon_ms', 'sample_interval_ms', 'order_seed'], 'plan')
  need(plan.schema === 'paper-agent-comparison-plan/v1', 'unsupported plan schema')
  need(Array.isArray(plan.scenes) && plan.scenes.length > 0 && plan.scenes.length <= 64, 'invalid scenes')
  for (const scene of plan.scenes) {
    exactKeys(scene, ['id', 'task_sha256', 'configuration_sha256', 'oracle_sha256'], 'scene')
    need(sceneId(scene.id) && digest(scene.task_sha256) && digest(scene.configuration_sha256) && digest(scene.oracle_sha256), 'invalid scene or hashes')
  }
  need(new Set(plan.scenes.map(scene => scene.id)).size === plan.scenes.length, 'duplicate scene')
  need(Array.isArray(plan.seeds) && plan.seeds.length > 0 && plan.seeds.length <= 256
    && plan.seeds.every(integer) && new Set(plan.seeds).size === plan.seeds.length, 'invalid seeds')
  need(Array.isArray(plan.harnesses) && plan.harnesses.length === 2, 'exactly omp and opencode harnesses required')
  for (const harness of plan.harnesses) {
    exactKeys(harness, ['id', 'revision'], 'harness')
    need(['omp', 'opencode'].includes(harness.id) && identifier(harness.revision), 'invalid harness or revision')
  }
  need(new Set(plan.harnesses.map(harness => harness.id)).size === 2, 'exactly omp and opencode harnesses required')
  need(Array.isArray(plan.models) && plan.models.length > 0 && plan.models.length <= 8, 'invalid models')
  for (const model of plan.models) {
    exactKeys(model, ['provider', 'id', 'revision'], 'model')
    need(identifier(model.provider) && identifier(model.id) && identifier(model.revision), 'invalid model identity')
  }
  need(new Set(plan.models.map(model => JSON.stringify([model.provider, model.id, model.revision]))).size === plan.models.length, 'duplicate model')
  need(plan.scenes.length * plan.seeds.length * plan.harnesses.length * plan.models.length <= 4096, 'schedule exceeds 4096 episodes')
  for (const field of ['prompt_sha256', 'permissions_sha256', 'runner_sha256', 'platform_build_sha256', 'simulator_build_sha256']) need(digest(plan[field]), `invalid ${field}`)
  need(integer(plan.budget_ms) && plan.budget_ms > 0 && integer(plan.max_tool_calls) && plan.max_tool_calls > 0, 'invalid budget')
  need(integer(plan.horizon_ms) && plan.horizon_ms >= 2000 && integer(plan.sample_interval_ms)
    && plan.sample_interval_ms >= 1000 && plan.sample_interval_ms % 1000 === 0
    && plan.horizon_ms % plan.sample_interval_ms === 0, 'horizon must align to an explicit 1 s DAQ bucket schedule')
  need(identifier(plan.order_seed), 'invalid order_seed')
  return plan
}

/** Each block contains every registered Harness/model combination. */
export function makeSchedule(plan) {
  validatePlan(plan)
  const schedule = []
  for (const scene of plan.scenes) for (const seed of plan.seeds) {
    const combinations = plan.harnesses.flatMap(harness => plan.models.map(model => ({ harness, model })))
    combinations.sort((a, b) => {
      const key = combination => JSON.stringify([plan.order_seed, scene.id, seed, combination.harness.id, combination.model.provider, combination.model.id, combination.model.revision])
      return sha(key(a)).localeCompare(sha(key(b))) || key(a).localeCompare(key(b))
    })
    for (const { harness, model } of combinations) {
      const ordinal = schedule.length + 1
      schedule.push({ ordinal, episode_id: `ep-${String(ordinal).padStart(6, '0')}`, scene: scene.id, seed, harness: harness.id, harness_revision: harness.revision, model })
    }
  }
  return schedule
}

export function freeze(plan, outDir) {
  validatePlan(plan)
  mkdirSync(outDir, { recursive: false })
  const registration = { schema: 'paper-agent-comparison-registration/v1', run_id: randomUUID(), registered_at_utc: new Date().toISOString(), plan, schedule: makeSchedule(plan) }
  const bytes = json(registration)
  writeFileSync(join(outDir, 'registration.json'), bytes, { flag: 'wx' })
  writeFileSync(join(outDir, 'registration.sha256'), `${sha(bytes)}\n`, { flag: 'wx' })
  mkdirSync(join(outDir, 'episodes'), { recursive: false })
  return registration
}

/** Only regular files under a non-symlink registration root are read. */
function readSafe(root, parts, limit) {
  let current = root
  for (const part of parts) {
    need(typeof part === 'string' && /^[a-zA-Z0-9._-]+$/.test(part) && part !== '.' && part !== '..', 'unsafe evidence path')
    current = join(current, part)
    const info = lstatSync(current)
    need(!info.isSymbolicLink(), 'symlink rejected')
  }
  const info = lstatSync(current)
  need(info.isFile() && info.size <= limit, 'evidence is not a regular file or exceeds size limit')
  return readFileSync(current)
}

function loadRegistration(root) {
  need(!lstatSync(root).isSymbolicLink() && lstatSync(root).isDirectory(), 'registration root must be a directory, not a symlink')
  const bytes = readSafe(root, ['registration.json'], 8 * 1024 * 1024)
  const expected = readSafe(root, ['registration.sha256'], 256).toString('utf8').trim()
  need(digest(expected) && sha(bytes) === expected, 'registration digest mismatch')
  const registration = JSON.parse(bytes)
  need(registration.schema === 'paper-agent-comparison-registration/v1' && typeof registration.run_id === 'string'
    && /^[0-9a-f-]{36}$/.test(registration.run_id) && typeof registration.registered_at_utc === 'string'
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(registration.registered_at_utc)
    && Number.isFinite(Date.parse(registration.registered_at_utc)), 'invalid registration')
  need(JSON.stringify(registration.schedule) === JSON.stringify(makeSchedule(registration.plan)), 'registration schedule mismatch')
  return { registration, digest: expected }
}

function trace(root, episodeId, name) {
  try {
    const bytes = readSafe(root, ['episodes', episodeId, `${name}.jsonl`], maxTraceBytes)
    const rows = bytes.toString('utf8').split(/\r?\n/).filter(line => line.trim())
    for (const row of rows) {
      const parsed = JSON.parse(row)
      need(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'trace row must be an object')
    }
    return { state: rows.length ? 'PRESENT_UNVERIFIED' : 'EMPTY_UNVERIFIED', lines: rows.length, sha256: sha(bytes) }
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'MISSING' : 'INVALID', reason: error.message }
  }
}

/** Inventory every scheduled episode without treating declared success as a verified result. */
export function summarize(root) {
  root = resolve(root)
  const { registration, digest: registrationSha256 } = loadRegistration(root)
  const p = registration.plan
  const episodes = registration.schedule.map(expected => {
    const result = { ...expected, declared_status: null, qualification: 'NOT_QUALIFIED', issues: ['Acquisition and source identity are not implemented or independently verified.'], traces: {} }
    let record
    try {
      record = JSON.parse(readSafe(root, ['episodes', expected.episode_id, 'episode.json'], 1024 * 1024))
    } catch (error) {
      result.record_state = error.code === 'ENOENT' ? 'NOT_RUN' : 'INVALID'
      result.issues.push(`episode record ${result.record_state}: ${error.message}`)
      return result
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      result.record_state = 'INVALID'
      result.issues.push('episode record must be an object')
      return result
    }
    result.declared_status = typeof record.status === 'string' ? record.status : null
    result.record_state = 'PRESENT_UNVERIFIED'
    const scene = p.scenes.find(item => item.id === expected.scene)
    const required = { run_id: registration.run_id, episode_id: expected.episode_id, scene: expected.scene, seed: expected.seed,
      harness: expected.harness, harness_revision: expected.harness_revision, model: expected.model,
      task_sha256: scene.task_sha256, configuration_sha256: scene.configuration_sha256, oracle_sha256: scene.oracle_sha256,
      prompt_sha256: p.prompt_sha256, permissions_sha256: p.permissions_sha256, runner_sha256: p.runner_sha256,
      platform_build_sha256: p.platform_build_sha256, simulator_build_sha256: p.simulator_build_sha256,
      budget_ms: p.budget_ms, max_tool_calls: p.max_tool_calls, horizon_ms: p.horizon_ms, sample_interval_ms: p.sample_interval_ms }
    const same = (key, value) => key === 'model'
      ? JSON.stringify([record.model?.provider, record.model?.id, record.model?.revision]) === JSON.stringify([value.provider, value.id, value.revision])
      : record[key] === value
    const mismatches = Object.entries(required).filter(([key, value]) => !same(key, value)).map(([key]) => key)
    if (!declaredStatuses.has(record.status)) mismatches.push('status')
    if (mismatches.length) { result.record_state = 'INVALID'; result.issues.push(`configuration/status mismatch: ${mismatches.join(', ')}`) }
    for (const name of traceNames) {
      result.traces[name] = trace(root, expected.episode_id, name)
      if (result.traces[name].state !== 'PRESENT_UNVERIFIED') result.issues.push(`${name} trace ${result.traces[name].state}`)
    }
    return result
  })
  const declaredStatusCounts = { NOT_RUN: 0, COMPLETED: 0, FAILED: 0, TIMEOUT: 0, CANCELLED: 0, ZERO_WRITE: 0, INVALID: 0 }
  for (const episode of episodes) {
    const category = episode.record_state === 'NOT_RUN' ? 'NOT_RUN'
      : episode.record_state === 'INVALID' ? 'INVALID' : episode.declared_status.toUpperCase()
    declaredStatusCounts[category]++
  }
  return { schema: 'paper-agent-comparison-inventory/v1', run_id: registration.run_id, registration_sha256: registrationSha256,
    status: 'NOT_QUALIFIED', acquisition: 'NOT_IMPLEMENTED', source_identity: 'NOT_VERIFIED', planned_episodes: episodes.length,
    status_denominator: episodes.length, declared_status_counts: declaredStatusCounts,
    status_count_note: 'Missing records count as NOT_RUN; invalid records or mismatched configuration count as INVALID; all other counts are declared statuses. COMPLETED is unverified and is not task success.', episodes }
}

function outsideInput(input, out) {
  const source = realpathSync(input)
  const destination = join(realpathSync(dirname(resolve(out))), basename(resolve(out)))
  const rel = relative(source, destination)
  need(rel && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)), 'output must be outside the registration directory')
}

function cli() {
  const [command, ...args] = process.argv.slice(2)
  const get = key => { const index = args.indexOf(`--${key}`); return index < 0 ? undefined : args[index + 1] }
  if (command === 'freeze') {
    need(get('plan') && get('out'), 'usage: freeze --plan PLAN.json --out NEW_DIRECTORY')
    const registration = freeze(JSON.parse(readFileSync(resolve(get('plan')), 'utf8')), resolve(get('out')))
    console.log(`FROZEN ${registration.run_id}; ${registration.schedule.length} scheduled episodes; acquisition NOT_IMPLEMENTED`)
  } else if (command === 'inventory') {
    need(get('registration') && get('out'), 'usage: inventory --registration DIRECTORY --out NEW_DIRECTORY')
    const source = resolve(get('registration')), out = resolve(get('out'))
    outsideInput(source, out)
    const report = summarize(source)
    mkdirSync(out, { recursive: false })
    writeFileSync(join(out, 'inventory.json'), json(report), { flag: 'wx' })
    console.log(`NOT_QUALIFIED: ${report.planned_episodes} scheduled episodes inventoried`)
    process.exitCode = 1
  } else if (command === 'acquire') {
    throw new Error('NOT_IMPLEMENTED / NOT_QUALIFIED: isolated AW/simulator process authentication and E7 acquisition are not implemented; no service or model was contacted')
  } else throw new Error('commands: freeze, inventory, acquire (NOT_IMPLEMENTED)')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { cli() } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 2 }
}
