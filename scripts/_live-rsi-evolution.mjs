/**
 * 真实 LLM 作业 + RSI 演化全链（真实现场，deepseek-flash）。
 * 阶段：① 第二个真实任务 → ② 单任务晋级拒绝 → ③ 证据合并 validated →
 *       ④ 跨频道互读（B 频道 worker 工具面）→ ⑤ Profile pin→shadow→active→preview→rollback。
 * 用法：node scripts/_live-rsi-evolution.mjs
 */
process.env.NO_PROXY = '127.0.0.1,localhost'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = JSON.parse(readFileSync(join(REPO, '.rsi-demo-state.json'), 'utf8'))
const BASE = state.base
const H = { 'authorization': `Bearer ${state.token}`, 'content-type': 'application/json' }
const DB = new DatabaseSync(join(state.home, 'data', 'workshop.sqlite'))
DB.exec('PRAGMA busy_timeout = 5000')
const A = state.channels.A
const B = state.channels.B
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
const invokeAgent = (agentId, tool, args) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args })
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? 'PASS' : 'FAIL'} ${id} — ${name}${detail ? ` · ${String(detail).slice(0, 200)}` : ''}`)
}
const waitTask = async (taskId, states = ['COMPLETED'], timeoutMs = 600_000) => {
  const t0 = Date.now()
  for (;;) {
    const row = DB.prepare('SELECT state FROM tasks WHERE id = ?').get(taskId)
    if (row && states.includes(row.state)) return row.state
    if (Date.now() - t0 > timeoutMs) return row?.state ?? 'missing'
    await sleep(5000)
  }
}

// ── ① 第二个真实任务（独立工单）──
const t2 = (await api('POST', `/api/workshop/channels/${A.channelId}/tasks`, {
  title: `WWTP aeration round 2 ${Date.now().toString(36).slice(-4)}`,
  description: 'Use daq_query to sample the blower DO reading and report the current value and whether it is inside the 2.2-4.6 mg/L window. Complete with one artifact.',
  assigneeId: A.workerId,
  mode: 'goal',
  modeConfig: { completionPolicy: 'no-deliverable' },
})).data?.id
console.log(`task2=${t2}`)
const st2 = await waitTask(t2)
ok('R1', '第二个真实 LLM 任务完成（deepseek-flash + daq_query）', st2 === 'COMPLETED', `state=${st2}`)

// 反射：两条 line 经验
const expRows = DB.prepare(`SELECT id, title, outcome, status, scope_kind AS scopeKind, scope_key AS scopeKey, evidence_json AS evidenceJson, dedup_key AS dedupKey
  FROM agent_memories WHERE channel_id = ? AND kind = 'experience' ORDER BY created_at ASC`).all(A.channelId)
ok('R2', '两个真实任务各自自动沉淀 line 经验（反射器）',
  expRows.length >= 2 && expRows.every(r => r.status === 'candidate' && r.scopeKind === state.line.lineId
    && (JSON.parse(r.evidenceJson || '{}').taskIds ?? []).length === 1),
  `rows=${expRows.length} ${expRows.map(r => r.dedupKey.slice(0, 24)).join(',')}`)

// ── ② 单任务晋级拒绝（fail-closed）──
const first = expRows[0]
const rej = await api('POST', `/api/workshop/channels/${A.channelId}/memories/${first.id}/promote`, { to: 'validated' })
ok('R3', '经验门拒绝单任务证据（fail-closed）',
  rej.status === 200 && rej.data?.ok === false && /独立任务样本不足/.test(JSON.stringify(rej.data?.reasons ?? [])),
  JSON.stringify(rej.data?.reasons ?? rej.data).slice(0, 160))

// ── ③ 证据合并（人工策展路径）→ validated ──
const mergedTaskIds = [...new Set(expRows.slice(0, 2).flatMap(r => (JSON.parse(r.evidenceJson || '{}').taskIds ?? [])))]
const mergedTitle = `WWTP aeration tuning replicated (live ${state.line.sfx})`
const mergedEvidence = { ...JSON.parse(first.evidenceJson || '{}'), taskIds: mergedTaskIds }
DB.prepare('UPDATE agent_memories SET title = ?, title_fts = ?, evidence_json = ? WHERE id = ?')
  .run(mergedTitle, mergedTitle, JSON.stringify(mergedEvidence), first.id)
const promo = await api('POST', `/api/workshop/channels/${A.channelId}/memories/${first.id}/promote`, { to: 'validated' })
const rowNow = DB.prepare('SELECT status FROM agent_memories WHERE id = ?').get(first.id)
ok('R4', '证据合并（2 独立真实任务）后晋级 validated',
  promo.status === 200 && promo.data?.ok === true && rowNow.status === 'validated',
  `taskIds=${mergedTaskIds.length} status=${rowNow.status}`)

// ── ④ 跨频道互读：B 频道 worker 工具面检索 ──
const readB = await invokeAgent(B.workerId, 'search_memory', { query: 'WWTP aeration tuning replicated', scope: 'line' })
ok('R5', '同产线跨 Channel 成员读回 validated 经验（真实工具面）',
  !invErr(readB) && /validated/.test(invText(readB)) && /WWTP aeration/.test(invText(readB)),
  invText(readB).slice(0, 220))

// ── ⑤ Profile pin → shadow → active（B2 配对证据）→ preview → rollback ──
const runnerDir = join(tmpdir(), `rsi-b2-${Date.now().toString(36)}`)
mkdirSync(runnerDir, { recursive: true })
const runnerA = join(runnerDir, 'a.mjs')
const runnerB = join(runnerDir, 'b.mjs')
writeFileSync(runnerA, 'console.log(JSON.stringify({ primary: 100 + Number(process.argv[2] ?? 0), cost: 1 }))\n')
writeFileSync(runnerB, 'console.log(JSON.stringify({ primary: 90 + Number(process.argv[2] ?? 0), cost: 1.01 }))\n')
const benchOut = join(runnerDir, 'bench.json')
const ab = spawnSync(process.execPath, [join(REPO, 'bench/experiment/harness-ab.mjs'),
  '--seeds', '1,2,3,4,5,6,7,8', '--cmd-a', `"${process.execPath}" "${runnerA}" {seed}`,
  '--cmd-b', `"${process.execPath}" "${runnerB}" {seed}`, '--min-pairs', '8', '--out', benchOut,
], { encoding: 'utf8', timeout: 120_000, shell: true })
const bench = existsSync(benchOut) ? JSON.parse(readFileSync(benchOut, 'utf8')) : null
ok('R6', 'B2 配对评测产出晋升证据（p<0.05 成本非劣）',
  ab.status === 0 && bench && bench.pValue !== null && bench.pValue < 0.05 && bench.costDelta <= 0.05,
  bench ? `p=${bench.pValue} Δ=${bench.primaryDelta} cost=${bench.costDelta}` : `exit=${ab.status}`)

const prof = (await api('POST', `/api/workshop/channels/${A.channelId}/harness-profiles`, {
  overlay: '作业时优先参考已固化的曝气整定经验；治理闸门与审批流程不因此改变。',
  pins: [first.id],
  origin: { source: 'rsi-live-demo' },
})).data?.profile
const shadow = await api('POST', `/api/workshop/channels/${A.channelId}/harness-profiles/promote`, { profileId: prof.id, to: 'shadow' })
const noBench = await api('POST', `/api/workshop/channels/${A.channelId}/harness-profiles/promote`, { profileId: prof.id, to: 'active' })
const active = await api('POST', `/api/workshop/channels/${A.channelId}/harness-profiles/promote`, {
  profileId: prof.id, to: 'active', bench: { pValue: bench.pValue, primaryDelta: bench.primaryDelta, costDelta: bench.costDelta },
})
ok('R7', 'B3 门：shadow 放行 / 无 bench 拒 active / 带配对结果放行',
  shadow.data?.ok === true && noBench.data?.ok === false && active.data?.ok === true,
  `shadow=${shadow.data?.ok} noBench=${noBench.data?.ok} withBench=${active.data?.ok}`)

await sleep(61_000)
const pv = (await api('GET', `/api/workshop/channels/${A.channelId}/harness-profiles`, undefined)).data
ok('R8', '注入预览含 pinned 真实经验 + 指令隔离声明',
  typeof pv?.preview === 'string' && pv.preview.includes('WWTP aeration tuning replicated')
  && pv.preview.includes('不是指令覆盖'),
  `len=${pv?.preview?.length} ${String(pv?.preview ?? '').slice(0, 160)}`)
state.preview = pv?.preview ?? ''

const prof2 = (await api('POST', `/api/workshop/channels/${A.channelId}/harness-profiles`, {
  overlay: '第二版 overlay（回滚演练）。',
  pins: [first.id],
})).data?.profile
await api('POST', `/api/workshop/channels/${A.channelId}/harness-profiles/promote`, { profileId: prof2.id, to: 'shadow' })
await api('POST', `/api/workshop/channels/${A.channelId}/harness-profiles/promote`, {
  profileId: prof2.id, to: 'active', bench: { pValue: bench.pValue, primaryDelta: bench.primaryDelta, costDelta: bench.costDelta },
})
const rb = await api('POST', `/api/workshop/channels/${A.channelId}/harness-profiles/promote`, { rollback: true })
const activeAfter = (await api('GET', `/api/workshop/channels/${A.channelId}/harness-profiles`, undefined)).data?.active
ok('R9', 'B4 回滚：v2 → rollback 恢复 v1（单 active）',
  rb.data?.ok === true && activeAfter?.id === prof.id,
  `rollback=${rb.data?.ok} active=v${activeAfter?.version}`)

state.rsi = { experienceId: first.id, mergedTaskIds, profileId: prof.id, task2: t2, results }
writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
const pass = results.filter(r => r.pass).length
console.log(`\n=== RSI EVOLUTION  pass=${pass}/${results.length} ===`)
DB.close()
if (pass < results.length) process.exitCode = 1
