#!/usr/bin/env node
/**
 * Paired fixed-horizon coordinator. Its only bundled adapter is a synthetic
 * software fixture: output is NEVER evidence of AW or plant behaviour.
 * No service discovery, autostart, network I/O, or production adapter exists.
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MockAdapter } from './synthetic-adapter.mjs'

const hash = b => createHash('sha256').update(b).digest('hex')
const json = x => `${JSON.stringify(x, null, 2)}\n`
const fail = s => { throw new Error(s) }
const integer = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi
async function deadline(call, ms) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(call),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture operation timeout')), ms) }),
    ])
  } finally { clearTimeout(timer) }
}

/** Freeze exact schedule before acquisition. Order is randomized and balanced
 * within each scene; there is no outcome-dependent block selection. */
export function buildPlan({ scenes, seeds, horizonMs, sampleMs, orderSeed }) {
  if (!Array.isArray(scenes) || scenes.length === 0 || new Set(scenes).size !== scenes.length
    || scenes.some(s => typeof s !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(s))) fail('invalid scenes')
  if (!Array.isArray(seeds) || seeds.length === 0 || new Set(seeds).size !== seeds.length
    || seeds.some(s => !integer(s, 0, 2147483647))) fail('invalid seeds')
  if (!integer(horizonMs, 2, 86400000) || !integer(sampleMs, 1, horizonMs)
    || horizonMs % sampleMs !== 0 || horizonMs / sampleMs < 2) fail('horizon must contain at least two equal sampling intervals')
  if (!integer(orderSeed, 0, 2147483647)) fail('invalid order seed')
  const blocks = []
  for (const scene of scenes) {
    const ordered = [...seeds].sort((a, b) => hash(`${orderSeed}/${scene}/${a}`).localeCompare(hash(`${orderSeed}/${scene}/${b}`)))
    const offset = parseInt(hash(`${orderSeed}/${scene}/offset`).slice(0, 2), 16) % 2
    for (let i = 0; i < ordered.length; i++) {
      const order = (i + offset) % 2 ? ['C1', 'C0'] : ['C0', 'C1']
      blocks.push({ scene, seed: ordered[i], order })
    }
  }
  return {
    schema: 'paired-synthetic-protocol/1', status: 'SOFTWARE_FIXTURE_ONLY',
    runId: randomUUID(), scenes, seeds, orderSeed, horizonMs, sampleMs,
    // The placeholder policy is fixed before outcomes and operates once.
    actionAtMs: sampleMs, action: { delta: 1 }, blocks,
    endpoint: 'last sample at horizon', clock: 'virtual-fixture-ms',
  }
}

export function validatePlan(p) {
  if (!p || p.schema !== 'paired-synthetic-protocol/1' || p.status !== 'SOFTWARE_FIXTURE_ONLY') fail('unsupported plan')
  if (typeof p.runId !== 'string' || !/^[0-9a-f-]{36}$/.test(p.runId)) fail('invalid runId')
  const expected = buildPlan({ scenes: p.scenes, seeds: p.seeds, horizonMs: p.horizonMs, sampleMs: p.sampleMs, orderSeed: p.orderSeed })
  if (JSON.stringify(p.blocks) !== JSON.stringify(expected.blocks) || p.actionAtMs !== expected.actionAtMs
    || p.action?.delta !== 1 || p.endpoint !== expected.endpoint || p.clock !== expected.clock) fail('plan does not match preregistered schedule')
  return p
}

export function freezePlan(dir, options) {
  const plan = buildPlan(options)
  mkdirSync(dir, { recursive: false })
  const bytes = Buffer.from(json(plan))
  writeFileSync(join(dir, 'plan.json'), bytes, { flag: 'wx' })
  writeFileSync(join(dir, 'plan.sha256'), `${hash(bytes)}  plan.json\n`, { flag: 'wx' })
  return plan
}

export function loadPlan(dir) {
  const bytes = readFileSync(join(dir, 'plan.json'))
  const expected = readFileSync(join(dir, 'plan.sha256'), 'utf8').trim().split(/\s+/)[0]
  if (!/^[0-9a-f]{64}$/.test(expected) || hash(bytes) !== expected) fail('plan hash mismatch')
  return { plan: validatePlan(JSON.parse(bytes)), digest: expected, bytes }
}

/**
 * Adapter contract (not implemented for AW): reset(block, condition) returns
 * source-verified state, sample(offsetMs) returns timestamped process value,
 * act(offsetMs, action) returns request/dispatch/readback/driver events, and
 * close() returns final device state plus full write-event ledger. Each call
 * must enforce a bounded timeout and fail closed on missing/late data. The
 * mock below uses a virtual clock and cannot provide real-source evidence.
 */
