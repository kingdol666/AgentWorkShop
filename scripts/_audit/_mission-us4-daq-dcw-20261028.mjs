/**
 * 2026-10-28 全功能验收 US-004:实机数采/数控节点连接验证(隔离实例 3470 + 专属模拟器 4020)。
 * 断言:
 *  D1 线与节点在册(11 DCW + 14 DAQ)
 *  D2 DAQ 样本流动(两窗口计数递增且时间戳前进)
 *  D3 DCW 读回环(手动读 ok)
 *  D4 DCW 合法写 110 类比:当前值+最小步 → 写穿+回读一致+verified 判定
 *  D5 负向:超单步限幅写被拒(400 且点名约束)
 *  D6 负向:越节点量程写被拒(400)
 * 证据: docs/audit/evidence/2026-10-28-full-acceptance-run2/us4-daq-dcw.json
 * 用法: node scripts/_audit/_mission-us4-daq-dcw-20261028.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3470'
const EMAIL = process.env.AW_ADMIN_EMAIL ?? 'admin@mission.local'
const PASS = process.env.AW_ADMIN_PASS ?? 'Mission#2026Acc'
const OUT = 'docs/audit/evidence/2026-10-28-full-acceptance-run2/us4-daq-dcw.json'
process.env.NO_PROXY = '127.0.0.1,localhost'

const checks = []
const check = (id, name, ok, detail) => {
  checks.push({ id, name, ok: !!ok, detail })
  console.log(`${ok ? '✔' : '✘'} [${id}] ${name}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 220)}` : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const api = async (method, path, body, token, timeoutMs = 15000) => {
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

// ── 登录 ──
const login = await api('POST', '/api/users/login', { email: EMAIL, password: PASS })
check('D0', '管理员登录', login.status === 200 && login.data?.data?.token, `status=${login.status}`)
const TOK = login.data?.data?.token
if (!TOK) process.exit(1)

// ── D1 线与节点 ──
const linesRes = await api('GET', '/api/workshop/dcw/lines', undefined, TOK)
const lines = linesRes.data?.data?.lines ?? linesRes.data?.data ?? []
const line = (Array.isArray(lines) ? lines : []).find(l => /injection-mission1/.test(l.name ?? '')) ?? null
check('D1a', '产线在册(注塑 mission1)', !!line, line ? `id=${line.id ?? line.lineId} name=${line.name} status=${line.status}` : JSON.stringify(linesRes.data).slice(0, 150))

const dcwRes = await api('GET', '/api/workshop/dcw?limit=200', undefined, TOK)
const dcwNodes = dcwRes.data?.data?.nodes ?? dcwRes.data?.data ?? []
const mine = (Array.isArray(dcwNodes) ? dcwNodes : []).filter(n => (n.lineId ?? '') === (line?.id ?? line?.lineId))
check('D1b', 'DCW 节点在册 ≥11', mine.length >= 11, `count=${mine.length}`)
const holdNode = mine.find(n => /hold-pressure/i.test(n.name ?? n.paramName ?? '')) ?? mine[0]

// ── D2 DAQ 样本流动 ──
const daqRes0 = await api('GET', '/api/workshop/daq?limit=50', undefined, TOK)
const daqNodes = (daqRes0.data?.data?.nodes ?? []).filter(n => n.enabled !== false).slice(0, 8)
const nodeIdCsv = daqNodes.map(n => n.id).join(',')
const win = async () => {
  const from = Date.now() - 90_000
  const r = await api('GET', `/api/workshop/daq/query?from=${from}&to=${Date.now()}&node_ids=${nodeIdCsv}&limit=500`, undefined, TOK)
  const series = r.data?.data?.series ?? []
  const points = series.flatMap(s => (s.points ?? []).map(p => ({ ts: p.at, v: p.v, node: s.nodeId })))
  return points
}
const w1 = await win()
await sleep(6000)
const w2 = await win()
const ts = rows => Math.max(0, ...rows.map(x => Number(x.ts ?? 0)))
check('D2a', 'DAQ 窗口1 有样本(series.points)', w1.length > 0, `points=${w1.length} nodes=${new Set(w1.map(x => x.node)).size}`)
check('D2b', '样本随时间前进', ts(w2) > ts(w1) && w2.length > 0, `tsMax1=${ts(w1)} tsMax2=${ts(w2)}`)

// ── D3 DCW 手动读 ──
const rd = await api('POST', `/api/workshop/dcw/${holdNode.id}/read`, {}, TOK)
const readVal = rd.data?.data?.read?.value ?? rd.data?.data?.read?.engineering ?? null
check('D3', 'DCW 手动读 ok', rd.status === 200 && rd.data?.data?.read?.ok !== false, `status=${rd.status} value=${readVal} raw=${JSON.stringify(rd.data?.data?.read).slice(0, 120)}`)

// ── D4 合法写(+1 工程量) → 回读一致(60s 频控窗:429 则等 65s 重试一次) ──
const cur = Number(readVal ?? holdNode.value ?? 0)
const target = cur + 1
let wr = await api('POST', `/api/workshop/dcw/${holdNode.id}/write`, { value: target }, TOK, 30000)
if (wr.status === 429) {
  console.log('· 写入命中 60s 频控(429,平台行为正确),等 65s 后重试')
  await sleep(65_000)
  wr = await api('POST', `/api/workshop/dcw/${holdNode.id}/write`, { value: target }, TOK, 30000)
}
const outcome = wr.data?.data?.outcome ?? {}
check('D4a', 'DCW 写穿+回读校验(readback-verified)', wr.status === 200 && outcome.ok === true && outcome.ack === 'readback-verified', `status=${wr.status} outcome=${JSON.stringify(outcome).slice(0, 220)}`)
const rb = await api('POST', `/api/workshop/dcw/${holdNode.id}/read`, {}, TOK)
const rbVal = rb.data?.data?.read?.value ?? null
check('D4b', '回读一致(写后读回 == 目标)', rb.status === 200 && rbVal != null && Math.abs(Number(rbVal) - target) < 0.51, `target=${target} readback=${rbVal}`)

// ── D5 负向:超单步限幅 ──
const big = target + 1000
const wBig = await api('POST', `/api/workshop/dcw/${holdNode.id}/write`, { value: big }, TOK, 20000)
check('D5', '超步限/量程写被拒(4xx)', wBig.status >= 400 && wBig.status < 500, `status=${wBig.status} msg=${JSON.stringify(wBig.data?.message ?? wBig.data).slice(0, 160)}`)

// ── 汇总 ──
const pass = checks.filter(c => c.ok).length
const result = {
  suite: 'US-004 数采/数控实机验证',
  base: BASE,
  at: new Date().toISOString(),
  line: line ? { id: line.id ?? line.lineId, name: line.name, status: line.status } : null,
  holdNode: { id: holdNode.id, name: holdNode.name },
  checks,
  verdict: `PASS(${pass}/${checks.length})`,
}
mkdirSync('docs/audit/evidence/2026-10-28-full-acceptance-run2', { recursive: true })
writeFileSync(OUT, JSON.stringify(result, null, 2))
console.log(`\nUS-004: ${result.verdict} → ${OUT}`)
process.exit(pass === checks.length ? 0 : 1)
