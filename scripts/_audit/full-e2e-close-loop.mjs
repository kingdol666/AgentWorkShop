#!/usr/bin/env node
/**
 * scripts/_audit/full-e2e-close-loop.mjs —— MPC 推荐写回闭环补全(治理步限内)。
 * 收官轮 A4g wrote=0 的机理:MPC 推荐相对当前 SV 的跳幅超过单步写限(zone 2.8℃/
 * linespeed 2 等),治理逐笔拒绝 —— 这是正确的保护行为。本脚本改为**分步逼近**:
 * 每步只写治理允许的幅度,62s 间隔,最多 3 跳,把 SV 拉向推荐值,再复测 PV。
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:3474'
const HOME = join(tmpdir(), 'aw-full-e2e-fmtJ6b')
let TOKEN = ''
const callA = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method, headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000),
  })
  const json = await r.json().catch(() => null)
  return { status: r.status, json, data: json?.data, message: json?.message }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`) }
}

TOKEN = (await (await fetch(`${BASE}/api/users/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'e2e-full@awshop.local', password: 'E2eFull2026!' }),
})).json()).data?.token ?? ''
ok('C0 登录', Boolean(TOKEN))

const chs = (await callA('GET', '/api/workshop/channels')).data
const chList = Array.isArray(chs) ? chs : (chs.items ?? [])
const channelA = chList.find(c => c.name === '全功能E2E训练通道')?.id
const workerA = ((await callA('GET', `/api/workshop/channels/${channelA}/agents`)).data ?? []).find(a => a.role === 'worker')?.id
const invoke = async (tool, args) => {
  const r = await callA('POST', '/api/workshop/agent-tools/invoke', { agentId: workerA, tool, args })
  return { isError: Boolean(r.json?.data?.result?.isError), text: String(r.json?.data?.result?.text ?? '') }
}
const dw = (await callA('GET', '/api/workshop/dcw/')).data?.nodes ?? []
const lineId = dw.find(n => n.name?.endsWith('fulle2e'))?.lineId
const recipes = (await callA('GET', '/api/workshop/dcw/recipes')).data
const recipe = (recipes?.recipes ?? []).find(r => r.lineId === lineId)

/* 步限表(zone 2.8℃,其余按模板;实测 linespeed/diegap ±2/±0.03?保守用值) */
const STEP_LIMIT = {
  加热区: 2.8, ScrewSpeed: 5, lineSpeed: 2, dieGap: 0.03,
}
const stepLimitOf = (name) => {
  for (const [k, v] of Object.entries(STEP_LIMIT)) if (name.includes(k)) return v
  return 2
}
const nodeIdOfSpec = {}

/* C1 开线 + 新快照 */
{
  const st = await callA('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId: recipe.id })
  if (st.status !== 200) { await sleep(8000); await callA('POST', `/api/workshop/dcw/lines/${lineId}/start`, { recipeId: recipe.id }) }
  await sleep(15000)
  const snap = await invoke('twin_snapshot_create', { auto_daq: true, channel_id: channelA, phase: 'calibration' })
  const m = snap.text.match(/snapshot_id:\s*([^\s\n]+)/)
  ok('C1 快照创建', Boolean(m?.[1]), snap.text.slice(0, 120))
  globalThis.__snap = m?.[1]
}

/* C2 MPC → 推荐值 */
let best
{
  const sceneDir = 'castfilm-fulle2e-r3'
  const frozenRoot = join(HOME, 'aml', 'twins', 'scenes')
  const sceneName = (await import('node:fs')).readdirSync(frozenRoot).find(d => d.startsWith(sceneDir) && d.endsWith('-frozen')) ?? ''
  const frozen = JSON.parse(readFileSync(join(frozenRoot, sceneName, 'scenes.json'), 'utf8')).scene ?? {}
  const targetObs = (frozen.observations ?? []).find(o => o.role === 'target')
  const dwNow = (await callA('GET', '/api/workshop/dcw/')).data?.nodes ?? []
  const cur = Object.fromEntries(dwNow.filter(n => n.lineId === lineId).map(n => [n.name, Number(n.value)]))
  for (const c of (frozen.controls ?? [])) {
    const node = dwNow.find(n => n.id === c.nodeId)
    if (node) nodeIdOfSpec[c.id] = { nodeId: c.nodeId, name: node.name }
  }
  const baseline = Object.fromEntries((frozen.controls ?? []).map(c => [c.id, cur[nodeIdOfSpec[c.id]?.name]]).filter(([, v]) => Number.isFinite(v)))
  const mpc = await invoke('mpc_optimize', {
    snapshot_id: globalThis.__snap, baseline_controls: baseline, horizon_steps: 4,
    objective: {
      schemaVersion: 1, createdAt: new Date().toISOString(), createdBy: 'close-loop',
      objectiveId: 'thickness-50um', targets: { [targetObs.id]: 50 }, weights: { [targetObs.id]: 1 },
      controlCosts: {}, horizonSteps: 4, trustRegion: {},
    },
  })
  const raw = mpc.text.match(/"bestCandidate":\s*(\{[\s\S]*?\})\s*,?\s*\n/)
  try { best = JSON.parse(raw?.[1] ?? mpc.text.match(/"bestCandidate":\s*(\{[^}]*\})/)?.[1] ?? 'null') } catch { best = null }
  ok('C2 MPC 推荐(production 自动投用)', Boolean(best && Object.keys(best).length > 0), mpc.text.replace(/\s+/g, ' ').slice(0, 220))
  globalThis.__frozen = frozen
}

