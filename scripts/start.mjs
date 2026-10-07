// ============================================================
// 生产启动入口（配置驱动 + 双模式）
// 模式判定（shared/config/home.mjs 单一入口）：
//   repo 模式：cwd 在项目检出内 → config.yml/data 都在项目根（开发/部署 checkout 场景）
//   home 模式：全局安装（aw start）→ cwd=AW Home,配置=AW Home/config.yml,
//              运行时覆盖=AW Home/runtime-settings.json,数据=AW Home/data
// 另在启动前预载 .env（cwd 的 .env;NUXT_SESSION_PASSWORD 等密钥只经环境
// 注入,绝不写入 config.yml/仓库;已导出的真实环境变量优先）。
// ============================================================
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRunMode } from '../shared/config/home.mjs'
import { setConfiguredTimeZone, installLocalIso, DEFAULT_TIME_ZONE } from '../shared/local-time.mjs'

// 生产进程时间输出统一本地时区(先于 .env 预载与 worker 启动)
installLocalIso()

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---- .env 预载（KEY=VALUE 行,# 注释;不覆盖已存在的环境变量;cwd 优先,包根兜底） ----
for (const envPath of [resolve(process.cwd(), '.env'), join(packageRoot, '.env')]) {
  if (!existsSync(envPath)) continue
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m || line.trim().startsWith('#')) continue
    const key = m[1]
    let val = m[2] ?? ''
    // 行内注释剥离(未加引号时):`KEY=value # 说明` 不应把 " # 说明" 烧进密钥
    if (hashIdx(val) >= 0) val = val.slice(0, hashIdx(val)).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) val = val.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = val
  }
}

// 共享配置引擎：config.yml + runtime-settings + env（模式感知路径）
const { loadEffective } = await import('../shared/config/engine.mjs')

/** 未加引号值中行内注释的起始下标(` #` 起算,避开 URL hash 等无空格场景) */
function hashIdx(val) {
  const i = val.indexOf(' #')
  return i
}

// CLI 传参优先（node scripts/start.mjs --port 8080）
let argPort
{
  const eq = process.argv.find(a => a.startsWith('--port='))
  const idx = process.argv.indexOf('--port')
  argPort = eq ? eq.split('=')[1] : (idx >= 0 ? process.argv[idx + 1] : undefined)
}

const rm = resolveRunMode({ cwd: process.cwd(), packageRoot, env: process.env })
// 包根锚点(随进程环境传给应用):prompts 播种源 = <包根>/.AgentWorkShop/prompts
process.env.AW_PACKAGE_ROOT = packageRoot
const eff = loadEffective({
  configPath: rm.configPath,
  settingsPath: rm.settingsPath,
  env: { ...process.env, ...(argPort ? { PORT: argPort } : {}) },
  mode: 'prod',
})
setConfiguredTimeZone(String(eff.effective['time.timeZone'] ?? DEFAULT_TIME_ZONE))
installLocalIso()

const host = eff.effective['server.host'] ?? '0.0.0.0'
const prodPort = eff.effective['server.prod.port'] ?? 3000
const portSource = eff.sources['server.prod.port']

