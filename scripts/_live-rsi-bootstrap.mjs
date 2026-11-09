/**
 * 真实环境自举（2026-11-11）：PLC 模拟器专用实例 :4011 + 生产构建平台 :4201 + 管理员注册。
 * 用法：node scripts/_live-rsi-bootstrap.mjs
 * 输出：状态 JSON 写 stdout（供后续脚本读取）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.env.SIM_BASE = 'http://127.0.0.1:4011'
// 子模块未初始化时回退到 bench 镜像（node_modules 齐备、久经基准验证）；
// 影子实例必须是另一个目录（SIM_SHADOW_DIR），否则 cpSync(src===dst) 报 EINVAL
if (!existsSync(join(REPO, 'plc-node-simulator', 'node_modules'))) {
  process.env.SIM_DIR = resolve(REPO, '..', 'plc-node-simulator-bench')
  process.env.SIM_SHADOW_DIR = resolve(REPO, '..', 'plc-node-simulator-rsi-demo')
}
const { ensureSimulator } = await import('../bench/lib/sim.mjs')

const HOME = join(REPO, '.rsi-demo-home')
const LOG = join(tmpdir(), `rsi-demo-${Date.now().toString(36)}`)
mkdirSync(HOME, { recursive: true })
mkdirSync(LOG, { recursive: true })

const PORT = 4201
const BASE = `http://127.0.0.1:${PORT}`
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}

// ── 1. PLC 模拟器（专用 :4011，影子数据目录）──
const sim = await ensureSimulator({ timeoutMs: 120_000, log: console.log })
console.log(`[sim] started=${sim.started} reason=${sim.reason} dir=${sim.dir}`)
if (!(await import('../bench/lib/sim.mjs')).simUp?.()) { /* simUp 导出缺失时不阻断，下面 health 探测兜底 */ }

// ── 2. 平台（生产构建）──
const logFd = openSync(join(LOG, 'platform.log'), 'a')
const server = spawn(process.execPath, [join(REPO, '.output/server/index.mjs')], {
  cwd: REPO,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    AW_MODE: 'home',
    AW_HOME: HOME,
    AW_RATE_LIMIT_OFF: '1',
    BACKUP_DISABLED: '1',
    NUXT_SESSION_PASSWORD: 'RsiDemo#2026-session-key-32chars-ok',
    PORT: String(PORT),
    HOST: '127.0.0.1',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
  detached: true,
})
server.unref?.()

let healthy = false
for (let i = 0; i < 90; i++) {
  await sleep(1500)
  try {
    const h = await api('GET', '/api/health')
    if (h?.data?.status === 'ok' && h?.data?.workshop === 'ready') { healthy = true; break }
  }
  catch { /* 未就绪 */ }
}
console.log(`[platform] ready=${healthy} port=${PORT} home=${HOME} log=${join(LOG, 'platform.log')}`)
if (!healthy) {
  console.error('[halt] 平台未就绪')
  process.exit(1)
}

// ── 3. 管理员注册 ──
const email = 'rsi-demo@awshop.local'
let token = null
const reg = await api('POST', '/api/users/register', { name: 'rsi-demo-admin', email, password: 'RsiDemo#2026' })
token = reg.data?.token
if (!token) {
  const login = await api('POST', '/api/users/login', { email, password: 'RsiDemo#2026' })
  token = login.data?.token
}
console.log(`[admin] token=${token ? 'ok' : 'FAIL'} email=${email}`)

// ── 4. 模拟器健康 ──
let simNodes = null
try {
  const r = await fetch('http://127.0.0.1:4011/api/nodes', { signal: AbortSignal.timeout(5000) })
  simNodes = (await r.json())?.data?.length ?? null
}
catch { simNodes = null }
console.log(`[sim] nodes=${simNodes}`)

writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify({
  base: BASE, simBase: 'http://127.0.0.1:4011', home: HOME, logDir: LOG, token, simNodes, pid: server.pid,
}, null, 2))
console.log('[state] .rsi-demo-state.json written')
if (!token) process.exit(1)
