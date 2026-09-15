/**
 * bench/lib/platform.mjs —— 平台自举：探测 → 不在则分离启动 bin/aw.mjs → 轮询就绪。
 *
 * 与 sim.mjs 的 ensureSimulator 对称：benchmark 的执行卡承诺"单命令端到端"，
 * 平台不在运行时必须由流程自己拉起（detached + unref，父进程退出不影响被测系统）。
 * 就绪判据 = GET /api/users/setup-status 返回 JSON（与 PIPELINE.md 执行卡一致）。
 * 凭据纪律：不注入任何凭据；首启实例由流程本身的 admin 默认注册语义处理（bench 惯例）。
 */
import { spawn } from 'node:child_process'
import { existsSync, openSync } from 'node:fs'
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
 * @returns {{started:boolean, pid?:number, log:string, reason?:string}}
 */
export async function ensurePlatform({ base = 'http://127.0.0.1:3001', timeoutMs = 150_000, log = console.log } = {}) {
  if (await platformUp(base)) return { started: false, log: '', reason: 'already-up' }
  const port = Number(new URL(base).port || 3001)
  const entry = join(REPO, 'bin', 'aw.mjs')
  if (!existsSync(entry)) return { started: false, log: '', reason: `入口不存在: ${entry}（请先在仓库根执行 pnpm install && pnpm build）` }
  const logPath = process.env.AW_BENCH_PLATFORM_LOG ?? resolve(REPO, '..', 'aw-bench-platform.log')
  const out = openSync(logPath, 'a')
  const child = spawn(process.execPath, [entry, 'start', '--port', String(port)], {
    cwd: REPO,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
    windowsHide: true,
  })
  child.unref()
  log(`  · 平台未在线 → 分离启动 (pid=${child.pid}, cwd=${REPO}, 日志 ${logPath})`)
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await sleep(2000)
    if (await platformUp(base)) return { started: true, pid: child.pid, log: logPath }
  }
  return { started: false, pid: child.pid, log: logPath, reason: `启动后 ${timeoutMs}ms 内未就绪（查看 ${logPath}）` }
}