// ---- 单实例互斥(hardening ST-1):同配置根双开直接退出码 2,防 SQLite 锁崩溃 ----
// ---- 单实例互斥 + 自动顶替:同配置根已有实例 → 自动停止后重启新实例(防 SQLite 锁崩溃) ----
const { acquireLock, checkPort, terminatePid, enforceLockHeartbeat } = await import('../shared/config/single-instance.mjs')
let requestedPort = argPort ? Number(argPort) : prodPort
// CLI 传参校验:--port -1 之类会被 parseArgs 弄成怪值,这里显式拒绝而非绑定到端口 1
if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
  console.error(`✖ 无效端口:${argPort ?? requestedPort}(须为 1-65535 的整数)`)
  process.exit(1)
}
let lock = acquireLock(rm.configRoot, { mode: `prod:${rm.mode}`, port: requestedPort })
if (!lock.ok) {
  const h = lock.holder
  console.log(`› 发现已运行实例(pid=${h.pid}${h.port ? `,端口=${h.port}` : ''},启动于 ${h.startedAt ?? '未知'})— 自动停止后重启 ...`)
  const stopped = await terminatePid(h.pid).catch(() => false)
  if (!stopped) {
    console.error(`✖ 旧实例(pid=${h.pid})自动停止失败,请手动执行 aw stop 或 taskkill /PID ${h.pid} /T /F`)
    process.exit(2)
  }
  lock = acquireLock(rm.configRoot, { mode: `prod:${rm.mode}`, port: requestedPort })
  if (!lock.ok) {
    console.error(`✖ 旧实例已停止但锁仍被占用(可能并发启动):pid=${lock.holder?.pid ?? '?'}`)
    process.exit(2)
  }
}
// 锁心跳:持锁期间锁被他人接管(多写者=JSON 快照互相毁灭,2026-10-04 实测事故)→ 本进程主动退出
enforceLockHeartbeat(lock, rm.configRoot)

// ---- 端口顺延:配置端口被任意进程占用(含其他配置根的实例)→ 逐个 +1(最多 10 次) ----
let port = requestedPort
let bumped = 0
while (bumped < 10 && await checkPort(host, port)) {
  console.log(`› 端口 ${port} 被占用,顺延至 ${port + 1} ...`)
  port += 1
  bumped += 1
}
if (bumped >= 10) {
  console.error(`✖ ${host} 上 ${requestedPort}-${port} 全部被占用,无法启动`)
  process.exit(1)
}
if (bumped > 0) {
  console.log(`✔ 使用顺延端口 ${port}(配置端口 ${requestedPort} 被占用)`)
  // 顺延结果回写锁文件:aw stop 的展示、aw status/TUI 的端口发现都读锁
  try {
    const cur = JSON.parse(readFileSync(lock.lockPath, 'utf8'))
    if (cur?.pid === process.pid) {
      cur.port = port
      writeFileSync(lock.lockPath, JSON.stringify(cur, null, 2), 'utf-8')
    }
  }
  catch { /* 锁自清/被接管等场景:展示值回退为配置端口,可接受 */ }
}

process.env.HOST = process.env.HOST || process.env.NITRO_HOST || String(host)
process.env.PORT = process.env.PORT || process.env.NITRO_PORT || String(port)
process.env.NITRO_HOST = process.env.HOST
process.env.NITRO_PORT = process.env.PORT

console.log(`[config] 生产服务启动 -> http://${process.env.HOST}:${process.env.PORT}  (模式: ${rm.mode}, port source: ${portSource}${bumped > 0 ? ' + 顺延' : ''})`)

// ---- P0-4 子进程监管(spawn + respawn)----
// 此前 `await import(.output)` 同进程直载:OOM(exit 134)= start.mjs 自身死亡,无人重启。
// 现由本父进程 spawn 服务子进程并监管:崩溃/健康失联/堆水位持续越限自动 respawn
// (退避 2s→60s,滑动 1h 窗口最多 10 次);父进程任何退出路径先杀子进程 ——
// 孤儿子进程占端口会让新实例顺延 +1(双实例假象);子进程侧另有 parent-watch 插件双保险。

const outputEntry = join(packageRoot, '.output', 'server', 'index.mjs')
if (!existsSync(outputEntry)) {
  console.error('✖ 未找到构建产物 .output/server/index.mjs —— 请先执行 aw build')
  process.exit(1)
}

const childEnv = { ...process.env, AW_PARENT_PID: String(process.pid) }
// 堆限额固化:父进程未带 --max-old-space-size 时给子进程补默认 4096MB(3GB 事故线以上)
if (!/max-old-space-size/.test(String(childEnv.NODE_OPTIONS ?? ''))) {
  const cfg = Number(childEnv.AW_HEAP_LIMIT_MB ?? 4096)
  const heapMb = Number.isFinite(cfg) && cfg >= 1024 ? cfg : 4096
  childEnv.NODE_OPTIONS = `${childEnv.NODE_OPTIONS ? `${childEnv.NODE_OPTIONS} ` : ''}--max-old-space-size=${heapMb}`
}

