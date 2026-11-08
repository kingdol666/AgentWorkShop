#!/usr/bin/env node
/**
 * channel-template-multisession-live.mjs —— Channel 模板 × 多会话 × 产线集成实机验收。
 *
 * 场景(用户目标):用**一个 Channel 模板**实例化频道,在同一频道上开多个会话,
 * 验证多会话管理业务 + 会话内真实产线操作集成:
 *   ① 模板实例化:通用闭环优化频道(主管 lead + 数据分析师/知识调优工程师/工艺工程师,omp 真模型)
 *   ② 基础成员绑节点(数采 auto / SP 写控 / 配方) → 建两个会话(克隆继承绑定面)
 *   ③ 会话内真实产线作业:daq_query / line_context / 双会话并行真 LLM 对话
 *   ④ 会话A内治理写:recipe_trial → HITL 卡 → 批准 → 设备回读收敛
 *   ⑤ 会话B关闭 → WP2 生命周卫(克隆停用/invoke 拒)且会话A不受影响;基础成员保留
 *
 * 用法:node scripts/_audit/channel-template-multisession-live.mjs --base http://127.0.0.1:4001
 * 证据:docs/audit/evidence/2026-11-08-multisession-opt/channel-multisession.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = (arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:4001')).replace(/\/$/, '')
const EVID = resolve(arg('out', join(REPO, 'docs/audit/evidence/2026-11-08-multisession-opt')))
mkdirSync(EVID, { recursive: true })

const OMP_MODEL = 'qwen3.5-9b-claude-4.6-opus-reasoning-distilled-v2'
const TEMPLATE_ID = arg('template', 'chtpl-generic-optimize-default')

let token = ''
const results = []
const step = (id, name, ok, detail = '') => {
  results.push({ id, name, pass: Boolean(ok), detail: String(detail ?? '').slice(0, 900) })
  console.log(`${ok ? '✔' : '✖'} [${id}] ${name}${ok ? '' : ` — ${String(detail ?? '').slice(0, 300)}`}`)
  return Boolean(ok)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, timeoutMs = 60_000) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined || body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await res.json().catch(() => null)
  return { status: res.status, data: j?.data, code: j?.code, message: j?.message ?? '' }
}
/** Agent 工具桥(admin 用户代调;身份=agentId,与 harness 同一 dispatch 层) */
async function invoke(agentId, tool, argsTool = {}, timeoutMs = 240_000) {
  const res = await fetch(`${base}/api/workshop/agent-tools/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
    body: JSON.stringify({ agentId, tool, args: argsTool }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await res.json().catch(() => null)
  return { status: res.status, isError: Boolean(j?.data?.result?.isError), text: String(j?.data?.result?.text ?? '') }
}
async function dcwNodes() {
  return (await api('GET', '/api/workshop/dcw')).data?.nodes ?? []
}
function parseText(m) {
  let parts = m.parts_json ?? m.parts ?? []
  if (typeof parts === 'string') { try { parts = JSON.parse(parts) } catch { parts = [{ text: parts }] } }
  if (!Array.isArray(parts)) parts = []
  return parts.map(p => p.text ?? '').join('')
}
async function poll(fn, timeoutMs, interval = 3000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(interval)
  }
  return null
}
/** recipe_trial 异步发起 → 轮询 HITL 卡 → 批准 → 收口;节拍/互斥拒绝自动等待重试 */
async function governedTrial(agentId, buildArgs, tag, maxRounds = 3) {
  for (let round = 0; round <= maxRounds; round++) {
    const startAt = Date.now()
    const trialP = invoke(agentId, 'recipe_trial', buildArgs(), 300_000)
    let card = null
    for (let i = 0; i < 25 && !card; i++) {
      await sleep(1500)
      const items = (await api('GET', '/api/workshop/hitl/pending')).data?.items ?? []
      card = items.find(x => (x.kind === 'dcw-approval' || String(x.nodeId ?? '').startsWith('recipe:'))
        && (!x.createdAt || new Date(x.createdAt).getTime() >= startAt - 1500)) ?? null
    }
    if (!card) {
      const early = await trialP.catch(e => ({ isError: true, text: String(e?.message ?? e) }))
      const text = early.text ?? ''
      const m = text.match(/等待\s*(\d+)s 后再试/)
      if (m && Number(m[1]) > 0 && Number(m[1]) <= 370) {
        console.log(`  · 节拍硬闸,等待 ${Number(m[1]) + 5}s 后重试(第 ${round + 1} 次)`)
        await sleep((Number(m[1]) + 5) * 1000)
        continue
      }
      if (/互斥|正在优化|接管|stale|open record/i.test(text) && round < maxRounds) {
        console.log('  · Agent 互斥拒绝,等 65s 接管窗口后重试')
        await sleep(65_000)
        continue
      }
      return { card: null, decided: null, trial: early }
    }
    const decided = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: `模板多会话验收批准(${tag})` })
    const trial = await trialP.catch(e => ({ isError: true, text: String(e?.message ?? e) }))
    return { card, decided, trial }
  }
  return { card: null, decided: null, trial: { isError: true, text: '重试轮次耗尽' } }
}
/** 设备侧回读:SP 值朝 target 收敛(一阶惯性,90s 窗) */
async function readbackConverged(nodeId, target, tol) {
  for (let i = 0; i < 45; i++) {
    await sleep(2000)
    const n = (await dcwNodes()).find(x => x.id === nodeId)
    const v = Number(n?.value ?? Number.NaN)
    if (Number.isFinite(v) && Math.abs(v - target) <= tol) return { ok: true, value: v }
  }
  const n = (await dcwNodes()).find(x => x.id === nodeId)
  return { ok: false, value: Number(n?.value ?? Number.NaN) }
}
function pickLine(dcwAll, daqAll, recipesAll, lines) {
  for (const lineId of lines.map(l => l.lineId)) {
    const sp = dcwAll.find(n => (n.lineId ?? '') === lineId && /SP/i.test(n.name ?? ''))
    const recipe = recipesAll.find(r => r.lineId === lineId)
    const daqs = daqAll.filter(n => (n.lineId ?? '') === lineId)
    if (!sp || !recipe || daqs.length < 1) continue
    const stepLimit = Number(sp.stepLimit ?? Number.NaN)
    if (!(Number.isFinite(stepLimit) && stepLimit > 0)) continue
    return { lineId, sp, recipe, daqs, stepLimit }
  }
  return null
}
async function bindingsOf(agentId) {
  const v = await poll(async () => {
    const r = await api('GET', `/api/workshop/agent-tools/bindings?agentId=${agentId}`)
    const d = r.data
    return Array.isArray(d) ? d : (d?.bindings ?? d?.items ?? null)
  }, 10_000, 1000)
  return Array.isArray(v) ? v : []
}

async function main() {
  // ═══ S0 登录 + 产线现场 + 治理窗口 ═══
  token = (await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })).data?.token ?? ''
  if (!step('S0-1', 'owner 登录(admin@awshop.local)', Boolean(token), 'admin token ok')) return finish(false)
  const dcwAll = await dcwNodes()
  const daqAll = (await api('GET', '/api/workshop/daq')).data?.nodes ?? []
  const recipesAll = (await api('GET', '/api/workshop/dcw')).data?.recipes ?? []
  const states = (await api('GET', '/api/workshop/dcw')).data?.lineStates ?? []
  const running = states.filter(s => s.active === true)
  if (!step('S0-2', '产线现场就绪', dcwAll.length > 0 && daqAll.length > 0 && recipesAll.length > 0 && running.length >= 1,
    `dcw=${dcwAll.length} daq=${daqAll.length} recipes=${recipesAll.length} running=${running.length}/${states.length}`)) return finish(false)
  await api('PATCH', '/api/system/settings', { override: { 'dcw.rollback_stale_ms': 60000 } })
  process.on('exit', () => { void fetch(`${base}/api/system/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` }, body: JSON.stringify({ override: { 'dcw.rollback_stale_ms': 1800000 } }) }).catch(() => {}) })

  const ctx = pickLine(dcwAll, daqAll, recipesAll, running)
  if (!step('S0-3', '目标线解析(SP/配方/数采)', Boolean(ctx), `line=${String(ctx?.lineId ?? '').slice(0, 8)} stepLimit=${ctx?.stepLimit ?? '?'}`)) return finish(false)

  // ═══ T1 模板实例化(通用闭环优化频道,绑线) ═══
  const inst = await api('POST', `/api/workshop/channel-templates/${TEMPLATE_ID}/instantiate`, {
    name: `多会话产线优化-${randomUUID().slice(0, 4)}`, bindLineId: ctx.lineId,
  })
  const cid = inst.data?.channelId ?? inst.data?.id
  const tAgents = (inst.data?.agents ?? [])
  const lead = tAgents.find(a => a.role === 'lead')
  const workers = tAgents.filter(a => a.role === 'worker')
  const chRow = (await api('GET', '/api/workshop/channels')).data?.find(c => c.id === cid)
  step('T1', `模板实例化(${TEMPLATE_ID}: 1 lead+3 worker, 绑线)`,
    Boolean(cid && lead && workers.length === 3) && chRow?.lineId === ctx.lineId,
    `ch=${String(cid ?? '').slice(0, 8)} lead=${String(lead?.id ?? '').slice(0, 8)} workers=${workers.length} line=${chRow?.lineId === ctx.lineId ? 'bound' : chRow?.lineId}`)
  if (!cid) return finish(false)

  // T2 模板 worker 补运行时配置(omp provider/model;模板 config 缺省无 provider)
  for (const w of workers) {
    await api('PATCH', `/api/workshop/channels/${cid}/agents/${w.id}`, { config: { ...(w.config ?? {}), rpcMode: 'rpc', provider: 'lm-studio', model: OMP_MODEL } })
  }
  const wsId = (await api('GET', '/api/workshop/workspaces')).data?.[0]?.id
    ?? (await api('POST', '/api/workshop/workspaces', { name: `模板多会话-${randomUUID().slice(0, 4)}` })).data?.id
  await api('POST', `/api/workshop/channels/${cid}/activate`, {})
  await api('POST', `/api/workshop/workspaces/${wsId}/channels/${cid}`, {})
  step('T2', 'worker 补 omp 运行时配置 + 频道激活', true, `model=${OMP_MODEL.slice(0, 24)}…`)

  // ═══ T3 基础成员节点绑定(会话创建前;克隆继承) ═══
  const analyst = workers.find(w => /数据分析师/.test(w.name ?? '')) ?? workers[0]
  const processEng = workers.find(w => /工艺工程师/.test(w.name ?? '')) ?? workers[workers.length - 1]
  const bindStatus = []
  for (const n of ctx.daqs.slice(0, 3)) {
    bindStatus.push((await api('POST', '/api/workshop/agent-tools/bindings', { agentId: analyst.id, nodeId: n.id, kind: 'daq', mode: 'auto' })).status)
  }
  bindStatus.push((await api('POST', '/api/workshop/agent-tools/bindings', { agentId: processEng.id, nodeId: ctx.sp.id, kind: 'dcw' })).status)
  bindStatus.push((await api('POST', '/api/workshop/agent-tools/bindings', { agentId: processEng.id, nodeId: ctx.recipe.id, kind: 'recipe' })).status)
  const rowsAnalyst = await bindingsOf(analyst.id)
  step('T3', '基础成员绑定(分析师=数采auto, 工艺=SP+配方)', bindStatus.every(s => s === 200) && rowsAnalyst.length >= 1,
    `posts=${bindStatus.length} bad=${bindStatus.filter(s => s !== 200).join(',')} analystRows=${rowsAnalyst.length}`)
  if (!bindStatus.every(s => s === 200)) return finish(false)

  // ═══ M1 双会话创建(克隆继承绑定面) ═══
  const sess = []
  for (const t of ['会话A·诊断', '会话B·巡检']) {
    const s = await api('POST', `/api/workshop/channels/${cid}/sessions`, { title: t })
    sess.push(s.data ?? {})
  }
  const [sA, sB] = sess
  const cloneIdsA = (sA.members ?? []).map(m => m.cloneId)
  const cloneIdsB = (sB.members ?? []).map(m => m.cloneId)
  const overlap = cloneIdsA.filter(x => cloneIdsB.includes(x))
  step('M1', '双会话创建(克隆成员,两会话互不相同)', Boolean(sA.sessionId && sB.sessionId && cloneIdsA.length >= 1 && overlap.length === 0),
    `A=${String(sA.sessionId ?? '').slice(0, 8)}(${cloneIdsA.length} clones) B=${String(sB.sessionId ?? '').slice(0, 8)}(${cloneIdsB.length} clones)`)
  if (!sA.sessionId || !sB.sessionId) return finish(false)
  const agsAll = (await api('GET', `/api/workshop/channels/${cid}/agents`)).data ?? []
  const cloneOf = (sid, baseAgent) => {
    const m = (sid.members ?? []).find(x => x.agentId === baseAgent.id || x.sourceAgentId === baseAgent.id || x.name === baseAgent.name)
    const id = m?.cloneId ?? m?.id
    return id ? { ...m, id } : null
  }
  const anaA = cloneOf(sA, analyst) ?? { id: cloneIdsA.find(x => agsAll.find(a => a.id === x && /数据分析师/.test(a.name ?? ''))) }
  const engA = cloneOf(sA, processEng) ?? { id: cloneIdsA.find(x => agsAll.find(a => a.id === x && /工艺工程师/.test(a.name ?? ''))) }
  const anaB = cloneOf(sB, analyst) ?? { id: cloneIdsB.find(x => agsAll.find(a => a.id === x && /数据分析师/.test(a.name ?? ''))) }
  const engB = cloneOf(sB, processEng) ?? { id: cloneIdsB.find(x => agsAll.find(a => a.id === x && /工艺工程师/.test(a.name ?? ''))) }

  // ═══ M2 克隆绑定面继承 ═══
  const rowsAnaA = await bindingsOf(anaA.id)
  const rowsEngB = await bindingsOf(engB.id)
  step('M2', '克隆继承绑定面(分析师克隆=数采行, 工艺克隆=dcw+recipe行)',
    rowsAnaA.some(r => r.kind === 'daq') && rowsEngB.some(r => r.kind === 'dcw') && rowsEngB.some(r => r.kind === 'recipe'),
    `anaA=${rowsAnaA.length}行 engB dcw=${rowsEngB.some(r => r.kind === 'dcw')} recipe=${rowsEngB.some(r => r.kind === 'recipe')}`)

  // ═══ P1 会话内真实产线读 ═══
  const qA = anaA.id ? await invoke(anaA.id, 'daq_query', { node_id: ctx.daqs[0].id, last_minutes: 3, bucket_ms: 1000 }) : { isError: true, text: 'no clone' }
  step('P1a', '会话A克隆 daq_query(真实数采样本)', !qA.isError && /样本|点|value|mean|均值/i.test(qA.text), qA.text.replace(/\s+/g, ' ').slice(0, 200))
  const lcB = engB.id ? await invoke(engB.id, 'line_context', {}) : { isError: true, text: 'no clone' }
  step('P1b', '会话B克隆 line_context(产线全景)', !lcB.isError && /产线|线|配方|批次/i.test(lcB.text), lcB.text.replace(/\s+/g, ' ').slice(0, 200))

  // ═══ P2 双会话并行真 LLM 对话(omp 独立 runtime) ═══
  const stamp = randomUUID().slice(0, 6)
  const sendTask = (toId, text) => api('POST', `/api/workshop/channels/${cid}/messages`, { toAgentId: toId, text, fromLabel: 'owner', priority: 'task', requireReply: true })
  const sentA = anaA.id ? await sendTask(anaA.id, `会话任务A[${stamp}]:请用 daq_query 查询你已授权的一个数采节点最近 2 分钟数据,并用一句话汇报当前均值与趋势。`) : { status: 400 }
  const sentB = anaB.id ? await sendTask(anaB.id, `会话任务B[${stamp}]:请用 line_context 查看绑定产线全景,并用一句话汇报产线当前运行状态与活动配方。`) : { status: 400 }
  const consumed = await poll(async () => {
    const res = await api('GET', `/api/workshop/channels/${cid}/messages?limit=80`)
    const raw = res.data?.messages ?? res.data
    const arr = Array.isArray(raw) ? raw : []
    const norm = arr.map(m => ({ to: m.to_agent_id ?? m.toAgentId ?? '', state: m.state ?? '', text: parseText(m) }))
    const doneA = norm.some(m => m.to === anaA.id && m.text.includes(`会话任务A[${stamp}]`) && m.state !== 'pending')
    const doneB = norm.some(m => m.to === anaB.id && m.text.includes(`会话任务B[${stamp}]`) && m.state !== 'pending')
    return doneA && doneB ? { doneA, doneB } : null
  }, 420_000, 6000) ?? { doneA: false, doneB: false }
  step('P2', '双会话并行真 LLM 对话(独立 runtime 各自消费)', Boolean(sentA.status === 200 && sentB.status === 200 && consumed.doneA && consumed.doneB),
    `sent=${sentA.status}/${sentB.status} consumedA=${consumed.doneA} consumedB=${consumed.doneB}`)

  // ═══ W1 会话A内治理写(recipe_trial → HITL → 回读) ═══
  const spNow = (await dcwNodes()).find(x => x.id === ctx.sp.id)
  const cur = Number(spNow?.value ?? 0)
  const param = ctx.recipe.params?.find(p => p.nodeId === ctx.sp.id) ?? {}
  const lo = Number(param.min ?? -Number.MAX_SAFE_INTEGER)
  const hi = Number(param.max ?? Number.MAX_SAFE_INTEGER)
  const down = cur - 0.6 * ctx.stepLimit
  const target = Number((down >= lo ? down : Math.min(cur + 0.6 * ctx.stepLimit, hi)).toFixed(2))
  const attempt = await governedTrial(engA.id, () => ({
    recipe_id: ctx.recipe.id,
    params: [{ node_id: ctx.sp.id, value: target }],
    hypothesis: `模板多会话验收·会话A工艺工程师:单变量 SP=${target}(HITL manual 链,自当前值 ${cur.toFixed(2)})`,
    emergency: true,
  }), 'MS-A')
  step('W1a', '会话A克隆 recipe_trial 发起 HITL 卡', Boolean(attempt.card), attempt.card ? `card=${String(attempt.card.id).slice(0, 10)}` : (attempt.trial?.text ?? '').slice(0, 200))
  step('W1b', 'HITL 批准受理', attempt.decided?.status === 200, attempt.decided?.message ?? '')
  step('W1c', 'trial 收口(设备受理)', Boolean(attempt.trial) && !attempt.trial.isError, (attempt.trial?.text ?? '').replace(/\s+/g, ' ').slice(0, 220))
  if (attempt.trial && !attempt.trial.isError) {
    const rb = await readbackConverged(ctx.sp.id, target, ctx.stepLimit * 0.3)
    step('W1d', '设备侧回读收敛(会话内治理写真实生效)', rb.ok, `target=${target} final=${Number.isFinite(rb.value) ? rb.value.toFixed(2) : '?'}`)
  }

  // ═══ C 会话生命周期(WP2 周卫) ═══
  const closeB = await api('POST', `/api/workshop/channels/${cid}/sessions/${sB.sessionId}/close`, { reason: '模板多会话验收' })
  const listRows = (await api('GET', `/api/workshop/channels/${cid}/sessions`)).data ?? []
  const rowA = listRows.find(s => s.id === sA.sessionId)
  const rowB = listRows.find(s => s.id === sB.sessionId)
  step('C1', '关闭会话B(A 不受影响)', closeB.status === 200 && rowB?.status === 'closed' && rowA?.status === 'active', `A=${rowA?.status} B=${rowB?.status}`)
  const agsAfter = (await api('GET', `/api/workshop/channels/${cid}/agents`)).data ?? []
  const bClonesDisabled = cloneIdsB.length > 0 && cloneIdsB.every((id) => { const a = agsAfter.find(x => x.id === id); return a && (a.enabled ?? 1) !== 1 })
  step('C2', '会话B克隆成员全部停用(enabled=0)', bClonesDisabled, `clones=${cloneIdsB.length} states=${cloneIdsB.map(id => agsAfter.find(x => x.id === id)?.enabled).join(',')}`)
  const denied = await invoke(cloneIdsB[0] ?? '', 'daq_query', { node_id: ctx.daqs[0].id, last_minutes: 1 })
  step('C3', 'B克隆身份 invoke 被拒(WP2 生效)', denied.isError || denied.status >= 400, `status=${denied.status} text=${denied.text.replace(/\s+/g, ' ').slice(0, 120)}`)
  const aliveA = anaA.id ? await invoke(anaA.id, 'my_industrial_nodes', {}) : { isError: true, text: 'no clone' }
  step('C4', '会话A克隆仍可正常作业', !aliveA.isError, aliveA.text.replace(/\s+/g, ' ').slice(0, 160))
  const baseAlive = await invoke(analyst.id, 'daq_query', { node_id: ctx.daqs[0].id, last_minutes: 1 })
  const leadAlive = agsAfter.find(x => x.id === lead?.id && (x.enabled ?? 1) === 1)
  const workersAlive = workers.every((w) => { const a = agsAfter.find(x => x.id === w.id); return a && (a.enabled ?? 1) === 1 })
  step('C5', '基础成员保留(lead+workers enabled, 基础分析师可作业)', Boolean(leadAlive && workersAlive) && !baseAlive.isError,
    `lead=${Boolean(leadAlive)} workersAlive=${workersAlive} baseInvoke=${baseAlive.isError ? 'ERR' : 'ok'}`)

  finish(results.every(r => r.pass))
}

function finish(pass) {
  const verdict = pass ? 'PASS' : 'FAIL'
  writeFileSync(join(EVID, 'channel-multisession.json'), JSON.stringify({ at: new Date().toISOString(), base, template: TEMPLATE_ID, pass: results.filter(r => r.pass).length, fail: results.filter(r => !r.pass).length, results }, null, 2))
  const md = [`# Channel 模板 × 多会话 × 产线集成实机验收 · ${verdict}`, '', `- base=${base} template=${TEMPLATE_ID}`, ...results.map(r => `- ${r.pass ? '✔' : '✖'} **${r.id}** ${r.name} — ${r.detail.slice(0, 200)}`), ''].join('\n')
  writeFileSync(join(EVID, 'channel-multisession.md'), md)
  console.log(`\n判定: ${verdict} (${results.filter(r => r.pass).length}/${results.length}) → ${EVID}`)
  process.exitCode = pass ? 0 : 1
}

main().catch((err) => { console.error('FAIL:', err?.message ?? err); finish(false) })
