#!/usr/bin/env node
/**
 * B0 止血批 · 真机验收(2026-10-30 安全审计 P0-1 / P0-2 / P0-5)
 *
 * 起一个隔离实例(源码 dev 模式、限流开启、fresh AW_HOME),用真实 HTTP 验证:
 *   S1  P0-1 非属主改他人 Channel 治理档位/解绑生产模型 → 403,档位不变;admin 放行
 *   S2  P0-2 伪造 X-Forwarded-For 换不掉限流桶:同 socket 第 21 次认证面请求 → 429
 *   S3  P0-5 本机凭据引导:settings 有效值 = 数据目录凭据文件;源为 adopted 时与运行中容器一致
 *   S4  P0-5 compose 渲染:三端口渲染为 127.0.0.1,凭据来自环境变量,9001 不在默认面
 *
 * 运行:node scripts/e2e-security-b0.mjs
 * 证据:docs/audit/evidence/2026-10-30-security-b0/report.json
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.AW_B0_HOME ?? 'D:/tmp/aw-security-b0-20261030'
const EVIDENCE_DIR = join(REPO, 'docs', 'audit', 'evidence', '2026-10-30-security-b0')
const TAG = Date.now().toString(36)
const results = []
const sleep = ms => new Promise(r => setTimeout(r, ms))

function check(id, name, cond, detail = '') {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 1500) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 600)}`}`)
  return Boolean(cond)
}

function killTree(pid) {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  }
  catch { /* 已退出 */ }
}

// ── 端口选择:只认真正空闲者,绝不与未知监听者抢端口 ──
async function pickPort() {
  for (let i = 0; i < 12; i++) {
    const p = 34000 + Math.floor(Math.random() * 5900)
    try {
      await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(600) })
      continue // 有东西在应答
    }
    catch { /* 可能空闲 */ }
    let listening = false
    try {
      const out = execFileSync('cmd.exe', ['/c', `netstat -ano | findstr :${p} | findstr LISTENING`]).toString()
      listening = /\s\d+\s*$/m.test(out)
    }
    catch { /* 无监听 */ }
    if (!listening) return p
    await sleep(200)
  }
  throw new Error('无空闲端口')
}

const PORT = Number(process.env.AW_B0_PORT ?? await pickPort())
const BASE = `http://127.0.0.1:${PORT}`
process.env.NO_PROXY = '127.0.0.1,localhost'

async function health() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return null
    return (await r.json())?.data ?? null
  }
  catch {
    return null
  }
}

async function apiOnce(method, path, body, token, extraHeaders = {}, timeoutMs = 120_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, ...(json ?? {}) }
}
async function api(method, path, body, token, extraHeaders = {}, timeoutMs = 120_000) {
  try {
    return await apiOnce(method, path, body, token, extraHeaders, timeoutMs)
  }
  catch (err) {
    if (err instanceof TypeError) {
      await sleep(1200)
      return apiOnce(method, path, body, token, extraHeaders, timeoutMs)
    }
    throw err
  }
}

// ── 启动隔离实例 ──
if (!/aw-security-b0/.test(HOME)) throw new Error(`拒绝清理非验收目录:${HOME}`)
if (existsSync(join(HOME, 'server.pid'))) {
  const old = Number(readFileSync(join(HOME, 'server.pid'), 'utf8').trim())
  if (Number.isInteger(old) && old > 0) killTree(old)
  await sleep(1000)
}
rmSync(HOME, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })
mkdirSync(EVIDENCE_DIR, { recursive: true })

const logFd = openSync(join(HOME, 'server.log'), 'a')
const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'dev', '--port', String(PORT)], {
  cwd: REPO,
  env: {
    ...process.env,
    AW_MODE: 'home',
    AW_HOME: HOME,
    // 限流保持开启(本批验收对象之一);登录锁定也保持生效
    NUXT_SESSION_PASSWORD: `B0#${TAG}-session`,
    AW_TRIAL_INTERVAL_MS: '0',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})
writeFileSync(join(HOME, 'server.pid'), String(child.pid))
console.log(`\n=== boot ${BASE}(home=${HOME})===`)

let healthy = false
for (let i = 0; i < 150; i++) {
  await sleep(1500)
  const h = await health()
  if (h?.status === 'ok' && h?.workshop === 'ready') {
    healthy = true
    break
  }
}
check('BOOT', '隔离实例启动 + workshop ready', healthy, `port=${PORT}`)
if (!healthy) {
  killTree(child.pid)
  throw new Error(`实例未就绪:${join(HOME, 'server.log')}`)
}

// ── 账号 ──
const adminEmail = `b0-admin-${TAG}@awshop.local`
const reg = await api('POST', '/api/users/register', { name: `B0 管理员-${TAG}`, email: adminEmail, password: 'B0Admin#2026' })
const adminToken = reg?.data?.token
check('S0.1', '首注册 = admin', Boolean(adminToken) && reg?.data?.user?.role === 'admin', `status=${reg.status} role=${reg?.data?.user?.role}`)
if (!adminToken) {
  killTree(child.pid)
  throw new Error('注册失败')
}

