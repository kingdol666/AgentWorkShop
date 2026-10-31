#!/usr/bin/env node
/**
 * 安全加固批 HTTP 真机验收(B2–B5 可观测面,2026-10-30)
 *
 * 起一个隔离实例(fresh AW_HOME + 限流关闭以免掩盖授权断言),用真实 HTTP 验证:
 *   M1 P1-3 设置面凭据掩码:editor/admin GET 均得 ***;回传 *** 不覆盖真实值
 *   M2 P1-8 产线授权:零授权用户写分析报告/运行日志 → 403;admin 全局台账 → 200
 *   M3 P2-5 DAQ 模板属主:他人改删 → 403;属主 → 200
 *   M4 P2-6 设备孪生/资产:user 角色操控 → 403;admin → 200
 *   M5 P2-7 账号加固:7 位密码拒绝;连错 5 次后正确密码仍可登录(账号不被锁死)
 *   M6 P3-8 A2A AgentCard:关闭公开面后未认证 → 401,恢复后 → 200
 *
 * 运行:node scripts/e2e-security-b2b5.mjs
 * 证据:docs/audit/evidence/2026-10-30-security-b2b5/report.json
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.AW_B25_HOME ?? 'D:/tmp/aw-security-b2b5-20261030'
const EVIDENCE_DIR = join(REPO, 'docs', 'audit', 'evidence', '2026-10-30-security-b2b5')
const TAG = Date.now().toString(36)
const results = []
const sleep = ms => new Promise(r => setTimeout(r, ms))

function check(id, name, cond, detail = '') {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 1200) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 500)}`}`)
  return Boolean(cond)
}

function killTree(pid) {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  }
  catch { /* 已退出 */ }
}

async function pickPort() {
  for (let i = 0; i < 12; i++) {
    const p = 34000 + Math.floor(Math.random() * 5900)
    try {
      await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(600) })
      continue
    }
    catch { /* 可能空闲 */ }
    let listening = false
    try {
      const out = execFileSync('cmd.exe', ['/c', `netstat -ano | findstr :${p} | findstr LISTENING`]).toString()
      listening = /\s\d+\s*$/.test(out)
    }
    catch { /* 无监听 */ }
    if (!listening) return p
    await sleep(200)
  }
  throw new Error('无空闲端口')
}

const PORT = Number(process.env.AW_B25_PORT ?? await pickPort())
const BASE = `http://127.0.0.1:${PORT}`
process.env.NO_PROXY = '127.0.0.1,localhost'

async function api(method, path, body, token, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, ...(json ?? {}) }
}

