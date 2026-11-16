/**
 * scripts/onboarding/lib.mjs —— 产线接入 skill 的共享库(fetch/断言/幂等指纹/登录)。
 * 设计分工:skill 指令(aw-line-onboarding)做文档理解与 driverConfig 生成;
 * 本目录脚本只做**确定性 REST 调用+断言**,输入是配置 JSON,永不理解文档。
 * 风格对齐 scripts/testing/api-full-loop.mjs(ok 计数断言 + 信封 {code,data})。
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'

let pass = 0, fail = 0
export const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  cond ? pass++ : fail++
  return cond
}
export const summary = (label, { graceful = false } = {}) => {
  console.log(`\n=== ${label}: ${pass} 通过 / ${fail} 失败 ===`)
  if (fail > 0) {
    if (graceful) process.exitCode = 1
    else process.exit(1)
  }
}

export const api = async (m, u, body, tok) => {
  const r = await fetch(BASE + u, {
    method: m,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return r.json()
}

export async function login() {
  if (process.env.AW_TOKEN) return process.env.AW_TOKEN
  const email = process.env.AW_EMAIL ?? 'admin@awshop.local'
  const password = process.env.AW_PASS ?? 'admin123'
  const j = await api('POST', '/api/users/login', { email, password })
  if (!j.data?.token) throw new Error(`登录失败:${j.message ?? '未知'}(可用 AW_TOKEN/AW_EMAIL/AW_PASS 覆盖)`)
  return j.data.token
}

/** 幂等指纹:同输入 → 同标签(写进 description,建前先查列表复用) */
export function fingerprint(kind, ...parts) {
  const h = createHash('sha1').update(parts.join('|')).digest('base64url').slice(0, 10)
  return `AW-${kind}:${h}`
}

/** 按 description 指纹在列表中找既有资源(幂等复用) */
export function findByTag(items, tag) {
  return (items ?? []).find(x => String(x.description ?? '').includes(tag))
}

/** 读 JSON 配置文件(process.argv[2]),带 --stdin 支持 */
export async function readConfig() {
  const arg = process.argv[2]
  if (!arg || arg === '--stdin') {
    const chunks = []
    for await (const c of process.stdin) chunks.push(c)
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  const { readFileSync } = await import('node:fs')
  return JSON.parse(readFileSync(arg, 'utf8'))
}

/** 守护红线:演示线1 及既有关键资源绝不允许出现在本次写入目标里 */
export const PROTECTED = ['ln-d7e0a2a2']
export function assertNotProtected(id, what = '资源') {
  if (PROTECTED.includes(id)) throw new Error(`红线:${what} ${id} 是受保护演示资源,禁止操作`)
}

/* ── 模拟器归属证明(nonce 绑定,端到端) ─────────────────────────────────
 * 归属链条:拉起方生成一次性 nonce → 以 AW_SIM_ATTEST_NONCE 注入模拟器进程 →
 * 拉起方写 attestation bundle(nonce/pid/端口/端点计划)→ 后续接入脚本经
 * AW_ONBOARD_ATTESTATION 读 bundle 并**当场复核**:模拟器必须出示同一 nonce
 * (端口抢占者/旧实例无法伪造),pid 必须存活,环回地址必须成立,配置里出现的
 * 每一个驱动端点(host/port/url/endpoint/brokerUrl)必须绑定在证明的端口集内。
 * simulated 标签、驱动名、loopback 地址本身都不构成证明 —— 只有 nonce 链成立
 * 才放行。未证明时任何 API 请求都不发出(平台 GET 会触发全局控制扫描/心跳写)。
 */
export const ATTESTATION_REJECTION = '接入已拒绝:无法证明驱动实现及其端点属于本次隔离模拟器,也无法证明实例或模拟器进程隔离;禁止执行可能触发设备活动的接入或验收操作'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])
const ENDPOINT_URL_KEYS = new Set(['url', 'endpoint', 'baseUrl', 'brokerUrl', 'brokerHost'])