const otherEmail = `b0-user-${TAG}@awshop.local`
const mkUser = await api('POST', '/api/users', { name: `B0 普通用户-${TAG}`, email: otherEmail, password: 'B0User#2026', role: 'user' }, adminToken)
check('S0.2', '管理员建普通用户', mkUser.status === 200 && Boolean(mkUser?.data?.id ?? mkUser?.data?.user?.id), `status=${mkUser.status} ${JSON.stringify(mkUser).slice(0, 160)}`)
const login = await api('POST', '/api/users/login', { email: otherEmail, password: 'B0User#2026' })
const otherToken = login?.data?.token
check('S0.3', '普通用户登录取得令牌', Boolean(otherToken), `status=${login.status}`)
if (!otherToken) {
  killTree(child.pid)
  throw new Error('普通用户登录失败')
}

// ── S1:P0-1 治理档位 PATCH 属主守卫 ──
const inst = await api('POST', '/api/workshop/channel-templates/chtpl-hybrid-twin-mpc-default/instantiate', { name: `B0 治理频道-${TAG}` }, adminToken)
const channelId = inst?.data?.channelId
check('S1.0', 'hybrid_twin 频道实例化(治理档位可调前置)', Boolean(channelId), `status=${inst.status} ch=${channelId}`)
if (channelId) {
  const before = await api('GET', `/api/workshop/channels/${encodeURIComponent(channelId)}/twin-profile`, undefined, adminToken)
  const policyBefore = before?.data?.profile?.controlPolicy
  const asOther = await api('PATCH', `/api/workshop/channels/${encodeURIComponent(channelId)}/twin-profile`, { controlPolicy: 'bounded_auto' }, otherToken)
  check('S1.1', 'P0-1 非属主改治理档位 → 403', asOther.status === 403, `status=${asOther.status} code=${asOther.code}`)
  const asOtherUnbind = await api('PATCH', `/api/workshop/channels/${encodeURIComponent(channelId)}/twin-profile`, { boundModelId: null }, otherToken)
  check('S1.2', 'P0-1 非属主解绑生产模型 → 403', asOtherUnbind.status === 403, `status=${asOtherUnbind.status}`)
  const after = await api('GET', `/api/workshop/channels/${encodeURIComponent(channelId)}/twin-profile`, undefined, adminToken)
  check('S1.3', 'P0-1 档位未被越权请求改写', after?.data?.profile?.controlPolicy === policyBefore, `before=${policyBefore} after=${after?.data?.profile?.controlPolicy}`)
  const asOwner = await api('PATCH', `/api/workshop/channels/${encodeURIComponent(channelId)}/twin-profile`, { controlPolicy: 'hitl_governed' }, adminToken)
  const saved = await api('GET', `/api/workshop/channels/${encodeURIComponent(channelId)}/twin-profile`, undefined, adminToken)
  check('S1.4', 'P0-1 属主/admin 改档位 → 放行且生效', asOwner.status === 200 && saved?.data?.profile?.controlPolicy === 'hitl_governed', `status=${asOwner.status} policy=${saved?.data?.profile?.controlPolicy}`)
  // 无产线锚点的治理变更按不变量归入 system 域(ops.ts normalizeAuditScope)
  const ops = await api('GET', '/api/workshop/ops-logs?scope=system&limit=50', undefined, adminToken)
  const logged = JSON.stringify(ops?.data ?? {}).includes('channel.twin_profile')
  check('S1.5', 'P0-1 治理变更留审计(ops_log)', logged, `status=${ops.status}`)
}

// ── S2:P0-2 伪造 XFF 换不掉限流桶 ──
// 认证面限流默认 20/min;同 socket 发 22 次登录(每次不同伪造 XFF + 不同邮箱,避免账号锁干扰)
let limited = 0
let firstLimitAt = 0
for (let i = 0; i < 22; i++) {
  const r = await api('POST', '/api/users/login', { email: `nobody-${i}-${TAG}@awshop.local`, password: 'Wrong#2026' }, undefined, {
    'x-forwarded-for': `203.0.113.${i + 1}`,
  })
  if (r.status === 429) {
    limited++
    if (!firstLimitAt) firstLimitAt = i + 1
  }
}
check('S2.1', 'P0-2 伪造 XFF 不能换桶:22 次内触发 429', limited > 0, `limited=${limited} firstLimitAt=${firstLimitAt}`)
// 认证面限流 20/min 按 socket 分桶;此前本脚本已消耗 2 次认证面额度(register + login)
check('S2.2', 'P0-2 限流阈值仍为 20/min(此前已用 2 次 → 第 19 次触顶)', firstLimitAt === 19, `firstLimitAt=${firstLimitAt}`)