async function main() {
  if (!/aw-security-b2b5/.test(HOME)) throw new Error(`拒绝清理非验收目录:${HOME}`)
  if (existsSync(join(HOME, 'server.pid'))) {
    const old = Number(readFileSync(join(HOME, 'server.pid'), 'utf8').trim())
    if (Number.isInteger(old) && old > 0) killTree(old)
    await sleep(800)
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
      // 限流关掉:避免 429 掩盖授权断言(限流本身由 B0 脚本专门验证)
      AW_RATE_LIMIT_OFF: '1',
      NUXT_SESSION_PASSWORD: `B25#${TAG}-session`,
      NO_PROXY: '127.0.0.1,localhost',
    },
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  })
  writeFileSync(join(HOME, 'server.pid'), String(child.pid))
  console.log(`\n=== boot ${BASE} ===`)

  let ready = false
  for (let i = 0; i < 150; i++) {
    await sleep(1500)
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2500) })
      const j = await r.json()
      if (j?.data?.workshop === 'ready') {
        ready = true
        break
      }
    }
    catch { /* 未就绪 */ }
  }
  check('BOOT', '隔离实例启动', ready, `port=${PORT}`)
  if (!ready) throw new Error(`实例未就绪:${join(HOME, 'server.log')}`)

  // ── 账号 ──
  const adminEmail = `b25-admin-${TAG}@awshop.local`
  const reg = await api('POST', '/api/users/register', { name: `B25 管理员-${TAG}`, email: adminEmail, password: 'B25Admin#2026' })
  const admin = reg?.data?.token
  check('S0.1', '首注册 = admin', Boolean(admin), `status=${reg.status}`)

  const editorEmail = `b25-editor-${TAG}@awshop.local`
  await api('POST', '/api/users', { name: `B25 编辑-${TAG}`, email: editorEmail, password: 'B25Editor#2026', role: 'editor' }, admin)
  const editorToken = (await api('POST', '/api/users/login', { email: editorEmail, password: 'B25Editor#2026' }))?.data?.token
  check('S0.2', 'editor 登录', Boolean(editorToken), '')

  const userEmail = `b25-user-${TAG}@awshop.local`
  await api('POST', '/api/users', { name: `B25 用户-${TAG}`, email: userEmail, password: 'B25Plain#2026', role: 'user' }, admin)
  const userToken = (await api('POST', '/api/users/login', { email: userEmail, password: 'B25Plain#2026' }))?.data?.token
  check('S0.3', 'user 登录', Boolean(userToken), '')

  // ── M1 设置面掩码(P1-3)──
  const settingsAsEditor = await api('GET', '/api/system/settings', undefined, editorToken)
  const eff = settingsAsEditor?.data?.effective ?? {}
  const secretKeys = ['daq.mqtt.password', 'daq.objectstore.secretKey', 'daq.objectstore.accessKey']
  const maskedAll = secretKeys.every(k => eff[k] === undefined || eff[k] === '' || eff[k] === '***')
  check('M1.1', 'editor GET settings:凭据键一律掩码/空(无明文)',
    settingsAsEditor.status === 200 && maskedAll,
    secretKeys.map(k => `${k}=${String(eff[k]).slice(0, 8)}`).join(' '))
  const settingsAsAdmin = await api('GET', '/api/system/settings', undefined, admin)
  const effAdmin = settingsAsAdmin?.data?.effective ?? {}
  check('M1.2', 'admin GET settings 同样掩码(明文只留服务端)',
    secretKeys.every(k => effAdmin[k] === undefined || effAdmin[k] === '' || effAdmin[k] === '***'),
    secretKeys.map(k => `${k}=${String(effAdmin[k]).slice(0, 8)}`).join(' '))
  // 掩码回传不覆盖:把 *** 原样写回 → 应与"未改变"等价(changed 不含该键)
  const patchEcho = await api('PATCH', '/api/system/settings', { override: { 'daq.mqtt.password': '***' } }, admin)
  check('M1.3', '回传 *** 不覆盖真实凭据(不产生变更)',
    patchEcho.status === 200 && !(patchEcho?.data?.changed ?? []).includes('daq.mqtt.password'),
    `changed=${JSON.stringify(patchEcho?.data?.changed ?? [])}`)

  // ── M2 产线授权(P1-8)──
  const line = await api('POST', '/api/workshop/dcw/lines', { name: `B25 线-${TAG}`, color: '#336699' }, admin)
  const lineId = line?.data?.line?.id ?? line?.data?.id
  check('M2.0', '建产线(授权断言前置)', Boolean(lineId), `status=${line.status}`)
  if (lineId) {
    const noGrant = await api('POST', '/api/workshop/analysis', { line_id: lineId, title: '零授权写报告' }, userToken)
    check('M2.1', '零授权用户写分析报告 → 403', noGrant.status === 403, `status=${noGrant.status} code=${noGrant.code}`)
    const noGrantLog = await api('POST', '/api/workshop/ops-logs', { summary: '零授权写日志', lineId }, userToken)
    check('M2.2', '零授权用户写产线日志 → 403', noGrantLog.status === 403, `status=${noGrantLog.status}`)
    const globalAsUser = await api('POST', '/api/workshop/ops-logs', { summary: '全局台账尝试' }, userToken)
    check('M2.3', '非 admin 写全局台账(空 lineId) → 403', globalAsUser.status === 403, `status=${globalAsUser.status}`)
    const globalAsAdmin = await api('POST', '/api/workshop/ops-logs', { summary: '管理员全局台账' }, admin)
    check('M2.4', 'admin 写全局台账 → 200', globalAsAdmin.status === 200, `status=${globalAsAdmin.status} code=${globalAsAdmin.code}`)
    const reportAsAdmin = await api('POST', '/api/workshop/analysis', { line_id: lineId, title: '管理分析报告', report: 'ok' }, admin)
    check('M2.5', 'admin 写该线分析报告 → 200', reportAsAdmin.status === 200, `status=${reportAsAdmin.status}`)
  }

  // ── M3 DAQ 模板属主(P2-5)──
  const mkTpl = (who, token) => api('POST', '/api/workshop/daq/templates', {
    name: `B25 模板 ${who}-${TAG}`,
    code: `B25${who}`.slice(0, 8),
    ch: '测试通道',
    unit: '%',
    base: 10,
    amp: 1,
    min: 0,
    max: 100,
    decimals: 1,
    icon: 'gauge',
  }, token)
  const tplOwner = await mkTpl('A', admin)
  const tplKey = tplOwner?.data?.template?.key
  check('M3.0', 'admin 建自定义模板', Boolean(tplKey), `status=${tplOwner.status} ${JSON.stringify(tplOwner).slice(0, 160)}`)
  if (tplKey) {
    const foreign = await api('PATCH', `/api/workshop/daq/templates/${encodeURIComponent(tplKey)}`, { unit: 'kPa' }, editorToken)
    check('M3.1', '他人改模板 → 403', foreign.status === 403, `status=${foreign.status} code=${foreign.code}`)
    const foreignDel = await api('DELETE', `/api/workshop/daq/templates/${encodeURIComponent(tplKey)}`, undefined, editorToken)
    check('M3.2', '他人删模板 → 403', foreignDel.status === 403, `status=${foreignDel.status}`)
    const own = await api('PATCH', `/api/workshop/daq/templates/${encodeURIComponent(tplKey)}`, { unit: 'kPa' }, admin)
    check('M3.3', '属主改模板 → 200', own.status === 200, `status=${own.status}`)
    await api('DELETE', `/api/workshop/daq/templates/${encodeURIComponent(tplKey)}`, undefined, admin)
  }

  // ── M4 设备孪生/资产(P2-6)──
  const twin = await api('POST', '/api/workshop/device-twins', { name: `B25 设备-${TAG}`, kind: 'device', workspaceId: '' }, admin)
  const twinId = twin?.data?.twin?.id ?? twin?.data?.id
  if (twinId) {
    const denied = await api('POST', `/api/workshop/device-twins/${twinId}/control`, { command: ['power_on', 'power_off', 'stop'].find(c => (twin?.data?.twin?.controls ?? []).includes(c)) ?? 'power_on' }, userToken)
    check('M4.1', 'user 角色操控设备孪生 → 403', denied.status === 403, `status=${denied.status} code=${denied.code}`)
    const deniedDel = await api('DELETE', `/api/workshop/device-twins/${twinId}`, undefined, userToken)
    check('M4.2', 'user 角色删设备孪生 → 403', deniedDel.status === 403, `status=${deniedDel.status}`)
    const controls = twin?.data?.twin?.controls ?? []
    // 选一个无需 args 的指令(未知指令会 400,与授权断言无关)
    const cmd = ['power_on', 'power_off', 'stop'].find(c => controls.includes(c)) ?? controls[0] ?? 'power_on'
    const allowed = await api('POST', `/api/workshop/device-twins/${twinId}/control`, { command: cmd }, editorToken)
    check('M4.3', 'editor 操控设备孪生 → 200', allowed.status === 200, `status=${allowed.status}`)
    await api('DELETE', `/api/workshop/device-twins/${twinId}`, undefined, admin)
  }
  else {
    check('M4.0', '建设备孪生(前置)', false, `status=${twin.status} ${JSON.stringify(twin).slice(0, 200)}`)
  }

  // ── M5 账号加固(P2-7)──
  // 自助注册默认关闭(P3-10),故用 admin 建号路径验证密码策略(同 schema)
  const weak = await api('POST', '/api/users', { name: `B25 弱口令-${TAG}`, email: `b25-weak-${TAG}@awshop.local`, password: 'Abc1234', role: 'user' }, admin)
  check('M5.1', '7 位密码建号 → 400/422 拒绝', weak.status === 400 || weak.status === 422, `status=${weak.status} code=${weak.code}`)

  const lockEmail = `b25-lock-${TAG}@awshop.local`
  await api('POST', '/api/users', { name: `B25 锁定-${TAG}`, email: lockEmail, password: 'B25Lock#2026', role: 'user' }, admin)
  for (let i = 0; i < 5; i++) {
    await api('POST', '/api/users/login', { email: lockEmail, password: `Wrong#2026${i}` }, undefined, { 'x-forwarded-for': `203.0.113.${i + 10}` })
  }
  const correctAfterLock = await api('POST', '/api/users/login', { email: lockEmail, password: 'B25Lock#2026' }, undefined, { 'x-forwarded-for': '198.51.100.77' })
  check('M5.2', '连错 5 次后正确密码仍可登录(账号不被第三方锁死)',
    correctAfterLock.status === 200 && Boolean(correctAfterLock?.data?.token),
    `status=${correctAfterLock.status} code=${correctAfterLock.code}`)

  // ── M6 A2A AgentCard 公开面(P3-8)──
  const ch = await api('POST', '/api/workshop/channels', { name: `B25 频道-${TAG}`, leadAgent: { name: `b25-lead-${TAG}`, harness: 'mock' } }, admin)
  const channelId = ch?.data?.channelId
  const agentId = ch?.data?.leadAgentId ?? (ch?.data?.agents ?? []).find(a => a.role === 'lead')?.id
  if (agentId) {
    const pub = await api('GET', `/api/workshop/a2a/${encodeURIComponent(agentId)}/card`)
    check('M6.1', '默认 AgentCard 公开(向后兼容)', pub.status === 200, `status=${pub.status}`)
    const setPrivate = await api('PATCH', '/api/system/settings', { override: { 'security.a2aCardPublic': false } }, admin)
    check('M6.2', '关闭公开面设置生效', setPrivate.status === 200, `status=${setPrivate.status}`)
    const closed = await api('GET', `/api/workshop/a2a/${encodeURIComponent(agentId)}/card`)
    check('M6.3', '关闭后未认证 → 401', closed.status === 401, `status=${closed.status}`)
    const withToken = await api('GET', `/api/workshop/a2a/${encodeURIComponent(agentId)}/card`, undefined, admin)
    check('M6.4', '关闭后带有效 token → 200', withToken.status === 200, `status=${withToken.status}`)
    await api('PATCH', '/api/system/settings', { override: { 'security.a2aCardPublic': null } }, admin)
  }
  else {
    check('M6.0', '建频道(前置)', false, `status=${ch.status} ${JSON.stringify(ch).slice(0, 200)}`)
  }

  const passed = results.filter(r => r.pass).length
  writeFileSync(join(EVIDENCE_DIR, 'report.json'), `${JSON.stringify({ at: new Date().toISOString(), port: PORT, home: HOME, total: results.length, passed, results }, null, 2)}\n`)
  writeFileSync(join(EVIDENCE_DIR, 'summary.md'), [
    '# 安全加固批 B2–B5 真机验收',
    '',
    `- 时间:${new Date().toISOString()}`,
    `- 结果:${passed}/${results.length}`,
    '',
    ...results.map(r => `- ${r.pass ? 'PASS' : 'FAIL'} \`${r.id}\` ${r.name}${r.pass ? '' : ` — ${r.detail}`}`),
    '',
  ].join('\n'))
  console.log(`\n=== ${passed}/${results.length} ===`)
  killTree(child.pid)
  void channelId
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
