#!/usr/bin/env node
/**
 * line-integration-live.mjs —— 产线 × Channel × HITL 集成实机验收（2026-11-07 控制台改版后回归）。
 *
 * 前置:PLC 模拟器(:4010)+ seed-industrial-demo 已对目标实例布线(演示线/节点/配方)。
 * 链路:
 *   L0 登录 + 产线现场就绪(DAQ/DCW 节点、产线开跑、配方在位)
 *   L1 建「产线集成频道」(mock lead)+ 激活 + 挂载 workspace
 *   L2 lead 成员实例 token(rotate-token;绑定主体必须是成员实例而非模板)
 *   L3 节点绑定:daq(auto)+ dcw(写向首绑强制 manual=HITL);绑定面回读核验
 *   L4 工具面=绑定面:daq_query 绑定节点成功 / 越权节点拒绝(阴性)
 *   L5 下发控制 HITL:recipe_trial(manual 绑定)→ HITL 卡 → 批准 → 设备侧回读值变化
 *   L6 harness 共存:同频道建会话→克隆成员→关闭会话(基础成员保留)
 *
 * 用法:AW_BASE=http://127.0.0.1:3002 node scripts/_audit/line-integration-live.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? '') : d }
const base = (arg('base', process.env.AW_BASE ?? 'http://127.0.0.1:3002')).replace(/\/$/, '')
const outDir = resolve(arg('out', join(REPO, 'bench', 'results', `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-line-integration`)))

let token = ''
const steps = []
const step = (name, ok, detail) => {
  steps.push({ name, ok: Boolean(ok), detail: String(detail ?? '').slice(0, 500) })
  console.log(`${ok ? '✔' : '✘'} [${name}] ${String(detail ?? '').slice(0, 300)}`)
  return Boolean(ok)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function api(method, path, body, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...((opts.agentToken ? { 'authorization': `Bearer ${opts.agentToken}`, 'x-aw-agent-token': opts.agentToken } : (token ? { authorization: `Bearer ${token}` } : {}))),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, data: json?.data, code: json?.code, message: json?.message ?? '' }
}
/** Agent 工具调用桥(成员实例令牌;绑定面=授权面的裁判口径) */
async function invoke(agent, tool, argsTool, timeoutMs = 120_000) {
  const res = await fetch(`${base}/api/workshop/agent-tools/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aw-agent-token': agent.token },
    body: JSON.stringify({ agentId: agent.id, tool, args: argsTool }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await res.json().catch(() => null)
  return { status: res.status, isError: Boolean(j?.data?.result?.isError), text: String(j?.data?.result?.text ?? '') }
}

async function main() {
  // ── L0 登录 + 产线现场 ──
  token = (await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'admin123' })).data?.token ?? ''
  if (!step('L0-login', Boolean(token), 'owner token')) return finish(false)
  const dcw = await api('GET', '/api/workshop/dcw')
  const dcwNodes = dcw.data?.nodes ?? []
  const recipes = dcw.data?.recipes ?? []
  const daq = await api('GET', '/api/workshop/daq')
  const daqNodes = daq.data?.nodes ?? []
  // 运行态在 data.lineStates(line 行本身不带 running);批次在跑=运行。停了的线重新开跑。
  const lineStates = dcw.data?.lineStates ?? []
  const runningIds = new Set(lineStates.filter(s => s.active === true).map(s => s.lineId))
  for (const l of (dcw.data?.lines ?? []).filter(x => !runningIds.has(x.id))) {
    const r = (recipes.find(x => x.lineId === l.id)) ?? recipes[0]
    await api('POST', `/api/workshop/dcw/lines/${l.id}/start`, { recipeId: r?.id })
  }
  const statesAfter = (await api('GET', '/api/workshop/dcw')).data?.lineStates ?? []
  const lines = statesAfter.filter(s => s.active === true)
  if (!step('L0-field', dcwNodes.length > 0 && daqNodes.length > 0 && recipes.length > 0 && lines.length > 0,
    `dcw=${dcwNodes.length} daq=${daqNodes.length} recipes=${recipes.length} 开跑产线=${lines.length}/${statesAfter.length}`)) return finish(false)

  // SP 写控节点(演示·…·SP)+ 一台 DAQ 节点(演示·…)
  const spNode = dcwNodes.find(n => /SP/i.test(n.name ?? '')) ?? dcwNodes[0]
  const daqNode = daqNodes[0]
  const recipe = recipes[0]
  step('L0-targets', Boolean(spNode?.id && daqNode?.id && recipe?.id),
    `SP=${spNode?.id?.slice(0, 12)}(min=${spNode?.min},max=${spNode?.max},value=${spNode?.value}) daq=${daqNode?.id?.slice(0, 12)} recipe=${String(recipe?.id).slice(0, 12)}`)

  // ── L1 建频道 + 激活 + 挂载 ──
  const wsList = (await api('GET', '/api/workshop/workspaces')).data ?? []
  const wsId = (Array.isArray(wsList) ? wsList[0]?.id : null)
    ?? (await api('POST', '/api/workshop/workspaces', { name: `产线集成-${randomUUID().slice(0, 5)}` })).data?.id
  const chName = `产线集成频道-${randomUUID().slice(0, 5)}`
  const ch = await api('POST', '/api/workshop/channels', { name: chName, lineId: spNode.lineId })
  const cid = ch.data?.channelId ?? ch.data?.id
  if (!step('L1-channel', Boolean(cid), `channel=${String(cid).slice(0, 12)} ${chName}`)) return finish(false)
  const lead = await api('POST', `/api/workshop/channels/${cid}/agents`, { name: '集成Lead', harness: 'mock', role: 'lead' })
  const leadId = lead.data?.id ?? lead.data?.agentId
  await api('POST', `/api/workshop/channels/${cid}/activate`, {})
  const mounted = await api('POST', `/api/workshop/workspaces/${wsId}/channels/${cid}`, {})
  if (!step('L1-mount', Boolean(leadId) && mounted.status === 200, `lead=${String(leadId).slice(0, 12)} mounted=${mounted.status}`)) return finish(false)

  // ── L2 成员实例令牌 ──
  const tok = await api('POST', `/api/workshop/channels/${cid}/agents/${leadId}/rotate-token`, {})
  let agent = { id: leadId, token: tok.data?.token ?? '' }
  if (!step('L2-member-token', Boolean(agent.token), `member=${String(leadId).slice(0, 12)} token=${Boolean(agent.token)}`)) return finish(false)

  // ── L3 节点绑定(daq auto + dcw 首绑强制 manual) ──
  const bDaq = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadId, nodeId: daqNode.id, kind: 'daq', mode: 'auto' })
  const bDcw = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadId, nodeId: spNode.id, kind: 'dcw' })
  const bindingsAfter = (await api('GET', `/api/workshop/agent-tools/bindings?agentId=${leadId}`)).data ?? {}
  const rows = Array.isArray(bindingsAfter) ? bindingsAfter : (bindingsAfter.bindings ?? bindingsAfter.items ?? [])
  const dcwRow = rows.find(r => r.kind === 'dcw' && (r.nodeId === spNode.id)) ?? (bDcw.data?.binding?.kind === 'dcw' ? bDcw.data.binding : null)
  const daqRow = rows.find(r => r.kind === 'daq' && (r.nodeId === daqNode.id)) ?? (bDaq.data?.binding?.kind === 'daq' ? bDaq.data.binding : null)
  if (!step('L3-bind', bDaq.status === 200 && bDcw.status === 200 && Boolean(dcwRow) && Boolean(daqRow),
    `daq=${bDaq.status} dcw=${bDcw.status} rows=${rows.length} dcwMode=${dcwRow?.mode ?? '?'}`)) return finish(false)
  step('L3-hitl-forced', dcwRow?.mode === 'manual', `写向首绑强制 manual 实测 dcwRow.mode=${dcwRow?.mode} notice=${bDcw.data?.notice ?? bDcw.message ?? ''}`)

  // ── L4 工具面=绑定面 ──
  const listRes = await fetch(`${base}/api/workshop/agent-tools/list?agentId=${leadId}`, { headers: { 'x-aw-agent-token': agent.token } })
  const tools = listRes.status === 200 ? ((await listRes.json())?.data?.tools ?? []) : []
  const names = tools.map(t => t.name)
  step('L4-toolface', ['daq_query', 'recipe_catalog', 'recipe_trial'].every(t => names.includes(t)),
    `n=${names.length} daq_query=${names.includes('daq_query')} recipe_trial=${names.includes('recipe_trial')}`)
  const qBound = await invoke(agent, 'daq_query', { node_id: daqNode.id, last_minutes: 3, bucket_ms: 1000 })
  step('L4-daq-bound', !qBound.isError && /样本|点|value/i.test(qBound.text), qBound.text.replace(/\s+/g, ' ').slice(0, 200))
  // 阴性用**跨线**节点:频道绑了线 → 线内节点只读按设计放行(e2e-binding-modes D3 口径),不是越权
  const cross = daqNodes.find(n => n.id !== daqNode.id && (n.lineId ?? '') !== (spNode.lineId ?? ''))
    ?? daqNodes.find(n => n.id !== daqNode.id && !String(n.name ?? '').includes((spNode.name ?? '').split('·')[1] ?? '###'))
  const qOther = cross ? await invoke(agent, 'daq_query', { node_id: cross.id, last_minutes: 1 }) : null
  step('L4-daq-cross-negative', !cross || qOther.isError === true,
    cross ? qOther.text.replace(/\s+/g, ' ').slice(0, 200) : '单一产线现场,无跨线节点(阴性跳过)')

  // ── L5 下发控制 HITL(写向 manual → 审批卡 → 批准 → 设备回读) ──
  // recipe_trial 在 manual 绑定下**阻塞等审批**:必须先异步发起 → 轮询审批卡 → 批准 → 再收 Promise。
  // 候选=各线 SP 写控节点:忙线(上次成功试验会挂起优化观察窗,期间该线拒新试验)自动换下一线。
  const spCandidates = dcwNodes.filter(n => /SP/i.test(n.name ?? ''))
    .map(n => ({ node: n, recipe: recipes.find(r => r.lineId === n.lineId) ?? recipes[0] }))
  if (!step('L5-candidates', spCandidates.length > 0, `候选 SP 写控节点=${spCandidates.length}`)) return finish(false)

  /** 一次「补绑定 → 发起 trial → 轮询本卡 → 批准 → 收口」。
   *  双轨授权:dcw(覆盖集 ⊆ 绑定面)∨ recipe(配方操作权)——两条都绑,哪种判法都放行 */
  const attemptTrial = async (cand, targetVal) => {
    const b1 = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: agent.id, nodeId: cand.node.id, kind: 'dcw' }).catch(() => null)
    const b2 = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: agent.id, nodeId: cand.recipe.id, kind: 'recipe' }).catch(() => null)
    if (b1?.status !== 200 || b2?.status !== 200) {
      console.log(`  · 绑定补充:dcw=${b1?.status ?? 'ERR'} recipe=${b2?.status ?? 'ERR'} ${b1?.message ?? ''}${b2?.message ?? ''}`)
    }
    const trialP = invoke(agent, 'recipe_trial', {
      recipe_id: cand.recipe.id,
      params: [{ node_id: cand.node.id, value: Number(targetVal.toFixed(2)) }],
      hypothesis: `产线集成验收:单变量 SP=${targetVal.toFixed(2)}(HITL manual 链)`,
      emergency: true,
    }, 240_000)
    // 只认 trial 发起**之后**创建的卡:此前超时运行会遗留孤儿审批卡(按创建时间甄别)
    const trialStartAt = Date.now()
    let card = null
    for (let i = 0; i < 20 && !card; i++) {
      await sleep(1500)
      const items = (await api('GET', '/api/workshop/hitl/pending')).data?.items ?? []
      card = items.find(x => (x.kind === 'dcw-approval' || String(x.nodeId ?? '').startsWith('recipe:'))
        && (!x.createdAt || new Date(x.createdAt).getTime() >= trialStartAt - 1500)) ?? null
    }
    if (!card) {
      const early = await trialP.catch(e => ({ isError: true, text: String(e?.message ?? e) }))
      return { early, card: null, decided: null, trial: early }
    }
    const decided = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: '产线集成验收批准' })
    const trial = await trialP.catch(e => ({ isError: true, text: String(e?.message ?? e) }))
    return { early: null, card, decided, trial }
  }

  let picked = null
  for (const cand of spCandidates) {
    // 一线一频道(平台隔离模型):频道已绑线(本脚本 L1 绑首线)→ 其他线各建专属频道再试;
    // 首线若忙(成功试验会挂起优化观察窗,期间拒新试验)也自然落到后续线。
    let candAgent = agent
    if ((cand.node.lineId ?? '') !== (spNode.lineId ?? '')) {
      const c2 = await api('POST', '/api/workshop/channels', { name: `产线集成频道-${cand.node.lineId?.slice(0, 6)}-${randomUUID().slice(0, 4)}`, lineId: cand.node.lineId })
      const cid2 = c2.data?.channelId ?? c2.data?.id
      const l2 = await api('POST', `/api/workshop/channels/${cid2}/agents`, { name: '集成Lead', harness: 'mock', role: 'lead' })
      const candLeadId = l2.data?.id ?? l2.data?.agentId
      await api('POST', `/api/workshop/channels/${cid2}/activate`, {})
      await api('POST', `/api/workshop/workspaces/${wsId}/channels/${cid2}`, {})
      const t2 = await api('POST', `/api/workshop/channels/${cid2}/agents/${candLeadId}/rotate-token`, {})
      candAgent = { id: candLeadId, token: t2.data?.token ?? '' }
      const bd = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: candLeadId, nodeId: cand.node.id, kind: 'dcw' })
      const br = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: candLeadId, nodeId: cand.recipe.id, kind: 'recipe' })
      if (!(cid2 && candAgent.token) || bd.status !== 200 || br.status !== 200) {
        console.log(`  · 线 ${cand.node.lineId?.slice(0, 8)} 频道/绑定未就绪:ch=${cid2?.slice(0, 8)} dcw=${bd.status} recipe=${br.status}`)
        continue
      }
    }
    const before = (await api('GET', '/api/workshop/dcw')).data?.nodes?.find(n => n.id === cand.node.id)
    const beforeVal = Number(before?.value ?? NaN)
    // 步子收进单步限制联锁:stepLimit 取节点行(配方参数层若配置会更严,以最小为准在服务端裁判);
    // 锚点=配方基线值(trial 不写版本,步限比较基准是配方参数值而非设备现值)
    const stepLimit = Number(before?.stepLimit ?? NaN)
    const baseVal = Number(cand.recipe.params.find(p => p.nodeId === cand.node.id)?.value ?? NaN)
    const anchor = Number.isFinite(baseVal) ? baseVal : beforeVal
    if (!(Number.isFinite(stepLimit) && stepLimit > 0) || !Number.isFinite(anchor)) {
      console.log(`  · 跳过 ${cand.node.name}(stepLimit=${before?.stepLimit} anchor=${anchor})`)
      continue
    }
    const target = anchor + stepLimit * 0.6
    agent = candAgent
    let attempt = await attemptTrial(cand, target)
    // 频控双闸感知重试:
    // ① 试验节拍(≥300s,同线防连发) —— 早拒(不建卡)或批准后 429;
    // ② 节点在线写间隔(≥60s,防抖动) —— 刚做过受治理写入(如 seed 回读验证)后立即试验会撞冷却。
    for (let round = 0; round < 3; round++) {
      const cadenceText = attempt.trial?.text ?? attempt.early?.text ?? ''
      const m = cadenceText.match(/等待\s*(\d+)s 后再试/) ?? cadenceText.match(/还需\s*(\d+)s/)
      const waitSec = m ? Number(m[1]) : 0
      if (!(waitSec > 0 && waitSec <= 360)) break
      console.log(`  · 频控闸生效(节拍/写间隔),等待 ${waitSec + 5}s 后自动重试(第 ${round + 1} 次)`)
      await sleep((waitSec + 5) * 1000)
      attempt = await attemptTrial(cand, target)
    }
    if (attempt.trial && !attempt.trial.isError) {
      picked = { cand, beforeVal, target, attempt, agent: candAgent }
      break
    }
    const failText = attempt.trial?.text ?? attempt.early?.text ?? ''
    console.log(`  · 候选 ${cand.node.name} 未收口:${failText.replace(/\s+/g, ' ').slice(0, 200)}`)
  }
  if (!step('L5-picked', Boolean(picked), picked
    ? `node=${picked.cand.node.id.slice(0, 12)} target=${picked.target.toFixed(2)}`
    : `所有候选线均未收口;末次失败:${(spCandidates.length ? '' : '无候选')}`)) return finish(false)
  const { cand: pickedCand, beforeVal, target } = picked
  const { card, decided, trial } = picked.attempt
  if (!step('L5-hitl-card', Boolean(card), card ? `card=${String(card.id).slice(0, 12)} nodeId=${String(card.nodeId).slice(0, 24)}` : '无审批卡')) return finish(false)
  step('L5-approve', Boolean(decided) && decided.status === 200, `decide=${decided?.status ?? '?'} ${decided?.message ?? ''}`)
  step('L5-trial-resolved', Boolean(trial) && !trial.isError, trial.text.replace(/\s+/g, ' ').slice(0, 220))

  // 设备侧回读:SP 节点 value 朝 target 收敛(工艺一阶惯性,放宽 60s)
  let afterVal = Number.NaN
  for (let i = 0; i < 30; i++) {
    await sleep(2000)
    const n = (await api('GET', '/api/workshop/dcw')).data?.nodes?.find(x => x.id === pickedCand.node.id)
    const v = Number(n?.value ?? NaN)
    if (Number.isFinite(v) && Math.abs(v - target) <= Math.max(0.8, Math.abs(target) * 0.05)) { afterVal = v; break }
    afterVal = v
  }
  const moved = Number.isFinite(beforeVal) && Number.isFinite(afterVal) && Math.abs(afterVal - beforeVal) > 0.3
  step('L5-device-effect', moved || (Number.isFinite(afterVal) && Math.abs(afterVal - target) <= Math.max(0.8, Math.abs(target) * 0.05)),
    `before=${beforeVal} → after=${afterVal}(target=${target.toFixed(2)})`)
  const pendingAfter = (await api('GET', '/api/workshop/hitl/pending')).data?.items ?? []
  step('L5-card-closed', !pendingAfter.some(x => x.id === card.id), `pending 含该卡=${pendingAfter.some(x => x.id === card.id)}`)

  // ── L6 harness 共存:同频道多会话(建→关,基础成员保留) ──
  const s = await api('POST', `/api/workshop/channels/${cid}/sessions`, { title: `产线频道会话-${randomUUID().slice(0, 4)}` })
  const sid = s.data?.sessionId
  const membersOf = async () => (await api('GET', `/api/workshop/channels/${cid}/agents`)).data ?? []
  const membersWithSession = await membersOf()
  const sess = sid ? (await api('GET', `/api/workshop/channels/${cid}/sessions`)).data ?? [] : []
  const sessRow = sess.find(x => x.id === sid)
  step('L6-session-create', Boolean(sid) && membersWithSession.length >= 2 && Boolean(sessRow),
    `session=${String(sid).slice(0, 12)} status=${sessRow?.status} members=${membersWithSession.length}`)
  if (sid) {
    const closed = await api('POST', `/api/workshop/channels/${cid}/sessions/${sid}/close`, {})
    const membersAfter = await membersOf()
    const leadStill = membersAfter.some(a => a.id === leadId && (a.enabled ?? 1) === 1)
    step('L6-session-close', closed.status === 200 && leadStill, `close=${closed.status} canceled=${closed.data?.canceledTasks} lead保留=${leadStill}`)
  }

  return finish(steps.every(x => x.ok))
}

function finish(pass) {
  mkdirSync(outDir, { recursive: true })
  const verdict = pass ? 'PASS' : 'FAIL'
  writeFileSync(join(outDir, 'line-integration.json'), JSON.stringify({ verdict, base, steps }, null, 2))
  console.log(`\n判定: ${verdict} → ${outDir}`)
  process.exitCode = pass ? 0 : 1
}

main().catch((err) => { console.error('FAIL:', err?.message ?? err); finish(false) })
