/**
 * mcp/discovery.mjs —— AgentWorkShop 运行实例的端口自动发现。
 *
 * 发现优先级(逐级探测,GET /api/health 返回 data.status==='ok' 才算命中):
 *   1. env AW_BASE_URL          显式指定平台地址(如 http://127.0.0.1:3005)
 *   2. env AW_PORT              显式钉住端口(多实例并存时消歧)
 *   3. 锁文件 .runtime/aw.lock  { pid, port, mode }——scripts/start.mjs 端口顺延后回写,
 *      是"实例真实监听端口"的唯一权威记录。依次找:
 *        a. cwd 向上逐级找 .AgentWorkShop/.runtime/aw.lock(repo 级)
 *        b. env AW_HOME/.runtime/aw.lock 与 AW_HOME/.AgentWorkShop/.runtime/aw.lock
 *        c. ~/.AgentWorkShop/.runtime/aw.lock(home 级)
 *   4. env PORT / NUXT_PORT     启动惯例变量(scripts/start.mjs 同款优先级)
 *   5. config.yml               server.dev.port / server.prod.port(轻量正则,不引 YAML 依赖)
 *   6. 默认端口                 3000(dev)/ 3001(prod)
 *
 * 刻意零依赖:本模块被 stdio MCP server(cli 子进程)与 CLI 命令共享,
 * 不得假设仓库 node_modules 的解析路径。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const LOCK_REL = join('.AgentWorkShop', '.runtime', 'aw.lock')
const HEALTH_PATH = '/api/health'
const HEALTH_TIMEOUT_MS = 800

/** cwd 向上逐级查找含 target 相对路径的目录;找不到返回 null */
export function walkUpFind(cwd, target) {
  let dir = resolve(cwd)
  for (;;) {
    const hit = join(dir, target)
    if (existsSync(hit)) return hit
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 读锁文件 → { pid, port, mode, startedAt } | null(损坏/越界端口一律忽略) */
export function readLock(lockPath) {
  try {
    const raw = JSON.parse(readFileSync(lockPath, 'utf8'))
    const port = Number(raw?.port)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
    return { pid: raw?.pid ?? null, port, mode: raw?.mode ?? null, startedAt: raw?.startedAt ?? null }
  }
  catch {
    return null
  }
}

/** GET /api/health 探活;命中返回 data(含 status/app/version/mode),未命中返回 null */
export async function probeHealth(base, timeoutMs = HEALTH_TIMEOUT_MS) {
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}${HEALTH_PATH}`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const json = await res.json().catch(() => null)
    const data = json?.data
    return data?.status === 'ok' ? data : null
  }
  catch {
    return null
  }
}

function pushCandidate(list, seen, cand) {
  const key = cand.base ?? `port:${cand.port}`
  if (seen.has(key)) return
  seen.add(key)
  list.push(cand)
}

/**
 * 轻量解析 config.yml 的 server.dev.port / server.prod.port(嵌套格式,零依赖)。
 * 只关心 server: 块下 dev:/prod: 子块的 port:,不引 YAML 依赖。
 */
export function parseServerPorts(text) {
  const ports = {}
  let inServer = false
  let sub = null
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent === 0) {
      inServer = t === 'server:'
      sub = null
      continue
    }
    if (!inServer) continue
    if (indent <= 2) {
      sub = /^(dev|prod):$/.test(t) ? t.slice(0, -1) : null
      continue
    }
    if (sub && t.startsWith('port:')) {
      const p = Number(t.slice(5).trim())
      if (Number.isInteger(p) && p > 0) ports[sub] = p
    }
  }
  return ports
}

/**
 * 组装候选(按优先级,不去重探测)。返回 [{ kind, source, base?, port? }]
 * kind: 'url' | 'lock' | 'envport' | 'config' | 'default'
 */
export function buildCandidates({ cwd = process.cwd(), env = process.env, defaults } = {}) {
  const cands = []
  const seen = new Set()
  const envUrl = env.AW_BASE_URL?.trim()
  if (envUrl) pushCandidate(cands, seen, { kind: 'url', source: 'env:AW_BASE_URL', base: envUrl.replace(/\/$/, '') })

  const pinPort = Number(env.AW_PORT)
  if (Number.isInteger(pinPort) && pinPort > 0) pushCandidate(cands, seen, { kind: 'envport', source: 'env:AW_PORT', port: pinPort })

  const lockPaths = []
  const awHome = env.AW_HOME?.trim()
  const repoLock = walkUpFind(cwd, LOCK_REL)
  if (repoLock) lockPaths.push({ path: repoLock, source: `lock:${repoLock}` })
  if (awHome) {
    // 显式 AW_HOME = 操作者指定的配置根:优先于隐式的 cwd 向上发现,
    // 且不再回落全局 ~/.AgentWorkShop(多实例隔离语义)
    lockPaths.unshift(
      { path: join(resolve(awHome), '.runtime', 'aw.lock'), source: `lock(AW_HOME):${awHome}` },
      { path: join(resolve(awHome), LOCK_REL), source: `lock(AW_HOME):${join(awHome, '.AgentWorkShop')}` },
    )
  }
  else {
    const homeLock = join(homedir(), LOCK_REL)
    lockPaths.push({ path: homeLock, source: `lock:${homeLock}` })
  }
  for (const { path, source } of lockPaths) {
    const lock = existsSync(path) ? readLock(path) : null
    if (lock) pushCandidate(cands, seen, { kind: 'lock', source, port: lock.port, lock })
  }

  for (const key of ['PORT', 'NUXT_PORT']) {
    const p = Number(env[key])
    if (Number.isInteger(p) && p > 0) pushCandidate(cands, seen, { kind: 'envport', source: `env:${key}`, port: p })
  }

  const configYaml = walkUpFind(cwd, 'config.yml')
  if (configYaml) {
    try {
      const ports = parseServerPorts(readFileSync(configYaml, 'utf8'))
      if (ports.dev) pushCandidate(cands, seen, { kind: 'config', source: `config:server.dev.port(${configYaml})`, port: ports.dev })
      if (ports.prod) pushCandidate(cands, seen, { kind: 'config', source: `config:server.prod.port(${configYaml})`, port: ports.prod })
    }
    catch { /* 读不了就跳过 */ }
  }

  for (const p of defaults ?? ['3000', '3001']) {
    const port = Number(p)
    if (Number.isInteger(port) && port > 0) pushCandidate(cands, seen, { kind: 'default', source: `default:${port}`, port })
  }
  return cands
}

/**
 * 自动发现运行中的 AgentWorkShop 实例。
 * 返回 { base, port|null, source, health, candidates } | null。
 * candidates 里每项附 ok 与 health,便于 aw_status/诊断展示"为什么没连上"。
 */
export async function discoverInstance(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS
  const cands = buildCandidates(opts)
  const probed = []
  for (const cand of cands) {
    const base = cand.base ?? `http://127.0.0.1:${cand.port}`
    const health = await probeHealth(base, timeoutMs)
    probed.push({ ...cand, base, ok: health != null, health })
    if (health) {
      return { base, port: cand.port ?? (Number(new URL(base).port) || null), source: cand.source, health, candidates: probed }
    }
  }
  return null
}

