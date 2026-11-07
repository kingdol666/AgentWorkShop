import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPlan, freezePlan, loadPlan, runStudy } from './paired.mjs'
import { MockAdapter } from './synthetic-adapter.mjs'

const options = { scenes: ['injection', 'anneal'], seeds: [42, 43, 44, 45], horizonMs: 1000, sampleMs: 100, orderSeed: 9 }
const fixture = fn => async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-paired-fixture-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await fn(t, dir)
}
const rows = p => readFileSync(p, 'utf8').trim().split('\n').map(JSON.parse)

test('plan balance, complete matching, and input validation', () => {
  const a = buildPlan(options), b = buildPlan(options)
  assert.deepEqual(a.blocks, b.blocks)
  assert.equal(a.blocks.length, 8)
  for (const scene of options.scenes) {
    const bs = a.blocks.filter(b => b.scene === scene)
    assert.equal(bs.filter(b => b.order[0] === 'C0').length, 2)
    assert.deepEqual(new Set(bs.map(b => b.seed)), new Set(options.seeds))
  }
  assert.throws(() => buildPlan({ ...options, horizonMs: 1100, sampleMs: 300 }), /horizon/)
  assert.throws(() => buildPlan({ ...options, seeds: [42, 42] }), /seeds/)
})

test('run uses equal observation times, resets paired state, and never qualifies fixture', fixture(async (_, dir) => {
  const planDir = join(dir, 'plan'), out = join(dir, 'out')
  freezePlan(planDir, options)
  const result = await runStudy(planDir, out)
  assert.equal(result.status, 'FIXTURE_COMPLETE')
  assert.equal(result.paperEligibility, 'NOT_QUALIFIED')
  const episodes = rows(join(out, 'episodes.jsonl'))
  assert.equal(episodes.length, 16)
  const journal = rows(join(out, 'journal.jsonl'))
  assert.equal(journal.filter(e => e.kind === 'episode-start').length, 16)
  assert.equal(journal.filter(e => e.kind === 'episode-end').length, 16)
  assert.equal(journal.filter(e => e.kind === 'write-attempt').length, 8)
  for (let i = 0; i < episodes.length; i += 2) {
    const [a, b] = episodes.slice(i, i + 2)
    assert.equal(a.initial.fingerprint, b.initial.fingerprint)
    assert.deepEqual(a.trajectory.map(x => x.offsetMs), b.trajectory.map(x => x.offsetMs))
    assert.equal(a.trajectory.at(-1).offsetMs, 1000)
    const noWrite = [a, b].find(e => e.condition === 'C0')
    assert.equal(noWrite.final.writeEvents.length, 0)
  }
  await assert.rejects(() => runStudy(planDir, out), /EEXIST/)
  assert.throws(() => freezePlan(planDir, options), /EEXIST/)
}))

test('tampering with a frozen plan is rejected before output creation', fixture(async (_, dir) => {
  const planDir = join(dir, 'plan')
  freezePlan(planDir, options)
  writeFileSync(join(planDir, 'plan.json'), '{}')
  assert.throws(() => loadPlan(planDir), /hash mismatch/)
  await assert.rejects(() => runStudy(planDir, join(dir, 'out')), /hash mismatch/)
}))

test('failed samples and reset mismatch are retained, not filtered', fixture(async (_, dir) => {
  const planDir = join(dir, 'plan'), out = join(dir, 'out')
  freezePlan(planDir, { ...options, scenes: ['injection'], seeds: [42] })
  let instance = 0
  class Broken extends MockAdapter {
    constructor() { super(); this.n = ++instance }
    async reset(b, c) { const state = await super.reset(b, c); if (this.n === 2) state.fingerprint = 'mismatch'; return state }
    async sample(t) { if (this.n === 1 && t === 200) throw new Error('injected sample failure'); return super.sample(t) }
  }
  const result = await runStudy(planDir, out, () => new Broken())
  assert.equal(result.failed, 2)
  const episodes = rows(join(out, 'episodes.jsonl'))
  assert.equal(episodes.length, 2)
  assert.match(episodes[0].error, /injected sample/)
  assert.match(episodes[1].error, /initial state mismatch/)
  assert.equal(rows(join(out, 'journal.jsonl')).filter(e => e.kind === 'episode-end').length, 2)
  assert.equal(result.paperEligibility, 'NOT_QUALIFIED')
}))

test('timeouts and unexpected no-write condition events fail closed', fixture(async (_, dir) => {
  const planDir = join(dir, 'plan'), out = join(dir, 'out')
  freezePlan(planDir, { ...options, scenes: ['injection'], seeds: [42] })
  class Broken extends MockAdapter {
    async reset(b, c) { this.cond = c; return super.reset(b, c) }
    async sample(t) { if (this.cond === 'C1') return new Promise(() => {}); return super.sample(t) }
    async close() { const r = await super.close(); if (this.cond === 'C0') r.writeEvents.push({ unexpected: true }); return r }
  }
  const result = await runStudy(planDir, out, () => new Broken(), 20)
  assert.equal(result.failed, 2)
  assert.match(rows(join(out, 'episodes.jsonl')).map(x => x.error).join(' '), /timeout/)
  assert.match(rows(join(out, 'episodes.jsonl')).map(x => x.error).join(' '), /C0 has write event/)
}))

test('CLI refuses unsupported adapter and executes only the labelled fixture', fixture(async (_, dir) => {
  const file = fileURLToPath(new URL('./paired.mjs', import.meta.url))
  const run = (...args) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8' })
  const plan = join(dir, 'cli-plan'), out = join(dir, 'cli-result')
  const frozen = run('freeze', '--out', plan, '--scenes', 'injection', '--seeds', '42,43', '--horizon-ms', '1000', '--sample-ms', '100', '--order-seed', '7')
  assert.equal(frozen.status, 0, frozen.stderr)
  const unsupported = run('run', '--plan', plan, '--out', out, '--adapter', 'aw-isolated')
  assert.equal(unsupported.status, 1)
  assert.match(unsupported.stderr, /NOT-IMPLEMENTED/)
  const result = run('run', '--plan', plan, '--out', out, '--adapter', 'synthetic-fixture')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(readFileSync(join(out, 'manifest.json'))).paperEligibility, 'NOT_QUALIFIED')
}))
