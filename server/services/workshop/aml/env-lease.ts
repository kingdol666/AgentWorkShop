/**
 * AML 共享环境租约(G1.6 / B.9.4)。
 *
 * 规则:
 *  - 训练/评估/Solver 运行期间持**读租约**(可多个并发);
 *  - 安装/重建/`ensureVenv({force:true})` 持**独占锁**:先拒绝新租约,等待所有读者释放;
 *    有读者时返回 ENV_BUSY(首版不强删占用目录,Windows 上 rmSync 会失败)。
 *
 * 进程内租约 + 跨进程文件锁:
 *  - 进程内用计数器(本文件);
 *  - 跨进程用 `<amlRoot>/runtime/env.lock` 文件锁(owner + heartbeat),仅用于阻止
 *    另一个 aw 进程同时重建同一环境。崩溃遗留锁需人工确认旧进程已退出后清理。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../../utils/errors'

export interface EnvReadLease {
  holder: string
  released: boolean
  release(): void
}

export interface EnvLeaseStatus {
  readers: number
  holders: string[]
  exclusive: string | null
  fileLock: { path: string, owner: string, pid: number, heartbeatAt: number } | null
}

const g = globalThis as typeof globalThis & {
  __amlEnvLease?: { readers: Map<string, number>, exclusive: string | null, lockPath: string | null }
}

function state() {
  g.__amlEnvLease ??= { readers: new Map<string, number>(), exclusive: null, lockPath: null }
  return g.__amlEnvLease
}

export function acquireEnvReadLease(holder: string): EnvReadLease {
  const s = state()
  if (s.exclusive) {
    throw new AppError(409, 'ENV_BUSY', `AML 环境正在维护(${s.exclusive}),暂不接受新任务;请等待安装/重建完成`)
  }
  s.readers.set(holder, (s.readers.get(holder) ?? 0) + 1)
  let released = false
  return {
    holder,
    get released() { return released },
    release() {
      if (released) return
      released = true
      const count = (s.readers.get(holder) ?? 1) - 1
      if (count <= 0) s.readers.delete(holder)
      else s.readers.set(holder, count)
    },
  }
}

/** 重建前检查:有读者立即 ENV_BUSY(不阻塞等待,避免请求挂死)。 */
export function assertEnvIdleForMaintenance(holder: string): void {
  const s = state()
  if (s.exclusive && s.exclusive !== holder) {
    throw new AppError(409, 'ENV_BUSY', `AML 环境已被 ${s.exclusive} 独占,拒绝重复维护`)
  }
  if (s.readers.size > 0) {
    const who = [...s.readers.keys()].join(', ')
    throw new AppError(409, 'ENV_BUSY', `AML 环境仍有在途任务(${who}),拒绝重建/安装`)
  }
}

/** 独占锁:进入时拒绝并发读者;退出时释放。 */
export async function withEnvExclusiveLock<T>(holder: string, amlRoot: string, fn: () => Promise<T> | T): Promise<T> {
  const s = state()
  assertEnvIdleForMaintenance(holder)
  s.exclusive = holder
  let lockPath: string | undefined
  let token: string | undefined
  try {
    lockPath = fileLockPath(amlRoot)
    token = acquireFileLock(lockPath, holder)
    return await fn()
  }
  finally {
    s.exclusive = null
    if (lockPath && token) releaseFileLock(lockPath, token)
  }
}

export function envLeaseStatus(amlRoot?: string): EnvLeaseStatus {
  const s = state()
  const lockPath = amlRoot ? fileLockPath(amlRoot) : null
  const lock = lockPath ? readFileLock(lockPath) : null
  return {
    readers: [...s.readers.values()].reduce((a, b) => a + b, 0),
    holders: [...s.readers.keys()],
    exclusive: s.exclusive,
    fileLock: lock && lockPath ? { path: lockPath, ...lock } : null,
  }
}

function fileLockPath(amlRoot: string): string {
  const dir = join(amlRoot, 'runtime')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'env.lock')
}

interface FileLock { owner: string, pid: number, heartbeatAt: number, token?: string }

function readFileLock(path: string): FileLock | null {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as FileLock
  }
  catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  }
  catch (err) {
    // EPERM = 进程存在但无权限;仅 ESRCH 才算已死
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function acquireFileLock(path: string, holder: string): string {
  const token = randomUUID()
  const payload = () => JSON.stringify({ owner: holder, pid: process.pid, heartbeatAt: Date.now(), token })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, payload(), { flag: 'wx' })
      return token
    }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    // 独占创建失败:区分"活锁"与"崩溃残留"。
    // 持有者崩溃(尤其 Windows TerminateProcess 不跑信号处理)会留下永久锁,
    // 使 AML 环境维护(venv 安装)此后每次 409 直到人工删文件 —— 必须能自愈。
    // 注意:同 PID + 不同 token 视为**另一个持有者**(同进程并发维护也必须互斥),
    // 只有 PID 已不存在才允许接管。
    const existing = readFileLock(path)
    // 存活即拒绝(含本进程的并发维护:同 PID 不同 token 仍是另一个持有者)
    if (existing?.pid && pidAlive(existing.pid)) {
      throw new AppError(409, 'ENV_BUSY', `AML 环境被进程 ${existing.pid}(${existing.owner ?? '未知'})锁定;如确认其已退出,请清理 ${path}`)
    }
    // 死 PID / 内容损坏 → 清理后重试 wx(仍保持"另一进程可能已换入新锁"的竞态安全:
    // 只有本轮 wx 成功才算拿到;两进程同时清理时只有一个能 wx 成功)。
    console.warn(`[aml-env] 接管崩溃残留的环境锁(pid=${existing?.pid ?? '?'} 已不存在):${path}`)
    try {
      rmSync(path, { force: true })
    }
    catch { /* 竞态留待下一轮 */ }
  }
  throw new AppError(409, 'ENV_BUSY', `AML 环境锁竞争失败(持续 EEXIST):${path}`)
}

function releaseFileLock(path: string, token: string): void {
  const existing = readFileLock(path)
  if (existing?.pid === process.pid && existing.token === token) rmSync(path, { force: true })
}

/** 观察项:租约文件更新时间(排障用,不参与判定)。 */
export function envLockMtime(amlRoot: string): number | null {
  try {
    return statSync(fileLockPath(amlRoot)).mtimeMs
  }
  catch {
    return null
  }
}