const HEALTH_URL = `http://127.0.0.1:${process.env.PORT}/api/health`
const RESTART_WINDOW_MS = 3_600_000
const MAX_RESTARTS_PER_WINDOW = 10
const START_GRACE_MS = 45_000
const PROACTIVE_HEAP_RATIO = 0.94

let serviceChild = null
let givingUp = false
let restartTimes = []
let healthFailStreak = 0
let heapHotStreak = 0

function killChild(sig = 'SIGTERM') {
  const c = serviceChild
  if (!c || c.exitCode !== null || c.signalCode) return
  try {
    c.kill(sig)
  }
  catch { /* 已死 */ }
}

function spawnServiceChild() {
  const gen = restartTimes.length + 1
  const heapMb = String(childEnv.NODE_OPTIONS ?? '').match(/max-old-space-size=(\d+)/)?.[1] ?? 'default'
  console.log(`[start] 拉起服务子进程 #${gen}(heap ${heapMb}MB)`)
  const c = spawn(process.execPath, [outputEntry], { stdio: 'inherit', env: childEnv })
  c.spawnTime = Date.now()
  serviceChild = c
  c.on('exit', (code, signal) => {
    if (givingUp || serviceChild !== c) return
    const now = Date.now()
    restartTimes = restartTimes.filter(t => now - t < RESTART_WINDOW_MS)
    restartTimes.push(now)
    if (restartTimes.length > MAX_RESTARTS_PER_WINDOW) {
      givingUp = true
      console.error(`[start] 子进程 1 小时内第 ${restartTimes.length} 次退出,超出上限 —— 放弃重启,请人工排查(exit=${code} signal=${signal})`)
      process.exit(1)
    }
    const backoff = Math.min(60_000, 2000 * 2 ** Math.min(restartTimes.length - 1, 5))
    console.error(`[start] 服务子进程 #${gen} 退出 code=${code} signal=${signal} —— ${Math.round(backoff / 1000)}s 后自动重启`)
    setTimeout(() => {
      if (!givingUp) spawnServiceChild()
    }, backoff)
  })
}

async function probeHealth() {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 3000)
    const res = await fetch(HEALTH_URL, { signal: ac.signal })
    clearTimeout(t)
    if (!res.ok) return null
    const body = await res.json().catch(() => null)
    return body?.data?.memory ?? body?.memory ?? null
  }
  catch {
    return null
  }
}

const healthTimer = setInterval(async () => {
  const c = serviceChild
  if (!c || c.exitCode !== null || givingUp) return
  if (Date.now() - (c.spawnTime ?? 0) < START_GRACE_MS) return
  const mem = await probeHealth()
  if (!mem) {
    healthFailStreak++
    if (healthFailStreak >= 3) {
      console.error('[start] 健康探针连续 3 次失联 —— 判定服务僵死,重启子进程')
      healthFailStreak = 0
      heapHotStreak = 0
      killChild('SIGKILL') // Windows = TerminateProcess;启动对账链自愈(crash-safe)
    }
    return
  }
  healthFailStreak = 0
  if (typeof mem?.heapRatio === 'number' && mem.heapRatio >= PROACTIVE_HEAP_RATIO) {
    heapHotStreak++
    if (heapHotStreak >= 3) {
      console.error(`[start] 堆水位 ${Math.round(mem.heapRatio * 100)}% 连续 ${heapHotStreak} 拍越限 —— 主动重启(先于 V8 OOM abort)`)
      heapHotStreak = 0
      killChild('SIGTERM')
    }
  }
  else {
    heapHotStreak = 0
  }
}, 30_000)
healthTimer.unref?.()

// 父进程任何退出路径先杀子进程(含锁心跳自杀 process.exit → 'exit' 事件)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    killChild('SIGTERM')
    const t = setTimeout(() => process.exit(0), 500)
    t.unref?.()
  })
}
process.on('exit', () => killChild('SIGKILL'))

spawnServiceChild()
