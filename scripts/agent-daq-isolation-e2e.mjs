/**
 * Agent 专属 DAQ 隔离对照：不绑线的 Channel 内，两个 Agent 各绑不同节点，
 * 验证 daq_query 只返回自己的绑定节点、调用他人节点被拒。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const c = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const EVID = join(REPO, 'docs', 'audit', '2026-10-21-full-function-evidence')
mkdirSync(EVID, { recursive: true })
const results = []
function ok(id, name, cond, detail = '') {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 600) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`)
}
async function api(method, path, body, token = c.adminToken) {
  const r = await fetch(c.base + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  return { status: r.status, ...(await r.json().catch(() => ({}))) }
}
async function invoke(agent, tool, args) {
  const r = await fetch(c.base + '/api/workshop/agent-tools/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aw-agent-token': agent.token },
    body: JSON.stringify({ agentId: agent.id, tool, args }),
    signal: AbortSignal.timeout(90_000),
  })
  const j = await r.json().catch(() => null)
  return { isError: Boolean(j?.data?.result?.isError), text: String(j?.data?.result?.text ?? '') }
}

async function main() {
  console.log(`━━━ Agent DAQ 隔离对照 @ ${c.base} ━━━`)
  const daq = Object.values(c.daq ?? {})
  if (daq.length < 2) throw new Error('需要至少 2 个 DAQ 节点')
  const aNode = daq[0]
  const bNode = daq[1]
  // 注意：刻意不传 lineId —— 无频道绑线扩权，只剩 Agent 直接绑定面
  const ch = await api('POST', '/api/workshop/channels', {
    name: `agent-daq-isolation-${Date.now().toString(36).slice(-5)}`,
    leadAgent: { name: 'iso-lead', harness: 'mock' },
  })
  const channelId = ch?.data?.channelId
  ok('D0', '无绑线隔离 Channel 创建', Boolean(channelId), `lineId=${ch?.data?.lineId ?? '(empty)'}`)
  if (!channelId) return finish({})
  const a = (await api('POST', `/api/workshop/channels/${channelId}/agents`, { name: 'iso-a', harness: 'mock', role: 'worker' })).data
  const b = (await api('POST', `/api/workshop/channels/${channelId}/agents`, { name: 'iso-b', harness: 'omp', role: 'worker' })).data
  const rows = (await api('GET', `/api/workshop/channels/${channelId}/agents`))?.data ?? []
  const list = Array.isArray(rows) ? rows : (rows.agents ?? [])
  const agentA = list.find(x => x.id === a?.id) ?? a
  const agentB = list.find(x => x.id === b?.id) ?? b
  ok('D1', '两个成员创建且有 token', Boolean(agentA?.token && agentB?.token), `${agentA?.id?.slice(0, 8)}/${agentB?.id?.slice(0, 8)}`)
  await api('POST', '/api/workshop/agent-tools/bindings', { agentId: agentA.id, nodeId: aNode, kind: 'daq', mode: 'auto' })
  await api('POST', '/api/workshop/agent-tools/bindings', { agentId: agentB.id, nodeId: bNode, kind: 'daq', mode: 'auto' })
  const la = await api('GET', `/api/workshop/agent-tools/list?agentId=${agentA.id}`)
  const lb = await api('GET', `/api/workshop/agent-tools/list?agentId=${agentB.id}`)
  const da = (la?.data?.tools ?? []).find(t => t.name === 'daq_query')?.description ?? ''
  const db = (lb?.data?.tools ?? []).find(t => t.name === 'daq_query')?.description ?? ''
  ok('D2', 'A 描述只含自己的节点', da.includes(aNode) && !da.includes(bNode), `own=${aNode} other=${bNode}`)
  ok('D3', 'B 描述只含自己的节点', db.includes(bNode) && !db.includes(aNode), `own=${bNode} other=${aNode}`)

  const ra = await invoke(agentA, 'daq_query', { last_minutes: 1, limit: 5 })
  const rb = await invoke(agentB, 'daq_query', { last_minutes: 1, limit: 5 })
  const countA = Number((ra.text.match(/数采数据查询结果\((\d+) 个节点/) ?? [])[1])
  const countB = Number((rb.text.match(/数采数据查询结果\((\d+) 个节点/) ?? [])[1])
  ok('D4', 'A 查询只覆盖 1 个绑定节点', !ra.isError && countA === 1, ra.text.slice(0, 260))
  ok('D5', 'B 查询只覆盖 1 个绑定节点', !rb.isError && countB === 1, rb.text.slice(0, 260))
  const cross = await invoke(agentA, 'daq_query', { node_id: bNode, last_minutes: 1, limit: 5 })
  ok('D6', 'A 调 B 的节点被拒', cross.isError && /未绑定|不在|可读|越权|拒绝|不可/.test(cross.text), cross.text.slice(0, 260))

  const ev = { at: new Date().toISOString(), channelId, lineBound: Boolean(ch?.data?.lineId), aNode, bNode, agentA: agentA.id, agentB: agentB.id, countA, countB, cross: cross.text.slice(0, 500), results }
  writeFileSync(join(EVID, 'agent-daq-isolation.json'), JSON.stringify(ev, null, 2))
  return finish(ev)
}
function finish(ev) {
  const pass = results.filter(r => r.pass).length
  writeFileSync(join(EVID, 'agent-daq-isolation-summary.json'), JSON.stringify({ at: new Date().toISOString(), pass, fail: results.length - pass, results, ev }, null, 2))
  console.log(`\n═══ Agent DAQ 隔离: ${pass}/${results.length} PASS ═══`)
  if (pass !== results.length) process.exitCode = 1
}
main().catch((e) => {
  console.error(e)
  ok('D-ERR', '脚本未抛异常', false, e.message)
  finish({})
})
