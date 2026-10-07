/**
 * 父进程看门(P0-4 respawn 配套)—— 生产由 scripts/start.mjs 以子进程方式拉起服务,
 * 子进程必须先于一切感知父进程死亡并自退:父被硬杀(taskkill 不带 /T)后孤儿子进程
 * 会占住端口,新实例被端口顺延推到 +1(双实例假象)。
 * env AW_PARENT_PID 未设(手动 node .output 直启)时不启用。
 */
const g = globalThis as typeof globalThis & { __awParentWatchTimer?: NodeJS.Timeout }

export default function parentWatchPlugin() {
  const ppid = Number(process.env.AW_PARENT_PID ?? 0)
  if (!Number.isInteger(ppid) || ppid <= 0 || g.__awParentWatchTimer) return
  g.__awParentWatchTimer = setInterval(() => {
    try {
      process.kill(ppid, 0)
    }
    catch {
      console.error('[parent-watch] 父进程已退出 —— 子进程自退(防孤儿占端口)')
      process.exit(1)
    }
  }, 5000)
  g.__awParentWatchTimer.unref?.()
}
