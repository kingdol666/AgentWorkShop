/**
 * Harness 进程注册表 — 运行时资源监控的中心事实源。
 *
 * 每个 harness 子进程(当前:omp `--mode rpc`)在 spawn 时登记、在退出/被杀时标记,
 * 供「运行时资源监控」列出全部已启动的 harness 进程(含已脱离 runtimes 的孤儿进程),
 * 并支持按 PID 强制终止(Windows: taskkill /T /F 杀进程树;POSIX: 进程组 SIGKILL)。
 *
 * 定位:模块级单例,harnest 装配(OmpRpcAgentImpl)登记,manager 监控层读取;
 * 不依赖 manager,避免循环依赖。
 */
import { spawnSync } from 'node:child_process'

/** 注册表条目:一个已启动(或已退出)的 harness 子进程 */
export interface HarnessProcessEntry {
  pid: number
  harness: string
  /** 可执行文件(诊断用) */
  command: string
  /** 完整 argv(诊断用) */
  args: string[]
  /** 归属 agent;未绑定(孤立/尚未装配完成)为 null */
  agentId: string | null
  channelId: string | null
  name: string | null
  role: 'lead' | 'worker' | null
  startedAt: number
  alive: boolean
  exitCode: number | null
  exitedAt: number | null
}

/** pid → 条目(模块级单例) */
const registry = new Map<number, HarnessProcessEntry>()

/** spawn 后登记(pid 无效直接忽略) */
export function registerHarnessProcess(
  pid: number,
  meta: { harness: string, command: string, args?: string[] },
): void {
  if (!Number.isInteger(pid) || pid <= 0) return
  registry.set(pid, {
    pid,
    harness: meta.harness,
    command: meta.command,
    args: meta.args ?? [],
    agentId: null,
    channelId: null,
    name: null,
    role: null,
    startedAt: Date.now(),
    alive: true,
    exitCode: null,
    exitedAt: null,
  })
}

/** 装配完成后绑定 agent 身份(monitor 据此归属进程 ↔ runtime) */
export function bindHarnessProcess(
  pid: number,
  meta: { agentId: string, channelId: string, name: string, role: 'lead' | 'worker' },
): void {
  const e = registry.get(pid)
  if (!e) return
  e.agentId = meta.agentId
  e.channelId = meta.channelId
  e.name = meta.name
  e.role = meta.role
}

/** 进程退出/被杀后标记(幂等;exit 事件与 kill 路径共用) */
export function markHarnessProcessExit(pid: number, exitCode: number | null): void {
  const e = registry.get(pid)
  if (!e) return
  e.alive = false
  e.exitCode = exitCode
  e.exitedAt = Date.now()
}

export function listHarnessProcesses(): HarnessProcessEntry[] {
  return [...registry.values()]
}

/** 某 agent 仍存活(未退出)的进程——terminate 兜底:runtime 已卸载但进程残留时按 agentId 强杀 */
export function listAliveHarnessProcessesByAgent(agentId: string): HarnessProcessEntry[] {
  return [...registry.values()].filter(e => e.alive && e.agentId === agentId)
}

/** 惰性清理:退出超过 retentionMs 的条目(防泄漏,monitor 快照时调用) */
export function sweepHarnessProcesses(retentionMs = 10 * 60_000): void {
  const now = Date.now()
  for (const [pid, e] of registry) {
    if (!e.alive && e.exitedAt !== null && now - e.exitedAt > retentionMs) {
      registry.delete(pid)
    }
  }
}

/**
 * 强制终止进程树。
 * Windows: taskkill /pid <pid> /T /F(整棵进程树,含 omp 可能拉起的子进程);
 * POSIX: 先按进程组(-pid)后按单进程 SIGKILL。
 * 同步标记条目为已退出(OS 层 exit 事件随后也会触发 markHarnessProcessExit)。
 */
export function killHarnessProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  let ok = false
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      ok = r.status === 0
    }
    else {
      try {
        process.kill(-pid, 'SIGKILL')
        ok = true
      }
      catch {
        try {
          process.kill(pid, 'SIGKILL')
          ok = true
        }
        catch {
          ok = false
        }
      }
    }
  }
  catch {
    /* 保持 ok = false */
  }
  markHarnessProcessExit(pid, null)
  return ok
}
