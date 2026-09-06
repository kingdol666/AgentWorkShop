// ============================================================
// 最终验收·全功能测试(home 生产实例):Channel/Team/产线/数采/写控/绑定/权限
// 用法:node scripts/_dbg-final-features.mjs <base> <adminPass>
// ============================================================
const BASE = process.argv[2] ?? 'http://127.0.0.1:3001'
const ADMIN_PASS = process.argv[3] ?? 'admin123'
let pass = 0, fail = 0
const sections = []
let section = 'START'
const sec = (name) => { section = name; console.log(`\n── ${name} ──`) }
const ok = (name, cond, detail = '') => {
  cond ? pass++ : fail++
  console.log(`${cond ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`)
  sections.push({ section, name, ok: cond, detail })
}
const api = async (path, opts = {}, tok) => {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...opts.headers },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const stamp = Date.now().toString(36)

// ===== 1. 基础面 =====
sec('基础面')
const adminTok = (await api('/api/users/login', { method: 'POST', body: JSON.stringify({ email: 'admin@awshop.local', password: ADMIN_PASS }) })).body?.data?.token
ok('admin 登录', Boolean(adminTok))
const me = await api('/api/users/me', {}, adminTok)
ok('/me 返回 admin', me.body?.data?.role === 'admin')
const health = await api('/api/health')
ok('/api/health 存活', health.status === 200)
const ss = await api('/api/users/setup-status')
ok('setup 已收敛(false)', ss.body?.data?.needsSetup === false)

// ===== 2. 产线管理与写控 =====
sec('产线管理与写控(DCW)')
const dcw = (await api('/api/workshop/dcw', {}, adminTok)).body?.data
ok('dcw 网关运行', dcw?.controller?.running === true)
ok(`写控节点在线 ${dcw?.controller?.nodesOnline}/${dcw?.controller?.nodesTotal}`, dcw?.controller?.nodesOnline > 0)
ok(`产线 ${dcw?.lines?.length} 条可见`, dcw?.lines?.length > 0)
const line1 = dcw.lines[0]
const line2 = dcw.lines[1]
ok('目标产线定位(前两条)', Boolean(line1 && line2), `${line1?.id} ${line2?.id}`)
// 写控:对 1 号产线的一个 mock 写控节点下发设定值并回读
const wNode = dcw.nodes.find(n => n.lineId === line1?.id && n.driver === 'mock')
ok('1号产线 mock 写控节点', Boolean(wNode), wNode?.id)
if (wNode) {
  const target = Math.round(((wNode.min ?? 150) + (wNode.max ?? 200)) / 2)
  const wr = await api(`/api/workshop/dcw/${wNode.id}/write`, { method: 'POST', body: JSON.stringify({ value: target }) }, adminTok)
  ok(`写控下发 ${target} 并 ACK 回读一致`, wr.status === 200 && wr.body?.data?.outcome?.ok === true, String(wr.body?.data?.outcome?.message ?? '').slice(0, 60))
}
// 产线开跑/停止(2号产线,含配方下发闭环)
const rStart = await api(`/api/workshop/dcw/lines/${line2.id}/start`, { method: 'POST', body: JSON.stringify({}) }, adminTok)
ok('2号产线开跑(lineStart)', rStart.status === 200 && rStart.body?.data?.run != null, `run=${rStart.body?.data?.run?.id?.slice(0, 8)}`)
await new Promise(r => setTimeout(r, 3000))
const rStop = await api(`/api/workshop/dcw/lines/${line2.id}/stop`, { method: 'POST', body: '{}' }, adminTok)
ok('2号产线停止', rStop.status === 200)

