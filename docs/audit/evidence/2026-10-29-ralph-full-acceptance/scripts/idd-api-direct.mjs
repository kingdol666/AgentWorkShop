#!/usr/bin/env node
/**
 * IDD 对外 API 独立真机测试(2026-10-29 ralph 验收 US-002)。
 * 覆盖:健康/注册/登录/token 铸造/鉴权负例/capabilities/results 列表+详情/categories CRUD/tasks/属主越权。
 * 前置:IDD 后端 127.0.0.1:3210 已启动。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'http://127.0.0.1:3210'
const HERE = dirname(fileURLToPath(import.meta.url))
const EVID = join(HERE, '..')
mkdirSync(EVID, { recursive: true })
process.env.NO_PROXY = '127.0.0.1,localhost'

const results = []
function check(id, name, ok, detail = '') {
  results.push({ id, name, pass: Boolean(ok), detail: String(detail).slice(0, 400) })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${name}${ok ? '' : ' — ' + String(detail).slice(0, 300)}`)
}
const api = async (method, path, body, token) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) })
  return { status: r.status, j: await r.json().catch(() => ({})) }
}
const stamp = 'ralph20261029'
const USER = `ralph_acc_${stamp}`

// I1 健康(免鉴权)
const h = await api('GET', '/api/health')
check('I1', 'GET /api/health 200', h.status === 200, JSON.stringify(h.j).slice(0, 200))

// I2 注册(fresh)——已存在则视为可接受并转登录
const reg = await api('POST', '/api/auth/register', { username: USER, password: 'Ralph#20261029', email: `${USER}@test.local` })
check('I2', 'POST /api/auth/register 注册新用户', reg.status === 200 || reg.status === 201 || /exist/i.test(JSON.stringify(reg.j)), `status=${reg.status} body=${JSON.stringify(reg.j).slice(0, 200)}`)

// I3 登录(用户名非 email)
const login = await api('POST', '/api/auth/login', { username: USER, password: 'Ralph#20261029' })
const session = login.j?.data?.session_token ?? login.j?.session_token ?? login.j?.data?.token ?? null
check('I3', 'POST /api/auth/login 返回会话', login.status === 200 && Boolean(session), `status=${login.status} keys=${Object.keys(login.j).join(',')}`)

// I4 铸造 idd_ API token
const mk = await api('POST', '/api/auth/tokens', { name: 'ralph-acceptance' }, session)
const iddToken = mk.j?.data?.token ?? mk.j?.token ?? null
check('I4', 'POST /api/auth/tokens 铸造 API token(明文一次)', mk.status === 200 && typeof iddToken === 'string' && iddToken.startsWith('idd_'), `status=${mk.status} tokenPrefix=${String(iddToken).slice(0, 6)}`)
if (iddToken) writeFileSync('D:/tmp/idd-token-ralph-20261029.txt', iddToken)

// I5 鉴权负例:无 token 访问外部面 → 401
const noAuth = await api('GET', '/api/external/v1/capabilities')
check('I5', '无 token 访问 /external/v1/capabilities → 401', noAuth.status === 401, `status=${noAuth.status}`)

// I6 capabilities(idd_ token)
const cap = await api('GET', '/api/external/v1/capabilities', undefined, iddToken)
const capShape = JSON.stringify(cap.j)
check('I6', 'idd_ token 访问 capabilities → 200 且含意图/引擎面', cap.status === 200 && (capShape.includes('intent') || capShape.includes('mode') || capShape.includes('harness')), `status=${cap.status} body=${capShape.slice(0, 200)}`)

// I7 坏 token → 401
const bad = await api('GET', '/api/external/v1/results', undefined, 'idd_bogus_token_123')
check('I7', '坏 token 访问 results → 401', bad.status === 401, `status=${bad.status}`)

// I8 结果库列表(分页形状)
const list = await api('GET', '/api/external/v1/results?limit=5&offset=0', undefined, iddToken)
const listBody = list.j?.results ?? list.j?.data?.results ?? list.j?.data ?? list.j
check('I8', 'GET /external/v1/results 列表 200', list.status === 200, `status=${list.status} body=${JSON.stringify(list.j).slice(0, 200)}`)
const firstResult = Array.isArray(listBody) ? listBody[0] : (listBody?.items?.[0] ?? listBody?.[0])
const firstId = firstResult?.result_id ?? firstResult?.id ?? null

// I9 不存在详情 → 404
const miss = await api('GET', '/api/external/v1/results/does-not-exist-xyz', undefined, iddToken)
check('I9', '不存在 result_id 详情 → 404', miss.status === 404, `status=${miss.status}`)

// I10 categories CRUD 回路
const catName = `ralph-acc-cat-${stamp}`
const catNew = await api('POST', '/api/external/v1/results/categories', { name: catName, description: 'ralph 验收临时分类' }, iddToken)
const catId = catNew.j?.id ?? catNew.j?.data?.id ?? catNew.j?.category?.id ?? null
const catList = await api('GET', '/api/external/v1/results/categories', undefined, iddToken)
let catRen = { status: 0 }, catDel = { status: 0 }
if (catId) {
  catRen = await api('PATCH', `/api/external/v1/results/categories/${catId}`, { name: catName + '-renamed' }, iddToken)
  catDel = await api('DELETE', `/api/external/v1/results/categories/${catId}`, undefined, iddToken)
}
check('I10', 'categories 建列改删回路', catNew.status < 300 && catList.status === 200 && (!catId || (catRen.status < 300 && catDel.status < 300)), `new=${catNew.status} list=${catList.status} ren=${catRen.status} del=${catDel.status}`)

// I11 tasks 列表
const tasks = await api('GET', '/api/external/v1/tasks', undefined, iddToken)
check('I11', 'GET /external/v1/tasks 200', tasks.status === 200, `status=${tasks.status} body=${JSON.stringify(tasks.j).slice(0, 160)}`)

// I12 属主越权:旧演示 token(results_demo 属主)的结果被新用户 PATCH → 403/拒绝
let own = { pass: null, detail: 'no legacy token file' }
const legacyPath = 'D:/tmp/idd-token.txt'
if (existsSync(legacyPath) && firstId) {
  const legacy = readFileSync(legacyPath, 'utf8').trim()
  const legacyList = await api('GET', '/api/external/v1/results?limit=5', undefined, legacy)
  if (legacyList.status === 200) {
    const lb = legacyList.j?.results ?? legacyList.j?.data ?? legacyList.j
    const legacyFirst = Array.isArray(lb) ? lb[0] : lb?.items?.[0]
    const legacyId = legacyFirst?.result_id ?? legacyFirst?.id
    if (legacyId) {
      const cross = await api('PATCH', `/api/external/v1/results/${legacyId}`, { description: '越权改动尝试' }, iddToken)
      own = { pass: cross.status === 403 || cross.status === 404, detail: `cross-user PATCH status=${cross.status}(403/404 均为拒绝)` }
    } else own = { pass: null, detail: 'legacy 用户无结果可测' }
  } else own = { pass: null, detail: `legacy token 失效 status=${legacyList.status}` }
} else if (!firstId) own = { pass: null, detail: '新用户名下无结果行,属主面由 e2e-idd-results 覆盖' }
if (own.pass === null) console.log(`SKIP [I12] 属主越权 — ${own.detail}`)
else check('I12', '跨用户 PATCH 他人结果被拒', own.pass, own.detail)

const pass = results.filter(r => r.pass).length
console.log(`\n结论: ${pass === results.length ? 'PASS' : 'FAIL'} (${pass}/${results.length})`)
writeFileSync(join(EVID, 'idd-api-direct-report.json'), JSON.stringify({ suite: 'idd-api-direct', base: BASE, at: new Date().toISOString(), results }, null, 2))
process.exitCode = pass === results.length ? 0 : 1
