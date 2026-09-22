/** 闭环寻优场景:cast-film-physics 产线(次优起点 h≈53.8μm)+6 写控+4 数采+优化团队 */
const BASE = 'http://127.0.0.1:3001'
const SIM = 'http://127.0.0.1:4010'
const tag = 'cf' + Math.random().toString(36).slice(2, 5)
const login = await fetch(BASE + '/api/users/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }) }).then(r => r.json())
const H = { 'content-type': 'application/json', authorization: `Bearer ${login.data.token}` }
const api = async (m, p, b) => (await fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined })).json()
const sim = async (m, p) => (await fetch(SIM + p, { method: m, headers: { 'content-type': 'application/json' } })).json()

// ① 切换 cast-film-physics 预设(次优起点:zone=200,N=150,v=95,gap=1.0 → h≈53.8μm 偏厚)
const apply = await sim('POST', '/api/presets/cast-film-physics')
const devices = (await sim('GET', '/api/nodes')).data ?? []
console.log('预设已应用,设备:', devices.map(d => d.name).join(' / '))

// ② 6 个写控点 → DCW 节点(权限窗=配方安全窗)
const SP_PLAN = [
  { dev: 'dev-extruder-mbtcp', sig: 'zone1-sp', unit: '℃', min: 150, max: 250, init: 200 },
  { dev: 'dev-extruder-mbtcp', sig: 'zone2-sp', unit: '℃', min: 150, max: 250, init: 200 },
  { dev: 'dev-extruder-mbtcp', sig: 'zone3-sp', unit: '℃', min: 150, max: 250, init: 200 },
  { dev: 'dev-extruder-opcua', sig: 'screw-sp', unit: 'rpm', min: 50, max: 200, init: 150 },
  { dev: 'dev-gauge-mqtt', sig: 'linespeed-sp', unit: 'm/min', min: 20, max: 120, init: 95 },
  { dev: 'dev-inspect-http', sig: 'diegap-sp', unit: 'mm', min: 0.5, max: 2.0, init: 1.0 },
]
const line = (await api('POST', '/api/workshop/dcw/lines', { name: `流延闭环寻优线-${tag}` })).data.line
const product = (await api('POST', '/api/workshop/dcw/products', { lineId: line.id, name: `流延产品-${tag}` })).data.product
const dcwIds = {}
for (const plan of SP_PLAN) {
  const dev = devices.find(d => d.id === plan.dev)
  const exp = (await sim('GET', `/api/nodes/${dev.id}/export`)).data
  const item = exp.items.find(i => i.signal === dev.signals.find(s => s.id === plan.sig)?.name)
  if (!item?.driverConfig) { console.error('导出缺', plan.sig); process.exit(1) }
  const dcw = (await api('POST', '/api/workshop/dcw', {
    templateRef: 'dcw-temp-sp', name: `${plan.sig}-${tag}`,
    driver: item.driver, driverConfig: item.driverConfig,
    unit: plan.unit, decimals: plan.sig === 'diegap-sp' ? 2 : (plan.sig === 'linespeed-sp' ? 0 : 1),
    min: plan.min, max: plan.max, readIntervalMs: 3000, lineId: line.id,
    semantics: `cast-film 物理引擎设定量 ${plan.sig}(治理写控)`,
  })).data.node
  dcwIds[plan.sig] = dcw.id
  console.log('DCW:', plan.sig, dcw.id)
}
// 配方窗(=权限窗)+ 初值 = 次优起点
const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
  productId: product.id, name: `寻优配方-${tag}`,
  params: SP_PLAN.map(p => ({ nodeId: dcwIds[p.sig], value: p.init, min: p.min, max: p.max })),
})).data.recipe
const st = (await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { recipeId: recipe.id }))
console.log('产线开跑:', !!st.data?.run?.id)