/** 新一轮拉起用的一次性 nonce(独立工具/sim-twin 自证共用)。 */
export function newAttestationNonce() {
  return randomBytes(32).toString('hex')
}

/** 从 driverConfig 抽取端点声明(显式端口键 + 已知 URL 键;bugbot P2:/port$/i 曾误咬
 * `transport` 类键、任意 scheme:// 值曾误判为端点 → 合法配置被硬拒)。 */
const PORT_KEYS = new Set(['port', 'brokerPort', 'simPort'])
function extractEndpointClaims(driverConfig, label, offenders) {
  const cfg = driverConfig && typeof driverConfig === 'object' && !Array.isArray(driverConfig) ? driverConfig : null
  if (!cfg) return { hasClaim: false, hasAttestedPort: false }
  let hasClaim = false
  let hasAttestedPort = false
  for (const [key, value] of Object.entries(cfg)) {
    if (key === 'host' || key === 'brokerHost') {
      if (typeof value !== 'string' || !LOOPBACK_HOSTS.has(value)) {
        offenders.push(`${label}: ${key}=${String(value)} 非环回地址`)
      }
      hasClaim = true
    }
    else if (PORT_KEYS.has(key)) {
      const port = Number(value)
      if (!Number.isInteger(port) || port <= 0) offenders.push(`${label}: ${key}=${String(value)} 不是有效端口`)
      else if (!isAttestedPort(port)) offenders.push(`${label}: ${key}=${port} 不在归属证明的端口集内`)
      else hasAttestedPort = true
      hasClaim = true
    }
    else if (ENDPOINT_URL_KEYS.has(key)) {
      try {
        const u = new URL(String(value))
        if (!LOOPBACK_HOSTS.has(u.hostname)) offenders.push(`${label}: ${key}=${String(value)} 非环回地址`)
        else if (u.port && isAttestedPort(Number(u.port))) hasAttestedPort = true
        else offenders.push(`${label}: ${key}=${String(value)} 端口不在归属证明的端口集内或缺显式端口`)
      }
      catch {
        offenders.push(`${label}: ${key}=${String(value)} 无法解析为端点`)
      }
      hasClaim = true
    }
  }
  // host 而无任何已证明端口(如 modbus 只配 host):拨号目标不可证明 → 不算成立
  if (hasClaim && !hasAttestedPort && offenders.length === 0) {
    offenders.push(`${label}: 只有环回 host,缺少绑定在归属证明端口集内的端口,端点不可证明`)
  }
  return { hasClaim, hasAttestedPort }
}

let attestedPorts = null
function isAttestedPort(port) {
  return attestedPorts?.has(port) ?? false
}

/**
 * 复核归属证明并(可选)校验配置内全部驱动端点绑定。通过返回 bundle;
 * 任何一步不成立即抛错 —— 调用方在证明成立前不得发出任何平台 API 请求。
 * @param cfg 接入配置(provision/onboard 的 nodes;verify-line 的 dcw/daq 由实时节点另行校验)
 */
