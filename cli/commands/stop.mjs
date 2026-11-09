// ============================================================
// 指令:stop —— 终止当前配置根下运行中的 aw 实例(读单实例锁 → 终止进程树)。
// 用法:aw stop [--home]   (--home 强制以 home 配置根为目标;默认随 cwd 解析)
// ============================================================
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { color } from '../core/logger.mjs'
import { isTruthy } from '../core/args.mjs'

const waitSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * 优先走 HTTP 优雅停机(令牌在 <configRoot>/.runtime/stop-token,由 start.mjs 写入)。
 * 成功 = nitro close 钩子已触发(停训练树/停内核/关库);失败/超时再回退 taskkill。
 * 端点要求环回 + 自定义 header,且只有 `aw start` 拉起的实例带令牌(dev 无令牌 → false)。
 */
async function tryGracefulStop(port, token) {
  if (!port || !token) return false
  try {
    const res = await fetch(`http://127.0.0.1:${Number(port)}/api/system/shutdown`, {
      method: 'POST',
      headers: { 'x-aw-stop-token': token, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  }
  catch {
    return false
  }
}

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
  // argv 为 parseArgs 结果({ flags, positionals, unknown });兼容裸数组调用
  const flags = argv?.flags ?? {}
  const positionals = Array.isArray(argv?.positionals) ? argv.positionals : (Array.isArray(argv) ? argv : [])
  // --home 接受布尔与字符串赋值两种形态(--home=true 走 parseArgs 是字符串)
  const forceHome = isTruthy(flags.home) || positionals.includes('--home')

  // 配置根必须与启动侧(start.mjs / dev-guard)同源:ctx.configRoot 已按
  // resolveRunMode 解析(检出内无 .AgentWorkShop 时回退 home),硬编码
  // <repo>/.AgentWorkShop 会对 home 模式运行实例失明。
  const configRoot = forceHome ? ctx.home : (ctx.configRoot ?? ctx.home)
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
  // 先礼貌后强制:HTTP 优雅停机能跑完 close 钩子(停训练树/停内核/关 DB),
  // 12s 未退出再走进程树强杀(Windows 上 close 钩子此前永远跑不到)。
  let token = ''
  try {
    token = readFileSync(join(configRoot, '.runtime', 'stop-token'), 'utf8').trim()
  }
  catch { /* 旧实例/未写入:直接强杀 */ }
  const graceful = await tryGracefulStop(holder?.port, token)
  if (graceful) {
    console.log(`› 已发送优雅停机请求,等待退出(最多 12s)…`)
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline && pidAlive(pid)) waitSync(200)
  }
  if (pidAlive(pid)) {
    try {
      killTree(pid)
    }
    catch (err) {
      console.error(`${color.red('✖')} 终止失败:${err.message}`)
      console.error(`  可手动执行:taskkill /PID ${pid} /T /F(Windows)`)
      return 1
    }
  }
  // 令牌与实例同生命周期;残留会让下次 stop 拿旧令牌打新实例
  try {
    rmSync(join(configRoot, '.runtime', 'stop-token'), { force: true })
  }
  catch { /* ignore */ }
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
