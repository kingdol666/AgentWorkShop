#!/usr/bin/env node
/**
 * 注塑真实场景闭环(2026-10-18):recipe_trial 多轮保压寻优 → HITL → 65s 工艺响应
 * → DAQ 复测 → 达标 recipe_update 固化(v2);不达标恢复基线。
 *
 * 前置:已运行的隔离平台 + PLC 模拟器注塑产线(scripts/_provision-injection-line.mjs),
 *       频道内存在启用的「工艺优化」worker;env: AW_BASE / AW_TOKEN。
 * 运行:npm run test:e2e-injection
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_TOKEN
if (!TOKEN) throw new Error('AW_TOKEN required')
const H = { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }
process.env.NO_PROXY = '127.0.0.1,localhost'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 500) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 500)}`}`)
}
const api = async (method, path, body, timeoutMs = 180_000) => {
  const r = await fetch(BASE + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const unwrap = r => r?.data ?? null
const invText = r => String(r?.data?.result?.text ?? r?.result?.text ?? r?.data?.text ?? '')
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.result?.isError ?? r?.data?.isError)
const invoke = (agentId, tool, args, timeoutMs = 240_000) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, timeoutMs)
const pendingIds = async () => new Set((unwrap(await api('GET', '/api/workshop/hitl/pending'))?.items ?? []).map(x => x.id))
const approve = card => api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: '注塑真实闭环 E2E 批准' })
async function invokeApproved(agentId, tool, args, label) {
  const known = await pendingIds()
  const p = invoke(agentId, tool, args)
  let card = null
  for (let i = 0; i < 90 && !card; i++) {
    await sleep(1000)
    const items = unwrap(await api('GET', '/api/workshop/hitl/pending'))?.items ?? []
    card = items.find(x => !known.has(x.id) && String(x.nodeId ?? '').startsWith('recipe:')) ?? null
  }
  if (card) await approve(card)
  const r = await p
  console.log(`  [${label}] hitl=${card?.id ?? '(无)'} isError=${invErr(r)} ${invText(r).slice(0, 260)}`)
  return { r, card }
}
const qualityOf = d => ({
  weight: Number(d?.nodes?.find(n => n.id === partWeight)?.value),
  flash: Number(d?.nodes?.find(n => n.id === flashRate)?.value),
  sink: Number(d?.nodes?.find(n => n.id === sinkMark)?.value),
  melt: Number(d?.nodes?.find(n => n.id === meltTemp)?.value),
})
const qualityOk = q => Number.isFinite(q.weight) && q.weight >= 32.15 && q.weight <= 32.85 && q.flash <= 0.4 && q.sink <= 1.5 && q.melt >= 235 && q.melt <= 262
const qText = q => `weight=${q.weight}g flash=${q.flash}% sink=${q.sink}% melt=${q.melt}℃`

const dcw = unwrap(await api('GET', '/api/workshop/dcw'))
const daq = unwrap(await api('GET', '/api/workshop/daq'))
const line = dcw.lines.find(l => /注塑|injection/i.test(l.name))
const dcwOf = re => dcw.nodes.find(n => n.lineId === line.id && re.test(`${n.name} ${n.id}`))
const daqOf = re => daq.nodes.find(n => n.lineId === line.id && re.test(`${n.name} ${n.id}`))
const holdPressure = dcwOf(/hold-pressure-sp/)
const holdTime = dcwOf(/hold-time-sp/)
const partWeight = daqOf(/part-weight/)?.id
const flashRate = daqOf(/flash-rate/)?.id
const sinkMark = daqOf(/sink-mark/)?.id
const meltTemp = daqOf(/melt-temp-pv/)?.id
const recipes = unwrap(await api('GET', '/api/workshop/dcw/recipes'))
const recipe = recipes.recipes.find(r => r.lineId === line.id && r.params.some(p => p.nodeId === holdTime.id))
const channels = unwrap(await api('GET', '/api/workshop/channels'))
const channelList = channels.channels ?? channels
let channel = null
let optimizer = null
for (const c of channelList.filter(x => /注塑/.test(x.name))) {
  const ag = unwrap(await api('GET', `/api/workshop/channels/${c.id}/agents`))
  const cand = (ag.agents ?? ag).find(a => a.role === 'worker' && /工艺优化/.test(a.name) && a.enabled)
  if (cand) {
    channel = c
    optimizer = cand
    break
  }
}
if (!channel || !optimizer) throw new Error('未找到含启用「工艺优化」worker 的注塑频道;请先运行注塑场景供给/真实闭环准备')
if (!line || !holdPressure || !holdTime || !partWeight || !flashRate || !sinkMark || !meltTemp || !recipe || !optimizer) throw new Error('scenario assets missing')
const basePressure = Number(recipe.params.find(p => p.nodeId === holdPressure.id)?.value)
const baseTime = Number(recipe.params.find(p => p.nodeId === holdTime.id)?.value)
const pressMax = Number(holdPressure.max)
await api('POST', '/api/workshop/agent-tools/bindings', { agentId: optimizer.id, nodeId: recipe.id, kind: 'recipe', mode: 'manual' })

async function readState() {
  const d = unwrap(await api('GET', '/api/workshop/dcw'))
  const p = Number(d.nodes.find(n => n.id === holdPressure.id)?.value)
  const t = Number(d.nodes.find(n => n.id === holdTime.id)?.value)
  const q = qualityOf(unwrap(await api('GET', '/api/workshop/daq')))
  return { p, t, q }
}
async function trial(params, hypothesis, label) {
  const { r, card } = await invokeApproved(optimizer.id, 'recipe_trial', { recipe_id: recipe.id, params, hypothesis, emergency: true }, label)
  await sleep(65_000)
  const st = await readState()
  return { r, card, ...st }
}

let st = await readState()
ok('P1', '场景/配方/worker 就绪', Boolean(line.id && recipe.id && optimizer.id) && st.q.weight > 0, `line=${line.id} recipe=${recipe.id} optimizer=${optimizer.id} ${qText(st.q)}`)

// 回到配方基线,保证本次闭环从确定工况开始
if (st.p !== basePressure || st.t !== baseTime) {
  const restore = await trial([{ node_id: holdPressure.id, value: basePressure }, { node_id: holdTime.id, value: baseTime }], `真实闭环 P2:恢复配方基线保压 ${basePressure}bar/保压时间 ${baseTime}s,确保本轮从确定工况开始。`, 'restore baseline')
  st = { p: restore.p, t: restore.t, q: restore.q }
  ok('P2', '恢复基线并完成 65s 复测', !invErr(restore.r) && st.p === basePressure, `${qText(st.q)} p=${st.p} t=${st.t}`)
}
else {
  ok('P2', '当前已在配方基线', true, `${qText(st.q)} p=${st.p} t=${st.t}`)
}
const baseline = { ...st }

// 保压逐级 +5bar,最多 6 轮(每轮 HITL + 65s 复测)
let best = { p: st.p, q: st.q }
let final = null
for (let i = 1; i <= 6; i++) {
  const target = Number(Math.min(pressMax, baseline.p + 5 * i).toFixed(1))
  if (target <= baseline.p) break
  const prevBest = { ...best }
  const r = await trial([{ node_id: holdPressure.id, value: target }], `真实闭环 P3-${i}:克重 ${st.q.weight}g、缩痕 ${st.q.sink}%,保压 ${st.p}→${target}bar(单变量);65s 后 DAQ 复测。`, `pressure +5 #${i}`)
  ok(`P3-${i}`, `保压 ${target}bar 试验经 HITL 并设备证实`, !invErr(r.r) && r.p === target, `${qText(r.q)} p=${r.p} ${invText(r.r).slice(0, 180)}`)
  if (r.p !== target) break
  st = { p: r.p, t: r.t, q: r.q }
  if (qualityOk(r.q)) {
    final = { ...r, target }
    break
  }
  if (r.q.weight > 32.85) {
    // 过冲:退回上一轮压力
    const back = await trial([{ node_id: holdPressure.id, value: prevBest.p }], `真实闭环 P3-${i} 纠偏:克重 ${r.q.weight}g 越过上限 32.85,退回 ${prevBest.p}bar。`, `pressure overshoot back`)
    st = { p: back.p, t: back.t, q: back.q }
    final = back
    break
  }
  best = { p: r.p, q: r.q }
}

// 若保压仍不足,补一档保压时间 +1s
if (!final || !qualityOk(final.q ?? st.q)) {
  if (!(final?.q && qualityOk(final.q))) {
    const targetT = Number((baseTime + 1).toFixed(1))
    const r = await trial([{ node_id: holdTime.id, value: targetT }], `真实闭环 P4:保压寻优后 ${qText(st.q)} 仍未全窗,单变量保压时间 ${st.t}→${targetT}s。`, 'hold-time +1')
    st = { p: r.p, t: r.t, q: r.q }
    final = r
    ok('P4', '保压时间补偿试验经 HITL 并复测', !invErr(r.r) && r.t === targetT, `${qText(r.q)} t=${r.t} ${invText(r.r).slice(0, 180)}`)
  }
}

const finalQ = final?.q ?? st.q
const finalOk = qualityOk(finalQ)
ok('P5', '最终质量入窗(克重/飞边/缩痕/熔温)', finalOk, qText(finalQ))

let update = null
if (finalOk) {
  const cur = await readState()
  update = await invokeApproved(optimizer.id, 'recipe_update', {
    recipe_id: recipe.id,
    params: [{ node_id: holdPressure.id, value: cur.p }, { node_id: holdTime.id, value: cur.t }],
    reason: `真实闭环复测达标(${qText(cur.q)}),固化保压 ${cur.p}bar/保压时间 ${cur.t}s;依据多轮 HITL 批准的 recipe_trial 与 65s DAQ 复测。`,
  }, 'recipe_update keep')
  ok('P6', '达标配方固化(v2,经 HITL)', !invErr(update.r) && /已保存为 v[2-9]/.test(invText(update.r)), invText(update.r).slice(0, 260))
}
else {
  const back = await trial([{ node_id: holdPressure.id, value: basePressure }, { node_id: holdTime.id, value: baseTime }], `真实闭环 P6:最终 ${qText(finalQ)} 未入窗,恢复基线保压 ${basePressure}bar/时间 ${baseTime}s 保护现场。`, 'corrective restore')
  ok('P6', '未达标时恢复基线并复测', !invErr(back.r) && back.p === basePressure, `${qText(back.q)} p=${back.p} t=${back.t}`)
}

const jr = await invoke(optimizer.id, 'dcw_journal', { recipe_id: recipe.id, limit: 30 })
const rl = await invoke(optimizer.id, 'recipe_log', { recipe_id: recipe.id, minutes: 60, limit: 30 })
ok('P7', '写控/配方日志可追溯', !invErr(jr) || !invErr(rl), `${invText(jr).slice(0, 160)} | ${invText(rl).slice(0, 160)}`)

const outDir = join('bench', 'results', `injection-pressure-loop-${new Date().toISOString().replace(/[:.]/g, '-')}`)
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, line: line.id, recipe: recipe.id, optimizer: optimizer.id, baseline, final: finalQ, finalOk, update: update ? invText(update.r) : null, journal: invText(jr), recipeLog: invText(rl), results }, null, 2))
console.log(`\n═══ 结论:${results.every(r => r.pass) ? 'PASS' : 'FAIL'}(${results.filter(r => r.pass).length}/${results.length}) out=${outDir} ═══`)
process.exit(results.every(r => r.pass) ? 0 : 1)
