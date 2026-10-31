#!/usr/bin/env node
/**
 * C3:auth-matrix / template-isolation / timezone-settings 三套件,
 * 每套件 fresh 实例 + 预引导(admin 注册 + security.allowRegistration=true)+ stdout 落盘。
 */
import { spawn, spawnSync } from 'node:child_process'
import { openSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'D:/codes/ABO/AgentWorkShop'
const LOGDIR = join(REPO, 'docs', 'audit', 'evidence', '2026-10-29-ralph-full-acceptance', 'logs')
mkdirSync(LOGDIR, { recursive: true })
process.env.NO_PROXY = '127.0.0.1,localhost'

const SUITES = [
  { name: 'auth-matrix', port: 3021, args: ['scripts/e2e-auth-matrix.mjs'], env: b => ({ BASE_URL: b }) },
  { name: 'template-isolation', port: 3022, args: ['scripts/e2e-template-isolation.mjs'], env: b => ({ BASE_URL: b }) },
  { name: 'timezone-settings', port: 3023, args: ['scripts/e2e-timezone-settings.mjs'], env: () => ({}), argv: b => [b] },
]

const health = async (port) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2500) })
    return r.ok ? (await r.json())?.data ?? null : null
  } catch { return null }
}

const summary = []
for (const s of SUITES) {
  const home = join('D:/tmp', `aw-ralph-c3-${s.name}`)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const BASE = `http://127.0.0.1:${s.port}`
  const logFd = openSync(join(LOGDIR, `c3-${s.name}.log`), 'a')
  const child = spawn(process.execPath, [join(REPO, '.output', 'server', 'index.mjs')], {
    cwd: REPO,
    env: { ...process.env, AW_MODE: 'home', AW_HOME: home, PORT: String(s.port), NUXT_SESSION_PASSWORD: `ralph-c3-${s.name}-session-key-32ch!`, AW_TRIAL_INTERVAL_MS: '0', NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '' },
    detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
  })
  child.unref()
  let up = null
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise(r => setTimeout(r, 1500))
    up = await health(s.port)
  }
  if (!up) {
    summary.push({ name: s.name, verdict: 'INSTANCE_BOOT_FAIL' })
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    continue
  }
  // 预引导:首注册=admin → 打开自助注册(三个套件都要自助注册多个用户)
  const reg = await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'c3-bootstrap', email: `c3-${s.name}@test.local`, password: 'C3#Bootstrap#2026' }) }).then(r => r.json()).catch(() => ({}))
  const adminToken = reg?.data?.token
  if (adminToken) {
    await fetch(`${BASE}/api/system/settings`, { method: 'PATCH', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ override: { 'security.allowRegistration': true } }) }).catch(() => {})
  }
  const suiteFd = openSync(join(LOGDIR, `c3-${s.name}-suite.log`), 'a')
  const r = spawnSync('node', [...s.args, ...(s.argv ? s.argv(BASE) : [])], {
    cwd: REPO, encoding: 'utf8', timeout: 12 * 60_000,
    env: { ...process.env, ...(s.env ? s.env(BASE) : {}), NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '' },
    windowsHide: true,
  })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  writeFileSync(join(LOGDIR, `c3-${s.name}-suite.log`), out)
  const lines = out.trim().split(/\r?\n/).filter(Boolean)
  summary.push({ name: s.name, exit: r.status, boot: 'ok', adminBootstrapped: Boolean(adminToken), tail: lines.slice(-4).join(' | ').slice(0, 500) })
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  await new Promise(r2 => setTimeout(r2, 2000))
}
writeFileSync(join(LOGDIR, 'c3-summary.json'), JSON.stringify(summary, null, 2))
for (const row of summary) console.log(`${row.exit === 0 ? 'PASS' : 'FAIL'} ${row.name} exit=${row.exit} ${row.tail ?? ''}`)
process.exitCode = summary.every(s => s.exit === 0) ? 0 : 1
