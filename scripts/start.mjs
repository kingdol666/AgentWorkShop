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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRunMode } from '../shared/config/home.mjs'

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

const host = eff.effective['server.host'] ?? '0.0.0.0'
const prodPort = eff.effective['server.prod.port'] ?? 3000
const portSource = eff.sources['server.prod.port']

// ---- 单实例互斥(hardening ST-1):同配置根双开直接退出码 2,防 SQLite 锁崩溃 ----
// ---- 单实例互斥 + 自动顶替:同配置根已有实例 → 自动停止后重启新实例(防 SQLite 锁崩溃) ----
const { acquireLock, checkPort, terminatePid } = await import('../shared/config/single-instance.mjs')
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

await import('../.output/server/index.mjs')
