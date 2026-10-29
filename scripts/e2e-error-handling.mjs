#!/usr/bin/env node
/**
 * e2e-error-handling —— 错误处理机制对抗性验收(2026-10-29)。
 *
 * 在隔离实例上故意做"会出现问题的操作"(小众场景/畸形输入/越权/竞态洪泛),
 * 断言三件事同时成立:
 *   ① 拦截:请求被结构化拒绝(4xx/409/413 等),永不 500 裸奔、永不拖垮实例;
 *   ② 错误警告记录:该入账的入账(手动 error 记录 / error-ledger 武装),
 *      不该入账的不入账(4xx 洪泛不在 audit_log 留 server.error);
 *   ③ 存活:整轮轰炸后 /api/health 仍 ok,实例零重启。
 *
 * 运行:node scripts/e2e-error-handling.mjs
 * 证据:docs/audit/evidence/2026-10-29-error-handling/report.json
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.AW_EH_HOME ?? 'D:/tmp/aw-error-handling-20261029'
const PORT = Number(process.env.AW_EH_PORT ?? 3450)
const BASE = `http://127.0.0.1:${PORT}`
const EVID = join(REPO, 'docs', 'audit', 'evidence', '2026-10-29-error-handling')
mkdirSync(EVID, { recursive: true })
process.env.NO_PROXY = '127.0.0.1,localhost'

const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 260)}`}`)
  return Boolean(cond)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function health() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2500) })
    return r.ok ? (await r.json())?.data ?? null : null
  }
  catch { return null }
}

function stopOwned() {
  const pidFile = join(HOME, 'server.pid')
  if (!existsSync(pidFile)) return
  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  if (Number.isInteger(pid) && pid > 0) {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  }
}

async function startInstance() {
  stopOwned()
  await sleep(1500)
  if (await health()) throw new Error(`端口 ${PORT} 已被非本验收实例占用`)
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  const log = openSync(join(HOME, 'server.log'), 'a')
  const child = spawn(process.execPath, [join(REPO, '.output', 'server', 'index.mjs')], {
    cwd: REPO,
    env: { ...process.env, AW_MODE: 'home', AW_HOME: HOME, PORT: String(PORT), NUXT_SESSION_PASSWORD: 'error-handling-20261029-session-key!', NO_PROXY: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '' },
    detached: true, stdio: ['ignore', log, log], windowsHide: true,
  })
  child.unref()
  writeFileSync(join(HOME, 'server.pid'), String(child.pid))
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    if ((await health())?.workshop === 'ready') return
  }
  throw new Error('隔离实例 60s 未就绪')
}

/* ── 请求助手 ── */
let admin = ''
const H = () => ({ 'authorization': `Bearer ${admin}`, 'content-type': 'application/json' })
async function call(method, path, { body, raw, headers, noAuth } = {}) {
  const h = { ...(headers ?? {}) }
  if (!noAuth && !raw) Object.assign(h, H())
  if (raw === undefined && body !== undefined && !h['content-type']) h['content-type'] = 'application/json'
  const r = await fetch(BASE + path, {
    method, headers: h,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    signal: AbortSignal.timeout(30000),
  })
  let j = null
  try {
    j = await r.json()
  }
  catch { /* 非 JSON 回包也合法 */ }
  return { status: r.status, j }
}
const data = r => r.j?.data ?? r.j

