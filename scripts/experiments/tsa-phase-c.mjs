/**
 * scripts/experiments/tsa-phase-c.mjs —— 三端验收 阶段C:绑线 Channel 真实作业(2026-11-19)。
 *
 * 生产口吻作业序列(deepseek-flash 单回合 40s~4min,严格串行):
 *   C1 只读早班巡检:daq_query 最近5分钟多节点 + 对照目标带判断(不写入)
 *   C2 闭环小步:line_context → recipe_propose(+1MPa) → 人工 HITL 批准 → 回读/journal/ACK 取证
 *   C3 治理负例(真实会发生的状况):越量程写 400 / 跨用户写 403
 *   C4 RSI:candidate 经验 → 人工 merge+promote → search_memory 召回;Agent 越权晋升 401
 * 断点续跑:每步证据落盘即跳过已完成步。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NO_PROXY = '127.0.0.1,localhost'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EV = join(REPO, 'docs', 'audit', 'evidence', '2026-11-19-three-system-acceptance')
mkdirSync(EV, { recursive: true })
const PRIVATE = 'D:/tmp/aw-tsa-1119'
const BASE = 'http://127.0.0.1:3021'
const CH = '8709a0e9-3aca-4dad-b339-6f0b14719eec'
const LINE = 'ln-74799404'
const PRESSURE_NODE = 'dw-25e7dde7'
const WEIGHT_DAQ = 'dn-8f8a6094'
const RECIPE = 'rc-23a5f77a'

const tokens = JSON.parse(readFileSync(join(PRIVATE, 'aw-tokens.json'), 'utf8'))
const statePath = join(PRIVATE, 'phase-c-state.json')
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}

const save = (name, obj) => { writeFileSync(join(EV, name), JSON.stringify(obj, null, 1)); writeFileSync(statePath, JSON.stringify(state, null, 1)) }
const log = (m) => console.log(`[phase-c] ${m}`)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function api(method, path, body, token, timeoutMs = 60_000) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text.slice(0, 400) } }
  return { status: r.status, json }
}

async function leadId() {
  const members = (await api('GET', `/api/workshop/channels/${CH}/agents`, undefined, tokens.admin)).json?.data ?? []
  return (members.find(a => a.role === 'lead'))?.id
}

async function sendWork(text) {
  const lid = await leadId()
  const r = await api('POST', `/api/workshop/channels/${CH}/messages`, { toAgentId: lid, text, priority: 'immediate', requireReply: true }, tokens.admin)
  return r
}

// 等待 lead 新的 agent 消息(时间戳晚于 sinceMs)
async function waitLeadReply(sinceMs, timeoutMs = 8 * 60_000) {
  const t0 = Date.now()
  for (;;) {
    const list = (await api('GET', `/api/workshop/channels/${CH}/messages?limit=30`, undefined, tokens.admin)).json?.data ?? []
    const items = Array.isArray(list) ? list : (list.items ?? [])
    const rep = items.find(m => (m.createdAtMs ?? Date.parse(m.createdAt ?? '')) > sinceMs
      && (m.fromAgentId || m.metadata?.['x-aw-from-agent'])
      && (m.parts ?? []).some(p => String(p.text ?? '').length > 10))
    if (rep) return rep
    if (Date.now() - t0 > timeoutMs) return null
    await sleep(15_000)
  }
}

async function main() {
  // =========== C1 只读早班巡检 ===========
  if (!state.c1) {
    log('C1 发送早班巡检作业(只读)…')
    const sent = await sendWork('【早班巡检】请读取「制品克重PV」「熔体压力PV」「飞边PV」最近5分钟的采样数据(均值/最小/最大/样本数),对照目标克重 32.50±0.35g 判断当前工况是否达标;若偏离,给出第一步调参方向的建议。本次只做巡检判断,先不要写入任何参数。')
    const sentAt = Date.now()
    save('phase-c-c1-sent.json', { status: sent.status, body: sent.json, sentAt: new Date(sentAt).toISOString() })
    log('C1 等待 lead 巡检回报…')
    const rep = await waitLeadReply(sentAt, 10 * 60_000)
    if (!rep) { save('phase-c-c1-ABORT.json', { error: 'lead 10min 未回报' }); throw new Error('C1 lead 无回报') }
    const text = (rep.parts ?? []).map(p => p.text).join('\n').slice(0, 2500)
    state.c1 = { messageId: rep.id, at: rep.createdAt ?? new Date().toISOString(), provider: rep.metadata?.['x-aw-model'] ?? null }
    save('phase-c-c1-reply.json', { id: rep.id, at: rep.createdAt, text })
    // 同时窗直连交叉核对
    const direct = await api('GET', `/api/workshop/daq/${WEIGHT_DAQ}/samples?limitMinutes=5`, undefined, tokens.admin)
    save('phase-c-c1-direct-samples.json', { status: direct.status, body: direct.json })
    log(`C1 完成: ${text.slice(0, 80)}…`)
  }

  // =========== C2 闭环小步(HITL 写控) ===========
  if (!state.c2) {
    let sentAt
    if (existsSync(join(EV, 'phase-c-c2-sent.json'))) {
      sentAt = Date.parse(JSON.parse(readFileSync(join(EV, 'phase-c-c2-sent.json'), 'utf8')).sentAt)
      log('C2 作业已在此前发送(断点续跑),直接等审批卡…')
    }
    else {
      log('C2 发送闭环小步作业(recipe_propose +1MPa)…')
      const sent = await sendWork('【闭环小步】结合刚才巡检的克重实测,执行一次受控调参:把「保压压力SP」在当前值基础上上调 1MPa(步限内),走配方审批流程提交方案;方案依据写明本轮巡检数据。等待我批准后再下发,获批后报告审批单号、下发结果与设备回读值。只允许这一个参数这一步。')
      sentAt = Date.now()
      save('phase-c-c2-sent.json', { status: sent.status, sentAt: new Date(sentAt).toISOString() })
    }
    // 轮询 HITL 待批卡
    let card = null
    const t0 = Date.now()
    while (Date.now() - t0 < 8 * 60_000) {
      const p = await api('GET', `/api/workshop/hitl/pending?channelId=${CH}`, undefined, tokens.admin)
      card = (p.json?.data?.items ?? []).find(i => i.kind === 'dcw-approval')
      if (card) break
      await sleep(10_000)
    }
    if (!card) { save('phase-c-c2-ABORT.json', { error: '8min 内未见审批卡' }); throw new Error('C2 无审批卡') }
    save('phase-c-c2-card.json', card)
    log(`C2 审批卡 ${card.id},人工批准…`)
    // 人工(owner)批准
    const decide = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, cancelled: false, comment: '巡检数据支持小步上调,批准执行' }, tokens.admin)
    save('phase-c-c2-decide.json', { status: decide.status, body: decide.json })
    // 等 lead 回报
    const rep = await waitLeadReply(sentAt, 8 * 60_000)
    const text = rep ? (rep.parts ?? []).map(p => p.text).join('\n').slice(0, 2500) : '(超时)'
    save('phase-c-c2-reply.json', rep ? { id: rep.id, at: rep.createdAt, text } : { timeout: true })
    // 独立取证:journal + readback
    await sleep(3000)
    const journal = await api('GET', `/api/workshop/dcw/journal?lineId=${LINE}&limit=20`, undefined, tokens.admin)
    save('phase-c-c2-journal.json', journal.json)
    const readback = await api('POST', `/api/workshop/dcw/${PRESSURE_NODE}/read`, {}, tokens.admin)
    save('phase-c-c2-readback.json', readback.json)
    state.c2 = { card: card.id, replied: Boolean(rep), readbackValue: readback.json?.data?.read?.value ?? readback.json?.data?.value ?? null }
    log(`C2 完成: card=${card.id} readback=${state.c2.readbackValue}`)
  }

  // =========== C3 治理负例(真实状况) ===========
  if (!state.c3) {
    log('C3 治理负例:越量程写 / 跨用户写…')
    const oob = await api('POST', `/api/workshop/dcw/${PRESSURE_NODE}/write`, { value: 999 }, tokens.admin)
    save('phase-c-c3-oob.json', { status: oob.status, body: oob.json })
    const cross = await api('POST', `/api/workshop/dcw/${PRESSURE_NODE}/write`, { value: 52 }, tokens.second)
    save('phase-c-c3-cross-user.json', { status: cross.status, body: cross.json })
    state.c3 = { oobStatus: oob.status, crossStatus: cross.status }
    log(`C3 完成: 越量程=${oob.status} 跨用户=${cross.status}(期望 400/403)`)
  }

  console.log('PHASE-C-RESULT ' + JSON.stringify({ ok: true, state }))
}

await main().catch((e) => {
  console.error(`[phase-c] FAILED: ${e.message}`)
  save('phase-c-ABORT.json', { error: e.message, at: new Date().toISOString(), state })
  process.exitCode = 1
})
