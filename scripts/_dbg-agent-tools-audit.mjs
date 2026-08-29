/** Agent 工业工具审计:绑定鉴权/物理语义/联锁校验/手动审批/数据查询/孪生绑定 UI */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
const jpost = (u, b) => fetch(ROOT + u, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) }).then(r => r.json())
const jget = (u) => fetch(ROOT + u, { headers: H }).then(r => r.json())
const jdel = (u) => fetch(ROOT + u, { method: 'DELETE', headers: H }).then(r => r.json())

// 工具调用经 HTTP 桥(与 omp host tools 同一服务层函数:industrial-tools.ts)
const invoke = async (tool, args, agentId = AGENT) =>
  (await jpost('/api/workshop/agent-tools/invoke', { agentId, tool, args })).data.result

// ===== 1. 产线/节点/配方夹具 =====
const line = (await jpost('/api/workshop/dcw/lines', { name: '工具审计线' })).data.line
const twins = (await jget('/api/workshop/device-twins')).data.twins.filter(t => t.kind !== 'daq')
const dev = twins[0]
const dq = (await jpost('/api/workshop/daq', { templateRef: 'daq-temp-tc', name: '工具审计-温度采集', lineId: line.id, intervalMs: 500 })).data.node
const dw = (await jpost('/api/workshop/dcw', { templateRef: 'dcw-temp-sp', name: '工具审计-温度设定', lineId: line.id })).data.node
const prod = (await jpost('/api/workshop/dcw/products', { name: '工具审计产品', lineId: line.id })).data.product
const rc = (await jpost('/api/workshop/dcw/recipes', {
  productId: prod.id, name: '工具审计配方',
  params: [{ templateRef: 'dcw-temp-sp', nodeId: dw.id, value: 180, min: 176, max: 188 }],
  daqWindows: [{ nodeId: dq.id, min: 100, max: 260 }],
})).data.recipe
const AGENT = 'agt-audit-1'
// 清理历史运行残留绑定(固定 agentId 跨轮复用)
for (const b of (await jget(`/api/workshop/agent-tools/bindings?agentId=${AGENT}`)).data.bindings) {
  await jdel(`/api/workshop/agent-tools/bindings/${b.id}`)
}
await jpost(`/api/workshop/dcw/lines/${line.id}/start`, { recipeId: rc.id })
await sleep(2500)
console.log('fixture ready:', line.name, '| daq', dq.id, '| dcw', dw.id)

// ===== 2. REST 绑定 CRUD =====
const bDcw = (await jpost('/api/workshop/agent-tools/bindings', { agentId: AGENT, nodeId: dw.id, kind: 'dcw', mode: 'manual' })).data.binding
const bDaq = (await jpost('/api/workshop/agent-tools/bindings', { agentId: AGENT, nodeId: dq.id, kind: 'daq', mode: 'auto' })).data.binding
const list = (await jget(`/api/workshop/agent-tools/bindings?agentId=${AGENT}`)).data.bindings
if (list.length === 2 && bDcw.mode === 'manual') console.log('PASS 绑定 CRUD:数控(manual)+ 数采(auto)')
else fail(`绑定 CRUD 异常: ${JSON.stringify(list)}`)

