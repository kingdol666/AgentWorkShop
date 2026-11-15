import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'

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

function readHolder(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'))
  }
  catch {
    return null
  }
}

/** Cross-process lock shared by every CLI path that writes .nuxt/.output. */
export async function withBuildLock(appRoot, fn, { timeoutMs = 30 * 60_000, staleMs = 24 * 60 * 60_000 } = {}) {
  const runtimeDir = join(appRoot, '.runtime')
  const lockPath = join(runtimeDir, 'build.lock')
  mkdirSync(runtimeDir, { recursive: true })
  const started = Date.now()
  let fd
  while (fd === undefined) {
    try {
      fd = openSync(lockPath, 'wx', 0o600)
    }
    catch (err) {
      if (err?.code !== 'EEXIST') throw err
      const holder = readHolder(lockPath)
      const age = existsSync(lockPath) ? Date.now() - (Date.parse(holder?.startedAt ?? '') || 0) : 0
      if (!pidAlive(Number(holder?.pid)) && (!holder || age > staleMs)) {
        try {
          rmSync(lockPath, { force: true })
        }
        catch { /* 竞态:下一轮重试 */ }
        continue
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for build lock held by pid ${holder?.pid ?? 'unknown'} (${lockPath})`, { cause: err })
      }
      await new Promise(resolve => setTimeout(resolve, 250))
      continue
    }
    try {
      const body = Buffer.from(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), appRoot }))
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
    if (existsSync(serviceLockPath)) {
      const service = readHolder(serviceLockPath)
      if (pidAlive(Number(service?.pid))) {
        throw new Error(`Cannot rebuild .output while service pid ${service.pid} is running; stop the service first (${serviceLockPath})`)
      }
    }
    return await fn()
  }
  finally {
    try {
      const owner = JSON.parse(readFileSync(lockPath, 'utf8'))
      if (owner.pid === process.pid && owner.appRoot === appRoot) rmSync(lockPath, { force: true })
    }
    catch { /* Never delete a lock whose owner cannot be verified. */ }
  }
}
