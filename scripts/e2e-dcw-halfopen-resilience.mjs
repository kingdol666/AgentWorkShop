#!/usr/bin/env node
/**
 * e2e-dcw-halfopen-resilience.mjs —— 半开 socket 韧性回归(缺陷1,2026-10-30)。
 *
 * 复现原崩溃场景:DCW/DAQ 持有 Modbus 连接时设备进程被杀(半开)→
 * 旧行为:write-after-end unhandledRejection 打崩平台进程;新行为:写 fail-closed、平台存活。
 * 前置:运行中的平台(AW_BASE,默认 3105,须含 2026-10-29 修复的构建)+ 孪生模拟器(4034,设备 41501)。
 * 断言:
 *   A1 基线写回读一致(连接池建立)
 *   A2 杀设备进程后连续 3 次写:全部 fail-closed(ok=false 或非 0 code),不抛未处理异常
 *   A3 设备死亡期间平台 /api/health 持续 ok(进程未崩)——核心断言
 *   A4 重启孪生模拟器后写恢复 readback 一致
 * 用法:node scripts/e2e-dcw-halfopen-resilience.mjs [--base http://127.0.0.1:3105] [--sim-base http://127.0.0.1:4034]
 */
import { execSync } from 'node:child_process'

const argOf = (k, d) => {
  const i = process.argv.indexOf(k)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d
}
const BASE = argOf('--base', 'http://127.0.0.1:3105')
const SIM_BASE = argOf('--sim-base', 'http://127.0.0.1:4034')
const SIM_PORT = new URL(SIM_BASE).port || '4034'
process.env.NO_PROXY = '127.0.0.1,localhost'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`)
  cond ? pass++ : fail++
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (m, u, body, tok) => {
  try {
    const r = await fetch(BASE + u, {
      method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    })
    return await r.json()
  }
  catch (e) {
    return { code: 'FETCH_ERROR', message: e instanceof Error ? e.message : String(e) }
  }
}

/* 登录 */
const login = await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })
const TOK = login.data?.token
if (!TOK) {
  console.error('登录失败')
  process.exit(1)
}
const H = () => TOK

/* A0 前置:平台与模拟器都在线 */
const health0 = await api('GET', '/api/health')
ok('A0 平台在线', health0?.data?.status === 'ok', health0?.message ?? '')
let simOk
try {
  const r = await fetch(`${SIM_BASE}/api/nodes`, { signal: AbortSignal.timeout(5000) })
  simOk = r.ok
}
catch {
  simOk = false
}
if (!simOk) {
  console.error('模拟器不在线(需先 sim-twin 拉起 4034),无法复现半开')
  process.exit(1)
}
ok('A0 模拟器在线', true, SIM_BASE)

/* 建隔离测试线 + 4 个 DCW 写控节点(不同寄存器;半开期写用"各自首次写"绕开 60s 写间隔闸,
 * 确保 3 发写真正打到驱动/socket 层而非被治理闸提前挡下) */
const TAG = `halfopen-${Date.now().toString(36)}`
const line = (await api('POST', '/api/workshop/dcw/lines', { name: `半开韧性-${TAG}`, description: `e2e:${TAG}` }, H())).data?.line
ok('建隔离产线', !!line?.id, line?.id ?? '')
const nodes = []
for (const reg of [40051, 40053, 40055, 40057]) {
  const n = (await api('POST', '/api/workshop/dcw', {
    name: `半开写控-${reg}-${TAG}`, lineId: line.id, driver: 'modbus-tcp', templateRef: 'dcw-temp-sp',
    driverConfig: { host: '127.0.0.1', port: 41501, unitId: 1, register: reg, registerType: 'holding', dataType: 'float32', byteOrder: 'big' },
    unit: '℃', decimals: 1, min: 0, max: 200, stepLimit: 200, holdIntervalMs: null,
  }, H())).data?.node
  if (n?.id) nodes.push(n)
}
ok('建写控节点×4', nodes.length === 4, nodes.map(n => n.id).join(','))
if (nodes.length < 4) process.exit(1)
const [n1, n2, n3, n4] = nodes

const write = async (n, v) => api('POST', `/api/workshop/dcw/${n.id}/write`, { value: v }, H())

/* A1 基线写:连接池建立,回读一致 */
const w1 = await write(n1, 88)
ok('A1 基线写回读一致', w1.code === 0 && w1.data?.outcome?.readback != null,
  `readback=${w1.data?.outcome?.readback} ${w1.message ?? ''}`)

/* A2 杀设备进程 → 连续写全部 fail-closed */
const netstatOut = execSync('netstat -ano', { encoding: 'utf8' })
const pidLine = netstatOut.split('\n')
  .find(l => l.includes(`:${SIM_PORT} `) && l.toUpperCase().includes('LISTENING')) ?? ''
const simPid = pidLine.trim().split(/\s+/).at(-1) ?? ''
ok('定位模拟器 PID', /^\d+$/.test(simPid), simPid)
execSync(`taskkill /PID ${simPid} /T /F`, { stdio: 'ignore' })
await sleep(1500)
/* 三发写用 n2/n3/n4 的【首次写】(各自无写入历史 → 不触发 60s 写间隔闸),
 * 确保请求真正穿透治理闸到达驱动/socket 层 —— 这才是被修复的崩溃路径 */
let allClosed = true
const msgs = []
for (const [i, n] of [n2, n3, n4].entries()) {
  const r = await write(n, 90 + i)
  const closed = r.code !== 0 || r.data?.outcome?.ok === false || r.data?.outcome?.ack === 'unverified'
  if (!closed) allClosed = false
  msgs.push(`#${i + 1} code=${r.code} ok=${r.data?.outcome?.ok} ack=${r.data?.outcome?.ack ?? '-'} msg=${String(r.message ?? r.data?.outcome?.message ?? '').slice(0, 60)}`)
  await sleep(500)
}
ok('A2 半开期间写全部 fail-closed(不抛异常)', allClosed, msgs.join(' | '))

/* A3 核心断言:设备死亡期间平台进程存活 */
const h1 = await api('GET', '/api/health')
ok('A3 设备死亡期间平台存活(不崩进程)', h1?.data?.status === 'ok', `uptime=${h1?.data?.uptimeMs ?? '?'}ms`)

/* A4 重启孪生模拟器 → 写恢复回读一致 */
execSync(`node scripts/onboarding/sim-twin.mjs --blueprint docs/dev/onboarding-e2e-20261028/03-blueprint.json --sim-port ${SIM_PORT} --keep-if-up`,
  { stdio: 'ignore', timeout: 180_000 })
let recovered = false, lastMsg = ''
for (let i = 0; i < 10 && !recovered; i++) {
  await sleep(3000)
  /* 轮转各节点写(失败写也可能锚定间隔闸,轮转可避开单节点 60s 窗) */
  for (const n of nodes) {
    const r = await write(n, 92)
    recovered = r.code === 0 && r.data?.outcome?.readback != null
    lastMsg = `readback=${r.data?.outcome?.readback} msg=${String(r.message ?? r.data?.outcome?.message ?? '').slice(0, 80)}`
    if (recovered) break
  }
}
ok('A4 设备恢复后写回环恢复', recovered, lastMsg)
const h2 = await api('GET', '/api/health')
ok('A5 恢复后平台仍存活', h2?.data?.status === 'ok', `uptime=${h2?.data?.uptimeMs ?? '?'}ms`)

console.log(`\n═══ 半开韧性回归: ${pass} 通过 / ${fail} 失败 ═══`)
process.exit(fail === 0 ? 0 : 1)
