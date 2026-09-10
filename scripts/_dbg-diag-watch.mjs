/**
 * 真实诊断完成观察器:轮询 3210 run 状态 → completed 后等 diag-bridge 入库 → kb_search 命中断言。
 * 用法:NO_PROXY='*' node scripts/_dbg-diag-watch.mjs [runId]
 */
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const DIAG = 'http://127.0.0.1:3210'
const RUN = process.argv[2] ?? '69e8c225'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let fail = 0
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✔' : '✘'} ${label}${detail ? ` —— ${detail}` : ''}`)
  if (!cond) fail++
}

// 插件出站 token(runtime-settings.json)
const overrides = JSON.parse(readFileSync(resolve('.AgentWorkShop/runtime-settings.json'), 'utf8')).overrides ?? {}
const DT = overrides['plugins.diag-bridge.token'] ?? ''

// e2e 用户 token(注册临时)
const reg = await fetch(`${BASE}/api/workshop/users/register`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: `diagwatch-${Date.now().toString(36)}` }),
}).then(r => r.json()).catch(() => null)
const userToken = reg?.data?.token ?? ''
if (!userToken) { console.error('no user token'); process.exit(2) }

// 找一个启用的 omp 成员经 REST invoke 工具(kb_search 为插件工具,任意成员皆可承载;
// 频道归属隔离 → 直接读 channel_agents 表)
import { DatabaseSync } from 'node:sqlite'
const wsdb = new DatabaseSync(join(resolve('.AgentWorkShop', 'data', 'workshop.sqlite')), { readOnly: true })
wsdb.exec('PRAGMA busy_timeout=4000')
const row = wsdb.prepare(`SELECT id, channel_id AS channelId, name, token FROM channel_agents
  WHERE harness = 'omp' AND enabled = 1 ORDER BY created_at DESC LIMIT 1`).get() ?? null
wsdb.close()
if (!row) { console.error('no omp member in channel_agents'); process.exit(2) }
const invoker = { id: row.id, channel: row.channelId, name: row.name, token: row.token }
console.log(`  · invoker=${invoker.name} (channel ${invoker.channel.slice(0, 8)})`)

const invoke = async (tool, args, timeoutMs = 60000) => {
  const res = await fetch(`${BASE}/api/workshop/agent-tools/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aw-agent-token': invoker.token },
    body: JSON.stringify({ agentId: invoker.id, tool, args }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(e => null)
  const j = res ? await res.json().catch(() => null) : null
  return String(j?.data?.result?.text ?? j?.result?.text ?? JSON.stringify(j)?.slice(0, 200))
}

// ── 轮询诊断状态(直连 3210,不依赖 AW 存活)──
const direct = async () => {
  const res = await fetch(`${DIAG}/api/diagnosis/status/${RUN}`, { headers: { authorization: `Bearer ${DT}` }, signal: AbortSignal.timeout(15000) }).catch(() => null)
  return res ? res.json().catch(() => null) : null
}
let st = null
for (let i = 0; i < 60; i++) { // 最多 60 分钟
  const j = await direct()
  st = j?.data ?? {}
  const s = st.engineStatus || st.status
  console.log(`  [${new Date().toLocaleTimeString('zh-CN')}] status=${s} score=${st.score ?? '-'}`)
  if (s === 'completed' || s === 'failed' || s === 'stopped') break
  await sleep(60_000)
}
const finalStatus = st.engineStatus || st.status
ok(finalStatus === 'completed', '真实 omp 诊断跑至 completed', `status=${finalStatus} score=${st.score ?? '-'} verdict=${st.judge_verdict ?? '-'}`)

if (finalStatus === 'completed') {
  // 等 diag-bridge 轮询器(15s)发现完成并入库(报告拉取+文档+索引+经验)
  let stored = false
  for (let i = 0; i < 24 && !stored; i++) {
    await sleep(10_000)
    const runs = await fetch(`${BASE}/api/plugins/diag-bridge/runs`, { headers: { authorization: `Bearer ${userToken}` } })
      .then(r => r.json()).catch(() => null)
    const mine = (runs?.runs ?? []).find(x => x.runId === RUN)
    if (mine?.stored === true) { stored = true; break }
    if (i % 6 === 5) console.log(`  … 等待入库(${(i + 1) * 10}s)`)
  }
  ok(stored, 'diag-bridge 自动入库完成(报告→文档→索引→经验)')

  // kb_search 命中报告独特内容(用报告 judge 结论关键词)
  let hit = ''
  for (let i = 0; i < 8; i++) {
    await sleep(5000)
    const s = await invoke('kb_search', { query: `${RUN.slice(0, 8)} 深度根因诊断 judge 结论` }, 60000)
    hit = s
    if (!s.startsWith('未检索到')) break
  }
  ok(!hit.startsWith('未检索到') && hit.length > 0, 'kb_search 检索到诊断报告/经验', hit.split('\n')[1]?.slice(0, 100) ?? hit.slice(0, 100))
}

console.log(fail === 0 ? '\n★ 诊断长链 ALL PASS' : `\n✘ ${fail} 项失败`)
process.exit(fail > 0 ? 1 : 0)
