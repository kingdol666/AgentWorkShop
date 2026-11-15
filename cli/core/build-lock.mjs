import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** 锁文件刚创建但内容尚未落盘的宽限窗(读不到 holder 时不得立即抢占)。 */
const EMPTY_LOCK_GRACE_MS = 60_000

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  }
  catch (err) {
    return err?.code === 'EPERM'
  }
}

function readRaw(path) {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return null
  }
}

function parseHolder(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  }
  catch {
    return null
  }
}

function lockAgeMs(lockPath) {
  try {
    return Math.max(0, Date.now() - statSync(lockPath).mtimeMs)
  }
  catch {
    return 0
  }
}

/**
 * Cross-process lock shared by every CLI path that writes .nuxt/.output.
 *
 * 回收规则(任一即可,且删除前二次确认锁内容未被替换):
 *  - holder JSON 可读且 pid 已死 → 立即回收(残留锁不应把构建挡满 staleMs);
 *  - 锁文件不可读(空/半写)且超过 60s 宽限 → 视为崩溃残留;
 *  - 锁龄超过 staleMs(默认 2h)→ 视为 PID 复用/失控构建。
 */
export async function withBuildLock(appRoot, fn, { timeoutMs = 30 * 60_000, staleMs = 2 * 60 * 60_000 } = {}) {
  const runtimeDir = join(appRoot, '.runtime')
  const lockPath = join(runtimeDir, 'build.lock')
  mkdirSync(runtimeDir, { recursive: true })
  const started = Date.now()
  const nonce = randomUUID()
  let fd
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, 'wx', 0o600)
    }
    catch (err) {
      if (err?.code !== 'EEXIST') throw err
      const raw = readRaw(lockPath)
      const holder = parseHolder(raw)
      const age = lockAgeMs(lockPath)
      const holderAlive = pidAlive(Number(holder?.pid))
      const reclaim = (holder && !holderAlive)
        || (!holder && age > EMPTY_LOCK_GRACE_MS)
        || age > staleMs
      if (reclaim) {
        // 判定与删除之间可能有人重新持锁:内容变了就不删(下一轮重新判定)
        if (readRaw(lockPath) === raw) {
          try {
            rmSync(lockPath, { force: true })
          }
          catch { /* 竞态:下一轮重试 */ }
        }
        continue
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for build lock held by pid ${holder?.pid ?? 'unknown'} (${lockPath})`, { cause: err })
      }
      await new Promise(resolve => setTimeout(resolve, 250))
      continue
    }
    try {
      const body = Buffer.from(JSON.stringify({ pid: process.pid, nonce, startedAt: new Date().toISOString(), appRoot }))
      writeSync(fd, body)
    }
    catch (err) {
      // 写锁失败:本进程已持有锁,清掉再抛,避免残留锁把后续构建挡到超时
      try {
        closeSync(fd)
      }
      catch { /* 已关闭 */ }
      try {
        rmSync(lockPath, { force: true })
      }
      catch { /* 清理失败交给超时逻辑 */ }
      throw err
    }
    closeSync(fd)
    break
  }
  try {
    const serviceLockPath = join(runtimeDir, 'aw.lock')
    const service = parseHolder(readRaw(serviceLockPath))
    if (pidAlive(Number(service?.pid))) {
      throw new Error(`Cannot rebuild .output while service pid ${service.pid} is running; stop the service first (${serviceLockPath})`)
    }
    return await fn()
  }
  finally {
    const owner = parseHolder(readRaw(lockPath))
    if (owner?.pid === process.pid && owner?.nonce === nonce && owner?.appRoot === appRoot) {
      try {
        rmSync(lockPath, { force: true })
      }
      catch { /* 释放失败由 staleMs 兜底 */ }
    }
  }
}
