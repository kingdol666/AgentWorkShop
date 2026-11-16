/**
 * scripts/onboarding/sim-attest.mjs —— 拉起**归属可证明**的隔离模拟器(onboarding 第一步)。
 *
 * 归属链条:本脚本生成一次性 nonce → AW_SIM_ATTEST_NONCE 注入新拉起的模拟器进程 →
 * 模拟器 /api/attestation 出示同一 nonce(端口抢占者/旧实例无法伪造)→ 写 attestation
 * bundle → 后续接入脚本以 AW_ONBOARD_ATTESTATION=<bundlePath> 运行(lib.mjs 当场复核)。
 *
 * 红线:绝不复用既有监听(端口被占即拒绝,不杀进程);绝不使用共享 4010;影子目录独立;
 * 协议端点必须全部是 127.0.0.1 且归属本进程 PID(ensureSimulator 内建隔离检查)。
 *
 * 输出(末行 JSON):{ simBase, shadowDir, pid, bundlePath, endpoints:[{kind,port}] }
 * 用法:node scripts/onboarding/sim-attest.mjs --sim-port 4058 [--shadow <dir>] [--bundle <path>]
 * 之后:AW_ONBOARD_ATTESTATION=<bundlePath> node scripts/onboarding/provision-line.mjs ...
 */
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const argOf = (k, d = null) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}

// sim.mjs 的 SIM_PORT/SIM_SHADOW 在模块加载时求值:必须先设 env 再动态 import
// (与 sim-twin 同纪律,静态 import 会拿默认端口)。
const DEFAULT_PORT = 4058
const SIM_PORT_ATTEST = Number(argOf('--sim-port', DEFAULT_PORT))
const SIM_BASE = `http://127.0.0.1:${SIM_PORT_ATTEST}`
const SHADOW = resolve(argOf('--shadow', join(tmpdir(), `aw-onboard-sim-${SIM_PORT_ATTEST}-${randomBytes(4).toString('hex')}`)))
const BUNDLE = resolve(argOf('--bundle', join(SHADOW, 'attestation.json')))

if (!Number.isInteger(SIM_PORT_ATTEST) || SIM_PORT_ATTEST < 1024) {
  console.error('拒绝:--sim-port 必须是有效端口')
  process.exit(1)
}
if (SIM_PORT_ATTEST === 4010) {
  console.error('拒绝:4010 常是其他会话的共享模拟器,归属证明必须用独立端口(--sim-port ≥ 4058)')
  process.exit(1)
}

// ── 1. 一次性 nonce(证明核心:只有本轮拉起的进程知道) ──
const nonce = randomBytes(32).toString('hex')
process.env.AW_SIM_ATTEST_NONCE = nonce
process.env.SIM_BASE = SIM_BASE
process.env.SIM_PORT = String(SIM_PORT_ATTEST)
process.env.SIM_SHADOW_DIR = SHADOW
// 环回 fetch 必须绕过代理(与 sim-twin/bench 同纪律;否则 attestation 复核被代理劫持)
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.no_proxy = '127.0.0.1,localhost'
process.env.HTTP_PROXY = ''
process.env.HTTPS_PROXY = ''

// ── 2. 拉起(端口被占 → ensureSimulator 返回 started:false,绝不复用/不杀) ──
const { ensureSimulator, simulatorEndpointPlan, simApi } = await import('../../bench/lib/sim.mjs')
const r = await ensureSimulator({ log: m => console.log(m) })
if (!r.started) {
  console.error(`拉起失败,拒绝接入(绝不复用既有实例):${r.reason}`)
  process.exit(1)
}

// ── 3. 当场复核:nonce + 进程身份 + 端点计划(loopback + 本 PID) ──
let att = null
for (let i = 0; i < 20 && !att; i++) {
  // simApi 返回 {status, ...(json)}:信封字段在顶层,data 是 attestation 载荷
  const probe = await simApi('GET', '/api/attestation').catch(() => null)
  if (probe?.data?.nonce) att = probe.data
  else await new Promise(rr => setTimeout(rr, 1500))
}
if (!att || att.nonce !== nonce) {
  console.error('归属证明失败:端口上的进程无法出示本轮注入的随机 nonce;拒绝接入(进程保留,人工排查)')
  process.exit(1)
}
if (Number.isInteger(r.pid) && att.pid !== r.pid) {
  console.error(`归属证明失败:attestation pid=${att.pid} 与拉起 pid=${r.pid} 不一致;拒绝接入`)
  process.exit(1)
}
let endpoints = [{ kind: 'api', port: SIM_PORT_ATTEST }]
try {
  const nodes = (await simApi('GET', '/api/nodes')).data
  endpoints = simulatorEndpointPlan(nodes, SIM_PORT_ATTEST)
}
catch (e) {
  console.error(`端点计划失败,拒绝接入:${e.message}`)
  process.exit(1)
}
const brokerPort = 18830 + (SIM_PORT_ATTEST - 4010) * 1000
const bundle = {
  version: 1,
  nonce,
  simBase: SIM_BASE,
  simPort: SIM_PORT_ATTEST,
  brokerPort,
  pid: att.pid,
  shadowDir: r.dir,
  endpoints,
  createdAt: new Date().toISOString(),
}
writeFileSync(BUNDLE, JSON.stringify(bundle, null, 2))
console.log(`✅ 归属证明成立:sim=${SIM_BASE} pid=${att.pid} bundle=${BUNDLE}`)
console.log(`   后续脚本必须带:AW_ONBOARD_ATTESTATION=${BUNDLE}`)
console.log(JSON.stringify({ simBase: SIM_BASE, shadowDir: r.dir, pid: att.pid, bundlePath: BUNDLE, endpoints }))
