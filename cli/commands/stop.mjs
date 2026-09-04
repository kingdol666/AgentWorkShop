// ============================================================
// 指令:stop —— 终止当前配置根下运行中的 aw 实例(读单实例锁 → 终止进程树)。
// 用法:aw stop [--home]   (--home 强制以 home 配置根为目标;默认随 cwd 解析)
// ============================================================
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { color } from '../core/logger.mjs'

export const meta = {
  name: 'stop',
  aliases: [],
  group: '服务',
  summary: '终止运行中的 aw 服务实例(读单实例锁)',
  usage: 'aw stop [--home]',
  needsProject: false,
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (err) {
    return err?.code === 'EPERM'
  }
}

/** 终止进程树:Windows taskkill /T /F;POSIX 先 SIGTERM 宽限 5s 再 SIGKILL */
function killTree(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'taskkill 失败').trim().split(/\r?\n/)[0])
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  }
  catch { /* 已死 */ }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && pidAlive(pid)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
  if (pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    }
    catch { /* 已死 */ }
  }
}

export async function run(argv, ctx) {
  const forceHome = (argv ?? []).some(a => a === '--home')

  const configRoot = forceHome
    ? ctx.home
    : (ctx.mode === 'repo' ? join(ctx.root, '.AgentWorkShop') : ctx.home)
  const lockPath = join(configRoot, '.runtime', 'aw.lock')

  if (!existsSync(lockPath)) {
    console.log(`${color.blue('ℹ')} 未发现运行中的实例(无锁文件:${lockPath})`)
    return 0
  }
  let holder
  try {
    holder = JSON.parse(readFileSync(lockPath, 'utf8'))
  }
  catch {
    rmSync(lockPath, { force: true })
    console.log(`${color.blue('ℹ')} 锁文件损坏,已清除:${lockPath}`)
    return 0
  }

  const pid = Number(holder?.pid)
  if (!Number.isInteger(pid) || pid <= 0) {
    rmSync(lockPath, { force: true })
    console.log(`${color.blue('ℹ')} 锁内 PID 无效,已清除锁文件`)
    return 0
  }
  if (!pidAlive(pid)) {
    rmSync(lockPath, { force: true })
    console.log(`${color.blue('ℹ')} 持锁进程已不存在(pid=${pid},残留锁),已清除锁文件`)
    return 0
  }

  console.log(`› 终止实例 pid=${pid}(mode=${holder.mode ?? '?'}${holder.port ? `,端口=${holder.port}` : ''},启动于 ${holder.startedAt ?? '?'})`)
  try {
    killTree(pid)
  }
  catch (err) {
    console.error(`${color.red('✖')} 终止失败:${err.message}`)
    console.error(`  可手动执行:taskkill /PID ${pid} /T /F(Windows)`)
    return 1
  }
  // 锁文件由退出钩子自清;残留则手动兜底
  for (let i = 0; i < 20 && existsSync(lockPath); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }
  try {
    if (existsSync(lockPath)) rmSync(lockPath, { force: true })
  }
  catch { /* ignore */ }
  console.log(`${color.green('✔')} 实例已停止(pid=${pid})`)
  return 0
}
