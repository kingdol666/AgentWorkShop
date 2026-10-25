#!/usr/bin/env node
/**
 * A20 质量门禁取证:真实运行 lint/typecheck/unit/i18n/docs,逐条记录 exitCode。
 * 用法:node scripts/run-quality-gates.mjs
 * 产物:docs/audit/evidence/2026-10-22-optimizer-process-model/gates.json
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const cwd = process.cwd()
const outDir = join(cwd, 'docs', 'audit', 'evidence', '2026-10-22-optimizer-process-model')
mkdirSync(outDir, { recursive: true })

const testFiles = readdirSync(join(cwd, 'tests')).filter(f => f.endsWith('.test.ts')).map(f => join('tests', f))

const steps = [
  { id: 'lint', cmd: process.execPath, args: [join('node_modules', 'eslint', 'bin', 'eslint.js'), '.'] },
  { id: 'typecheck', cmd: process.execPath, args: [join('scripts', 'typecheck.mjs')] },
  {
    id: 'unit',
    cmd: process.execPath,
    args: [
      join('node_modules', 'tsx', 'dist', 'cli.mjs'),
      '--tsconfig', join('.nuxt', 'tsconfig.server.json'),
      '--test', '--test-force-exit', ...testFiles,
    ],
  },
  { id: 'i18n', cmd: process.execPath, args: [join('scripts', '_i18n-verify-keys.mjs')] },
  { id: 'docs', cmd: process.execPath, args: [join('scripts', 'check-docs-sync.mjs')] },
]

function run(step) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString()
    const child = spawn(step.cmd, step.args, { cwd, shell: false, env: { ...process.env, FORCE_COLOR: '0' } })
    let tail = ''
    const collect = (chunk) => {
      tail = (tail + chunk.toString('utf8')).slice(-2000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', err => resolve({ id: step.id, exitCode: -1, startedAt, endedAt: new Date().toISOString(), command: [step.cmd, ...step.args].join(' '), tail: String(err) }))
    child.on('exit', code => resolve({ id: step.id, exitCode: code ?? -1, startedAt, endedAt: new Date().toISOString(), command: [step.cmd, ...step.args].join(' '), tail }))
  })
}

const results = []
for (const step of steps) {
  console.log(`[gates] ${step.id} …`)
  const result = await run(step)
  console.log(`[gates] ${step.id} exit=${result.exitCode}`)
  results.push(result)
}
const ok = results.every(r => r.exitCode === 0)
writeFileSync(join(outDir, 'gates.json'), JSON.stringify({ at: new Date().toISOString(), ok, results }, null, 2))
console.log(`[gates] ${ok ? 'ALL PASS' : 'FAILED'} → ${join(outDir, 'gates.json')}`)
process.exitCode = ok ? 0 : 1
