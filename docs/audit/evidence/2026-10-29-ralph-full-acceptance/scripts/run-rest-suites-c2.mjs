#!/usr/bin/env node
/**
 * C2 驱动:每个 REST 面套件独占一个 fresh 实例(端口 3011-3015,独立 home),
 * 串行 执行→收集尾行→杀实例,消除共享实例的设置污染(allowRegistration 等)。
 */
import { spawn, spawnSync } from 'node:child_process'
import { openSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'D:/codes/ABO/AgentWorkShop'
const LOGDIR = join(REPO, 'docs', 'audit', 'evidence', '2026-10-29-ralph-full-acceptance', 'logs')
mkdirSync(LOGDIR, { recursive: true })
process.env.NO_PROXY = '127.0.0.1,localhost'

const SUITES = [
  { name: 'auth-matrix', port: 3011, cmd: 'node', args: ['scripts/e2e-auth-matrix.mjs'], env: b => ({ BASE_URL: b }) },
  { name: 'template-isolation', port: 3012, cmd: 'node', args: ['scripts/e2e-template-isolation.mjs'], env: b => ({ BASE_URL: b }) },
  { name: 'rest-robustness', port: 3013, cmd: 'node', args: ['scripts/e2e-rest-robustness.mjs'], env: b => ({ AW_E2E_BASE: b }) },
  { name: 'timezone-settings', port: 3014, cmd: 'node', args: ['scripts/e2e-timezone-settings.mjs'], env: b => ({ TZ_BASE: b }), argv: b => [b] },
  { name: 'agent-team', port: 3015, cmd: 'node', args: ['scripts/e2e-agent-team.mjs'], env: () => ({}), argv: b => [`--base=${b}`] },
]

const health = async (port) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2500) })
    return r.ok ? (await r.json())?.data ?? null : null
  } catch { return null }
}

const summary = []
for (const s of SUITES) {
  const home = join('D:/tmp', `aw-ralph-c2-${s.name}`)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  const BASE = `http://127.0.0.1:${s.port}`
  const logFd = openSync(join(LOGDIR, `c2-${s.name}.log`), 'a')
  const child = spawn(process.execPath, [join(REPO, '.output', 'server', 'index.mjs')], {
    cwd: REPO,
    env: { ...process.env, AW_MODE: 'home', AW_HOME: home, PORT: String(s.port), NUXT_SESSION_PASSWORD: `ralph-c2-${s.name}-session-key-32ch!`, AW_TRIAL_INTERVAL_MS: '0', NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '' },
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
  const argv = (s.argv ? s.argv(BASE) : [])
  const r = spawnSync(s.cmd, [...s.args, ...argv], {
    cwd: REPO, encoding: 'utf8', timeout: 12 * 60_000,
    env: { ...process.env, ...(s.env ? s.env(BASE) : {}), NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '' },
    windowsHide: true,
  })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  const lines = out.trim().split(/\r?\n/).filter(Boolean)
  summary.push({ name: s.name, exit: r.status, boot: 'ok', tail: lines.slice(-4).join(' | ').slice(0, 500) })
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  await new Promise(r2 => setTimeout(r2, 2000))
}
writeFileSync(join(LOGDIR, 'c2-summary.json'), JSON.stringify(summary, null, 2))
for (const row of summary) console.log(`${row.verdict ?? row.exit === 0 ? 'PASS' : 'FAIL'} ${row.name} exit=${row.exit ?? row.verdict} ${row.tail ?? ''}`)
process.exitCode = summary.every(s => s.exit === 0) ? 0 : 1
