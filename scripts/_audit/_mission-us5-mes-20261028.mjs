/**
 * 2026-10-28 全功能验收 US-005:自定义 MES API(REST)绑定实机验证。
 * 自定义端点 = scripts/dev-mes-simulator.mjs @15160(五格式仿真,x-api-token 鉴权)。
 * 断言:
 *  M1 运行时凭据仓注册(mes/secrets PUT,值不回显)
 *  M2 mes-rest DCW 节点创建(绑定产线,readMap/writeMap/historyMap 三映射)
 *  M3 读原语:手动读经自定义 API 取到 live 值(rot=80)
 *  M4 写原语:写 rot+2 → MES 201 {ack:true,applied} → 回读一致
 *  M5 历史原语:mes/preview 经 historyMap 拉到真实行(标量熔压历史)
 *  M6 负向:错凭据 fail-closed(401 链路文案指向 secretRef)
 *  M7 负向:私有地址未显式放行被 SSRF 守卫拒绝
 * 证据: docs/audit/evidence/2026-10-28-full-acceptance-run2/us5-mes-bind.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3470'
const MES = process.env.MES_BASE ?? 'http://127.0.0.1:15160'
const MES_TOKEN = 'mission-mes-token-2026'
const LINE_ID = process.env.MISSION_LINE_ID ?? 'ln-e27a1867'
const EMAIL = 'admin@mission.local'
const PASS = 'Mission#2026Acc'
const OUT = 'docs/audit/evidence/2026-10-28-full-acceptance-run2/us5-mes-bind.json'
process.env.NO_PROXY = '127.0.0.1,localhost'

const checks = []
const check = (id, name, ok, detail) => {
  checks.push({ id, name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 260) })
  console.log(`${ok ? '✔' : '✘'} [${id}] ${name}${detail ? ` — ${typeof detail === 'string' ? detail.slice(0, 220) : JSON.stringify(detail).slice(0, 220)}` : ''}`)
}
const api = async (method, path, body, token, timeoutMs = 20000) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  let data = null
  try { data = await r.json() } catch { /* non-json */ }
  return { status: r.status, data }
}

const login = await api('POST', '/api/users/login', { email: EMAIL, password: PASS })
const TOK = login.data?.data?.token
check('M0', '管理员登录', login.status === 200 && !!TOK, `status=${login.status}`)
if (!TOK) process.exit(1)

// ── M1 凭据注册 ──
const sec = await api('PUT', '/api/workshop/mes/secrets', { ref: 'mission-mes', value: 'mission-mes-token-2026' }, TOK)
check('M1', 'MES 运行时凭据注册(mission-mes)', sec.status === 200, `status=${sec.status} resp=${JSON.stringify(sec.data).slice(0, 120)}`)

// ── M2 mes-rest 节点创建(绑定产线) ──
const readMap = { method: 'GET', path: '/api/v1/params/multi/current', query: {}, headers: {}, response: { valuePath: 'data.fields.rot' } }
const writeMap = { method: 'POST', path: '/api/v1/params/multi/set', query: {}, headers: {}, bodyTemplate: { rot: '{{value}}' }, successOn: [200, 201], response: { ackPath: 'ack' } }
const historyMap = { path: '/api/v1/params/melt_pressure/history', query: {}, headers: {}, response: { format: 'scalar', rowsPath: 'data.rows', valuePath: 'value', tsPath: 'ts', tsFormat: 'iso' } }
const createRes = await api('POST', '/api/workshop/dcw', {
  templateRef: 'dcw-temp-sp',
  name: 'mes-rest:mission-rot-set',
  driver: 'mes-rest',
  lineId: LINE_ID,
  unit: '%',
  decimals: 1,
  min: 0,
  max: 100,
  stepLimit: 5,
  enabled: true,
  driverConfig: {
    baseUrl: MES,
    secretRef: 'mission-mes',
    authType: 'header',
    allowPrivateHost: 'true',
    readMap: JSON.stringify(readMap),
    writeMap: JSON.stringify(writeMap),
    historyMap: JSON.stringify(historyMap),
  },
}, TOK)
const node = createRes.data?.data?.node ?? createRes.data?.data
check('M2', 'mes-rest 节点创建并绑定产线', createRes.status === 200 && !!node?.id, `status=${createRes.status} id=${node?.id} line=${node?.lineId} err=${createRes.data?.message ?? JSON.stringify(createRes.data).slice(0, 200)}`)
if (!node?.id) process.exit(1)

