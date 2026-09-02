// ============================================================
// 生产启动入口（配置驱动 + 双模式）
// 模式判定（shared/config/home.mjs 单一入口）：
//   repo 模式：cwd 在项目检出内 → config.yml/data 都在项目根（开发/部署 checkout 场景）
//   home 模式：全局安装（aw start）→ cwd=AW Home,配置=AW Home/config.yml,
//              运行时覆盖=AW Home/runtime-settings.json,数据=AW Home/data
// 另在启动前预载 .env（cwd 的 .env;NUXT_SESSION_PASSWORD 等密钥只经环境
// 注入,绝不写入 config.yml/仓库;已导出的真实环境变量优先）。
// ============================================================
import { existsSync, readFileSync } from 'node:fs'
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) val = val.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = val
  }
}

// 共享配置引擎：config.yml + runtime-settings + env（模式感知路径）
const { loadEffective } = await import('../shared/config/engine.mjs')

// CLI 传参优先（node scripts/start.mjs --port 8080）
let argPort
{
  const eq = process.argv.find(a => a.startsWith('--port='))
  const idx = process.argv.indexOf('--port')
  argPort = eq ? eq.split('=')[1] : (idx >= 0 ? process.argv[idx + 1] : undefined)
}

const rm = resolveRunMode({ cwd: process.cwd(), packageRoot, env: process.env })
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
const { acquireLock } = await import('../shared/config/single-instance.mjs')
const lock = acquireLock(rm.configRoot, { mode: `prod:${rm.mode}`, port: argPort ? Number(argPort) : prodPort })
if (!lock.ok) {
  const h = lock.holder
  console.error(`✖ 已有实例在运行(pid=${h.pid}${h.port ? `,端口=${h.port}` : ''},启动于 ${h.startedAt ?? '未知'},模式=${h.mode ?? '未知'})`)
  console.error(`  › 配置根: ${rm.configRoot}`)
  console.error(`  › 如确认是残留锁文件,可删除 ${lock.lockPath} 后重试`)
  process.exit(2)
}

process.env.HOST = process.env.HOST || process.env.NITRO_HOST || String(host)
process.env.PORT = process.env.PORT || process.env.NITRO_PORT || String(prodPort)
process.env.NITRO_HOST = process.env.HOST
process.env.NITRO_PORT = process.env.PORT

console.log(`[config] 生产服务启动 -> http://${process.env.HOST}:${process.env.PORT}  (模式: ${rm.mode}, port source: ${portSource})`)

await import('../.output/server/index.mjs')
