#!/usr/bin/env node
/**
 * 生产构建启动冒烟(CI 用):在隔离 home 上真启 `.output/server/index.mjs`,
 * 断言健康门、SSR 首页与鉴权 401,并验证缺会话密钥时安全插件拒绝启动。
 *
 * 只读本地端口与临时目录;不接触现用实例、共享 home 或外部服务。
 * 用法:先 `pnpm run build`,再 `node scripts/ci-boot-smoke.mjs`。
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(repo, '.output', 'server', 'index.mjs')
const HOST = '127.0.0.1'
const failures = []
const passes = []

function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  ;(ok ? passes : failures).push(name)
}

async function freePort() {
  const server = createServer()
  await new Promise((res, rej) => {
    server.once('error', rej)
    server.listen(0, HOST, res)
  })
  const { port } = server.address()
  await new Promise(res => server.close(() => res()))
  return port
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function startServer({ home, port, withSessionSecret }) {
  const env = {
    ...process.env,
    AW_MODE: 'home',
    AW_HOME: home,
    PORT: String(port),
    NITRO_HOST: HOST,
    NITRO_PORT: String(port),
    BACKUP_DISABLED: '1',
    NODE_ENV: 'production',
  }
  if (withSessionSecret) env.NUXT_SESSION_PASSWORD = randomBytes(32).toString('hex')
  else delete env.NUXT_SESSION_PASSWORD
  // 冒烟只验证本机数据面:显式清掉可能指向共享后端的变量,避免 CI 依赖外部服务
  for (const key of ['DAQ_TSDB_URL', 'AW_DATA_DIR', 'AW_STOP_TOKEN', 'AW_PARENT_PID']) delete env[key]
  const child = spawn(process.execPath, [entry], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  child.stdout.on('data', (d) => {
    output += String(d)
  })
  child.stderr.on('data', (d) => {
    output += String(d)
  })
  const closed = new Promise(resolveClose => child.once('close', resolveClose))
  return { child, closed, log: () => output }
}

async function waitHealthy(port, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://${HOST}:${port}/api/health`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) return await res.json()
    }
    catch { /* 启动中 */ }
    await sleep(500)
  }
  return null
}

async function stopChild(child, closed) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const outcome = await Promise.race([closed, sleep(15_000).then(() => 'timeout')])
  if (outcome === 'timeout' && child.exitCode === null) {
    child.kill('SIGKILL')
    await Promise.race([closed, sleep(5_000)])
  }
}

if (!existsSync(entry)) {
  console.error(`✖ 缺少 ${entry};请先 pnpm run build`)
  process.exit(1)
}

console.log('\n━━━ B1. 正常启动:健康门 + SSR + 鉴权 ━━━')
const home = mkdtempSync(join(tmpdir(), 'aw-ci-boot-'))
let child
let closed
try {
  const port = await freePort()
  const started = startServer({ home, port, withSessionSecret: true })
  child = started.child
  closed = started.closed
  const health = await waitHealthy(port)
  check('GET /api/health 可达', Boolean(health), health ? `version=${health.data?.version}` : 'timeout')
  if (health) {
    check('health status=ok 且 workshop=ready', health.data?.status === 'ok' && health.data?.workshop === 'ready', `status=${health.data?.status} workshop=${health.data?.workshop}`)
  }
  const page = await fetch(`http://${HOST}:${port}/`, { signal: AbortSignal.timeout(15_000) })
  const html = await page.text()
  check('GET / SSR 200 且返回 HTML', page.status === 200 && /<html/i.test(html), `status=${page.status} bytes=${html.length}`)
  const guarded = await fetch(`http://${HOST}:${port}/api/workshop/aml`, { signal: AbortSignal.timeout(10_000) })
  check('未鉴权 /api/workshop/aml → 401', guarded.status === 401, `status=${guarded.status}`)
}
finally {
  if (child) await stopChild(child, closed)
}

console.log('\n━━━ B2. 缺会话密钥:安全插件必须拒绝启动 ━━━')
{
  const port = await freePort()
  const started = startServer({ home: mkdtempSync(join(tmpdir(), 'aw-ci-boot-nosecret-')), port, withSessionSecret: false })
  const outcome = await Promise.race([started.closed, sleep(90_000).then(() => 'timeout')])
  const exited = outcome !== 'timeout'
  check('缺 NUXT_SESSION_PASSWORD 不在 90s 内提供健康服务', exited, exited ? `exit=${outcome}` : 'still running')
  check('拒绝原因写入日志', /sessionPassword|NUXT_SESSION_PASSWORD/i.test(started.log()), started.log().split('\n').find(l => /sessionPassword/i.test(l))?.slice(0, 160) ?? 'no marker')
  await stopChild(started.child, started.closed)
}

// 清理是尽力而为:Windows 上刚退出的子进程可能短暂占用 sqlite 句柄,清理失败不算门禁失败
try {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
catch {
  console.log(`  INFO  临时 home 未立即删除(句柄占用): ${home}`)
}

console.log(`\nRESULT ${failures.length === 0 ? 'PASS' : 'FAIL'} ${passes.length}/${passes.length + failures.length}`)
process.exit(failures.length === 0 ? 0 : 1)