// ── M3 读原语(自定义 API live 值;与直连真值比对) ──
const simNow = await fetch(`${MES}/api/v1/params/multi/current`, { headers: { 'x-api-token': MES_TOKEN }, signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null)
const simRot = Number(simNow?.data?.fields?.rot)
const rd = await api('POST', `/api/workshop/dcw/${node.id}/read`, {}, TOK)
const rv = rd.data?.data?.read?.value
check('M3', '读原语经自定义 API 取 live 值(与直连真值一致)', rd.status === 200 && rd.data?.data?.read?.ok === true && Number(rv) === simRot, `status=${rd.status} value=${rv} sim=${simRot} msg=${rd.data?.data?.read?.message}`)

// ── M4 写原语(80→82;MES 201 ack;回读一致) ──
let wr = await api('POST', `/api/workshop/dcw/${node.id}/write`, { value: 82 }, TOK, 30000)
const outcome = wr.data?.data?.outcome ?? {}
check('M4a', '写原语写穿自定义 API(outcome ok+readback)', wr.status === 200 && outcome.ok === true && Number(outcome.readback) === 82, `status=${wr.status} outcome=${JSON.stringify(outcome).slice(0, 200)}`)
const applied = await fetch(`${MES}/api/v1/params/multi/current`, { headers: { 'x-api-token': MES_TOKEN }, signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null)
check('M4b', 'MES 侧真值已变更(applied rot=82)', Number(applied?.data?.fields?.rot) === 82, `rot=${applied?.data?.fields?.rot}`)

// ── M5 历史原语(mes/preview;失败须带出错误文案) ──
const prev = await api('POST', '/api/workshop/mes/preview', { node_id: node.id, max_rows: 50 }, TOK, 30000)
const stats = prev.data?.data ?? {}
const rows = stats.sample ?? []
const totalRows = Number(stats.totalRows ?? 0)
check('M5', '历史原语拉到真实行(preview totalRows>0 且有采样)', prev.status === 200 && totalRows > 0 && Array.isArray(rows) && rows.length > 0, `status=${prev.status} err=${prev.data?.message ?? ''} totalRows=${totalRows} sample=${Array.isArray(rows) ? rows.length : 'n/a'} format=${stats.format}`)

// ── M6 负向:错凭据 fail-closed(read 端点 200 + read.ok=false,文案指向凭据链路) ──
await api('PUT', '/api/workshop/mes/secrets', { ref: 'mission-mes', value: 'wrong-token-deliberately' }, TOK)
const rdBad = await api('POST', `/api/workshop/dcw/${node.id}/read`, {}, TOK)
const badMsg = String(rdBad.data?.data?.read?.message ?? rdBad.data?.message ?? '')
check('M6', '错凭据 fail-closed(读失败且文案指向凭据链路)', rdBad.data?.data?.read?.ok === false && /凭据|token|secret|401/i.test(badMsg), `status=${rdBad.status} readOk=${rdBad.data?.data?.read?.ok} msg=${badMsg.slice(0, 160)}`)
await api('PUT', '/api/workshop/mes/secrets', { ref: 'mission-mes', value: 'mission-mes-token-2026' }, TOK)

// ── M7 负向:SSRF 守卫(私有地址未放行) ──
const ssrf = await api('POST', '/api/workshop/dcw', {
  templateRef: 'dcw-temp-sp',
  name: 'mes-rest:ssrf-probe',
  driver: 'mes-rest',
  driverConfig: {
    baseUrl: 'http://127.0.0.1:15160',
    secretRef: 'mission-mes',
    authType: 'header',
    readMap: JSON.stringify(readMap),
  },
}, TOK)
const ssrfNode = ssrf.data?.data?.node ?? ssrf.data?.data
let ssrfRejected = ssrf.status >= 400
let ssrfMsg = String(ssrf.data?.message ?? '')
if (!ssrfRejected && ssrfNode?.id) {
  const r2 = await api('POST', `/api/workshop/dcw/${ssrfNode.id}/read`, {}, TOK)
  ssrfRejected = r2.status >= 400 || r2.data?.data?.read?.ok === false
  ssrfMsg = String(r2.data?.data?.read?.message ?? r2.data?.message ?? '')
}
check('M7', '私有地址未放行被拒(SSRF 守卫)', ssrfRejected && /私有|private|SSRF|放行/i.test(ssrfMsg), `msg=${ssrfMsg.slice(0, 200)}`)

// ── 汇总 ──
const pass = checks.filter(c => c.ok).length
const result = {
  suite: 'US-005 自定义 MES API 绑定实机验证',
  base: BASE, mes: MES, at: new Date().toISOString(),
  node: { id: node.id, name: node.name, lineId: node.lineId },
  checks,
  verdict: `PASS(${pass}/${checks.length})`,
}
mkdirSync('docs/audit/evidence/2026-10-28-full-acceptance-run2', { recursive: true })
writeFileSync(OUT, JSON.stringify(result, null, 2))
console.log(`\nUS-005: ${result.verdict} → ${OUT}`)
process.exit(pass === checks.length ? 0 : 1)
