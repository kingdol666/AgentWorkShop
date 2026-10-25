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

function acquireFileLock(path: string, holder: string): string {
  const token = randomUUID()
  try {
    writeFileSync(path, JSON.stringify({ owner: holder, pid: process.pid, heartbeatAt: Date.now(), token }), { flag: 'wx' })
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    const existing = readFileLock(path)
    // 不做 read-then-delete 过期回收:另一个进程可能已换入新锁。
    throw new AppError(409, 'ENV_BUSY', `AML 环境被进程 ${existing?.pid ?? '?'}(${existing?.owner ?? '未知'})锁定;如确认其已退出,请清理 ${path}`)
  }
  return token
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
