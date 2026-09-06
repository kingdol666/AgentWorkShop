// 验收阶段4:多 Harness 团队 + 设备绑定 + 极简任务
// 用法:node scripts/_dbg-acc-4-team.mjs <base> <user> <pass>
import { mkdirSync } from 'node:fs'
const BASE = process.argv[2] ?? 'http://127.0.0.1:3021'
const [USER, PASS] = [process.argv[3], process.argv[4]]
mkdirSync('.e2e-shots', { recursive: true })
const stamp = Date.now().toString(36)

const api = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { 'content-type': 'application/json', ...opts.headers } })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const login = await api('/api/users/login', { method: 'POST', body: JSON.stringify({ email: `${USER}@awshop.local`, password: PASS }) })
const H = { authorization: `Bearer ${login.body.data.token}`, 'content-type': 'application/json' }
const post = (p, b) => api(p, { method: 'POST', headers: H, body: JSON.stringify(b) })

// 1) 三个不同 harness 的 agent 模板
const mk = async (name, harness) => {
  const r = await post('/api/workshop/agents', { name, harness, visibility: 'private' })
  if (r.status !== 0 && r.body?.code !== 0) throw new Error(`建 agent ${name}: ${JSON.stringify(r.body)}`)
  console.log(`✔ agent 模板 ${name} harness=${harness} id=${r.body.data.id.slice(0, 10)}`)
  return r.body.data
}
const leadTpl = await mk(`acc-lead-${stamp}`, 'omp')
const wMock = await mk(`acc-w-mock-${stamp}`, 'mock')
const wCodex = await mk(`acc-w-codex-${stamp}`, 'codex')

// 2) team + 成员
const team = await post('/api/workshop/teams', { name: `验收团队-${stamp}`, description: '多 harness 验收' })
const teamId = team.body.data.id
console.log('✔ team 创建', teamId.slice(0, 10))
for (const [tpl, role] of [[leadTpl, 'lead'], [wMock, 'worker'], [wCodex, 'worker']]) {
  const r = await post(`/api/workshop/teams/${teamId}/members`, { agentId: tpl.id, role })
  console.log(`${r.body?.code === 0 ? '✔' : '✖'} member ${tpl.name} role=${role}`, r.body?.code === 0 ? '' : JSON.stringify(r.body))
}

// 3) channel(不带 lead,由 deploy 带入) + deploy
const ch = await post('/api/workshop/channels', { name: `验收频道-${stamp}`, description: '多 harness 团队验收' })
const channelId = ch.body.data.channelId ?? ch.body.data.id
console.log('✔ channel 创建', channelId.slice(0, 10))
const dep = await post(`/api/workshop/teams/${teamId}/deploy`, { channelId })
if (dep.body?.code !== 0) { console.error('✖ deploy 失败:', JSON.stringify(dep.body)); process.exit(1) }
const deployed = dep.body.data
console.log('✔ team 部署到 channel:', JSON.stringify(deployed).slice(0, 200))

// 部署后实例 id(克隆体):channel agents 列表
const ags = await api(`/api/workshop/channels/${channelId}/agents`, { headers: H })
const chanAgents = ags.body?.data ?? []
const find = (harness) => chanAgents.find(a => a.harness === harness)
const leadInst = find('omp')
const mockInst = find('mock')
const codexInst = find('codex')
console.log('实例:', [leadInst, mockInst, codexInst].map(a => a ? `${a.name}(${a.harness})=${a.id.slice(0, 10)}` : '(缺)').join(' '))

// 4) 设备绑定:worker ↔ daq 节点 / worker ↔ dcw 写控节点
for (const [inst, nodeId, kind] of [[mockInst, 'dn-43f55a32', 'daq'], [codexInst, 'dw-322b1978', 'dcw']]) {
  if (!inst) { console.log(`✖ 绑定跳过:实例缺失 kind=${kind}`); continue }
  const r = await post('/api/workshop/agent-tools/bindings', { agentId: inst.id, nodeId, kind, mode: 'auto' })
  console.log(`${r.body?.code === 0 ? '✔' : '✖'} 绑定 ${inst.name}(${kind}) ↔ ${nodeId}`, r.body?.code === 0 ? '' : JSON.stringify(r.body))
}
const bl = await api('/api/workshop/agent-tools/bindings', { headers: H })
const mine = (bl.body?.data?.bindings ?? []).filter(b => [mockInst?.id, codexInst?.id].includes(b.agentId))
console.log(`✔ 绑定清单(${mine.length} 条新建):`, mine.map(b => `${b.kind}:${b.nodeId}`).join(', '))

// 5) 极简任务(省 token):发消息给 lead,要求派发给各 worker 单句回复
const msg = await post(`/api/workshop/channels/${channelId}/messages`, {
  toAgentId: leadInst?.id,
  text: '团队自检任务:请把下面这句话原样转交给每个 worker 执行——「用一句不超过 15 字的话报告你的引擎名并说 ok,不要调用任何工具」。收齐后向人类汇总。',
  fromLabel: 'admin',
  priority: 'task',
})
console.log(`${msg.body?.code === 0 ? '✔' : '✖'} 任务消息下发`, msg.body?.code === 0 ? '' : JSON.stringify(msg.body))

// 6) 轮询 channel 消息(最多 90s),统计各 harness 回复
console.log('等待 worker 回复(轮询 90s)...')
const seen = new Map()
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 3000))
  const ms = await api(`/api/workshop/channels/${channelId}/messages?limit=50`, { headers: H })
  const items = ms.body?.data?.items ?? ms.body?.data ?? []
  for (const m of (Array.isArray(items) ? items : [])) {
    if (i === 0 && seen.size === 0) console.log('  [msg 样例]', JSON.stringify(m).slice(0, 220))
    const from = m.fromAgentName ?? m.fromAgentId ?? m.from ?? '?'
    if (!seen.has(from)) seen.set(from, String(m.text ?? '').slice(0, 60))
  }
  const harnessHits = ['mock', 'omp', 'codex'].filter(h => [...seen.keys()].some(k => String(k).toLowerCase().includes(h)) || [...seen.values()].some(v => v.toLowerCase().includes(h)))
  process.stdout.write(`  t=${(i + 1) * 3}s 发言者=${seen.size} 命中=${harnessHits.join(',')}\r`)
  if (harnessHits.length >= 2 && seen.size >= 3) break
}
console.log('')
for (const [k, v] of seen) console.log(`  [${k}] ${v}`)
console.log('CHANNEL_ID=' + channelId)
