/**
 * 2026-10-28 安全加固验收脚本(可复跑)。
 * 前置:隔离实例已由文档中的 setup 流程建立场景(scenario.json/admin.json)。
 * 用法: AW_BASE_URL=http://127.0.0.1:3410 AW_E2E_DIR=/path/to/e2e node scripts/security-acceptance.mjs
 * 环境: AW_BASE_URL / AW_E2E_DIR;证据默认写 docs/audit/evidence/<date>-security-hardening。
 */
/**
 * 2026-10-28 安全加固验收(S1-S9 已实施项)。
 * 前置:隔离实例运行在 127.0.0.1:3410,场景已由 setup.mjs 建立。
 * 输出:docs/audit/evidence/2026-10-28-security-hardening/report.json
 */
import fs from 'node:fs'

const BASE = process.env.AW_BASE_URL ?? 'http://127.0.0.1:3410'
const ROOT = process.cwd()
const E2E_DIR = process.env.AW_E2E_DIR ?? 'D:/tmp/aw-e2e-20261028'
const scenario = JSON.parse(fs.readFileSync(`${E2E_DIR}/scenario.json`, 'utf8'))
const admin = JSON.parse(fs.readFileSync(`${E2E_DIR}/admin.json`, 'utf8'))

const results = []
function record(id, name, pass, expected, actual, note = '') {
  results.push({ id, name, pass, expected, actual, note })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name} | expected=${expected} actual=${actual}${note ? ' | ' + note : ''}`)
}

async function call(method, path, { body, token, headers = {} } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json = null
  try {
    json = JSON.parse(text)
  }
  catch { /* non-json */ }
  return { status: r.status, json, text }
}

const ADMIN = admin.resp.data.token
const runId = (await call('GET', `/api/workshop/dcw/recipes`, { token: ADMIN })).json?.data?.runs?.[0]?.id

// ---- 普通用户(幂等:密码存 E2E_DIR/user2.json;已存在则重置密码) ----
const USER_FILE = `${E2E_DIR}/user2.json`
let userFixture = null
try {
  userFixture = JSON.parse(fs.readFileSync(USER_FILE, 'utf8'))
}
catch { /* 首次运行 */ }
const USER_PW = userFixture?.password ?? (`u2-${Math.random().toString(36).slice(2, 14)}`)
const u2reg = await call('POST', '/api/users', { token: ADMIN, body: { name: 'Sec User2', email: 'sec-user2@aw.local', password: USER_PW, role: 'user' } })
if (u2reg.status !== 200 && u2reg.status !== 201) {
  const list = await call('GET', '/api/users?keyword=sec-user2&pageSize=50', { token: ADMIN })
  const rows = list.json?.data?.items ?? list.json?.data?.users ?? list.json?.data ?? []
  const row = Array.isArray(rows) ? rows.find(u => u.email === 'sec-user2@aw.local') : null
  if (row?.id) await call('PUT', `/api/users/${row.id}`, { token: ADMIN, body: { password: USER_PW } })
}
const u2login = await call('POST', '/api/users/login', { body: { email: 'sec-user2@aw.local', password: USER_PW } })
const USER = u2login.json?.data?.token
const USER_ID = u2login.json?.data?.user?.id
fs.writeFileSync(USER_FILE, JSON.stringify({ email: 'sec-user2@aw.local', password: USER_PW, id: USER_ID }, null, 2))
record('AUTH-0', '普通用户创建/登录(幂等)', Boolean(USER), 'token', u2login.status)

// 每次运行先撤销历史授权,保证"无产线授权"负例可重复
if (USER_ID) {
  await call('PUT', '/api/workshop/permissions', {
    token: ADMIN,
    body: {
      userId: USER_ID,
      grants: [{ lineId: scenario.A.line.id, mode: null }, { lineId: scenario.B.line.id, mode: null }],
    },
  })
}

// 1) 未授权/无产线授权
const noAuth = await call('GET', '/api/workshop/dcw/recipes')
record('S4-1', '未认证读配方 → 401', noAuth.status === 401, 401, noAuth.status)

const u2Recipes = await call('GET', '/api/workshop/dcw/recipes', { token: USER })
const empty = (u2Recipes.json?.data?.recipes ?? []).length === 0 && (u2Recipes.json?.data?.runs ?? []).length === 0
record('S4-2', '无产线授权读配方列表 → 空集(非全量)', u2Recipes.status === 200 && empty, '200 + []', `${u2Recipes.status} + recipes=${u2Recipes.json?.data?.recipes?.length}`)

const u2Journal = await call('GET', '/api/workshop/dcw/journal', { token: USER })
record('S4-3', '无授权读写账本 → 空集', (u2Journal.json?.data?.anchors ?? []).length === 0, '[]', (u2Journal.json?.data?.anchors ?? []).length)

const u2Alarms = await call('GET', '/api/workshop/daq/alarms', { token: USER })
record('S4-4', '无授权读报警 → 空集', (u2Alarms.json?.data?.alarms ?? []).length === 0, '[]', (u2Alarms.json?.data?.alarms ?? []).length)

const u2Read = await call('POST', `/api/workshop/dcw/${scenario.A.dcwTemp.id}/read`, { token: USER, body: {} })
record('S4-5', '无授权读节点 PLC 值 → 403', u2Read.status === 403, 403, u2Read.status)

const u2Del = await call('DELETE', `/api/workshop/dcw/recipes/${scenario.A.recipe.id}`, { token: USER })
record('S4-6', '无授权删配方 → 403', u2Del.status === 403, 403, u2Del.status)

const u2Close = await call('POST', `/api/workshop/dcw/runs/${runId}/close`, { token: USER, body: {} })
record('S4-7', '无授权关批次 → 403', u2Close.status === 403, 403, u2Close.status)

// 2) 控制面权限
const u2Test = await call('POST', '/api/workshop/daq/test-driver', { token: USER, body: { driver: 'mock', driverConfig: {} } })
record('S5-1', '普通用户 test-driver → 403', u2Test.status === 403, 403, u2Test.status)
const u2TestDcw = await call('POST', '/api/workshop/dcw/test-driver', { token: USER, body: { driver: 'mock', driverConfig: {} } })
record('S5-2', '普通用户 dcw test-driver → 403', u2TestDcw.status === 403, 403, u2TestDcw.status)
const u2Reconnect = await call('POST', '/api/workshop/daq/infra/reconnect', { token: USER, body: {} })
record('S5-3', '普通用户 infra/reconnect → 403', u2Reconnect.status === 403, 403, u2Reconnect.status)
const adminTest = await call('POST', '/api/workshop/daq/test-driver', { token: ADMIN, body: { driver: 'mock', driverConfig: {} } })
record('S5-4', 'admin test-driver 仍可用', adminTest.status === 200, 200, adminTest.status)

// S12:ingest 时间戳方向
const futureAt = new Date(Date.now() + 5 * 60_000).toISOString()
const futureIngest = await call('POST', `/api/workshop/daq/${scenario.A.daqTemp.id}/ingest`, {
  token: ADMIN,
  body: { at: futureAt, value: 1 },
})
record('S12-1', '未来时间戳 ingest → 400 FUTURE_TIMESTAMP', futureIngest.status === 400 && futureIngest.json?.code === 'FUTURE_TIMESTAMP', '400 FUTURE_TIMESTAMP', `${futureIngest.status} ${futureIngest.json?.code}`)

const backfillAt = new Date(Date.now() - 10 * 60_000).toISOString()
const backfillIngest = await call('POST', `/api/workshop/daq/${scenario.A.daqTemp.id}/ingest`, {
  token: ADMIN,
  body: { at: backfillAt, value: 1 },
})
record('S12-2', '10 分钟前回填 ingest → 200', backfillIngest.status === 200, 200, backfillIngest.status)

// S15:Modbus 原始量程不可表示 → 配置期拒绝
const badRaw = await call('POST', '/api/workshop/dcw', {
  token: ADMIN,
  body: {
    templateRef: 'temp-sp',
    name: '验收-坏原始量程',
    driver: 'modbus-tcp',
    driverConfig: { host: '127.0.0.1', register: 1, dataType: 'int16', rawMin: 0, rawMax: 70000 },
    lineId: scenario.A.line.id,
  },
})
record('S15-1', 'int16 rawMax=70000 → 400 配置期拒绝', badRaw.status === 400 && /int16/.test(String(badRaw.text ?? '')), '400 + int16', `${badRaw.status} ${String(badRaw.text).slice(0, 120)}`)

// 3) harness 启动面
const u2Ch = await call('POST', '/api/workshop/channels', {
  token: USER,
  body: { name: 'u2-注入测试', leadAgent: { name: 'evil', harness: 'omp', config: { command: 'cmd.exe', args: ['/c', 'whoami'] } } },
})
record('S1-1', '非 admin 创建 Channel 带 command → 403', u2Ch.status === 403 && u2Ch.json?.code === 'HARNESS_SPAWN_FORBIDDEN', '403 HARNESS_SPAWN_FORBIDDEN', `${u2Ch.status} ${u2Ch.json?.code}`)

const u2Agent = await call('POST', '/api/workshop/agents', {
  token: USER,
  body: { name: 'evil-agent', harness: 'omp', config: { command: '/bin/sh', args: ['-c', 'id'] } },
})
record('S1-2', '非 admin 创建 Agent 带 command → 403', u2Agent.status === 403 && u2Agent.json?.code === 'HARNESS_SPAWN_FORBIDDEN', '403 HARNESS_SPAWN_FORBIDDEN', `${u2Agent.status} ${u2Agent.json?.code}`)

const adminCmd = await call('POST', '/api/workshop/agents', {
  token: ADMIN,
  body: { name: 'evil-admin-agent', harness: 'omp', config: { command: 'cmd.exe', args: ['/c', 'whoami'] } },
})
record('S1-3', 'admin 指定通用解释器 → 403 HARNESS_COMMAND_DENIED', adminCmd.status === 403 && adminCmd.json?.code === 'HARNESS_COMMAND_DENIED', '403 HARNESS_COMMAND_DENIED', `${adminCmd.status} ${adminCmd.json?.code}`)

const u2ChPlain = await call('POST', '/api/workshop/channels', { token: USER, body: { name: 'u2-成员注入测试' } })
const u2ChId = u2ChPlain.json?.data?.channelId
const u2Member = u2ChId
  ? await call('POST', `/api/workshop/channels/${u2ChId}/agents`, { token: USER, body: { name: 'm', harness: 'omp', config: { args: ['--no-session'] } } })
  : { status: 0, json: null }
record('S1-4', '非 admin 新增成员带 args → 403', u2Member.status === 403 && u2Member.json?.code === 'HARNESS_SPAWN_FORBIDDEN', '403 HARNESS_SPAWN_FORBIDDEN', `${u2Member.status} ${u2Member.json?.code}`)

const u2Tpl = await call('POST', '/api/workshop/channel-templates', {
  token: USER,
  body: { name: 'u2-tpl', lead: { name: 'l', harness: 'omp', config: { args: ['--no-session'] } } },
})
record('S1-5', '非 admin 建模板内联 args → 403', u2Tpl.status === 403 && u2Tpl.json?.code === 'HARNESS_SPAWN_FORBIDDEN', '403 HARNESS_SPAWN_FORBIDDEN', `${u2Tpl.status} ${u2Tpl.json?.code}`)

// 4) Agent token 不回显
const rotate = await call('POST', `/api/workshop/channels/${scenario.manual.channelId}/agents/${scenario.manual.worker.id}/rotate-token`, { token: ADMIN, body: {} })
const workerToken = rotate.json?.data?.token
const roster = await call('GET', `/api/workshop/channels/${scenario.manual.channelId}/agents`, { headers: { authorization: `Bearer ${workerToken ?? ''}` } })
const leaked = JSON.stringify(roster.json ?? {})
record('S3-1', 'worker Agent token 拉名册 → 200', roster.status === 200, 200, roster.status)
record('S3-2', '名册不含 token 字段', !leaked.includes('"token"'), 'no "token"', leaked.includes('"token"') ? 'LEAK' : 'clean')
record('S3-3', '名册不含 config 字段(非属主)', !leaked.includes('"config"'), 'no "config"', leaked.includes('"config"') ? 'LEAK' : 'clean')

// 5) 授权 operate 后的数据面
if (USER_ID) {
  await call('PUT', '/api/workshop/permissions', { token: ADMIN, body: { userId: USER_ID, grants: [{ lineId: scenario.A.line.id, mode: 'operate' }] } })
}
const u2Recipes2 = await call('GET', '/api/workshop/dcw/recipes', { token: USER })
const gotOne = (u2Recipes2.json?.data?.recipes ?? []).length === 1
record('S4-8', '仅授权线A → 只看到线A的1个配方', gotOne, 1, (u2Recipes2.json?.data?.recipes ?? []).length)

const u2PatchMin = await call('PATCH', `/api/workshop/dcw/${scenario.A.dcwTemp.id}`, { token: USER, body: { min: 10 } })
record('S2-1', 'operate 改 min(安全字段) → 403', u2PatchMin.status === 403 && u2PatchMin.json?.code === 'DCW_CONFIG_ADMIN_ONLY', '403 DCW_CONFIG_ADMIN_ONLY', `${u2PatchMin.status} ${u2PatchMin.json?.code}`)

const u2PatchName = await call('PATCH', `/api/workshop/dcw/${scenario.A.dcwTemp.id}`, { token: USER, body: { name: '温度设定(手动线)' } })
record('S2-2', 'operate 改 name(运行字段) → 200', u2PatchName.status === 200, 200, u2PatchName.status)

const u2PatchDaq = await call('PATCH', `/api/workshop/daq/${scenario.A.daqTemp.id}`, { token: USER, body: { driver: 'mock' } })
record('S2-3', 'operate 改 DAQ driver → 403', u2PatchDaq.status === 403 && u2PatchDaq.json?.code === 'DAQ_CONFIG_ADMIN_ONLY', '403 DAQ_CONFIG_ADMIN_ONLY', `${u2PatchDaq.status} ${u2PatchDaq.json?.code}`)

const u2Read2 = await call('POST', `/api/workshop/dcw/${scenario.A.dcwTemp.id}/read`, { token: USER, body: {} })
record('S4-9', '授权线A后可读节点 PLC 值 → 200', u2Read2.status === 200, 200, u2Read2.status)

const u2Query = await call('GET', `/api/workshop/daq/query?line_id=${scenario.A.line.id}&last_minutes=5&limit=2`, { token: USER })
record('S4-10', '授权线A后可查数采 → 200', u2Query.status === 200, 200, u2Query.status)

// ---- 汇总 ----
const pass = results.filter(r => r.pass).length
const fail = results.length - pass
const outDir = `${ROOT}/docs/audit/evidence/2026-10-28-security-hardening`
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(`${outDir}/report.json`, JSON.stringify({
  suite: 'security-hardening',
  at: new Date().toISOString(),
  base: BASE,
  totals: { total: results.length, pass, fail },
  results,
}, null, 2))
console.log(`\n结论:${fail === 0 ? 'PASS' : 'FAIL'}(${pass}/${results.length}) → ${outDir}/report.json`)
process.exit(fail === 0 ? 0 : 1)
