import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { readLock } from '../../mcp/discovery.mjs'
import { desktopHome } from '../../shared/config/home.mjs'
import { configRoot } from './config.mjs'

function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  }
  catch (err) {
    return err?.code === 'EPERM'
  }
}

/** Explicit endpoint wins. Do not fall through to a different backend while the selected one boots. */
export async function resolveTuiUrl({ url, savedUrl, env = process.env, cwd = process.cwd(), timeoutMs = 12_000 } = {}) {
  const explicit = url || env.AW_TUI_URL
  if (explicit) return explicit

  const root = configRoot(cwd, env)
  const roots = env.AW_HOME?.trim() ? [root] : [root, desktopHome(env)]
  for (const candidate of new Set(roots)) {
    const lockPath = join(candidate, '.runtime', 'aw.lock')
    const initial = readLock(lockPath)
    if (!initial || !ownerAlive(initial.pid)) continue

    const deadline = performance.now() + timeoutMs
    while (performance.now() < deadline) {
      const lock = readLock(lockPath)
      if (!lock || lock.pid !== initial.pid || lock.startedAt !== initial.startedAt) break
      const origin = `http://127.0.0.1:${lock.port}`
      const remaining = Math.max(1, Math.ceil(deadline - performance.now()))
      try {
        const res = await fetch(`${origin}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(Math.min(800, remaining)) })
        const data = res.ok ? (await res.json())?.data : null
        if (data?.status === 'ok' && data.workshop === 'ready') return origin
      }
      catch { /* The same supervisor may still be starting. */ }
      await wait(Math.max(0, Math.min(200, deadline - performance.now())))
    }
    throw new Error('本机 AgentWorkShop 实例尚未就绪。请等待启动完成后重试，或用 --url 指定其他实例。')
  }
  return savedUrl || 'http://127.0.0.1:3001'
}