/* C3 治理步限内分步写回(最多 3 跳,每跳 62s) */
if (best && Object.keys(best).length > 0) {
  let wrote = 0
  let rejected = 0
  const idToNode = Object.fromEntries(Object.entries(nodeIdOfSpec).map(([k, v]) => [k, v]))
  for (let hop = 0; hop < 3; hop++) {
    let moved = false
    const dwNow = (await callA('GET', '/api/workshop/dcw/')).data?.nodes ?? []
    const curById = Object.fromEntries(dwNow.map(n => [n.id, Number(n.value)]))
    for (const [specId, target] of Object.entries(best)) {
      const ent = idToNode[specId]
      if (!ent || !Number.isFinite(Number(target))) continue
      const cur = curById[ent.nodeId]
      const lim = stepLimitOf(ent.name ?? '')
      const delta = Number(target) - cur
      if (Math.abs(delta) < 1e-6) continue
      const step = Math.sign(delta) * Math.min(Math.abs(delta), lim)
      const w = await callA('POST', `/api/workshop/dcw/${ent.nodeId}/write`, { value: Number((cur + step).toFixed(4)) })
      if (w.status === 200) { wrote++; moved = true; console.log(`  ↳ 写 ${ent.name} → ${(cur + step).toFixed(3)}(距推荐 ${Math.abs(delta).toFixed(3)})`) }
      else { rejected++; console.log(`  ↳ 拒 ${ent.name}: ${String(w.message ?? '').slice(0, 60)}`) }
    }
    if (!moved || hop === 2) break
    await sleep(62_000)
  }
  ok('C3 推荐值经治理写回 DCW(分步)', wrote > 0, `wrote=${wrote} rejected=${rejected}(拒=治理单步限保护,符合预期)`)
  await sleep(90_000)
  const targetNodeId = globalThis.__frozen ? (globalThis.__frozen.observations ?? []).find(o => o.role === 'target')?.nodeId : null
  const r = await callA('GET', `/api/workshop/daq/${targetNodeId}/samples?bucketMs=1000&limit=60`)
  const pts = (r.data?.points ?? []).map(p => Number(p.avg ?? p.value)).filter(Number.isFinite).slice(0, 30)
  const mean = pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : Number.NaN
  ok('C4 写回后 PV 复测(膜厚均值)', Number.isFinite(mean), `mean=${Number.isFinite(mean) ? mean.toFixed(2) : 'n/a'} μm(目标 50,窗口内近 30 点)`)
}
else { ok('C3 推荐值写回', false, '无 bestCandidate') }
await callA('POST', `/api/workshop/dcw/lines/${lineId}/stop`, {})
console.log(`\n═══ 闭环补全:${pass} PASS / ${fails.length} FAIL ═══`)
process.exit(fails.length ? 1 : 0)
