/**
 * bench/lib/platform.mjs —— 平台自举：探测 → 不在则分离启动 bin/aw.mjs → 轮询就绪。
 *
 * 与 sim.mjs 的 ensureSimulator 对称：benchmark 的执行卡承诺"单命令端到端"，
 * 平台不在运行时必须由流程自己拉起（detached + unref，父进程退出不影响被测系统）。
 * 就绪判据 = GET /api/users/setup-status 返回 JSON（与 PIPELINE.md 执行卡一致）。
 * 凭据纪律：不注入任何凭据；首启实例由流程本身的 admin 默认注册语义处理（bench 惯例）。
 */
import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sleep } from './util.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = resolve(HERE, '..', '..')

export const platformUp = async (base) => {
  try {
    const r = await fetch(`${base}/api/users/setup-status`, {
      signal: AbortSignal.timeout(6000),
      headers: { 'content-type': 'application/json' },
    })
    const j = await r.json().catch(() => null)
    return r.status === 200 && j != null
  } catch { return false }
}

/**
 * 确保平台在线：在线即复用；离线则 spawn `node bin/aw.mjs start --port <p>` 并等待就绪。
 * 崩溃感知重试：共享配置根冷启会自动顶替旧实例，旧进程句柄未放净时新进程可能在
 * initWorkshopDb 处 disk I/O error 崩溃（2026-09-19 实测）——检测到日志 fatal 且进程已死
 * 就不等满超时，等 5s 重试一次自愈该竞态；AW_HOME 隔离根冷启天然无此竞态。
 * @returns {{started:boolean, pid?:number, log:string, reason?:string}}
 */
export async function ensurePlatform({ base = 'http://127.0.0.1:3001', timeoutMs = 150_000, log = console.log } = {}) {
  if (await platformUp(base)) return { started: false, log: '', reason: 'already-up' }
  const port = Number(new URL(base).port || 3001)
  const entry = join(REPO, 'bin', 'aw.mjs')
  if (!existsSync(entry)) return { started: false, log: '', reason: `入口不存在: ${entry}（请先在仓库根执行 pnpm install && pnpm build）` }
  const logPath = process.env.AW_BENCH_PLATFORM_LOG ?? resolve(REPO, '..', 'aw-bench-platform.log')
  const isolation = process.env.AW_HOME ? `隔离配置根 ${process.env.AW_HOME}` : '共享配置根(同根旧实例会被自动顶替)'
  const crashed = () => {
    try { return /fatal uncaughtException|disk I\/O error/i.test(readFileSync(logPath, 'utf8').slice(-4000)) } catch { return false }
  }
  let pid = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = openSync(logPath, 'a')
    const child = spawn(process.execPath, [entry, 'start', '--port', String(port)], {
      cwd: REPO,
      detached: true,
      stdio: ['ignore', out, out],
      env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
      windowsHide: true,
    })
    child.unref()
    pid = child.pid
    log(`  · 平台未在线 → 分离启动 (pid=${child.pid}, cwd=${REPO}, ${isolation}, 日志 ${logPath})`)
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      await sleep(2000)
      if (await platformUp(base)) return { started: true, pid, log: logPath }
      if (crashed() && !(await processAlive(pid))) break
    }
    if (await platformUp(base)) return { started: true, pid, log: logPath }
    if (attempt === 1) {
      log('  · 平台启动疑似崩溃（日志含 fatal 且进程已死）→ 5s 后重试一次')
      await sleep(5000)
    }
  }
  return { started: false, pid, log: logPath, reason: `两次启动后仍未就绪（查看 ${logPath}）` }
}

/** Windows 下按 pid 探活；探测失败按存活处理（宁可等满超时也不误重试）。 */
const processAlive = (pid) => new Promise((resolveP) => {
  try {
    const p = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true })
    let buf = ''
    p.stdout.on('data', (d) => { buf += String(d) })
    p.on('close', () => resolveP(buf.includes(String(pid))))
    p.on('error', () => resolveP(true))
  } catch { resolveP(true) }
})
