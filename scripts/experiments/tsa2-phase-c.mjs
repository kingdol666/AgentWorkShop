/**
 * scripts/experiments/tsa2-phase-c.mjs —— 集成实测轮(round2) 阶段C:绑线 Channel 真实作业(数采/数控/RSI 多轮/记忆)。
 *
 * 生产口吻作业序列(deepseek-flash 单回合 40s~4min,严格串行):
 *   C0 装备:频道启用双桥插件 + 全员 omp/ustc + 铸 worker agent token(负例用)
 *   C1 只读早班巡检:daq_query 多节点判读(频道内 lead-worker 分工取证)
 *   C2 闭环小步 R1:保压压力SP +1MPa → HITL(choice=0) → 回读/journal
 *   C3 闭环小步 R2:保压时间SP +0.5s → HITL(choice=0) → 回读/journal(第二个任务证据)
 *   C4 RSI 多轮闭环:candidate 清单 → 单条晋升门拒(1/2) → merge(2条) → 人工晋升 validated → agent token 401
 *   C5 记忆召回轮:save_memory + search_memory 班中小结回报(会话记忆管理取证)
 *   C6 治理负例:越量程 400 / 跨用户 403
 * 断点续跑:state 存 D:/tmp/aw-liv2-1119/phase-c-state.json;每步证据落盘即跳过。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NO_PROXY = '127.0.0.1,localhost'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-19-integrated-live-round')
mkdirSync(EV, { recursive: true })
const PRIVATE = 'D:/tmp/aw-liv2-1119'
const BASE = 'http://127.0.0.1:3021'

const tokens = JSON.parse(readFileSync(join(PRIVATE, 'aw-tokens.json'), 'utf8'))
const statePath = join(PRIVATE, 'phase-c-state.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
const save = (name, obj) => { writeFileSync(join(EV, name), JSON.stringify(obj, null, 1)); writeFileSync(statePath, JSON.stringify(state, null, 1)) }
const log = (m) => console.log(`[phase-c2] ${m}`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, token, timeoutMs = 60_000) {
  let r
  try {
    r = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) { return { status: 0, json: { raw: `network-error:${e.cause?.code ?? e.name}` } } }
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 400) } }
  return { status: r.status, json }
}

function onboardCtx() {
  const o = JSON.parse(readFileSync(join(PRIVATE, 'onboard-result.json'), 'utf8'))
  return { lineId: o.lineId, chId: o.channelId, agents: o.agents }
}

async function sendWork(chId, leadId, text) {
  // 中文正文走文件体,避免 GBK 管道乱码
  const bodyPath = join(PRIVATE, 'c-msg.json')
  writeFileSync(bodyPath, JSON.stringify({ toAgentId: leadId, text, priority: 'immediate', requireReply: true }))
  const r = await fetch(BASE + `/api/workshop/channels/${chId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${tokens.admin}` },
    body: readFileSync(bodyPath),
    signal: AbortSignal.timeout(60_000),
  })
  const json = await r.json().catch(() => ({ raw: 'parse-error' }))
  return { status: r.status, json }
}

async function waitReply(chId, sinceMs, timeoutMs = 10 * 60_000, needAgent = true) {
  const t0 = Date.now()
  for (;;) {
    const list = (await api('GET', `/api/workshop/channels/${chId}/messages?limit=40`, undefined, tokens.admin)).json?.data ?? []
    const items = Array.isArray(list) ? list : (list.items ?? [])
    const rep = items.find(m => Date.parse(m.createdAt ?? '') > sinceMs
      && (!needAgent || (m.fromAgentId && m.fromAgentId !== ''))
      && (m.parts ?? []).some(p => String(p.text ?? '').length > 30))
    if (rep) return rep
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(15_000)
  }
}

async function replyText(rep, cap = 2600) {
  return rep ? { id: rep.id, from: rep.fromAgentId, at: rep.createdAt, text: (rep.parts ?? []).map(p => p.text ?? '').join('\n').slice(0, cap) } : { timeout: true }
}

async function waitDcwCard(chId, timeoutMs = 30 * 60_000) {
  const t0 = Date.now()
  for (;;) {
    const p = await api('GET', `/api/workshop/hitl/pending?channelId=${chId}`, undefined, tokens.admin)
    const card = (p.json?.data?.items ?? []).find(i => i.kind === 'dcw-approval')
    if (card) return card
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(10_000)
  }
}

async function main() {
  const { lineId, chId, agents } = onboardCtx()
  const lead = agents.find(a => a.role === 'lead')
  const workers = agents.filter(a => a.role === 'worker')
  log(`频道=${chId} lead=${lead.id} workers=${workers.length} 线=${lineId}`)

  // =========== C0 装备 ===========
  if (!state.c0) {
    const put = await api('PUT', `/api/workshop/channels/${chId}/plugins`, {
      plugins: [{ name: 'diag-bridge', enabled: true }, { name: 'rag-bridge', enabled: true }],
    }, tokens.admin)
    for (const a of [...agents]) {
      const cfg = { ...(a.config ?? {}), provider: 'ustc', model: 'deepseek-flash', rpcMode: 'rpc' }
      await api('PATCH', `/api/workshop/channels/${chId}/agents/${a.id}`, { config: cfg }, tokens.admin)
    }
    await api('PATCH', `/api/workshop/channels/${chId}`, { llm: { provider: 'ustc', model: 'deepseek-flash', effort: 'max' } }, tokens.admin)
    const w0 = workers[0]
    const tok = await api('POST', `/api/workshop/channels/${chId}/agents/${w0.id}/rotate-token`, {}, tokens.admin)
    const agentToken = tok.json?.data?.token ?? tok.json?.token
    if (agentToken) writeFileSync(join(PRIVATE, 'worker-agent-token.txt'), agentToken)
    save('phase-c2-c0-equip.json', { plugins: put.status, agents: agents.map(a => a.role), agentTokenMinted: Boolean(agentToken) })
    state.c0 = { plugins: put.status, agentToken: Boolean(agentToken) }
    log('C0 装备完成')
  }

  // =========== C1 只读早班巡检(频道内分工) ===========
  if (!state.c1) {
    log('C1 发送早班巡检作业(只读)…')
    const sent = await sendWork(chId, lead.id, '【早班巡检】请读取「制品克重PV」「熔体压力PV」「飞边PV」「模具温度PV」最近5分钟采样(均值/最小/最大/样本数),对照目标克重 32.50±0.35g 判定当前工况是否达标;若偏离请给出第一步调参方向。请按班组分工安排:可派一名工艺员取数,由你汇总判读。本次只巡检,先不要写任何参数。')
    const sentAt = Date.now()
    save('phase-c2-c1-sent.json', { status: sent.status, sentAt: new Date(sentAt).toISOString() })
    log('C1 等待巡检回报…')
    const rep = await waitReply(chId, sentAt, 10 * 60_000)
    save('phase-c2-c1-reply.json', await replyText(rep))
    state.c1 = { replied: Boolean(rep) }
    log(`C1 完成 replied=${state.c1.replied}`)
  }

  // =========== C2 闭环小步 R1:保压压力SP +1MPa ===========
  if (!state.c2) {
    let sentAt
    if (existsSync(join(EV, 'phase-c2-c2-sent.json'))) {
      sentAt = Date.parse(JSON.parse(readFileSync(join(EV, 'phase-c2-c2-sent.json'), 'utf8')).sentAt)
      log('C2 作业已发送(断点续跑),直接等审批卡…')
    } else {
      log('C2 发送闭环小步 R1(保压压力SP +1MPa)…')
      const sent = await sendWork(chId, lead.id, '【闭环调参 R1】结合刚才巡检结论,执行一次受控调参:把「保压压力SP」在当前值基础上上调 1MPa(步限内),走配方审批流程提交方案,方案依据写明本轮巡检实测。等我批准后再下发;获批后回报审批单号、下发结果与设备回读值。只允许这一个参数这一步。')
      sentAt = Date.now()
      save('phase-c2-c2-sent.json', { status: sent.status, sentAt: new Date(sentAt).toISOString() })
    }
    const card = await waitDcwCard(chId, 8 * 60_000)
    if (!card) { save('phase-c2-c2-ABORT.json', { error: '8min 无审批卡' }); throw new Error('C2 无审批卡') }
    save('phase-c2-c2-card.json', card)
    log(`C2 审批卡 ${card.id},choice=0 批准…`)
    const decide = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, cancelled: false, choice: 0, comment: '巡检数据支持小步上调,批准执行' }, tokens.admin)
    save('phase-c2-c2-decide.json', { status: decide.status, body: decide.json })
    const rep = await waitReply(chId, sentAt, 20 * 60_000)
    save('phase-c2-c2-reply.json', await replyText(rep))
    await sleep(3000)
    const journal = await api('GET', `/api/workshop/dcw/journal?lineId=${lineId}&limit=20`, undefined, tokens.admin)
    save('phase-c2-c2-journal.json', journal.json)
    // 回读:取保压压力SP 节点 id(journal 里有 nodeId)
    const jnode = (journal.json?.data?.items ?? journal.json?.data ?? [])[0]?.nodeId
    const readback = jnode ? await api('POST', `/api/workshop/dcw/${jnode}/read`, {}, tokens.admin) : { status: 0, json: { note: 'no-node' } }
    save('phase-c2-c2-readback.json', readback.json)
    state.c2 = { card: card.id, replied: Boolean(rep), decide: decide.status }
    log(`C2 完成 card=${card.id} decide=${decide.status} replied=${state.c2.replied}`)
  }

  // =========== C3 闭环小步 R2:保压时间SP +0.5s(第二个任务证据) ===========
  if (!state.c3) {
    log('C3 发送闭环小步 R2(保压时间SP +0.5s)…')
    const sent = await sendWork(chId, lead.id, '【闭环调参 R2】克重仍略低于目标带下沿,执行第二次受控小步:把「保压时间SP」在当前值基础上上调 0.5s(步限内),同样走配方审批,依据写 R1 后的回读与最近数据。等我批准;获批后回报审批单号、下发与回读结果。仍然只允许这一个参数这一步。')
    const sentAt = Date.now()
    save('phase-c2-c3-sent.json', { status: sent.status, sentAt: new Date(sentAt).toISOString() })
    const card = await waitDcwCard(chId, 8 * 60_000)
    if (!card) { save('phase-c2-c3-ABORT.json', { error: '8min 无审批卡' }); throw new Error('C3 无审批卡') }
    save('phase-c2-c3-card.json', card)
    const decide = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, cancelled: false, choice: 0, comment: 'R1 回读一致,继续小步逼近目标带,批准' }, tokens.admin)
    save('phase-c2-c3-decide.json', { status: decide.status, body: decide.json })
    const rep = await waitReply(chId, sentAt, 8 * 60_000)
    save('phase-c2-c3-reply.json', await replyText(rep))
    await sleep(3000)
    const journal = await api('GET', `/api/workshop/dcw/journal?lineId=${lineId}&limit=20`, undefined, tokens.admin)
    save('phase-c2-c3-journal.json', journal.json)
    state.c3 = { card: card.id, decide: decide.status, replied: Boolean(rep) }
    log(`C3 完成 card=${card.id} decide=${decide.status}`)
  }

  // =========== C4 RSI 多轮闭环 ===========
  if (!state.c4) {
    log('C4 RSI:收集 candidates(经验条目挂在 lead agent 名下,须走 agent 记忆面)…')
    const t0 = Date.now()
    let items = []
    while (Date.now() - t0 < 6 * 60_000) {
      const m = await api('GET', `/api/workshop/channels/${chId}/agents/${lead.id}/memories?limit=100`, undefined, tokens.admin)
      items = m.json?.data?.items ?? (Array.isArray(m.json?.data) ? m.json.data : [])
      const cands = items.filter(x => x.kind === 'experience' && x.status === 'candidate' && x.scopeKind === 'line')
      if (cands.length >= 2) break
      await sleep(20_000)
    }
    const cands = items.filter(x => x.kind === 'experience' && x.status === 'candidate' && x.scopeKind === 'line')
    save('phase-c2-c4-candidates.json', { all: items.filter(x => x.kind === 'experience').slice(0, 12).map(x => ({ id: x.id, title: x.title, status: x.status, scope: x.scopeKind })), candidateCount: cands.length })
    if (cands.length < 2) throw new Error(`RSI candidate 不足(=${cands.length})`)
    // 单条晋升门拒(预期 1/2)
    const gate = await api('POST', `/api/workshop/channels/${chId}/memories/${cands[0].id}/promote`, { to: 'validated' }, tokens.admin)
    save('phase-c2-c4-single-promote-gate.json', gate.json)
    // merge 前两条
    const merge = await api('POST', `/api/workshop/channels/${chId}/memories/merge`, { memoryIds: [cands[0].id, cands[1].id] }, tokens.admin)
    save('phase-c2-c4-merge.json', merge.json)
    const mergedId = merge.json?.data?.memoryId
    // 人工晋升 validated
    const promo = mergedId
      ? await api('POST', `/api/workshop/channels/${chId}/memories/${mergedId}/promote`, { to: 'validated' }, tokens.admin)
      : { status: 0, json: { note: 'no-merged-id' } }
    save('phase-c2-c4-promote-validated.json', promo.json)
    // agent token 越权晋升 401(用另一条 candidate)
    const victim = cands[2]?.id ?? cands[1].id
    let agentTok = null
    try { agentTok = readFileSync(join(PRIVATE, 'worker-agent-token.txt'), 'utf8').trim() } catch {}
    const unauthorized = agentTok
      ? await api('POST', `/api/workshop/channels/${chId}/memories/${victim}/promote`, { to: 'validated' }, agentTok)
      : { status: 0, json: { note: 'no-agent-token' } }
    save('phase-c2-c4-agent-promote-401.json', { agentId: workers[0].id, result: { http: unauthorized.status, body: JSON.stringify(unauthorized.json).slice(0, 300) } })
    state.c4 = { candidates: cands.length, gate: gate.json?.data?.ok, merged: Boolean(mergedId), promoted: promo.json?.data?.ok, unauthorizedStatus: unauthorized.status }
    log(`C4 完成 candidates=${cands.length} gate=${state.c4.gate} promote=${state.c4.promoted} 401=${unauthorized.status}`)
  }

  // =========== C5 记忆召回轮(save/search 会话记忆) ===========
  if (!state.c5) {
    log('C5 发送班中小结(记忆沉淀+召回)…')
    const sent = await sendWork(chId, lead.id, '【班中小结】请完成两件事并回报:1) 用 save_memory 把本轮闭环调参结论沉淀到频道共享记忆(保压压力SP +1MPa、保压时间SP +0.5s 均经审批下发且回读一致;克重趋近目标带;单步增益参考);2) 用 search_memory 检索「保压压力 克重」验证可召回,回报命中的条目标题与状态。')
    const sentAt = Date.now()
    save('phase-c2-c5-sent.json', { status: sent.status, sentAt: new Date(sentAt).toISOString() })
    const rep = await waitReply(chId, sentAt, 20 * 60_000)
    save('phase-c2-c5-reply.json', await replyText(rep))
    state.c5 = { replied: Boolean(rep) }
    log(`C5 完成 replied=${state.c5.replied}`)
  }

  // =========== C6 治理负例 ===========
  if (!state.c6) {
    log('C6 治理负例…')
    // 越量程:取 R1 journal 的 nodeId
    const journal = JSON.parse(readFileSync(join(EV, 'phase-c2-c2-journal.json'), 'utf8'))
    const jitems = journal?.data?.items ?? journal?.data ?? []
    const nodeId = jitems[0]?.nodeId
    const oob = nodeId ? await api('POST', `/api/workshop/dcw/${nodeId}/write`, { value: 999 }, tokens.admin) : { status: 0, json: { note: 'no-node' } }
    save('phase-c2-c6-oob.json', { status: oob.status, body: oob.json })
    const cross = nodeId ? await api('POST', `/api/workshop/dcw/${nodeId}/write`, { value: 52 }, tokens.second) : { status: 0, json: { note: 'no-node' } }
    save('phase-c2-c6-cross-user.json', { status: cross.status, body: cross.json })
    state.c6 = { oob: oob.status, cross: cross.status }
    log(`C6 完成 越量程=${oob.status} 跨用户=${cross.status}(期望 400/403)`)
  }

  console.log('PHASE-C-RESULT ' + JSON.stringify({ ok: true, state }))
}

await main().catch((e) => {
  console.error(`[phase-c2] FAILED: ${e.message}`)
  save('phase-c2-ABORT.json', { error: e.message, at: new Date().toISOString(), state })
  process.exitCode = 1
})