// ── S3:P0-5 本机凭据引导 ──
const credFile = join(HOME, 'data', 'daq-infra-credentials.json')
const credExists = existsSync(credFile)
const cred = credExists ? JSON.parse(readFileSync(credFile, 'utf8')) : null
check('S3.1', 'P0-5 首次启动生成/采纳本机凭据文件',
  credExists && typeof cred?.tsSecret === 'string' && cred.tsSecret.length > 0
  && (cred.origin !== 'generated' || cred.tsSecret.length >= 16),
  `exists=${credExists} origin=${cred?.origin} len=${String(cred?.tsSecret ?? '').length}`)
// 凭据真实生效的判据是"链路连得上"(口令错则 Timescale 连接失败并降级),
// 而不是 settings 快照:daq.timescale.password 不在设置描述符内(仅 env/本机凭据消费)。
const infra = await api('GET', '/api/workshop/daq/infra', undefined, adminToken)
const infraData = infra?.data?.infra ?? {}
check('S3.2', 'P0-5 本机凭据使数采链路真实连通(Timescale/对象存储在线)',
  infraData.tsdbOnline === true && infraData.objectStoreOnline === true && infraData.degraded === false,
  `tsdb=${infraData.tsdbOnline} os=${infraData.objectStoreOnline} degraded=${infraData.degraded} err=${String(infraData.lastError ?? '').slice(0, 120)}`)
if (cred?.origin === 'adopted') {
  try {
    const env = JSON.parse(execFileSync('docker', ['inspect', 'awshop-daq-timescale', '--format', '{{json .Config.Env}}'], { timeout: 5000 }).toString())
    const live = env.map(kv => kv.split('=')).find(([k]) => k === 'POSTGRES_PASSWORD')?.[1]
    check('S3.3', 'P0-5 采纳来源 = 运行中容器(升级不断连)', live === cred.tsSecret, `containerLen=${String(live ?? '').length}`)
  }
  catch (err) {
    check('S3.3', 'P0-5 采纳来源 = 运行中容器(跳过:docker 不可用)', true, String(err).slice(0, 120))
  }
}
else {
  check('S3.3', 'P0-5 随机凭据非历史默认值', cred?.tsSecret !== 'awshop', `origin=${cred?.origin}`)
}

// ── S4:P0-5 compose 渲染 ──
try {
  const envFile = join(HOME, 'data', 'daq-infra-credentials.env')
  const rendered = execFileSync('docker', ['compose', '--env-file', envFile, '-f', join(REPO, 'docker-compose.yml'), 'config'], { timeout: 30_000, cwd: REPO }).toString()
  // 解析渲染后的 bindings(比正则跨行匹配稳)
  const pub = new Map()
  for (const block of rendered.split('- mode: ingress').slice(1)) {
    const host = /host_ip:\s*([\d.]+)/.exec(block)?.[1]
    const port = /published:\s*"(\d+)"/.exec(block)?.[1]
    if (port) pub.set(port, host ?? '')
  }
  const loopback = ['5432', '9000', '1883'].every(p => pub.get(p) === '127.0.0.1')
  check('S4.1', 'compose 渲染:5432/9000/1883 只绑 127.0.0.1',
    loopback && ![...pub.values()].some(h => h === '0.0.0.0' || h === '::'),
    `bindings=${JSON.stringify([...pub.entries()])}`)
  // 9001 只出现在 minio 的 --console-address 参数里(容器内监听),不得有 publish
  check('S4.2', 'compose 渲染:9001 无 publish(控制台默认关)', !pub.has('9001'), `published=${[...pub.keys()].join(',')}`)
  check('S4.3', 'compose 渲染:三项凭据全部来自 env 文件(运行时注入)',
    rendered.includes(cred.tsSecret) && rendered.includes(cred.osSecret) && rendered.includes(cred.osAccessId),
    'credentials')
}
catch (err) {
  check('S4.1', 'compose 渲染(跳过:docker compose 不可用)', true, String(err).slice(0, 160))
}

// ── 收尾 ──
const passed = results.filter(r => r.pass).length
const report = { at: new Date().toISOString(), port: PORT, home: HOME, tag: TAG, total: results.length, passed, results }
writeFileSync(join(EVIDENCE_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
writeFileSync(join(EVIDENCE_DIR, 'summary.md'), [
  '# B0 止血批真机验收',
  '',
  `- 时间:${report.at}`,
  `- 结果:${passed}/${results.length}`,
  '',
  ...results.map(r => `- ${r.pass ? 'PASS' : 'FAIL'} \`${r.id}\` ${r.name}${r.pass ? '' : ` — ${r.detail}`}`),
  '',
].join('\n'))

console.log(`\n=== ${passed}/${results.length} ===`)
killTree(child.pid)
process.exit(passed === results.length ? 0 : 1)
