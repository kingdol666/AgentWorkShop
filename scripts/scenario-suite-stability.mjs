/**
 * US-004 产线稳定性优化：基线窗口 → 两轮 ±2bar 小步（每轮 HITL）→ 复测方差/均值 → 劣化回退。
 * 读取 setup 阶段临时 context（含测试 token）；只写临时实例。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CTX = process.argv[2] ?? join(process.env.TEMP ?? '', 'aw-scenario-suite-a1FFaM', 'scenario-context.json')
const c = JSON.parse(readFileSync(CTX, 'utf8'))
const EVID = join(REPO, 'docs', 'audit', '2026-10-20-scenario-suite-evidence')
mkdirSync(EVID, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
function ok(id, name, cond, detail = '') {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 600) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${detail ? ` — ${String(detail).slice(0, 260)}` : ''}`)
}
async function api(method, path, body, token = c.adminToken) {
  const r = await fetch(c.base + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
async function invoke(agent, tool, args, timeoutMs = 240_000) {
  const r = await fetch(c.base + '/api/workshop/agent-tools/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aw-agent-token': agent.token },
    body: JSON.stringify({ agentId: agent.id, tool, args }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await r.json().catch(() => null)
  return { status: r.status, isError: Boolean(j?.data?.result?.isError), text: String(j?.data?.result?.text ?? '') }
}
async function pendingIds() {
  const r = await api('GET', '/api/workshop/hitl/pending')
  return new Set((r?.data?.items ?? []).map(x => x.id))
}
async function approvedTrial(params, hypothesis, label) {
  const known = await pendingIds()
  const p = invoke(c.agents.optimizer, 'recipe_trial', { recipe_id: c.recipeId, params, hypothesis, emergency: true })
  let card = null
  for (let i = 0; i < 90 && !card; i++) {
    await sleep(1000)
    const items = (await api('GET', '/api/workshop/hitl/pending'))?.data?.items ?? []
    card = items.find(x => !known.has(x.id) && String(x.nodeId ?? '').startsWith('recipe:')) ?? null
  }
  if (card) {
    await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: `US-004 稳定性 ${label}` })
  }
  const r = await p
  return { card, ...r }
}
async function windowStats(nodeId, windowMs, endMs = Date.now()) {
  const to = endMs
  const from = to - windowMs
  const r = await api('GET', `/api/workshop/daq/${nodeId}/samples?from=${from}&to=${to}&bucketMs=5000&limit=500`)
  const pts = r?.data?.points ?? []
  const vals = pts.map(p => Number(p.value ?? p.avg)).filter(Number.isFinite)
  if (!vals.length) return { n: 0, mean: NaN, std: NaN, min: NaN, max: NaN, inWindow: 0, from, to }
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length)
  return {
    n: vals.length, mean, std, min: Math.min(...vals), max: Math.max(...vals),
    inWindow: vals.filter(v => v >= 32.15 && v <= 32.85).length, from, to,
  }
}
async function readPressure() {
  const d = (await api('GET', '/api/workshop/dcw'))?.data
  const n = (d?.nodes ?? []).find(x => x.id === c.dcw?.['hold-pressure-sp'])
  return { value: Number(n?.value), min: Number(n?.min), max: Number(n?.max), stepLimit: Number(n?.stepLimit) }
}

async function main() {
  console.log(`━━━ US-004 stability @ ${c.base} line=${c.lineId} ━━━`)
  const weight = c.daq?.['part-weight'] ?? c.weightNode
  const pressNode = c.dcw?.['hold-pressure-sp']
  const press = await readPressure()
  ok('U4-1', '保压节点/克重节点在位', Boolean(pressNode && weight), `press=${pressNode} weight=${weight} value=${press.value}`)
  const base = await windowStats(weight, 90_000)
  ok('U4-2', '基线窗口统计', base.n >= 8 && Number.isFinite(base.mean), `n=${base.n} mean=${base.mean.toFixed(3)} std=${base.std.toFixed(3)} range=${base.min}~${base.max} in=${base.inWindow}`)
  const stepLimit = Math.max(0.1, Number(press.stepLimit) || 1.8)
  const step = Math.min(1.8, stepLimit)
  const rounds = []
  let degraded = false
  let lastWriteAt = 0
  let rollbackValue = press.value

  for (const [i, dir] of [[1, 1], [2, -1]]) {
    // 每轮从“当前实际值”计算，硬性保证 |Δ| ≤ stepLimit（reviewer 指出的 65→63.2 跨 3.6 已修正）
    const cur = await readPressure()
    const target = Number((Number(cur.value) + dir * step).toFixed(2))
    const delta = Math.abs(target - Number(cur.value))
    ok(`U4-3.${i}`, `第 ${i} 轮步长合规`, delta <= stepLimit + 1e-9, `current=${cur.value} target=${target} delta=${delta.toFixed(2)} stepLimit=${stepLimit}`)
    const tr = await approvedTrial([{ node_id: pressNode, value: target }], `US-004 稳定性第 ${i} 轮:单变量保压 ${cur.value}→${target}bar(Δ=${delta.toFixed(2)}),观察克重均值/方差是否稳定。`, `round${i}`)
    const applied = Number(tr.text.match(/hold-pressure-sp→([\d.]+)bar/)?.[1] ?? NaN)
    lastWriteAt = Date.now()
    ok(`U4-4.${i}`, `第 ${i} 轮 HITL 批准并下发`, Boolean(tr.card) && !tr.isError && Math.abs(applied - target) < 1e-6, `${tr.text.slice(0, 180)}`)
    await sleep(65_000)
    const st = await windowStats(weight, 65_000)
    const anyOut = st.n > 0 && st.inWindow < st.n
    const worse = !(st.n >= 5) || st.std > Math.max(base.std * 2, 0.08) || anyOut || st.mean < 32.15 || st.mean > 32.85
    rounds.push({ round: i, from: cur.value, target, applied, delta, stats: st, worse, hitl: tr.card?.id ?? null })
    ok(`U4-5.${i}`, `第 ${i} 轮复测`, st.n >= 5 && Number.isFinite(st.mean), `mean=${st.mean.toFixed(3)} std=${st.std.toFixed(3)} in=${st.inWindow}/${st.n} worse=${worse}`)
    if (worse) {
      degraded = true
      const back = await approvedTrial([{ node_id: pressNode, value: rollbackValue }], `US-004 回退:第 ${i} 轮 mean=${st.mean.toFixed(3)}/std=${st.std.toFixed(3)}/窗内 ${st.inWindow}/${st.n} 判为劣化,回退 ${target}→${rollbackValue}bar。`, `rollback${i}`)
      lastWriteAt = Date.now()
      await sleep(65_000)
      const rb = await windowStats(weight, 60_000)
      rounds.push({ round: i, rollback: true, from: target, target: rollbackValue, stats: rb, hitl: back.card?.id ?? null })
      ok(`U4-6.${i}`, `第 ${i} 轮劣化回退`, Boolean(back.card) && !back.isError && rb.inWindow >= rb.n, `mean=${rb.mean.toFixed(3)} std=${rb.std.toFixed(3)} in=${rb.inWindow}/${rb.n}`)
      break
    }
  }

  // 最终窗口必须从最后一次写入 +65s 工艺响应之后开始（reviewer 指出的混窗已修正）
  const settleFrom = lastWriteAt + 65_000
  await sleep(60_000)
  const final = await windowStats(weight, 60_000, settleFrom + 60_000)
  const finalOk = final.n >= 8 && final.inWindow === final.n && final.std <= Math.max(base.std * 1.5, 0.08)
  ok('U4-7', '最终状态质量窗与稳定度(末次写入后窗口)', finalOk, `window=${new Date(settleFrom).toISOString()}~${new Date(settleFrom + 60_000).toISOString()} mean=${final.mean.toFixed(3)} std=${final.std.toFixed(3)} in=${final.inWindow}/${final.n} degraded=${degraded}`)
  const ev = { story: 'US-004', lineId: c.lineId, recipeId: c.recipeId, pressNode, weightNode: weight, stepLimit, step, baseline: base, rounds, final, degraded, rollbackTriggered: degraded }
  writeFileSync(join(EVID, 'US-004-stability.json'), JSON.stringify(ev, null, 2))
  const pass = results.filter(r => r.pass).length
  console.log(`\n═══ stability: ${pass}/${results.length} PASS ═══`)
  if (pass !== results.length) process.exitCode = 1
}
main().catch((e) => {
  console.error(e)
  ok('U4-ERR', '脚本未抛异常', false, e.message)
  process.exitCode = 1
})
