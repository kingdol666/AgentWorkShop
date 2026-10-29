#!/usr/bin/env node
/**
 * 2026-10-29 生产投产验收 — REST 面套件驱动:每套件独占 fresh 实例(端口 3051-3058),
 * 预引导(admin + allowRegistration)后串行执行,套件 stdout 全量落盘。
 * hitl-live 也纳入(自带 puppeteer/WS,--base 指向 fresh 实例)。
 */
import { spawn, spawnSync } from 'node:child_process'
import { openSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'D:/codes/ABO/AgentWorkShop'
const LOGDIR = join(REPO, 'docs', 'audit', 'evidence', '2026-10-29-prod-acceptance', 'logs')
mkdirSync(LOGDIR, { recursive: true })
process.env.NO_PROXY = '127.0.0.1,localhost'

const SUITES = [
  { name: 'api-live', port: 3051, args: ['scripts/api-live-e2e.mjs'], env: b => ({ AW_BASE: b }), seed: false },
  { name: 'auth-matrix', port: 3052, args: ['scripts/e2e-auth-matrix.mjs'], env: b => ({ BASE_URL: b }), seed: true },
  { name: 'template-isolation', port: 3053, args: ['scripts/e2e-template-isolation.mjs'], env: b => ({ BASE_URL: b }), seedAdmin: 'zhangwei' },
  { name: 'rest-robustness', port: 3054, args: ['scripts/e2e-rest-robustness.mjs'], env: b => ({ AW_E2E_BASE: b }), seed: false },
  { name: 'timezone-settings', port: 3055, args: ['scripts/e2e-timezone-settings.mjs'], env: () => ({}), argv: b => [b], seed: false, tzData: true },
  { name: 'agent-team', port: 3056, args: ['scripts/e2e-agent-team.mjs'], env: () => ({}), argv: b => [`--base=${b}`], seed: false },
  { name: 'hitl-live', port: 3057, args: ['scripts/e2e-hitl-live.mjs'], env: () => ({}), argv: b => ['--base', b], seed: true },
  { name: 'error-handling', port: 3058, cmd: 'node', args: ['scripts/e2e-error-handling.mjs'], env: () => ({}), selfSpawn: true },
]

const health = async (port) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2500) })
    return r.ok ? (await r.json())?.data ?? null : null
  } catch { return null }
}

const summary = []
for (const s of SUITES) {
  const logPath = join(LOGDIR, `t3-${s.name}.log`)
  if (s.selfSpawn) {
    // error-handling 自管实例(内置),直接跑
    const r = spawnSync('node', s.args, { cwd: REPO, encoding: 'utf8', timeout: 14 * 60_000, env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '' }, windowsHide: true })
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    writeFileSync(logPath, out)
    const tail = out.trim().split(/\r?\n/).filter(Boolean)
    summary.push({ name: s.name, exit: r.status, tail: tail.slice(-3).join(' | ').slice(0, 300) })
    continue
  }
  const home = join('D:/tmp', `aw-prod-acc-${s.name}`)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const BASE = `http://127.0.0.1:${s.port}`
  const logFd = openSync(join(LOGDIR, `t3-${s.name}-boot.log`), 'a')
  const child = spawn(process.execPath, [join(REPO, '.output', 'server', 'index.mjs')], {
    cwd: REPO,
    env: { ...process.env, AW_MODE: 'home', AW_HOME: home, PORT: String(s.port), NUXT_SESSION_PASSWORD: `prod-acc-${s.name}-session-key-32ch!`, AW_TRIAL_INTERVAL_MS: '0', NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '' },
    detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
  })
  child.unref()
  let up = null
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise(r => setTimeout(r, 1500))
    up = await health(s.port)
  }
  if (!up) {
    summary.push({ name: s.name, exit: 'BOOT_FAIL' })
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    continue
  }
  if (s.seed || s.seedAdmin) {
    const email = s.seedAdmin ? 'zhangwei@awshop.io' : `seed-${s.name}@test.local`
    const password = s.seedAdmin ? 'Awshop@123' : `Seed#${s.name}#2026`
    const reg = await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'seed-admin', email, password }) }).then(r => r.json()).catch(() => ({}))
    if (reg?.data?.token) {
      await fetch(`${BASE}/api/system/settings`, { method: 'PATCH', headers: { authorization: `Bearer ${reg.data.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ override: { 'security.allowRegistration': true } }) }).catch(() => {})
    }
  }
  const r = spawnSync('node', [...s.args, ...(s.argv ? s.argv(BASE) : [])], {
    cwd: REPO, encoding: 'utf8', timeout: 14 * 60_000,
    env: { ...process.env, ...(s.env ? s.env(BASE) : {}), ...(s.tzData ? { AW_TZ_DATA: join(home, 'data') } : {}), NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '' },
    windowsHide: true,
  })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  writeFileSync(logPath, out)
  const lines = out.trim().split(/\r?\n/).filter(Boolean)
  summary.push({ name: s.name, exit: r.status, tail: lines.slice(-3).join(' | ').slice(0, 300) })
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  await new Promise(r2 => setTimeout(r2, 2000))
}
writeFileSync(join(LOGDIR, 't3-summary.json'), JSON.stringify(summary, null, 2))
for (const row of summary) console.log(`${row.exit === 0 ? 'PASS' : 'FAIL'} ${row.name} exit=${row.exit} ${(row.tail ?? '').slice(0, 160)}`)
process.exitCode = summary.every(s => s.exit === 0) ? 0 : 1
