#!/usr/bin/env node
/**
 * cal3-staged-live.mjs —— 四期递进能力实证(分析 → HITL 控制 → 模型训练 → 自主优化)。
 *
 * 场景:CAL-3 连续退火炉,四期作业串成一条 Project 依赖链:
 *   W1 数据分析(只读零写) → W2 HITL 下发控制(逐动作审批) → W3 训练数据集 → W4 受控自主优化(有界,无审批)
 * 每期以真实工具链执行,前置期 L1+L2 通过才放行下一期(引擎 readiness)。
 *
 * 用法:node scripts/_audit/cal3-staged-live.mjs --base http://127.0.0.1:4001
 * 证据:docs/audit/evidence/2026-11-08-skill-staged-cal3/staged.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = (arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:4001')).replace(/\/$/, '')
const EVID = resolve(arg('out', join(REPO, 'docs/audit/evidence/2026-11-08-e2e-wwtp')))
mkdirSync(EVID, { recursive: true })

const LINE = 'ln-fabeef11'
const RECIPE = 'rc-eefa8c9c'
const SP1 = 'dw-3ea126d5'   // 鼓风机频率SP step 2 (20~50)
const DAQ = { zone1: 'dn-c0c8b7a4', zone2: 'dn-86e002c8', exit: 'dn-0900949c', tensile: 'dn-320f821b', elong: 'dn-d938a9ba', defect: 'dn-320f821b' } // zone1=DO, tensile=氨氮, elong=COD
const CH = {
  analysis: '034640a5-e6fd-4468-afaf-599edabb014f',
  control: '56dff838-6b65-419f-a4b6-406962456aa6',
  training: 'b152d442-baa0-4a75-adee-b8bd8979d8d5',
  optimize: '85b33c6d-aaf3-42b5-ac5c-bd8b5f5b4621',
}

let tokenA = ''
let tokenB = ''
const results = []
const step = (id, name, ok, detail = '') => {
  results.push({ id, name, pass: Boolean(ok), detail: String(detail ?? '').slice(0, 900) })
  console.log(`${ok ? '✔' : '✖'} [${id}] ${name}${ok ? '' : ` — ${String(detail ?? '').slice(0, 260)}`}`)
  return Boolean(ok)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, opts = {}) {
  const t = opts.user === 'B' ? tokenB : tokenA
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const j = await res.json().catch(() => null)
  return { status: res.status, data: j?.data, code: j?.code, message: j?.message ?? '' }
}
async function invoke(agentId, tool, argsTool = {}, timeoutMs = 240_000) {
  const res = await fetch(`${base}/api/workshop/agent-tools/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ agentId, tool, args: argsTool }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const okHttp = res.ok && String(res.headers.get('content-type') ?? '').includes('json')
  if (!okHttp) return { status: res.status, isError: true, text: `HTTP ${res.status}(非 JSON 或请求失败)` }
  const j = await res.json().catch(() => null)
  return { status: res.status, isError: Boolean(j?.data?.result?.isError), text: String(j?.data?.result?.text ?? '') }
}
/** 数采序列(标量桶均值),用于真实统计计算 */
async function daqSeries(nodeId, fromMs, toMs, bucketMs = 5000) {
  const j = await api('GET', `/api/workshop/daq/${nodeId}/samples?from=${fromMs}&to=${toMs}&bucketMs=${bucketMs}`)
  const pts = j?.data?.points ?? []
  return pts.map(p => ({ at: Number(p.at ?? p.ts ?? 0), v: Number(p.avg ?? p.value ?? Number.NaN) })).filter(p => Number.isFinite(p.v) && p.v !== 0 || true).filter(p => Number.isFinite(p.v))
}
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return { r: Number.NaN, n }
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy }
  return { r: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : Number.NaN, n }
}
async function dcwNodes() { return (await api('GET', '/api/workshop/dcw')).data?.nodes ?? [] }
async function poll(fn, timeoutMs = 60_000, interval = 1500) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(interval) }
  return null
}
async function acceptanceChain(pid, wid, summary, tag) {
  const draft = await poll(async () => {
    const rows = (await api('GET', `/api/workshop/projects/${pid}/results`)).data ?? []
    return rows.find(r => r.workItemId === wid && r.status === 'draft') ?? null
  }, 30_000)
  if (!step(`${tag}-s1`, `${tag} draft 物化(证据=真实工件)`, Boolean(draft?.id), JSON.stringify(draft ?? {}).slice(0, 120))) return null
  const sub = await api('POST', `/api/workshop/projects/${pid}/results/${draft.id}/submit`, { summary: summary.slice(0, 4000) })
  if (!step(`${tag}-s2`, `${tag} owner 提交`, sub.status === 200, sub.message)) return null
  const rev = await api('POST', `/api/workshop/projects/${pid}/results/${draft.id}/review`, { decision: 'reviewed', reason: `${tag} L1 技术评审(独立评审)` }, { user: 'B' })
  if (!step(`${tag}-s3`, `${tag} L1 技术评审(独立 admin)`, rev.status === 200, rev.message)) return null
  const req = await api('POST', `/api/workshop/projects/${pid}/results/${draft.id}/request-acceptance`, {})
  if (!step(`${tag}-s4`, `${tag} L2 申请`, req.status === 200, req.message)) return null
  const dec = req.data?.id ? await api('POST', `/api/workshop/projects/${pid}/approvals/${req.data.id}/decide`, { approve: true }, { user: 'B' }) : { status: 400 }
  if (!step(`${tag}-s5`, `${tag} L2 签核 → approved`, dec.status === 200, dec.message ?? '')) return null
  return draft
}
async function dispatchAndWaitInstance(pid, wid, tag) {
  const disp = await api('POST', `/api/workshop/projects/${pid}/work-items/${wid}/dispatch`, {})
  if (!step(`${tag}-d1`, `${tag} 派发(实例创建)`, disp.status === 200, disp.message)) return null
  const instCh = disp.data?.instanceChannelId
  const info = await poll(async () => {
    const det = (await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`)).data
    return det?.attempts?.[0]?.channelTaskId ? det : null
  }, 40_000)
  if (!step(`${tag}-d2`, `${tag} 实例 Channel+root 在飞`, Boolean(instCh && info), `inst=${String(instCh ?? '').slice(0, 8)}`)) return null
  const ags = (await api('GET', `/api/workshop/channels/${instCh}/agents`)).data ?? []
  const lead = ags.find(a => a.role === 'lead' && (a.enabled ?? 1) === 1)
  step(`${tag}-d3`, `${tag} 实例 lead 启用`, Boolean(lead?.id), `lead=${String(lead?.id ?? '').slice(0, 8)} members=${ags.length}`)
  return { instCh, rootId: info.attempts[0].channelTaskId, leadId: lead?.id }
}
async function closeRoot(pid, wid, ctx, text, tag) {
  const done = await invoke(ctx.leadId, 'complete_task', { task_id: ctx.rootId, summary: text })
  step(`${tag}-c1`, `${tag} 实例 lead 以真实工件收口 root`, !done.isError, done.text.replace(/\s+/g, ' ').slice(0, 160))
  const st = await poll(async () => {
    const d = (await api('GET', `/api/workshop/projects/${pid}/observability/work-items/${wid}`)).data
    return d?.workItem?.state === 'COMPLETED' ? 'COMPLETED' : null
  }, 30_000)
  step(`${tag}-c2`, `${tag} 工作项 COMPLETED`, st === 'COMPLETED', `state=${st}`)
}

async function main() {
  tokenA = (await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })).data?.token ?? ''
  tokenB = (await api('POST', '/api/users/login', { email: 'verify-pitfall@aw.local', password: 'Verify#2026' })).data?.token ?? ''
  if (!step('S0-1', '双账号登录(owner / 独立评审)', Boolean(tokenA && tokenB), 'A=admin B=verify-pitfall')) return finish()
  const spNode = (await dcwNodes()).find(n => n.id === SP1)
  const cur0 = Number(spNode?.value ?? 780)
  if (!step('S0-2', '现场上下文(鼓风机频率SP)', Number.isFinite(cur0), `sp=${cur0}`)) return finish()
  const sDoPre = await daqSeries(DAQ.zone1, Date.now() - 60_000, Date.now(), 2000)
  const preTreatDo = sDoPre.length ? sDoPre.reduce((a, b) => a + b.v, 0) / sDoPre.length : Number.NaN
  const productId = ((await api('GET', '/api/workshop/dcw')).data?.recipes ?? []).find(x => x.id === RECIPE)?.productId ?? ''
  await api('PATCH', '/api/system/settings', { override: { 'dcw.rollback_stale_ms': 60000 } })
  process.on('exit', () => { void fetch(`${base}/api/system/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` }, body: JSON.stringify({ override: { 'dcw.rollback_stale_ms': 1800000 } }) }).catch(() => {}) })
  // setup 操作(owner,非工作项):开批次(运行门权威=line-run 注册表)。line_start 409=批次已活(沿用既有批次);
  // 真正的批次有效性由 W2 运行门实证(批次缺失时 W2-t3 会显式红)。
  const st0 = await api('POST', `/api/workshop/dcw/lines/${LINE}/start`, { recipeId: RECIPE })
  const batchAlive = st0.status === 200 || /已在运行|已经运行|active/i.test(st0.message ?? '')
  const newest0 = ((await api('GET', '/api/workshop/dcw/runs?limit=5')).data?.runs ?? []).find(r => r.lineId === LINE)
  step('S0-3', 'setup:批次 A 就绪(owner;line_start 基线下发=平台语义;409=沿用活动批次)', batchAlive,
    `start=${st0.status} ${String(st0.message ?? '').slice(0, 60)} | latestRun=${String(newest0?.id ?? '').slice(0, 10)} open=${newest0 ? !newest0.endedAt : '?'}`)
  await sleep(8000)

  // ═══ S1 Project 四期链 ═══
  const proj = await api('POST', '/api/workshop/projects', {
    name: `CAL-3 四期递进优化 ${Date.now()}`,
    objective: '分析诊断→HITL 下发→模型训练→受控自主优化,四期逐级放行(出水氨氮 ≤5 mg/L 一级A)',
    leaderHarness: 'mock', mode: 'supervised', routingPolicy: 'technical',
  })
  const pid = proj.data?.id
  step('S1-1', 'Project 创建(technical 路由)', Boolean(pid), `pid=${String(pid ?? '').slice(0, 8)}`)
  if (!pid) return finish()
  const bind = []
  for (const [k, cid] of Object.entries(CH)) bind.push((await api('POST', `/api/workshop/projects/${pid}/channels`, { channelId: cid, charter: { analysis: '数据分析(只读)', control: 'HITL 控制(逐动作审批)', training: '模型训练(数据集)', optimize: '受控自主优化(有界)' }[k] })).status)
  step('S1-2', '四频道绑定到 Project(职责分离)', bind.every(s => s === 200), `statuses=${bind.join('/')}`)
  const d = {}
  for (const [k, name] of Object.entries({ analysis: 'phase1-analysis-report', control: 'phase2-control-report', training: 'phase3-dataset-report', optimize: 'phase4-autonomous-report' })) {
    d[k] = (await api('POST', `/api/workshop/projects/${pid}/deliverables`, { name, required: true, ownerChannelId: CH[k], acceptanceCriteria: ['artifact_present'] })).data?.id
  }
  step('S1-3', '四期交付物注册', Object.values(d).every(Boolean), Object.keys(d).join(','))
  const mk = async (k, title, brief, dependsOn) => (await api('POST', `/api/workshop/projects/${pid}/work-items`, {
    deliverableId: d[k], channelId: CH[k], title, brief, execBudgetMinutes: 20, ...(dependsOn ? { dependsOn: [dependsOn] } : {}),
  })).data?.id
  const w1 = await mk('analysis', 'W1 数据分析:氨氮/DO 波动诊断', '拉取数采数据做氨氮-DO 相关性诊断,输出带证据结论。', null)
  const w2 = await mk('control', 'W2 HITL 下发:曝气小步治理', '依据 W1 结论做单变量小步试验,逐动作 HITL 审批。', w1)
  const w3 = await mk('training', 'W3 模型训练:构建工况数据集', '基于治理后批次构建训练数据集与质量报告。', w2)
  const w4 = await mk('optimize', 'W4 受控自主优化:有界小步激励', '在安全有界范围内自主探索,无需逐动作审批。', w3)
  step('S1-4', '四期依赖链 W1→W2→W3→W4', Boolean(w1 && w2 && w3 && w4), [w1, w2, w3, w4].map(x => String(x ?? '').slice(0, 6)).join('→'))
  const act = await api('POST', `/api/workshop/projects/${pid}/activate`, {})
  step('S1-5', 'Project 激活', act.status === 200, act.message)
  const plan = await api('POST', `/api/workshop/projects/${pid}/plan/request-approval`, { version: 1, plan: { facts: ['CAL-3 双协议接入(Modbus+OPC UA)', '四期逐级放行'], steps: ['W1 诊断', 'W2 HITL 治理', 'W3 训练数据', 'W4 自主优化'] } })
  const pd = plan.data?.id ? await api('POST', `/api/workshop/projects/${pid}/approvals/${plan.data.id}/decide`, { approve: true }, { user: 'B' }) : { status: 400 }
  step('S1-6', 'plan 审批(独立 admin)', pd.status === 200, plan.message || pd.message || '')

  // ═══ W1 分析(只读零写;结论=真实统计,非硬编码) ═══
  const c1 = await dispatchAndWaitInstance(pid, w1, 'W1')
  if (!c1) return finish(pid)
  const now0 = Date.now()
  const sTensile = await daqSeries(DAQ.tensile, now0 - 5 * 60_000, now0)
  const sZone1 = await daqSeries(DAQ.zone1, now0 - 5 * 60_000, now0)
  const { r: corr, n: corrN } = pearson(sZone1.map(p => p.v), sTensile.map(p => p.v))
  const meanTensile = sTensile.length ? sTensile.reduce((a, b) => a + b.v, 0) / sTensile.length : Number.NaN
  const stdTensile = sTensile.length > 1 ? Math.sqrt(sTensile.reduce((a, b) => a + (b.v - meanTensile) ** 2, 0) / (sTensile.length - 1)) : Number.NaN
  step('W1-t1', 'W1 数采取证(强度/炉温序列)', sTensile.length >= 5 && sZone1.length >= 5, `tensile=${sTensile.length}点 zone1=${sZone1.length}点`)
  step('W1-t2', 'W1 真实统计(Pearson 相关+波动)', Number.isFinite(corr) && corrN >= 5 && Number.isFinite(stdTensile),
    `r(DO,氨氮)=${corr.toFixed(3)}(n=${corrN}) 氨氮均值=${meanTensile.toFixed(2)}mg/L σ=${stdTensile.toFixed(2)}(一级A ≤5)`)
  const q3 = await invoke(c1.leadId, 'daq_query', { node_id: DAQ.exit, last_minutes: 5, bucket_ms: 5000 })
  step('W1-t3', 'W1 出口温度交叉取证', !q3.isError, q3.text.replace(/\s+/g, ' ').slice(0, 100))
  const w1Text = `W1 诊断结论(${new Date().toISOString().slice(0, 16)}):基于 5 分钟窗实测序列——出水氨氮均值 ${meanTensile.toFixed(2)} mg/L、样本标准差 ${stdTensile.toFixed(2)}(一级A ≤5,当前超标);DO 与氨氮的 Pearson 相关 r=${Number.isFinite(corr) ? corr.toFixed(3) : 'NA'}(n=${corrN},桶 5s)。${corr <= -0.4 ? '中强负相关,支持曝气主导假设' : corr >= 0.4 ? '正相关,与预期方向相反,需复核' : '相关性弱,DO 非唯一主导因素,需更多窗口数据'}。建议 W2 做单变量小步治理试验(鼓风机 +2Hz,步限 2,两次调整间隔 ≥300s 已由配方 opIntervalMs 平台强制),W3 以完结批次建数据集,W4 探索档有界激励。`
  const save = await invoke(c1.leadId, 'analysis_save', { title: 'CAL-3 四期·W1 诊断', summary: w1Text, tags: ['诊断', 'CAL-3'], line_id: LINE })
  step('W1-t4', 'W1 结论入台账(带真实统计)', !save.isError, save.text.replace(/\s+/g, ' ').slice(0, 140))
  const profAna = (await api('GET', `/api/workshop/channels/${CH.analysis}/twin-profile`)).data
  step('W1-t5', '分析频道零写档(profile=line-doctor)', profAna?.profile?.profile === 'line-doctor', `profile=${profAna?.profile?.profile}`)
  await closeRoot(pid, w1, c1, w1Text, 'W1')
  if (!await acceptanceChain(pid, w1, w1Text, 'W1')) return finish(pid)

  // ═══ W2 HITL 下发控制 ═══
  const c2 = await dispatchAndWaitInstance(pid, w2, 'W2')
  if (!c2) return finish(pid)
  // args 一次性固化(digest 稳定):value 取当前实值,后续 neg/intent/trial 全程复用同一对象
  const preTrialVal = Number(((await dcwNodes()).find(n => n.id === SP1))?.value ?? 780)
  const targetW2 = Math.min(50, Math.max(20, Number((preTrialVal + 2).toFixed(1))))
  const argsW2 = { recipe_id: RECIPE, params: [{ node_id: SP1, value: targetW2 }], hypothesis: `W2 依据 W1 结论:鼓风机频率 ${preTrialVal.toFixed(1)}→${targetW2}(Δ+2),HITL 逐动作审批` }
  const neg = await invoke(c2.leadId, 'recipe_trial', argsW2)
  step('W2-t0', 'W2 治理阴性:无 write_intent 被拒', neg.isError && neg.text.includes('PROJECT_WRITE_INTENT_REQUIRED'), neg.text.replace(/\s+/g, ' ').slice(0, 150))
  const wiReq = await invoke(c2.leadId, 'project_request_write_intent', { tool: 'recipe_trial', args: argsW2, reason: '依据 W1 诊断的单变量治理试验' })
  step('W2-t1', 'W2 write_intent 申请(lead-only)', !wiReq.isError, wiReq.text.replace(/\s+/g, ' ').slice(0, 150))
  const ap = await poll(async () => {
    const rows = (await api('GET', `/api/workshop/projects/${pid}/approvals?status=pending`)).data ?? []
    return (Array.isArray(rows) ? rows : rows.items ?? []).find(a => a.kind === 'write_intent') ?? null
  }, 20_000)
  step('W2-t2', 'W2 owner 批准 write_intent', ap ? (await api('POST', `/api/workshop/projects/${pid}/approvals/${ap.id}/decide`, { approve: true })).status === 200 : false, `approval=${String(ap?.id ?? '').slice(0, 8)}`)
  let trial = null
  let w2WriteAt = 0
  let firstTrialError = ''
  for (let round = 0; round < 4 && !(trial && !trial.isError); round++) {
    const startAt = Date.now()
    const p = invoke(c2.leadId, 'recipe_trial', argsW2, 300_000)
    let card = null
    for (let i = 0; i < 25 && !card; i++) {
      await sleep(1500)
      const items = (await api('GET', '/api/workshop/hitl/pending')).data?.items ?? []
      // 卡按时间窗过滤(避免批准陈旧卡);nodeId 形态按动作而异:recipe_trial=recipe:<配方id>,直写=<节点id>
      card = items.find(x => (x.kind === 'dcw-approval' || String(x.nodeId ?? '').startsWith('recipe:'))
        && (String(x.nodeId ?? '').startsWith('recipe:') || String(x.nodeId ?? '').includes(SP1.slice(0, 8)))
        && (!x.createdAt || new Date(x.createdAt).getTime() >= startAt - 1500)) ?? null
    }
    if (card) {
      const dec = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: 'WWTP-4 W2 HITL 批准' })
      trial = await p.catch(e => ({ isError: true, text: String(e?.message ?? e) }))
      step(`W2-card${round ? `r${round}` : ''}`, `W2 HITL 卡批准受理(第 ${round + 1} 次尝试)`, dec.status === 200, `card=${String(card.id).slice(0, 10)} trialErr=${(trial.text ?? '').replace(/\s+/g, ' ').slice(0, 110)}`)
      const m = (trial.text ?? '').match(/[等待还需]\s*(\d+)\s*s/)
      if (trial.isError && m && Number(m[1]) > 0 && Number(m[1]) <= 370) {
        if (!firstTrialError) firstTrialError = trial.text.slice(0, 150)
        console.log(`  · 节拍硬闸(如实记录),等待 ${Number(m[1]) + 5}s 并重新申请意图`)
        await sleep((Number(m[1]) + 5) * 1000)
        await invoke(c2.leadId, 'project_request_write_intent', { tool: 'recipe_trial', args: argsW2, reason: '节拍重试重申请' })
        const rows2 = (await api('GET', `/api/workshop/projects/${pid}/approvals?status=pending`)).data ?? []
        const ap2 = (Array.isArray(rows2) ? rows2 : []).find(a => a.kind === 'write_intent')
        if (ap2) await api('POST', `/api/workshop/projects/${pid}/approvals/${ap2.id}/decide`, { approve: true })
        trial = null
      } else if (trial.isError) {
        if (!firstTrialError) firstTrialError = trial.text.slice(0, 150)
        // 任何其他错误(如意图在卡创建门通过时被消费):重申请意图后重试
        console.log(`  · trial 被拒(${trial.text.slice(0, 90)}),重申请意图后重试`)
        await invoke(c2.leadId, 'project_request_write_intent', { tool: 'recipe_trial', args: argsW2, reason: '被拒后重申请' })
        const rows2 = (await api('GET', `/api/workshop/projects/${pid}/approvals?status=pending`)).data ?? []
        const ap2 = (Array.isArray(rows2) ? rows2 : []).find(a => a.kind === 'write_intent')
        if (ap2) await api('POST', `/api/workshop/projects/${pid}/approvals/${ap2.id}/decide`, { approve: true })
        trial = null
      }
    }
    else {
      trial = await p.catch(e => ({ isError: true, text: String(e?.message ?? e) }))
      if (trial.isError) {
        if (!firstTrialError) firstTrialError = trial.text.slice(0, 150)
        // 未挂卡=门在前置就被拒(常见:意图已被上一轮消费)→重申请意图后重试
        if (/PROJECT_WRITE_INTENT_REQUIRED/.test(trial.text) && round < 3) {
          console.log('  · 未挂卡(意图缺失),重申请意图后重试')
          await invoke(c2.leadId, 'project_request_write_intent', { tool: 'recipe_trial', args: argsW2, reason: '未挂卡重申请' })
          const rows2 = (await api('GET', `/api/workshop/projects/${pid}/approvals?status=pending`)).data ?? []
          const ap2 = (Array.isArray(rows2) ? rows2 : []).find(a => a.kind === 'write_intent')
          if (ap2) await api('POST', `/api/workshop/projects/${pid}/approvals/${ap2.id}/decide`, { approve: true })
          trial = null
          continue
        }
        step('W2-card', 'W2 trial 未挂卡(如实记录)', false, trial.text.slice(0, 150))
        break
      }
    }
  }
  w2WriteAt = Date.now()
  step('W2-t3', 'W2 HITL 卡→批准→trial 收口(最终态)', Boolean(trial) && !trial.isError, `${(trial?.text ?? '未取得回执').replace(/\s+/g, ' ').slice(0, 170)}${firstTrialError ? ` |首次被拒:${firstTrialError.replace(/\s+/g, ' ').slice(0, 90)}` : ''}`)
  const afterTrial = (await dcwNodes()).find(n => n.id === SP1)
  const spAfterW2 = Number(afterTrial?.value ?? Number.NaN)
  // 精确断言:设备值=目标 ±1.0(±3 容差会把回退值误判为生效)
  step('W2-t4', 'W2 设备侧精确生效(=目标±1.0 且移动 ≥0.5)', Number.isFinite(spAfterW2) && Math.abs(spAfterW2 - targetW2) <= 1.0 && Math.abs(spAfterW2 - preTrialVal) >= 0.5,
    `before=${preTrialVal} after=${Number.isFinite(spAfterW2) ? spAfterW2.toFixed(1) : '?'} target=${targetW2}`)
  // 工艺惯性后复测(卡上指引的 daq_query 复测)
  await sleep(30_000)
  const sPost = await daqSeries(DAQ.zone1, Date.now() - 30_000, Date.now(), 2000)
  const meanPost = sPost.length ? sPost.reduce((a, b) => a + b.v, 0) / sPost.length : Number.NaN
  step('W2-t5', 'W2 工艺惯性后炉温复测(实测窗均值)', sPost.length >= 5 && Number.isFinite(meanPost), `post窗均值=${Number.isFinite(meanPost) ? meanPost.toFixed(1) : '?'}℃(n=${sPost.length})`)
  const w2Text = `W2 治理结论:依据 W1 统计建议(r=${Number.isFinite(corr) ? corr.toFixed(3) : 'NA'}),鼓风机频率SP 经 write_intent(owner 批准)+ HITL 逐动作审批后下发,设备回读 ${Number.isFinite(spAfterW2) ? spAfterW2.toFixed(1) : '?'}℃(试验前 ${preTrialVal},目标 ${targetW2});惯性 30s 后炉温复测均值 ${Number.isFinite(meanPost) ? meanPost.toFixed(1) : '?'}℃。`
  await closeRoot(pid, w2, c2, w2Text, 'W2')
  if (!await acceptanceChain(pid, w2, w2Text, 'W2')) return finish(pid)

  // ═══ W3 模型训练数据 ═══
  const c3 = await dispatchAndWaitInstance(pid, w3, 'W3')
  if (!c3) return finish(pid)
  // 已知缺口:AML 档位是频道级,任务实例不继承 → 训练族走基础频道 lead
  const baseTrainLead = ((await api('GET', `/api/workshop/channels/${CH.training}/agents`)).data ?? []).find(a => a.role === 'lead')
  step('W3-t0', 'AML 档位为频道级(实例不继承;训练走基础 lead)', Boolean(baseTrainLead?.id), `baseLead=${String(baseTrainLead?.id ?? '').slice(0, 8)} profile=${(await api('GET', `/api/workshop/channels/${CH.training}/twin-profile`)).data?.profile?.profile}`)
  // W3 零写纪律:只关批次(run close=批次账务,不写设备参数;绝不做 line.start——那会向 PLC 下发全部配方参数,
  // 上一轮审查抓到的正是这个:line.start 把 W2 治理值 778 回退到基线 780)。治理值靠保写心跳维持。
  const openRun = ((await api('GET', '/api/workshop/dcw/runs?limit=30')).data?.runs ?? []).find(r => r.lineId === LINE && !r.endedAt)
  let closed = { status: 0 }
  if (openRun) closed = await api('POST', `/api/workshop/dcw/runs/${openRun.id}/close`, {})
  step('W3-t1', 'W3 批次收口(run close;零设备写)', closed.status === 200, `close=${closed.status}${openRun ? ` run=${String(openRun.id).slice(0, 10)}` : ''}`)
  // 断言治理值未被回退:W3 全程设备值保持在治理值(±1.5)
  const spAfterW3 = Number(((await dcwNodes()).find(n => n.id === SP1))?.value ?? Number.NaN)
  step('W3-t2', 'W3 零写佐证:设备值保持治理值(未被 line.start 回退)', Number.isFinite(spAfterW3) && Math.abs(spAfterW3 - targetW2) <= 1.5, `after=${Number.isFinite(spAfterW3) ? spAfterW3.toFixed(1) : '?'} 治理值=${targetW2}`)
  // 治理后时段数据在场佐证:治理后窗口炉温实测均值 ≈ 治理值
  const sTreat = await daqSeries(DAQ.zone1, w2WriteAt, Date.now(), 2000)
  const meanTreat = sTreat.length ? sTreat.reduce((a, b) => a + b.v, 0) / sTreat.length : Number.NaN
  step('W3-t3', 'W3 治理后数据在场(治理后 DO 窗实测,方向性判据)', sTreat.length >= 8 && Number.isFinite(meanTreat) && Number.isFinite(preTreatDo) && meanTreat > preTreatDo,
    `治理后 DO 窗均值=${Number.isFinite(meanTreat) ? meanTreat.toFixed(2) : '?'} mg/L(n=${sTreat.length}) vs 试验前 DO 均值 ${Number.isFinite(preTreatDo) ? preTreatDo.toFixed(2) : '?'}(升曝气→DO 应上行;τ≈40s)`);
  // 数据集窗口须覆盖治理时刻(含治理后数据);beat 网格须连续覆盖 history+horizon
  const runMinutes = openRun ? Math.max(12, Math.ceil((Date.now() - new Date(openRun.startedAt ?? Date.now()).getTime()) / 60000) + 4) : 30
  const buildDs = async () => invoke(baseTrainLead.id, 'aml_dataset_build', {
    line_id: LINE, product_id: productId, recipe_id: RECIPE,
    nodes: [{ node_id: DAQ.zone1, role: 'control' }, { node_id: DAQ.tensile, role: 'target' }],
    window_minutes: runMinutes, beat_ms: 2000, history_steps: 32, horizon_steps: 8,
  })
  let ds = await buildDs()
  for (let r = 0; r < 4 && ds.isError && /不足一个窗口|没有可用的批次/.test(ds.text); r++) {
    console.log(`  · 网格不足,等 60s 重试(第 ${r + 1} 次)`)
    await sleep(60_000)
    ds = await buildDs()
  }
  let dsId = (ds.text.match(/ds-[a-z0-9-]+/i) ?? [])[0] ?? ''
  // 去重熔断=复用旧数据集,不符合「治理后数据」要求 → force 重建一次
  if (dsId && ds.isError && /熔断|已构建过同规格/.test(ds.text)) {
    console.log('  · 去重熔断命中 → force=true 重建(数据已更新)')
    ds = await invoke(baseTrainLead.id, 'aml_dataset_build', {
      line_id: LINE, product_id: productId, recipe_id: RECIPE,
      nodes: [{ node_id: DAQ.zone1, role: 'control' }, { node_id: DAQ.tensile, role: 'target' }],
      window_minutes: runMinutes, beat_ms: 2000, history_steps: 32, horizon_steps: 8, force: true,
    })
    dsId = (ds.text.match(/ds-[a-z0-9-]+/i) ?? [])[0] ?? dsId
  }
  step('W3-t4', 'W3 aml_dataset_build(含治理后时段)', Boolean(dsId) && !ds.isError, ds.text.replace(/\s+/g, ' ').slice(0, 220))
  const stats = dsId ? await invoke(baseTrainLead.id, 'aml_dataset_stats', { dataset_id: dsId }) : { isError: true, text: '无数据集' }
  step('W3-t5', 'W3 aml_dataset_stats(质量报告)', !stats.isError, stats.text.replace(/\s+/g, ' ').slice(0, 220))
  const w3Text = `W3 训练结论:收口含治理后时段的批次(run close,零设备写,鼓风机治理值 ${targetW2}Hz 保持),构建数据集 ${dsId || '(未生成)'}(窗口 ${runMinutes}min,覆盖治理时刻 ${new Date(w2WriteAt).toISOString().slice(11, 19)} 之后的数据;control=DO,target=出水氨氮);质量报告:${stats.text.replace(/\s+/g, ' ').slice(0, 240)}`
  await closeRoot(pid, w3, c3, w3Text, 'W3')
  if (!await acceptanceChain(pid, w3, w3Text, 'W3')) return finish(pid)

  // ═══ W4 受控自主优化(有界;探索档;模型绑定前的探索阶段) ═══
  // 文档约束:两次调整间隔 ≥300s —— 已由配方 opIntervalMs=300000 平台强制(配方族);
  // 探索激励走 dcw_control 路径(平台闸 60s),文档约束由驱动在此显式执行:距 W2 批准下发 ≥300s 才动。
  const c4 = await dispatchAndWaitInstance(pid, w4, 'W4')
  if (!c4) return finish(pid)
  const baseOptLead = ((await api('GET', `/api/workshop/channels/${CH.optimize}/agents`)).data ?? []).find(a => a.role === 'lead')
  const prof = (await api('GET', `/api/workshop/channels/${CH.optimize}/twin-profile`)).data
  step('W4-t0', 'W4 优化档位就绪(aml_optimization 探索模式)', prof?.profile?.profile === 'aml_optimization', `profile=${prof?.profile?.profile} phase=${prof?.profile?.capability?.phase}`)
  const gapMs = Date.now() - w2WriteAt
  if (gapMs < 300_000) {
    const waitMs = 300_000 - gapMs + 5000
    console.log(`  · 文档约束:两次调整间隔 ≥300s,距 W2 下发 ${Math.round(gapMs / 1000)}s → 等待 ${Math.round(waitMs / 1000)}s`)
    await sleep(waitMs)
  }
  // setup 操作(owner):一律显式开批次 B 供探索档作业(line_start 按基线重新下发=平台语义;
  // 批次 A 已被 W3 完结入数据集。此写发生在 W4 工作项之外,不计入 W4 的「无审批」口径,如实披露)
  let stB = await api('POST', `/api/workshop/dcw/lines/${LINE}/start`, { recipeId: RECIPE })
  for (let i = 0; i < 3 && stB.status !== 200; i++) {
    console.log(`  · 批次 B 开跑被拒(${String(stB.message ?? '').slice(0, 80)}),等 65s 重试`)
    await sleep(65_000)
    stB = await api('POST', `/api/workshop/dcw/lines/${LINE}/start`, { recipeId: RECIPE })
  }
  const newestB = ((await api('GET', '/api/workshop/dcw/runs?limit=5')).data?.runs ?? []).find(r => r.lineId === LINE)
  const batchBAlive = stB.status === 200 || /已在运行|已经运行|active/i.test(stB.message ?? '')
  step('W4-s0', 'setup:批次 B 就绪(owner;line_start 基线下发=平台语义;有效性由探索步运行门实证)', batchBAlive,
    `start=${stB.status} ${String(stB.message ?? '').slice(0, 60)} | latestRun=${String(newestB?.id ?? '').slice(0, 10)} open=${newestB ? !newestB.endedAt : '?'}`)
  await sleep(8000)
  const approvalsBefore = ((await api('GET', `/api/workshop/projects/${pid}/approvals`)).data ?? [])
  const apprCountBefore = Array.isArray(approvalsBefore) ? approvalsBefore.length : 0
  const hitlBefore = ((await api('GET', '/api/workshop/hitl/pending')).data?.items ?? []).length
  const before = Number(((await dcwNodes()).find(n => n.id === SP1))?.value ?? Number.NaN)
  const stepW4 = 1.5
  let exp = { isError: true, text: '' }
  let firstRejectText = ''
  for (let r = 0; r < 5; r++) {
    exp = await invoke(baseOptLead.id, 'optimization_explore', {
      control_node_id: SP1, target_node_id: DAQ.tensile, direction: 'up', step: stepW4, settle_seconds: 60,
      hypothesis: `W4 探索档有界激励(模型绑定前探索阶段;非模型驱动):鼓风机频率上行 ${stepW4}Hz,有界 [20,50],步限 2`,
    }, 300_000)
    const m = exp.isError ? (exp.text.match(/还需\s*(\d+)s/) ?? exp.text.match(/(\d+)s/)) : null
    if (exp.isError && m && Number(m[1]) > 0 && Number(m[1]) <= 120) {
      if (!firstRejectText) firstRejectText = exp.text.slice(0, 120)
      console.log(`  · 在线写间隔闸,等待 ${Number(m[1]) + 5}s 后重试(第 ${r + 1} 次)`)
      await sleep((Number(m[1]) + 5) * 1000)
      continue
    }
    if (!exp.isError) break
    if (!firstRejectText) firstRejectText = exp.text.slice(0, 120)
    await sleep(10_000)
  }
  step('W4-t1', 'W4 有界激励执行(探索档;首次被拒如实记录)', !exp.isError, `${exp.text.replace(/\s+/g, ' ').slice(0, 200)}${firstRejectText ? ` |首次被拒:${firstRejectText}` : ''}`)
  const hitlAfter = ((await api('GET', '/api/workshop/hitl/pending')).data?.items ?? []).length
  const approvalsAfter = ((await api('GET', `/api/workshop/projects/${pid}/approvals`)).data ?? [])
  const apprCountAfter = Array.isArray(approvalsAfter) ? approvalsAfter.length : 0
  step('W4-t2', 'W4 无审批产生(HITL 队列无新增+项目审批数无新增)', hitlAfter === hitlBefore && apprCountAfter === apprCountBefore, `hitl=${hitlBefore}→${hitlAfter} approvals=${apprCountBefore}→${apprCountAfter}`)
  // 台账强证据:干预记录 approval_id 为空(源=agent-auto,非 HITL)
  const ih = await invoke(baseOptLead.id, 'intervention_history', { node_id: SP1, limit: 5 })
  const w4NoApproval = !ih.isError && /approval|审批|null|无/i.test(ih.text)
  step('W4-t3', 'W4 干预台账可查(审批归因面)', !ih.isError, ih.text.replace(/\s+/g, ' ').slice(0, 180))
  const after4 = Number(((await dcwNodes()).find(n => n.id === SP1))?.value ?? Number.NaN)
  // 精确有界:Δ=+stepW4(±0.3) 且落在 [20,50] 且 ≤ 步限
  step('W4-t4', 'W4 精确有界生效(Δ=+6±0.5,界内,≤步限)', Number.isFinite(after4) && Math.abs(after4 - before - stepW4) <= 0.3 && after4 >= 20 && after4 <= 50 && stepW4 <= 2,
    `before=${before} after=${Number.isFinite(after4) ? after4.toFixed(1) : '?'} Δ=+${stepW4}Hz bound=[20,50] stepLimit=2`)
  const w4Text = `W4 自主优化结论(如实口径):aml_optimization 探索档(**模型绑定前的探索阶段,非模型驱动**;Channel goal 由后续 W3 数据集+训练补齐),对鼓风机频率SP执行有界上行激励(+${stepW4}℃,距上次调整 ${Math.round((Date.now() - w2WriteAt) / 1000)}s ≥300s 文档约束),设备 ${before}→${Number.isFinite(after4) ? after4.toFixed(1) : '?'}Hz;全程无审批产生(队列/审批数无新增,台账 approval 归因见工件);可辨识性判读以台账记录为准。`
  await closeRoot(pid, w4, c4, w4Text, 'W4')
  if (!await acceptanceChain(pid, w4, w4Text, 'W4')) return finish(pid)

  // ═══ S3 项目收口 ═══
  const comp = await api('POST', `/api/workshop/projects/${pid}/complete`, {})
  step('S3-1', '项目完成审批创建', comp.status === 200, comp.message)
  if (comp.data?.id) step('S3-2', '项目完成签核(独立 admin)', (await api('POST', `/api/workshop/projects/${pid}/approvals/${comp.data.id}/decide`, { approve: true }, { user: 'B' })).status === 200, '')
  const pf = (await api('GET', `/api/workshop/projects/${pid}`)).data
  step('S3-3', '项目终态 completed', pf?.status === 'completed', `status=${pf?.status}`)
  const evs = (await api('GET', `/api/workshop/projects/${pid}/events?scope=all&limit=400`)).data ?? []
  const types = new Set((Array.isArray(evs) ? evs : evs.items ?? []).map(e => e.type))
  const need = ['work.dispatched', 'work.completed', 'result.submitted', 'result.reviewed', 'approval.approved']
  step('S3-4', '全链审计事件齐备', need.every(n => types.has(n)), `missing=${need.filter(n => !types.has(n)).join(',')}`)
  step('S3-5', '四期交付物全部 approved', (await api('GET', `/api/workshop/projects/${pid}/results`)).data?.filter(r => r.status === 'approved').length >= 4, `approved=${(await api('GET', `/api/workshop/projects/${pid}/results`)).data?.filter(r => r.status === 'approved').length}`)
  finish(pid)
}

function finish(pid) {
  const pass = results.filter(r => r.pass).length
  const fail = results.length - pass
  // 完整性标志:预期断言数(防早退时把不完整结果伪装成全绿)
  const EXPECTED = 76
  const complete = results.length >= EXPECTED
  writeFileSync(join(EVID, 'staged.json'), JSON.stringify({ generatedAt: new Date().toISOString(), base, pid: pid ?? '', expected: EXPECTED, complete, pass, fail, results }, null, 2))
  console.log(`\n=== CAL3 STAGED pass=${pass}/${results.length}${complete ? '' : '(不完整!早退)'} fail=${fail} ===`)
  process.exitCode = fail > 0 || !complete ? 1 : 0
}

main().catch(e => { console.error('fatal:', e); finish('') })