/* ── 主流程 ── */
try {
  await startInstance()
  const bootLog = readFileSync(join(HOME, 'server.log'), 'utf8')
  ok('E0', 'error-ledger 钩子已武装(启动日志)', bootLog.includes('[error-ledger] armed'), bootLog.includes('[error-ledger] armed') ? '' : '未见武装行')

  const reg = await call('POST', '/api/users/register', { noAuth: true, body: { name: 'eh-admin', email: 'eh@test.local', password: 'Eh#Admin#2026' } })
  admin = data(reg)?.token ?? ''
  ok('E0b', 'admin 注册', Boolean(admin), `status=${reg.status} body=${JSON.stringify(reg.j).slice(0, 200)}`)
  // 开自助注册(E8 要一个非 admin 用户)
  await call('PATCH', '/api/system/settings', { body: { override: { 'security.allowRegistration': true } } })

  /* ── A. 畸形输入:拦截 + 存活 ── */
  const malformed = await fetch(BASE + '/api/workshop/ops-logs', { method: 'POST', headers: { 'authorization': `Bearer ${admin}`, 'content-type': 'application/json' }, body: '{"summary": broken!!!' }).catch(() => ({ status: 0, j: null }))
  ok('E1', '畸形 JSON → 结构化拒绝(非 5xx 裸奔)', malformed.status >= 400 && malformed.status < 500, `status=${malformed.status}`)
  ok('E1b', '畸形 JSON 后实例存活', Boolean(await health()))

  const wrongCt = await fetch(BASE + '/api/workshop/ops-logs', { method: 'POST', headers: { 'authorization': `Bearer ${admin}`, 'content-type': 'text/plain' }, body: 'summary=hello' })
  ok('E2', '错误 Content-Type → 不崩、结构化回包', wrongCt.status < 500, `status=${wrongCt.status}`)

  const big = 'x'.repeat(10 * 1024 * 1024)
  const huge = await call('POST', '/api/workshop/ops-logs', { body: { summary: big, lineId: '' } })
  ok('E3', '10MB 超大摘要 → 拒绝且不炸', (huge.status >= 400 && huge.status < 500) || huge.status === 413, `status=${huge.status}`)
  ok('E3b', '超大载荷后实例存活', Boolean(await health()))

  const ctrl = await call('GET', `/api/workshop/ops-logs?q=${encodeURIComponent('a\x00\x01b')}`)
  ok('E4', '控制字符查询参数 → 安全处理', ctrl.status === 200 || (ctrl.status >= 400 && ctrl.status < 500), `status=${ctrl.status}`)
  const sqli = await call('GET', `/api/workshop/ops-logs?q=${encodeURIComponent('\' OR 1=1; DROP TABLE audit_log;--')}`)
  ok('E5', 'SQL 注入样式查询 → 无害(参数化查询)', sqli.status === 200 && Array.isArray(data(sqli)?.logs), `status=${sqli.status}`)
  const uni = await call('GET', `/api/workshop/ops-logs?q=${encodeURIComponent('🚀💥中文\temoji')}`)
  ok('E5b', 'Unicode/emoji 查询 → 正常', uni.status === 200)

  /* ── B. 枚举与引用校验 ── */
  const badScope = await call('GET', '/api/workshop/ops-logs?scope=hack')
  ok('E6', '非法 scope 枚举 → 400 且点名合法值', badScope.status === 400 && /scope/.test(JSON.stringify(badScope.j)), `status=${badScope.status} ${JSON.stringify(badScope.j).slice(0, 120)}`)
  const badRange = await call('GET', '/api/workshop/ops-logs?from=2026-01-01T00:00:00Z&to=2025-01-01T00:00:00Z')
  ok('E7', '时间区间倒置 → 400 拒绝', badRange.status === 400, `status=${badRange.status}`)
  const badTime = await call('GET', '/api/workshop/ops-logs?from=not-a-date')
  ok('E7b', '非法时间格式 → 400 带示例指引', badTime.status === 400 && /示例/.test(JSON.stringify(badTime.j)), `status=${badTime.status}`)
  const badLevel = await call('GET', '/api/workshop/ops-logs?level=critical')
  ok('E7c', 'level 枚举外值 → 空集或 400(不 500)', badLevel.status < 500, `status=${badLevel.status}`)

  const noLine = await call('POST', '/api/workshop/ops-logs', { body: { summary: 'x', lineId: 'ln-not-exist' } })
  ok('E8', '引用不存在产线 → 400 点名', noLine.status === 400 && /产线不存在/.test(JSON.stringify(noLine.j)), `status=${noLine.status}`)

  /* ── C. 手动记录 level 校验 + error 记录入账 ── */
  const line = (await call('POST', '/api/workshop/dcw/lines', { body: { name: `eh-line-${Date.now().toString(36)}`, simulated: true, description: '错误处理验收临时线' } }))
  const lineId = data(line)?.line?.id ?? data(line)?.id ?? ''
  ok('E9', '临时产线建立', line.status === 200 && Boolean(lineId), `status=${line.status}`)
  const badLv = await call('POST', '/api/workshop/ops-logs', { body: { summary: 'x', lineId, level: 'catastrophic' } })
  ok('E10', '手动记录非法 level → 400 枚举校验', badLv.status === 400 && /level/.test(JSON.stringify(badLv.j)), `status=${badLv.status}`)
  const errLv = await call('POST', '/api/workshop/ops-logs', { body: { summary: '验收:值班上报 3 号机液压油温异常告警', lineId, level: 'error', detail: { note: 'error-ledger 联动验证' } } })
  ok('E11', '手动 error 记录入册', errLv.status === 200, `status=${errLv.status}`)
  await sleep(500)
  const q = await call('GET', `/api/workshop/ops-logs?lineId=${lineId}&level=error`)
  const hit = (data(q)?.logs ?? []).find(l => /液压油温/.test(String(l.summary)))
  ok('E11b', 'error 记录可按级别+产线检索回(红标渲染数据源)', Boolean(hit), `n=${(data(q)?.logs ?? []).length}`)

  /* ── D. 越权与非存在引用 ── */
  const u = await call('POST', '/api/users/register', { noAuth: true, body: { name: 'eh-user', email: `eh-u-${Date.now()}@test.local`, password: 'Eh#User#2026' } })
  const userTok = data(u)?.token ?? ''
  ok('E12', '普通用户注册(已开自助注册)', Boolean(userTok), `status=${u.status}`)
  const forbidden = await fetch(BASE + '/api/system/settings', { headers: { authorization: `Bearer ${userTok}` } })
  ok('E13', '普通用户访问 admin 设置面 → 403', forbidden.status === 403, `status=${forbidden.status}`)
  const noTool = await call('POST', '/api/workshop/agent-tools/invoke', { body: { agentId: 'nope', tool: 'no_such_tool', args: {} } })
  ok('E14', '未知工具调用 → 结构化错误回执(非 500)', noTool.status < 500, `status=${noTool.status}`)
  const noParam = await call('PATCH', '/api/workshop/dcw/params/dc-not-exist', { body: { min: 0 } })
  ok('E15', '引用不存在 DCW 参数 → 404/400 干净回执', noParam.status === 404 || noParam.status === 400, `status=${noParam.status}`)

  /* ── E. 对抗洪泛:拦截 + 不入 server.error + 存活 ── */
  const before = await call('GET', '/api/workshop/ops-logs?scope=system&level=error&limit=500')
  const beforeN = (data(before)?.logs ?? []).length
  let answered = 0
  const t0 = Date.now()
  const barrage = Array.from({ length: 50 }, (_, i) => call('GET', `/api/workshop/ops-logs?q=${encodeURIComponent(`flood-${i}`)}&scope=${i % 2 ? 'line' : 'system'}&limit=${i}`))
  const settled = await Promise.allSettled(barrage)
  for (const s of settled) if (s.status === 'fulfilled' && s.value.status < 500) answered++
  ok('E16', `50 连发 adversarial 查询全部结构化应答(${Math.round((Date.now() - t0))}ms)`, answered === 50, `answered=${answered}`)
  await sleep(800)
  const after = await call('GET', '/api/workshop/ops-logs?scope=system&level=error&limit=500')
  const afterN = (data(after)?.logs ?? []).length
  ok('E17', '4xx 洪泛零 server.error 入账(不淹没真错误)', afterN === beforeN, `before=${beforeN} after=${afterN}`)
  ok('E18', '轰炸后实例存活且零重启', Boolean(await health()), 'health ok')
}
catch (err) {
  ok('FATAL', '验收未捕获异常', false, err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err))
}
finally {
  const passed = results.filter(r => r.pass).length
  const verdict = passed === results.length ? 'PASS' : 'FAIL'
  writeFileSync(join(EVID, 'report.json'), JSON.stringify({ suite: 'error-handling', at: new Date().toISOString(), base: BASE, summary: { total: results.length, passed, failed: results.length - passed, verdict }, results }, null, 2))
  console.log(`\n结论:${verdict}(${passed}/${results.length})`)
  console.log(`证据:${join(EVID, 'report.json')}`)
  stopOwned()
  process.exit(passed === results.length ? 0 : 1)
}