export async function assertOnboardingOwnership(cfg) {
  const bundlePath = process.env.AW_ONBOARD_ATTESTATION
  if (!bundlePath) throw new Error(ATTESTATION_REJECTION)
  let bundle
  try {
    bundle = JSON.parse(readFileSync(bundlePath, 'utf8'))
  }
  catch (e) {
    throw new Error(`${ATTESTATION_REJECTION}(归属证明不可读:${e.message})`, { cause: e })
  }
  if (bundle?.version !== 1 || typeof bundle.nonce !== 'string' || !bundle.nonce
    || typeof bundle.simBase !== 'string' || !bundle.simBase) {
    throw new Error(`${ATTESTATION_REJECTION}(归属证明形态无效)`)
  }
  let base
  try {
    base = new URL(bundle.simBase)
  }
  catch {
    throw new Error(`${ATTESTATION_REJECTION}(simBase 无法解析)`)
  }
  if (!LOOPBACK_HOSTS.has(base.hostname) || base.protocol !== 'http:') {
    throw new Error(`${ATTESTATION_REJECTION}(simBase 必须是环回 http 地址,实际 ${bundle.simBase})`)
  }
  attestedPorts = new Set([...(Array.isArray(bundle.endpoints) ? bundle.endpoints : []).map(e => Number(e?.port)).filter(Number.isInteger), Number(bundle.simPort), Number(bundle.brokerPort)].filter(Number.isInteger))
  // 当场复核:端口上的进程必须出示本轮拉起方注入的 nonce(抢占者/旧实例无法伪造)
  let att
  try {
    const r = await fetch(new URL('/api/attestation', bundle.simBase), { signal: AbortSignal.timeout(5000) })
    att = await r.json()
  }
  catch (e) {
    attestedPorts = null
    throw new Error(`${ATTESTATION_REJECTION}(模拟器不可达:${e.message})`, { cause: e })
  }
  if (att?.data?.nonce !== bundle.nonce) {
    attestedPorts = null
    throw new Error(`${ATTESTATION_REJECTION}(端口上的进程无法出示本轮拉起的随机 nonce)`)
  }
  if (Number.isInteger(bundle.pid) && bundle.pid > 0) {
    try {
      process.kill(bundle.pid, 0)
    }
    catch {
      attestedPorts = null
      throw new Error(`${ATTESTATION_REJECTION}(证明中的模拟器进程已不存在)`)
    }
  }
  // 配置内驱动端点绑定(有配置才校验;verify-line 对实时节点另用 assertDriverEndpointsAttested)
  if (cfg && typeof cfg === 'object') {
    const offenders = []
    const seen = new Set()
    for (const node of [...(Array.isArray(cfg.nodes) ? cfg.nodes : []), ...(Array.isArray(cfg.dcw) ? cfg.dcw : []), ...(Array.isArray(cfg.tests) ? cfg.tests : []), ...(Array.isArray(cfg.connectivity?.tests) ? cfg.connectivity.tests : [])]) {
      if (!node || typeof node !== 'object') continue
      const label = `${node.kind ?? 'node'}「${node.name ?? node.id ?? '?'}」`
      if (seen.has(label + JSON.stringify(node.driverConfig ?? null))) continue
      seen.add(label + JSON.stringify(node.driverConfig ?? null))
      extractEndpointClaims(node.driverConfig, label, offenders)
    }
    if (offenders.length) {
      attestedPorts = null
      throw new Error(`${ATTESTATION_REJECTION}(端点绑定失败:${offenders.slice(0, 4).join('; ')}${offenders.length > 4 ? ` 等 ${offenders.length} 项` : ''})`)
    }
  }
  return bundle
}

/** 校验单个实时节点的 driverConfig 端点绑定(须先经 assertOnboardingOwnership 建立端口集)。 */
export function assertDriverEndpointsAttested(driverConfig, label) {
  if (!attestedPorts) throw new Error(`${ATTESTATION_REJECTION}(先建立归属证明)`)
  const offenders = []
  const { hasClaim, hasAttestedPort } = extractEndpointClaims(driverConfig, label, offenders)
  if (!hasClaim || !hasAttestedPort) {
    offenders.push(`${label}: driverConfig 缺少可证明的端点声明(host+绑定端口/url),无法证明驱动端点归属`)
  }
  if (offenders.length) {
    attestedPorts = null
    throw new Error(`${ATTESTATION_REJECTION}(${offenders.join('; ')})`)
  }
}

/** 轮询直到 cond 或超时(验收用:采样落库/HITL 卡出现) */
export async function pollUntil(fn, { timeoutMs = 30000, stepMs = 2000, label = 'poll' } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn()
    if (v) return v
    await new Promise(r => setTimeout(r, stepMs))
  }
  throw new Error(`${label}: ${Math.round(timeoutMs / 1000)}s 内未达成`)
}
