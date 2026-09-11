// ============================================================
// AgentWorkShop CLI — 子进程生命周期工具（共享）
// ------------------------------------------------------------
// aw dev / start / build 都把「前台运行一个长命令」这件事交给子进程:
// 若不统一处理，会出现三类真实缺陷:
//   1. 子进程被信号杀死时 close 回调的 code === null，旧代码写 code ?? 0
//      → Ctrl+C 打断构建却被报成「成功」。
//   2. 不转发父进程信号 → Ctrl+C 只杀父进程，nuxt 变孤儿继续占用端口。
//   3. 转发后不等子进程退出、无强杀兜底 → 僵尸残留。
//
// 本模块收敛为两个导出:
//   · runChild()      —— spawn + 信号转发 + 等待退出 + 超时强杀 + 退出码/信号传播
//   · signalExitCode()—— 退出码约定:被信号终止 → 128 + signalNumber
//
// 退出码约定（POSIX 惯例,与 bash 一致）:
//   · 正常退出       → 子进程 exit code 原样透传
//   · 被信号 N 终止  → 128 + N（SIGINT=2 → 130,SIGTERM=15 → 143；未知信号 → 1）
//   · spawn 失败     → 1
// ============================================================
import { spawn } from 'node:child_process'

/** 信号名 → 编号（跨平台:Windows 下 libuv 亦按此表上报 signal） */
const SIGNAL_NUMBERS = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
}

/** 优雅终止宽限期（毫秒）:转发 SIGTERM 后等待,超时仍存活则 SIGKILL */
export const SHUTDOWN_GRACE_MS = 5000

/** 被信号终止的退出码:128 + signalNumber（约定,未知信号退化为 1） */
export function signalExitCode(signal) {
  const n = SIGNAL_NUMBERS[signal]
  return Number.isInteger(n) ? 128 + n : 1
}

/**
 * 前台运行子进程并传播其退出语义（aw dev/start/build 唯一入口）。
 *
 * @param {string} command 可执行文件（如 process.execPath）
 * @param {string[]} args  参数数组
 * @param {{
 *   cwd?: string,
 *   env?: Record<string, string>,
 *   stdio?: any,
 *   forwardSignals?: boolean,    转发 SIGINT/SIGTERM/SIGHUP 到子进程（默认 true）
 *   graceMs?: number,            优雅终止宽限期（默认 SHUTDOWN_GRACE_MS）
 *   killSignal?: NodeJS.Signals, 首轮终止信号（默认 SIGTERM）
 *   onSpawnError?: (err: Error) => void,
 * }} [options]
 * @returns {Promise<number>} 进程退出码（信号终止 → 128 + signalNumber）
 */
export function runChild(command, args = [], options = {}) {
  const {
    cwd,
    env,
    stdio = 'inherit',
    forwardSignals = true,
    graceMs = SHUTDOWN_GRACE_MS,
    killSignal = 'SIGTERM',
    onSpawnError,
  } = options

  return new Promise((resolveExit) => {
    const child = spawn(command, args, { cwd, env, stdio })

    let settled = false
    let killTimer = null
    let graceTimer = null

    /** 幂等收口:先摘事件监听与定时器,再上报退出码 */
    const finish = (code) => {
      if (settled) return
      settled = true
      if (graceTimer) clearTimeout(graceTimer)
      if (killTimer) clearTimeout(killTimer)
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(sig, onSignal)
      resolveExit(code)
    }

    // 首轮终止 → 宽限期内未退出 → SIGKILL 强杀兜底（对齐 cli/commands/stop.mjs 的
    // SIGTERM → 5s → SIGKILL 语义;强杀不等回执,由 close 事件收口）
    const terminate = () => {
      if (settled) return
      try {
        child.kill(killSignal)
      }
      catch { /* 已退出 */ }
      if (graceTimer) return
      graceTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        }
        catch { /* 已退出 */ }
      }, graceMs)
      // 强杀后仍不收口（极端情况:句柄泄漏）→ 定时硬收口,避免 aw 永不返回
      graceTimer.unref?.()
      if (!killTimer) {
        killTimer = setTimeout(() => finish(signalExitCode('SIGTERM')), graceMs + 5000)
        killTimer.unref?.()
      }
    }

    const onSignal = () => terminate()

    if (forwardSignals) {
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, onSignal)
    }

    child.on('error', (err) => {
      onSpawnError?.(err)
      finish(1)
    })

    // close（而非 exit）:确保 stdio 已全部排空,长命令输出不丢失
    child.on('close', (code, signal) => {
      // code === null ⇔ 子进程被信号杀死 → 必须传播非 0
      finish(code ?? (signal ? signalExitCode(signal) : 1))
    })
  })
}

export default runChild