// ===== 3. 工具语义(HTTP 桥 = omp host tool 同路径) =====
{
  // 3.1 未绑定节点 → 鉴权拒绝
  const denied = await invoke('dcw_control', { node_id: 'dw-nonexist', value: 180 })
  if (denied.isError && denied.text.includes('无权')) console.log('PASS dcw_control 鉴权:未绑定节点拒绝')
  else fail(`鉴权失效: ${denied.text.slice(0, 60)}`)

  // 3.2 my_industrial_nodes:物理语义 + 窗口 + 模式
  const mine = await invoke('my_industrial_nodes', {})
  const okMine = mine.text.includes('数控') && mine.text.includes('数采') && mine.text.includes('176~188') && mine.text.includes('手动确认')
  if (okMine) console.log('PASS my_industrial_nodes:物理含义/配方窗口/控制模式齐备')
  else fail(`节点语义缺失: ${mine.text.slice(0, 200)}`)

  // 3.3 manual 模式:挂起审批 → 批准 → 执行成功
  const pendingP = invoke('dcw_control', { node_id: dw.id, value: 182 })
  await sleep(600)
  const pending = (await jget(`/api/workshop/agent-tools/approvals?agentId=${AGENT}`)).data.approvals
  if (pending.length !== 1) fail(`审批未挂起: ${pending.length}`)
  else console.log('PASS manual 模式:下发挂起待审批(', pending[0].detail.slice(0, 40), ')')
  const dec = await jpost(`/api/workshop/agent-tools/approvals/${pending[0].id}/decide`, { approved: true, comment: '同意,按工艺执行' })
  const result = await pendingP
  if (dec.data?.approval?.status === 'approved' && result.text.includes('下发成功') && result.text.includes('182')) console.log('PASS 批准后执行成功,回读语义齐备')
  else fail(`批准执行异常: ${result.text.slice(0, 120)}`)

  // 3.4 拒绝 + 备注 → 返回 tool result
  const pendingP2 = invoke('dcw_control', { node_id: dw.id, value: 185 })
  await sleep(600)
  const pending2 = (await jget(`/api/workshop/agent-tools/approvals?agentId=${AGENT}`)).data.approvals
  await jpost(`/api/workshop/agent-tools/approvals/${pending2[0].id}/decide`, { approved: false, comment: '窗口上沿太近,不要动' })
  const result2 = await pendingP2
  if (!result2.text.includes('下发成功') && result2.text.includes('窗口上沿太近')) console.log('PASS 拒绝 + 用户备注回给 tool result')
  else fail(`拒绝备注缺失: ${result2.text.slice(0, 120)}`)

  // 3.5 模式切 auto → 直接执行;越窗 195 联锁拒绝
  await jpatchWrap(bDcw.id)
  async function jpatchWrap(id) {
    await fetch(`${ROOT}/api/workshop/agent-tools/bindings/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ mode: 'auto' }) })
  }
  const auto = await invoke('dcw_control', { node_id: dw.id, value: 182 })
  if (auto.text.includes('下发成功')) console.log('PASS auto 模式直接执行(无需批准)')
  else fail(`auto 模式异常: ${auto.text.slice(0, 100)}`)
  const over = await invoke('dcw_control', { node_id: dw.id, value: 195 })
  if (over.isError && over.text.includes('195')) console.log('PASS 工具联锁:越配方窗口 195 被拒(物理语义回给 AI)')
  else fail(`联锁失效: ${over.text.slice(0, 100)}`)

  // 3.6 daq_query:最近数据 + 物理语义
  const q = await invoke('daq_query', { last_minutes: 5 })
  const okQ = q.text.includes('熔体/箱体温度') && q.text.includes('最新') && q.text.includes('工具审计-温度采集')
  if (okQ) console.log('PASS daq_query:物理语义 + 统计 + 序列')
  else fail(`daq_query 异常: ${q.text.slice(0, 200)}`)
  const qForb = await invoke('daq_query', { node_id: 'dn-nonexist' })
  if (qForb.isError) console.log('PASS daq_query 鉴权:未绑定节点拒绝')
  else fail('daq_query 鉴权失效')
}

// ===== 4. 孪生 UI:Agent 检查器绑定面板 =====
// 取一个真实 Channel agent id
const chans = (await jget('/api/workshop/channels')).data
const firstCh = (chans ?? [])[0]
const chanAgents = firstCh ? (await jget(`/api/workshop/channels/${firstCh.id}/agents`)).data : []
const agentId = chanAgents[0]?.id ?? ''
if (agentId) {
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1200'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1200 })
  await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
  await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
    await sleep(1000)
  }
  for (let i = 0; i < 30; i++) {
    if (await page.evaluate(() => typeof window.__town?.scene?.setSelected === 'function')) break
    await sleep(1000)
  }
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    btns.find(b => b.textContent.trim() === '编辑')?.click()
  })
  await sleep(400)
  await page.evaluate((id) => { window.__town.scene.setSelected({ kind: 'agent', id }) }, agentId)
  await sleep(900)
  const ui = await page.evaluate(() => ({
    hasSect: document.body.textContent.includes('工业节点绑定'),
    hasEmpty: document.body.textContent.includes('未绑定工业节点'),
    hasBindBar: document.body.textContent.includes('选择节点…'),
  }))
  console.log('agent inspector:', JSON.stringify(ui))
  if (ui.hasSect && ui.hasBindBar) console.log('PASS 孪生侧栏 Agent 绑定面板渲染')
  else fail(`绑定面板缺失: ${JSON.stringify(ui)}`)
  await page.screenshot({ path: 'docs/audit/screenshots/agent-bind-panel.png' })
  await browser.close()
}
else {
  console.log('[warn] 无运行时 Agent,跳过 UI 段(REST/工具段已覆盖)')
}

// ===== 清理 =====
await jpost(`/api/workshop/dcw/lines/${line.id}/stop`, {})
await jdel(`/api/workshop/daq/${dq.id}`)
await jdel(`/api/workshop/dcw/${dw.id}`)
await jdel(`/api/workshop/dcw/recipes/${rc.id}`)
await jdel(`/api/workshop/dcw/products/${prod.id}`)
await jdel(`/api/workshop/dcw/lines/${line.id}`)
console.log(process.exitCode ? 'AUDIT FAILED' : 'AUDIT ALL PASS')
process.exit(process.exitCode ?? 0)
