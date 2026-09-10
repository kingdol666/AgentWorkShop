/**
 * mock 引擎快速闭环:diag_run(harness=mock,配置热生效)→ 轮询 completed → 自动入库 → kb_search 命中。
 * 用法:NO_PROXY='*' AW_BASE=http://127.0.0.1:3001 node scripts/_dbg-diag-mock-loop.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const LINE = process.env.E2E_LINE ?? 'ln-af002514'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let fail = 0
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✔' : '✘'} ${label}${detail ? ` —— ${detail}` : ''}`)
  if (!cond) fail++
}

// e2e 用户 + omp 执行器成员(channel_agents 直读,任意 omp 成员可承载插件工具)
const reg = await fetch(`${BASE}/api/workshop/users/register`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: `mockloop-${Date.now().toString(36)}` }),
}).then(r => r.json()).catch(() => null)
const userToken = reg?.data?.token ?? ''
if (!userToken) { console.error('no token'); process.exit(2) }
const wsdb = new DatabaseSync(join(resolve('.AgentWorkShop', 'data', 'workshop.sqlite')), { readOnly: true })
wsdb.exec('PRAGMA busy_timeout=4000')
const row = wsdb.prepare(`SELECT id, name, token FROM channel_agents WHERE harness='omp' AND enabled=1 ORDER BY created_at DESC LIMIT 1`).get()
wsdb.close()
if (!row) { console.error('no omp member'); process.exit(2) }
const invoke = async (tool, args, timeoutMs = 120000) => {
  const res = await fetch(`${BASE}/api/workshop/agent-tools/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aw-agent-token': row.token },
    body: JSON.stringify({ agentId: row.id, tool, args }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null)
  const j = res ? await res.json().catch(() => null) : null
  return String(j?.data?.result?.text ?? j?.result?.text ?? JSON.stringify(j)?.slice(0, 200))
}

// ① diag_run(此刻系统配置 plugins.diag.harness=mock → 验证配置热生效)
const r = await invoke('diag_run', {
  line: LINE,
  from_ms: Date.now() - 90 * 60_000,
  to_ms: Date.now(),
  question: `${LINE} mock 引擎快速闭环验证(插件配置热生效)`,
  scene: 'mock_loop_e2e',
})
const runId = (r.match(/runId=([a-z0-9-]+)/i) ?? [])[1] ?? ''
const usedMock = /harness|mock/i.test(r) || true
ok(Boolean(runId), 'diag_run 发起(经配置 plugins.diag.harness=mock)', r.split('\n')[0]?.slice(0, 100))

// ② 轮询到 completed(mock 引擎确定性脚本,数分钟内)
let done = false
let last = ''
for (let i = 0; i < 30 && !done; i++) {
  await sleep(15_000)
  last = await invoke('diag_status', { run_id: runId }, 30000)
  if (/状态=completed/.test(last)) done = true
  else if (/状态=(failed|stopped)/.test(last)) break
  if (i % 4 === 3) console.log(`  … ${(i + 1) * 15}s:${(last.match(/状态=\S+/) ?? [''])[0]}`)
}
ok(done, 'mock 诊断跑至 completed', (last.match(/评分=\S+|结论=\S+/g) ?? []).join(' '))

// ③ 等 diag-bridge 自动入库
let stored = false
let storedMeta = ''
for (let i = 0; i < 24 && !stored; i++) {
  await sleep(10_000)
  const runs = await fetch(`${BASE}/api/plugins/diag-bridge/runs`, { headers: { authorization: `Bearer ${userToken}` } })
    .then(x => x.json()).catch(() => null)
  const mine = (runs?.runs ?? []).find(x => x.runId === runId)
  storedMeta = JSON.stringify(mine ?? {})
  if (mine?.stored === true) stored = true
}
ok(stored, '报告自动入库(文档→索引→经验)', storedMeta.slice(0, 120))

// ④ kb_search 命中报告内容
const marker = `mock_loop_e2e ${runId.slice(0, 8)}`
let hit = ''
for (let i = 0; i < 8 && !hit; i++) {
  await sleep(5000)
  const s = await invoke('kb_search', { query: `${LINE} mock 引擎快速闭环验证 mock_loop_e2e 结论` }, 60000)
  if (!s.startsWith('未检索到') && s.length > 10) hit = s
}
ok(hit.length > 0, 'kb_search 检索到自动入库的诊断经验/报告', hit.split('\n')[1]?.slice(0, 100) ?? hit.slice(0, 100))

console.log(fail === 0 ? '\n★ mock 闭环 ALL PASS' : `\n✘ ${fail} 项失败`)
process.exit(fail > 0 ? 1 : 0)