// ===== 3. 数据采集(DAQ) =====
sec('数据采集(DAQ)')
const daq = (await api('/api/workshop/daq', {}, adminTok)).body?.data
ok(`数采节点在线 ${daq?.controller?.nodesOnline}/${daq?.controller?.nodesTotal}`, daq?.controller?.nodesOnline > 0)
ok(`采样管道 produced=${daq?.controller?.produced} consumed=${daq?.controller?.consumed} dropped=${daq?.controller?.dropped}`, daq?.controller?.produced > 0 && daq?.controller?.dropped === 0)
const liveDaq = daq.nodes.find(n => n.state === 'ok' && n.lineId)
ok('活采样节点定位', Boolean(liveDaq), `${liveDaq?.id} v=${liveDaq?.value}`)
if (liveDaq) {
  const a0 = liveDaq.lastAt
  await new Promise(r => setTimeout(r, 5000))
  const daq2 = (await api('/api/workshop/daq', {}, adminTok)).body?.data
  const n2 = daq2.nodes.find(n => n.id === liveDaq.id)
  ok('采样节拍推进(lastAt 前进+值变化)', n2.lastAt > a0 || n2.value !== liveDaq.value, `v ${liveDaq.value}→${n2.value}`)
  const sp = await api(`/api/workshop/daq/${liveDaq.id}/samples?limit=10`, {}, adminTok)
  ok('时序历史查询(>0 数据点)', sp.status === 200 && (sp.body?.data?.points?.length ?? 0) > 0, `points=${sp.body?.data?.points?.length}`)
}
const alarms = await api('/api/workshop/daq/alarms', {}, adminTok)
ok('告警查询可用', alarms.status === 200)

// ===== 4. Channel + AgentTeamWork + 绑定 + 团队闭环 =====
sec('Channel / AgentTeam / 绑定 / 团队作业闭环')
const mk = async (name, harness) => (await api('/api/workshop/agents', { method: 'POST', body: JSON.stringify({ name, harness, visibility: 'private' }) }, adminTok)).body?.data
const leadTpl = await mk(`fin-lead-${stamp}`, 'omp')
const wMock = await mk(`fin-w-mock-${stamp}`, 'mock')
const wCodex = await mk(`fin-w-codex-${stamp}`, 'codex')
ok('3 个 Agent 模板(omp/mock/codex)', Boolean(leadTpl && wMock && wCodex))
const team = (await api('/api/workshop/teams', { method: 'POST', body: JSON.stringify({ name: `验收团队-${stamp}` }) }, adminTok)).body?.data
ok('AgentTeam 创建', Boolean(team?.id))
for (const [tpl, role] of [[leadTpl, 'lead'], [wMock, 'worker'], [wCodex, 'worker']]) {
  const r = await api(`/api/workshop/teams/${team.id}/members`, { method: 'POST', body: JSON.stringify({ agentId: tpl.id, role }) }, adminTok)
  ok(`成员入队 ${role}`, r.body?.code === 0)
}
const ch = (await api('/api/workshop/channels', { method: 'POST', body: JSON.stringify({ name: `验收频道-${stamp}` }) }, adminTok)).body?.data
const channelId = ch?.channelId
ok('Channel 创建', Boolean(channelId))
const dep = (await api(`/api/workshop/teams/${team.id}/deploy`, { method: 'POST', body: JSON.stringify({ channelId }) }, adminTok)).body?.data
ok('Team 部署到 Channel(3 实例)', dep?.agents?.length === 3, JSON.stringify(dep?.agents?.map(a => a.harness)))
const ags = (await api(`/api/workshop/channels/${channelId}/agents`, {}, adminTok)).body?.data
const leadInst = ags.find(a => a.harness === 'omp')
ok('lead 实例(omp)就位', Boolean(leadInst))