export async function runStudy(planDir, outDir, adapterFactory = () => new MockAdapter(), timeoutMs = 3000) {
  if (!integer(timeoutMs, 1, 300000)) fail('invalid fixture timeout')
  const { plan, digest, bytes } = loadPlan(planDir)
  // Reservation is atomic: never overwrite a previous or interrupted run.
  mkdirSync(outDir, { recursive: false })
  writeFileSync(join(outDir, 'plan.json'), bytes, { flag: 'wx' })
  writeFileSync(join(outDir, 'plan.sha256'), `${digest}  plan.json\n`, { flag: 'wx' })
  const events = join(outDir, 'episodes.jsonl')
  writeFileSync(events, '', { flag: 'wx' })
  const journal = join(outDir, 'journal.jsonl')
  writeFileSync(journal, '', { flag: 'wx' })
  const seen = new Map(); let failed = 0; let count = 0
  for (const block of plan.blocks) {
    for (const condition of block.order) {
      const rec = { schema: 'paired-fixture-episode/1', runId: plan.runId,
        scene: block.scene, seed: block.seed, condition, status: 'NOT_QUALIFIED',
        limitation: 'SYNTHETIC SOFTWARE FIXTURE; NOT PAPER EVIDENCE', trajectory: [], writes: [] }
      const log = (kind, payload = {}) => appendFileSync(journal, `${JSON.stringify({ runId: plan.runId,
        scene: block.scene, seed: block.seed, condition, kind, ...payload })}\n`, 'utf8')
      log('episode-start')
      let adapter
      try {
        adapter = adapterFactory()
        if (adapter.kind !== 'synthetic-fixture') fail('only the bundled synthetic fixture is supported')
        const initial = await deadline(() => adapter.reset(block, condition), timeoutMs)
        if (!initial || !Number.isFinite(initial.value) || typeof initial.fingerprint !== 'string') fail('invalid reset')
        rec.initial = initial
        log('reset', { initial })
        const key = `${block.scene}/${block.seed}`
        if (seen.has(key) && seen.get(key) !== initial.fingerprint) fail('paired initial state mismatch')
        seen.set(key, initial.fingerprint)
        for (let t = 0; t <= plan.horizonMs; t += plan.sampleMs) {
          const observation = await deadline(() => adapter.sample(t), timeoutMs)
          if (!observation || observation.offsetMs !== t || !Number.isFinite(observation.value)) fail('missing, invalid or out-of-order sample')
          rec.trajectory.push(observation)
          log('sample', { observation })
          if (condition === 'C1' && t === plan.actionAtMs) {
            log('write-attempt', { offsetMs: t, action: plan.action })
            const result = await deadline(() => adapter.act(t, plan.action), timeoutMs)
            if (!result || result.offsetMs !== t || result.status !== 'accepted') fail('scripted action failed')
            rec.writes.push(result)
            log('write', { result })
          }
        }
        rec.final = await deadline(() => adapter.close(), timeoutMs)
        if (!rec.final || !Array.isArray(rec.final.writeEvents)) fail('missing write ledger')
        if (condition === 'C0' && rec.final.writeEvents.length) fail('C0 has write event')
        if (condition === 'C1' && rec.final.writeEvents.length !== rec.writes.length) fail('write ledger mismatch')
        rec.status = 'FIXTURE_COMPLETE'
      } catch (err) {
        rec.status = 'FIXTURE_ERROR'; rec.error = String(err?.message ?? err); failed++
        // Preserve what the adapter can report without making it valid.
        try { if (adapter && !rec.final) rec.final = await deadline(() => adapter.close(), timeoutMs) } catch { /* incomplete is recorded */ }
      }
      log('episode-end', { status: rec.status, ...(rec.error ? { error: rec.error } : {}) })
      appendFileSync(events, `${JSON.stringify(rec)}\n`, 'utf8'); count++
    }
  }
  const manifest = { schema: 'paired-fixture-result/1', runId: plan.runId, planSha256: digest,
    status: failed ? 'FIXTURE_ERROR' : 'FIXTURE_COMPLETE', paperEligibility: 'NOT_QUALIFIED',
    reason: 'Synthetic fixture only; no real AW, simulator, independent audit, or physical process was exercised.',
    episodes: count, expectedEpisodes: plan.blocks.length * 2, failed,
    episodesSha256: hash(readFileSync(events)), journalSha256: hash(readFileSync(journal)) }
  writeFileSync(join(outDir, 'manifest.json'), json(manifest), { flag: 'wx' })
  return manifest
}

const split = s => String(s ?? '').split(',').filter(Boolean)
async function main(argv) {
  const [cmd, ...args] = argv
  const get = key => { const i = args.indexOf(`--${key}`); return i < 0 ? undefined : args[i + 1] }
  if (cmd === 'freeze') {
    if (!get('out')) fail('--out is required')
    const p = freezePlan(resolve(get('out')), { scenes: split(get('scenes')), seeds: split(get('seeds')).map(Number),
      horizonMs: Number(get('horizon-ms')), sampleMs: Number(get('sample-ms')), orderSeed: Number(get('order-seed')) })
    console.log(`Frozen synthetic fixture plan ${p.runId}; not a real experiment.`)
  } else if (cmd === 'run') {
    if (!get('plan') || !get('out')) fail('--plan and --out are required')
    if (get('adapter') !== 'synthetic-fixture') fail('NOT-IMPLEMENTED: isolated AW/simulator adapter; only --adapter synthetic-fixture is available')
    const m = await runStudy(resolve(get('plan')), resolve(get('out')))
    console.log(json(m)); if (m.failed) process.exitCode = 1
  } else {
    console.log('freeze --out NEW_DIR --scenes injection --seeds 42,43 --horizon-ms 1000 --sample-ms 100 --order-seed 7\nrun --plan DIR --out NEW_DIR --adapter synthetic-fixture\nThis fixture does not run AW or generate paper evidence.')
    if (cmd && cmd !== 'help') process.exitCode = 2
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1 })
}
