/**
 * RSI 越用越聪明验证轮：重启后持久性 + 新真实任务自动沉淀 + 注入对照（A 有 profile vs B 无）。
 * 用法：node scripts/_live-rsi-smarter-check.mjs
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
const A = state.channels.A
const B = state.channels.B
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? 'PASS' : 'FAIL'} ${id} — ${name}${detail ? ` · ${String(detail).slice(0, 200)}` : ''}`)
}
const api = async (method, path, body, timeoutMs = 120_000) => {
  const r = await fetch(BASE + path, {
    method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
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

try {
  // ── S1 重启持久性（经验/Profile/版本链）──
  const profA = (await api('GET', `/api/workshop/channels/${A.channelId}/harness-profiles`)).data
  const expA = DB.prepare(`SELECT count(*) n FROM agent_memories WHERE channel_id = ? AND kind='experience'`).get(A.channelId).n
  ok('S1', '重启后持久性：Profile v3 active + 经验全部还在',
    profA.active?.version === 3 && profA.active?.status === 'active' && expA >= 3,
    `active=v${profA.active?.version} exp=${expA} preview=${profA.preview?.length}c`)

  // ── S2 注入对照：A（有 active profile+绑线）vs B（同产线但无 profile）──
  const profB = (await api('GET', `/api/workshop/channels/${B.channelId}/harness-profiles`)).data
  ok('S2', '注入对照：A 注入经验+隔离声明 / B（无 profile）空串=零改动',
    typeof profA.preview === 'string' && profA.preview.includes('不是指令覆盖') && profA.preview.includes('WWTP aeration')
    && (profB.preview ?? '') === '',
    `A=${profA.preview?.length}c B=${JSON.stringify(profB.preview ?? '')}`)

  // ── S3 第三个真实任务（deepseek-flash；Agent 的 contextPrefix 此刻含 validated 经验）──
  const t3 = (await api('POST', `/api/workshop/channels/${A.channelId}/tasks`, {
    title: `WWTP compliance check ${Date.now().toString(36).slice(-4)}`,
    description: 'Check current effluent quality: use daq_query on the effluent nodes and verify COD<50, NH3<5, TP<0.5. Complete with one artifact summarizing compliance.',
    assigneeId: A.workerId,
    mode: 'goal',
    modeConfig: { completionPolicy: 'no-deliverable' },
  })).data?.id
  console.log(`task3=${t3}`)
  const st3 = await waitTask(t3)
  ok('S3', '第三个真实 LLM 任务完成（Profile v3 已在注入面）', st3 === 'COMPLETED', `state=${st3}`)

  // ── S4 自动沉淀：任务终态 → 新经验（candidate，带 T3 证据）──
  const rows = DB.prepare(`SELECT id, title, status, scope_kind AS scopeKind, evidence_json AS ev FROM agent_memories
    WHERE channel_id = ? AND kind='experience' AND dedup_key = ?`).get(A.channelId, `exp:task:${t3}`)
  ok('S4', '越用越多：新任务终态自动沉淀第 4 条经验（反射器）',
    Boolean(rows?.id) && rows.status === 'candidate' && rows.scopeKind === state.line.lineId
    && JSON.parse(rows.ev || '{}').taskIds?.[0] === t3,
    rows ? `${rows.title.slice(0, 40)} status=${rows.status}` : '未落行')

  // ── S5 看板与元层同步增长 ──
  const stats = (await api('GET', `/api/workshop/channels/${A.channelId}/memories/experience-stats`)).data
  const imp = (await api('GET', `/api/workshop/channels/${A.channelId}/improvement-stats`)).data
  ok('S5', '经验看板与元层成效同步（total/byStatus/improvement 动作）',
    stats?.total >= 4 && (imp.stats ?? []).some(s => s.actionKind === 'experience_promote'),
    `total=${stats?.total} byStatus=${JSON.stringify(stats?.byStatus)} impKinds=${(imp.stats ?? []).map(s => s.actionKind).join(',')}`)

  state.smarter = { t3, expTotal: stats.total, results }
  writeFileSync(join(REPO, '.rsi-demo-state.json'), JSON.stringify(state, null, 2))
} catch (err) {
  ok('HALT', '验证轮未完成', false, err instanceof Error ? err.message.slice(0, 300) : String(err))
} finally {
  const pass = results.filter(r => r.pass).length
  console.log(`\n=== SMARTER CHECK  pass=${pass}/${results.length} ===`)
  DB.close()
}
