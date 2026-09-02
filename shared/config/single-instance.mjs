// ============================================================
// 单实例互斥(hardening ST-1)—— 零依赖,CLI / 启动脚本通用。
// 锁文件 <configRoot>/.runtime/aw.lock 原子创建(wx):
//   { pid, startedAt, mode, port }
// 已存在且 PID 存活 → 视为已有实例(返回冲突信息,调用方以退出码 2 退出);
// PID 已死(崩溃/强杀残留) → 自动接管重写。进程退出时 releaseLock 兜底清理。
// ============================================================
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    // signal 0 探活:进程存在但不发信号;ESRCH=不存在,EPERM=存在(他人进程)
    process.kill(pid, 0)
    return true
  }
  catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * 尝试获取单实例锁。
 * @returns {{ ok: true, lockPath: string, release: () => void }
 *   | { ok: false, lockPath: string, holder: { pid: number, startedAt: string, mode: string, port: number | null } }}
 */
export function acquireLock(configRoot, { mode = 'prod', port = null } = {}) {
  const runtimeDir = join(configRoot, '.runtime')
  const lockPath = join(runtimeDir, 'aw.lock')
  mkdirSync(runtimeDir, { recursive: true })
  if (existsSync(lockPath)) {
    let holder = null
    try {
      holder = JSON.parse(readFileSync(lockPath, 'utf8'))
    }
    catch { /* 损坏锁文件按残留处理 */ }
    if (holder && pidAlive(holder.pid)) {
      return { ok: false, lockPath, holder: { ...holder, port: holder.port ?? null } }
    }
    try { rmSync(lockPath) } catch { /* 抢不掉则下方 wx 再失败 */ }
  }
  const me = { pid: process.pid, startedAt: new Date().toISOString(), mode, port }
  try {
    writeFileSync(lockPath, JSON.stringify(me, null, 2), { flag: 'wx' })
  }
  catch (err) {
    // 与并发启动者竞态:按冲突处理
    let holder = null
    try { holder = JSON.parse(readFileSync(lockPath, 'utf8')) } catch { /* ignore */ }
    if (holder && pidAlive(holder.pid)) {
      return { ok: false, lockPath, holder: { ...holder, port: holder.port ?? null } }
    }
    throw err
  }
  let released = false
  const release = () => {
    if (released) return
    released = true
    try {
      const cur = JSON.parse(readFileSync(lockPath, 'utf8'))
      if (cur?.pid !== process.pid) return // 锁已被他人接管,不误删
      rmSync(lockPath)
    }
    catch { /* 已不存在/损坏,忽略 */ }
  }
  process.once('exit', release)
  process.once('SIGINT', () => { release(); process.exit(130) })
  process.once('SIGTERM', () => { release(); process.exit(143) })
  return { ok: true, lockPath, release }
}

/** 端口占用探测:返回占用进程 PID(未占用返回 null)。TCP try-listen 后立刻释放。 */
export async function checkPort(host, port) {
  const net = await import('node:net')
  return new Promise((resolveProbe) => {
    const srv = net.createServer()
    srv.once('error', (err) => {
      resolveProbe(err?.code === 'EADDRINUSE' ? port : null)
      srv.close()
    })
    srv.listen(port, host, () => {
      srv.close(() => resolveProbe(null))
    })
  })
}
