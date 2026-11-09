/**
 * 正规治理写链（write_intent → owner 批准 → HITL → recipe_trial → 独立回读）。
 * 用法：node scripts/_live-rsi-write-intent.mjs
 */
process.env.NO_PROXY = '127.0.0.1,localhost'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = JSON.parse(readFileSync(join(REPO, '.rsi-demo-state.json'), 'utf8'))
const BASE = state.base
const H = { 'authorization': `Bearer ${state.token}`, 'content-type': 'application/json' }
const DB = new DatabaseSync(join(state.home, 'data', 'workshop.sqlite'))
DB.exec('PRAGMA busy_timeout = 5000')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (method, path, body, timeoutMs = 120_000) => {
  const r = await fetch(BASE + path, {
    method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? '')
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)
const parseTool = r => { try { return JSON.parse(invText(r)) } catch { return null } }
const invokeAgent = (agentId, tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args })
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? 'PASS' : 'FAIL'} ${id} — ${name}${detail ? ` · ${String(detail).slice(0, 200)}` : ''}`)
}

try {
  const attempt = DB.prepare(
    'SELECT channel_id AS channelId, channel_task_id AS taskId FROM project_work_item_attempts WHERE work_item_id = ? ORDER BY attempt_no DESC LIMIT 1',
  ).get(state.project.workItemId)
  const instLead = DB.prepare(`SELECT id FROM channel_agents WHERE channel_id = ? AND role = 'lead'`).get(attempt.channelId)?.id
  const blowerSp = state.line.dcw['blower-hz-sp']

  // ① channel lead 申请 write_intent（项目来源任务的高风险写闸）
  const wi = await invokeAgent(instLead, 'project_request_write_intent', {
    tool: 'recipe_trial',
    args: { recipe_id: state.line.recipeId, params: [{ node_id: blowerSp, value: 24 }], emergency: true },
    reason: 'RSI live demo：风机频率 26→24Hz 达标降耗试验（owner 批准 + HITL 双闸）',
    task_id: attempt.taskId,
  })
  const body = parseTool(wi)
  ok('W1', 'channel lead 申请 write_intent（digest 绑定工作项）',
    wi.status === 200 && !invErr(wi) && body?.approvalId && String(body?.digest ?? '').length === 64,
    `approval=${body?.approvalId} digest=${String(body?.digest ?? '').slice(0, 12)}… err=${invText(wi).slice(0, 120)}`)
  if (!body?.approvalId) throw new Error('write_intent 申请失败')

  // ② owner 批准 write_intent
  const dec = await api('POST', `/api/workshop/projects/${state.project.id}/approvals/${body.approvalId}/decide`, { approve: true, reason: 'RSI live demo write_intent 批准' })
  ok('W2', 'owner 批准 write_intent', dec.status === 200 && dec.data?.status === 'approved', `status=${dec.status}`)

  // ③ recipe_trial 执行（write_intent 消费 + HITL 卡 → 人批准）
  const cards0 = new Set(((await api('GET', '/api/workshop/hitl/pending')).data?.items ?? []).map(x => x.id))
  const trialP = invokeAgent(instLead, 'recipe_trial', {
    recipe_id: state.line.recipeId,
    params: [{ node_id: blowerSp, value: 24 }],
    hypothesis: 'RSI live demo：风机频率 26→24Hz（write_intent+HITL 双闸治理下发）',
    emergency: true,
  })
  let card = null
  for (let i = 0; i < 60 && !card; i++) {
    await sleep(2000)
    card = ((await api('GET', '/api/workshop/hitl/pending')).data?.items ?? []).find(x => !cards0.has(x.id)) ?? null
  }
  if (card) await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, choice: 0, comment: 'RSI live demo HITL 批准' })
  const trialR = await trialP
  ok('W3', 'write_intent+HITL 双批准后下发真实设备', !invErr(trialR), invText(trialR).slice(0, 240))

  // ④ 独立回读（周期补扫或即时）→ 台账 match
  let blind = null
  for (let i = 0; i < 40; i++) {
    await sleep(3000)
    blind = DB.prepare(`SELECT b.verdict, b.detail, b.task_id AS taskId FROM blind_verifications b
      WHERE b.channel_id = ? ORDER BY b.created_at DESC LIMIT 1`).get(attempt.channelId)
    if (blind && blind.verdict === 'match') break
  }
  ok('W4', 'C1 独立回读 verdict=match（指令=设备实时值）', blind?.verdict === 'match',
    blind ? `${blind.verdict} ${String(blind.detail).slice(0, 120)}` : '无台账')

  // ⑤ 验证看板（REST）
  const board = (await api('GET', `/api/workshop/channels/${attempt.channelId}/verifications`)).data
  ok('W5', '验证看板可查（REST）', (board?.total ?? 0) >= 1, `total=${board?.total} byVerdict=${JSON.stringify(board?.byVerdict)}`)

  state.writeIntent = { approvalId: body.approvalId, trial: !invErr(trialR), blind: blind?.verdict }
  writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
} catch (err) {
  ok('HALT', '治理写链未完成', false, err instanceof Error ? err.message.slice(0, 300) : String(err))
} finally {
  const pass = results.filter(r => r.pass).length
  console.log(`\n=== WRITE-INTENT CHAIN  pass=${pass}/${results.length} ===`)
  DB.close()
}