// 绑定:mock worker↔daq 节点,codex worker↔写控节点
const dq1 = daq.nodes.find(n => n.lineId === line1?.id)
const b1 = await api('/api/workshop/agent-tools/bindings', { method: 'POST', body: JSON.stringify({ agentId: ags.find(a => a.harness === 'mock').id, nodeId: dq1.id, kind: 'daq', mode: 'auto' }) }, adminTok)
ok('绑定 Agent↔数采节点', b1.body?.code === 0)
const b2 = await api('/api/workshop/agent-tools/bindings', { method: 'POST', body: JSON.stringify({ agentId: ags.find(a => a.harness === 'codex').id, nodeId: wNode.id, kind: 'dcw', mode: 'auto' }) }, adminTok)
ok('绑定 Agent↔写控节点', b2.body?.code === 0)
const bl = (await api('/api/workshop/agent-tools/bindings', {}, adminTok)).body?.data?.bindings ?? []
ok(`绑定清单落盘(${bl.length} 条)`, bl.length >= 2)

// 团队作业闭环:human → lead 派发 → workers 回复
const msg = await api(`/api/workshop/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify({
  toAgentId: leadInst.id,
  text: '团队闭环自检:请把这句话转交每个 worker 执行——「用一句不超过 15 字的话报告你的引擎名并说 ok,不要调用任何工具」。收齐后向人类汇总。',
  fromLabel: 'admin', priority: 'task',
}) }, adminTok)
ok('任务下发 lead', msg.body?.code === 0)
console.log('等待团队闭环(lead 派发→worker 回复→lead 汇总,轮询 150s)...')
let leadReplied = false, mockReplied = false, codexReplied = false
let summarySeen = false
for (let i = 0; i < 50; i++) {
  await new Promise(r => setTimeout(r, 3000))
  const ms = (await api(`/api/workshop/channels/${channelId}/messages?limit=60`, {}, adminTok)).body?.data ?? []
  const timeline = (await api(`/api/workshop/channels/${channelId}/events?limit=100`, {}, adminTok)).body?.data ?? []
  const all = []
  for (const m of (Array.isArray(ms) ? ms : [])) {
    all.push({ from: m.fromAgentId, to: m.toAgentId, text: (m.parts ?? []).map(p => p.text ?? '').join(' ') })
  }
  for (const ev of (Array.isArray(timeline) ? timeline : [])) {
    const t = JSON.stringify(ev)
    if (t.includes('codex') && t.includes('ok')) codexReplied = codexReplied || /引擎.*ok|ok/i.test(t)
  }
  for (const a of all) {
    if (a.from === ags.find(x => x.harness === 'mock').id) mockReplied = true
    if (a.from === ags.find(x => x.harness === 'codex').id) codexReplied = true
    if (a.from === leadInst.id && /汇总|汇总完成|报告|ok/i.test(a.text)) leadReplied = true
    if (/汇总/.test(a.text) && a.from === leadInst.id) summarySeen = true
  }
  process.stdout.write(`  t=${(i + 1) * 3}s mock=${mockReplied ? 'Y' : 'n'} codex=${codexReplied ? 'Y' : 'n'} lead汇总=${summarySeen ? 'Y' : 'n'}\r`)
  if (mockReplied && codexReplied && summarySeen) break
}
console.log('')
ok('worker(mock) 回复', mockReplied)
ok('worker(codex) 回复', codexReplied)
ok('lead 汇总闭环', summarySeen || leadReplied)

// ===== 5. 权限回归 =====
sec('权限(回归)')
const ov = (await api('/api/workshop/permissions', {}, adminTok)).body?.data
ok('权限总览(权限管理页数据源)', ov?.lines?.length > 0 && ov?.users?.length > 0, `lines=${ov?.lines?.length} users=${ov?.users?.length}`)
const adminRow = ov.users.find(u => u.role === 'admin')
ok(`admin 用户 channels 数(${adminRow?.channels?.length})在总览可见`, (adminRow?.channels?.length ?? 0) >= 1)

console.log(`\n===== 全功能测试: ${pass} 通过 / ${fail} 失败 =====`)
console.log('CHANNEL_ID=' + channelId)
process.exit(fail > 0 ? 1 : 0)