// ③ 检测面 → DAQ 节点(挂线,物理引擎实时产出)
const DAQ_PLAN = [
  { dev: 'dev-gauge-mqtt', sig: 'film-thickness', tpl: 'thickness-scan', unit: 'μm' },
  { dev: 'dev-extruder-mbtcp', sig: 'melt-temp', tpl: 'temp-tc', unit: '℃' },
  { dev: 'dev-extruder-opcua', sig: 'melt-pressure', tpl: 'pressure-tx', unit: 'MPa' },
  { dev: 'dev-inspect-http', sig: 'defect-rate', tpl: 'vision-cam', unit: '%' },
]
const daqIds = {}
for (const plan of DAQ_PLAN) {
  const dev = devices.find(d => d.id === plan.dev)
  const exp = (await sim('GET', `/api/nodes/${dev.id}/export`)).data
  const item = exp.items.find(i => i.signal === dev.signals.find(s => s.id === plan.sig)?.name)
  if (!item?.driverConfig) { console.error('导出缺', plan.sig); continue }
  const daq = (await api('POST', '/api/workshop/daq', {
    templateRef: plan.tpl, name: `${plan.sig}-${tag}`,
    driver: item.driver, driverConfig: item.driverConfig,
    unit: plan.unit, lineId: line.id, intervalMs: 2000, publishIntervalMs: 0,
  })).data.node
  daqIds[plan.sig] = daq.id
  console.log('DAQ:', plan.sig, daq.id)
}

// ④ 团队:优化总工 + 挤出工艺工程师(绑定全部写控与数采)
const ch = (await api('POST', '/api/workshop/channels', { name: `流延寻优工坊-${tag}`, scenarioPrompt: '本频道执行流延线厚度闭环寻优:所有决策必须基于 daq_query 实测数字与工艺机理,写入走 dcw_control(配方窗内),每轮迭代留痕。' })).data
const CH = ch?.channelId ?? ch?.id
const lead = (await api('POST', '/api/workshop/agents', {
  name: `优化总工-${tag}`, harness: 'omp',
  config: { intro: '寻优总工:派发/督办/验收', systemPromptPrefix: '你是优化总工。把寻优任务派给挤出工艺工程师;督办进度;收口前核对其数据链(测量→决策→写入→复测)。中文简短。' },
})).data
const worker = (await api('POST', '/api/workshop/agents', {
  name: `工艺工程师-${tag}`, harness: 'omp',
  config: { intro: '挤出工艺工程师:闭环寻优执行者', systemPromptPrefix: '你是挤出工艺工程师。按机理与实测数据决定每一轮调整,禁止臆造数字;单步限幅防震荡;达标且稳定后才收口。中文。' },
})).data
const team = (await api('POST', '/api/workshop/teams', { name: `寻优剧组-${tag}` })).data
const teamId = team.id ?? team?.team?.id
await api('POST', `/api/workshop/teams/${teamId}/members`, { agentId: lead.id, role: 'lead' })
await api('POST', `/api/workshop/teams/${teamId}/members`, { agentId: worker.id, role: 'worker' })
await api('POST', `/api/workshop/teams/${teamId}/deploy`, { channelId: CH })
const inst = (await api('GET', `/api/workshop/channels/${CH}/agents`)).data ?? []
const WI = inst.find(a => a.role === 'worker')
for (const [sig, nodeId] of Object.entries(dcwIds)) await api('POST', '/api/workshop/agent-tools/bindings', { agentId: WI.id, nodeId, kind: 'dcw', mode: 'auto' })
for (const [sig, nodeId] of Object.entries(daqIds)) await api('POST', '/api/workshop/agent-tools/bindings', { agentId: WI.id, nodeId, kind: 'daq', mode: 'auto' })
const bl = (await api('GET', `/api/workshop/agent-tools/bindings?agentId=${WI.id}`)).data.bindings
console.log('worker 绑定数:', bl.length)

console.log(JSON.stringify({ tag, CH, lineId: line.id, recipeId: recipe.id, dcwIds, daqIds, workerInst: WI.id, leadInst: inst.find(a => a.role === 'lead').id }))