/** 供 aw_status 展示:只探测不命中也算信息(列出全部候选与失败原因形态) */
export async function discoverWithReport(opts = {}) {
  const cands = buildCandidates(opts)
  const probed = []
  for (const cand of cands) {
    const base = cand.base ?? `http://127.0.0.1:${cand.port}`
    const health = await probeHealth(base, opts.timeoutMs ?? HEALTH_TIMEOUT_MS)
    probed.push({ source: cand.source, base, ok: health != null, health: health ?? null })
  }
  const hit = probed.find(p => p.ok)
  return { hit: hit ?? null, candidates: probed }
}

/**
 * 解析本实例的配置根(与锁文件发现同优先级):
 *   env AW_HOME > cwd 向上找 .AgentWorkShop > ~/.AgentWorkShop
 */
export function findConfigRoot(opts = {}) {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const awHome = env.AW_HOME?.trim()
  if (awHome) return resolve(awHome)
  const repoRoot = walkUpFind(cwd, join('.AgentWorkShop', '.runtime', 'aw.lock'))
  if (repoRoot) return dirname(dirname(repoRoot))
  const repoRootDir = walkUpFind(cwd, join('.AgentWorkShop', 'runtime-settings.json'))
  if (repoRootDir) return dirname(repoRootDir)
  return join(homedir(), '.AgentWorkShop')
}

/**
 * 读 MCP 集成开关(系统设置 → MCP 集成 → 启动 MCP 集成)。
 * 优先级与平台一致:env AW_MCP_ENABLED > <configRoot>/runtime-settings.json 的 overrides["mcp.enabled"] > 默认 false。
 * 文件缺失/损坏一律视为 false(fail-closed:开关语义宁可拒绝)。
 */
export function readMcpEnabled(opts = {}) {
  const env = opts.env ?? process.env
  const envVal = env.AW_MCP_ENABLED?.trim()
  if (envVal !== undefined && envVal !== '') {
    return /^(1|true|on|yes)$/i.test(envVal)
  }
  try {
    const root = opts.configRoot ?? findConfigRoot(opts)
    const raw = JSON.parse(readFileSync(join(root, 'runtime-settings.json'), 'utf8'))
    return raw?.overrides?.['mcp.enabled'] === true
  }
  catch {
    return false
  }
}
