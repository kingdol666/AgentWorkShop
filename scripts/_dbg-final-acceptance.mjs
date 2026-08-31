/** 最终验收:产线控制 + 数字孪生 + Agent 权限 全功能测试(1号产线)
 *  T1 数采卡片实时 + 与 REST/趋势同源一致
 *  T2 设备节点绑定核对(REST)
 *  T3 产线/配方隔离:越窗 400、窗内直写、非本线节点不采样
 *  T4 启停门控:停线 produced 冻结 + offline;复跑恢复(结束保持运行)
 *  T5 真实 Modbus PLC 下发(127.0.0.1:1502 模拟器:175→raw1000 回读一致)+ 真机数采
 *  T6 Agent 权限注入:无绑定拒绝 / HITL 发起+批准 / daq_query 只列有权节点
 */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const LINE = 'ln-af002514'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = (u, m = 'GET', b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())
const OUT = 'docs/audit/screenshots/ui-polish-0831'
const fails = []
const okIf = (m, c) => { if (c) console.log(`PASS ${m}`); else { console.log(`FAIL ${m}`); fails.push(m) } }

// ── T5前置:真实 Modbus 节点(PLC 模拟器 1502 已外部启动) ──
let mk = (await J('/api/workshop/dcw')).data.nodes.find(n => n.name === '真机-温度设定')
if (!mk) {
  const r = await J('/api/workshop/dcw', 'POST', {
    templateRef: 'dcw-temp-sp', name: '真机-温度设定', driver: 'modbus-tcp', lineId: LINE,
    driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40021, dataType: 'float32', byteOrder: 'big', engMin: 150, engMax: 200, rawMin: 0, rawMax: 2000 },
  })
  mk = r.data.node
}
const mkTest = await J(`/api/workshop/dcw/${mk.id}/test`, 'POST', {})
console.log('T5 prep 真机数控 test:', mkTest.data?.test?.ok, '|', (mkTest.data?.test?.message ?? '').slice(0, 60))

let mkDq = (await J('/api/workshop/daq')).data.nodes.find(n => n.name === '真机-温度采集')
if (!mkDq) {
  const r = await J('/api/workshop/daq', 'POST', {
    templateRef: 'daq-temp-tc', name: '真机-温度采集', driver: 'modbus-tcp', lineId: LINE, intervalMs: 1000,
    driverConfig: { host: '127.0.0.1', port: 1502, unitId: 1, register: 40003, dataType: 'float32', byteOrder: 'big' },
  })
  mkDq = r.data.node
}
await J(`/api/workshop/daq/${mkDq.id}/bind`, 'POST', { deviceId: 'dev-mtgnirdi-hrh38' }).catch(() => {})
await J(`/api/workshop/daq/${mkDq.id}`, 'PATCH', { posX: 2395, posZ: 1135 })
console.log('T5 prep 真机数采:', mkDq.id.slice(0, 12), '→ 收卷机 L1(绑定+落位)')

// ── T1/T2 puppeteer 一致性与绑定核对 ──
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
try {
  await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  for (let i = 0; i < 45; i++) {
    if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
    await new Promise(r => setTimeout(r, 1000))
  }
  await new Promise(r => setTimeout(r, 4000))
  const twins = (await J('/api/workshop/device-twins')).data.twins
  const ext = twins.find(t => t.name === '挤出机 L1')
  await page.evaluate((id) => { window.__town.scene.setSelected?.({ kind: 'device', id }) }, ext.id)
  await new Promise(r => setTimeout(r, 1500))

  const snap = async () => ({
    panel: await page.evaluate(() => [...document.querySelectorAll('.twin-daq .daq-item')].map(e => e.textContent?.replace(/\s+/g, ' ').trim())),
    rest: (await J('/api/workshop/daq')).data.nodes.filter(n => n.deviceBindingId === ext.id).map(n => `${n.value} ${n.unit}`),
  })
  const a1 = await snap()
  await sleep(8000)
  const a2 = await snap()
  const match = a1.panel.length > 0 && a1.panel.some(p => a1.rest.some(r => p.includes(r.split(' ')[0])))
  okIf(`T1 卡片值与 REST 同源一致: ${JSON.stringify(a1.panel)} vs ${JSON.stringify(a1.rest)}`, match)
  const liveChanged = a2.panel.filter((v, i) => v !== a1.panel[i]).length
  okIf(`T1 卡片实时刷新(8s 内 ${liveChanged}/${a1.panel.length} 通道变化)`, liveChanged > 0)
  const trendDrawn = await page.evaluate(() => {
    const c = document.querySelector('.trend-cv')
    if (!c) return false
    const ctx = c.getContext('2d')
    const data = ctx.getImageData(0, 0, c.width, c.height).data
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return true
    }
    return false
  })
  okIf('T1 趋势曲线画布有实时绘制(与卡片同源 daqSim 单一数据源)', trendDrawn)
  await page.screenshot({ path: `${OUT}/final-t1-consistency.png` })
}
catch (e) { fails.push('puppeteer 段异常: ' + String(e).slice(0, 150)) }
finally { await browser.close() }

// T2 绑定核对(REST)
{
  const bindPairs = [
    ['压力变送器 01', '挤出机 L1'], ['温度传感器 01', 'MD 纵拉机 L1'], ['张力传感器 01', 'TD 拉幅机 L1'],
    ['温度设定器(示例)', '控制台 · CON'], ['压力设定器(示例)', '控制台 · CON'],
  ]
  const dcwAll = (await J('/api/workshop/dcw')).data.nodes
  const daqAll = (await J('/api/workshop/daq')).data.nodes
  const twins = (await J('/api/workshop/device-twins')).data.twins
  let bindOk = 0
  for (const [nodeName, devName] of bindPairs) {
    const n = nodeName.includes('设定器') ? dcwAll.find(x => x.name === nodeName) : daqAll.find(x => x.name === nodeName)
    const dev = twins.find(t => t.name === devName)
    if (n?.deviceBindingId === dev?.id) bindOk++
    else fails.push(`T2 绑定不符: ${nodeName}`)
  }
  okIf(`T2 设备节点绑定核对: ${bindOk}/${bindPairs.length} 与设计一致`, bindOk === bindPairs.length)
}

// ── T3 产线/配方隔离 ──
{
  const dwTemp = (await J('/api/workshop/dcw')).data.nodes.find(n => n.name === '温度设定器(示例)')
  const over = await fetch(`${BASE}/api/workshop/dcw/${dwTemp.id}/write`, { method: 'POST', headers: H, body: JSON.stringify({ value: 195 }) }).then(r => r.json())
  okIf(`T3 越窗写入被拒(${String(over.message ?? over.code).slice(0, 50)})`, over.code !== 0)
  const inWin = await fetch(`${BASE}/api/workshop/dcw/${dwTemp.id}/write`, { method: 'POST', headers: H, body: JSON.stringify({ value: 183 }) }).then(r => r.json())
  okIf(`T3 窗内直写 ACK(value=${inWin.data?.outcome?.value ?? inWin.data?.outcome?.eng ?? '?'})`, inWin.code === 0 && inWin.data?.outcome?.ok === true)
  const daqNow = (await J('/api/workshop/daq')).data
  const idleNode = daqNow.nodes.find(n => !n.lineId && n.driver === 'mock' && n.enabled && n.value != null)
  if (idleNode) {
    const v1 = idleNode.value
    await sleep(6000)
    const n2 = (await J('/api/workshop/daq')).data.nodes.find(n => n.id === idleNode.id)
    okIf(`T3 产线隔离: 未分配节点不采集(${idleNode.name}: ${v1} → ${n2.value}, state=${n2.state})`, n2.value === v1 && n2.state === 'offline')
  } else console.log('T3 跳过未分配节点采样观察(无可选节点)')
}

// ── T4 启停门控 ──
{
  const m0 = (await J('/api/workshop/daq')).data.meta
  await J(`/api/workshop/dcw/lines/${LINE}/stop`, 'POST', {})
  await sleep(5000)
  const m1 = (await J('/api/workshop/daq')).data
  const stoppedNode = m1.nodes.find(n => n.lineId === LINE)
  okIf(`T4 停线冻结: produced ${m0.produced} → ${m1.meta.produced}(不变)`, m1.meta.produced === m0.produced)
  okIf(`T4 停线联动: 节点 offline(${stoppedNode?.state})`, stoppedNode?.state === 'offline')
  const st = await J(`/api/workshop/dcw/lines/${LINE}/start`, 'POST', { recipeId: (await J('/api/workshop/dcw')).data.recipes.find(r => r.lineId === LINE && r.name === 'A-标准工艺').id })
  okIf('T4 复跑恢复: 产线重新激活', st.data?.line?.active === true)
  await sleep(5000)
  const m2 = (await J('/api/workshop/daq')).data.meta
  okIf(`T4 复跑恢复: produced ${m1.meta.produced} → ${m2.meta.produced}(增长)`, m2.meta.produced > m1.meta.produced)
}

// ── T5 真实 Modbus PLC 下发 ──
{
  const w = await fetch(`${BASE}/api/workshop/dcw/${mk.id}/write`, { method: 'POST', headers: H, body: JSON.stringify({ value: 175 }) }).then(r => r.json())
  const oc = w.data?.outcome
  okIf(`T5 真实 PLC 写: 175 → raw ${oc?.raw}(换算回读一致, message=${String(oc?.message ?? '').slice(0, 40)})`, w.code === 0 && oc?.ok === true && oc?.raw === 1000)
  const w2 = await fetch(`${BASE}/api/workshop/dcw/${mk.id}/write`, { method: 'POST', headers: H, body: JSON.stringify({ value: 180 }) }).then(r => r.json())
  okIf(`T5 真实 PLC 写: 180 → raw ${w2.data?.outcome?.raw}`, w2.code === 0 && w2.data?.outcome?.ok === true && w2.data?.outcome?.raw === 1200)
  await sleep(4000)
  const daqLive = (await J('/api/workshop/daq')).data.nodes.find(n => n.id === mkDq.id)
  okIf(`T5 真机数采: ${daqLive?.name} 实时值 ${daqLive?.value} ${daqLive?.unit} (${daqLive?.state}, 真实 Modbus 读 40003)`, daqLive?.value != null && daqLive?.state !== 'offline')
}

// ── T6 Agent 权限注入 ──
{
  const worker = '0effc739-d9a0-4ab3-b14f-98596e0a44ca'
  const unboundDcw = (await J('/api/workshop/dcw')).data.nodes.find(n => n.name === '真机-温度设定')
  // 6a:无绑定节点 → dcw_control 拒绝
  const denied = await J('/api/workshop/agent-tools/invoke', 'POST', { agentId: worker, tool: 'dcw_control', args: { nodeId: unboundDcw.id, value: 185 } }).then(r => r.data?.result)
  const deniedText = String(denied?.text ?? denied ?? '')
  okIf(`T6 权限拒绝: 未绑定节点 dcw_control 被拒(${deniedText.slice(0, 60)})`, /未授权|无权|绑定|denied|权限|失败|error/i.test(deniedText))
  // 6b:已绑定节点 → 走鉴权 + HITL pending
  const dwTemp = (await J('/api/workshop/dcw')).data.nodes.find(n => n.name === '温度设定器(示例)')
  const allowed = await J('/api/workshop/agent-tools/invoke', 'POST', { agentId: worker, tool: 'dcw_control', args: { nodeId: dwTemp.id, value: 184 } }).then(r => r.data?.result)
  const allowedText = String(allowed?.text ?? allowed ?? '')
  const pend = (await J(`/api/workshop/agent-tools/approvals?agentId=${worker}`)).data.approvals
  okIf(`T6 已绑定节点发起下发 → HITL 待审(${pend.length} 条: ${String(pend[0]?.detail ?? '').slice(0, 50)})`, pend.length > 0 || /184/.test(allowedText))
  // 拒绝该审批(保留 183 为最终演示值)+ 校验无写副作用
  if (pend.length > 0) {
    await J(`/api/workshop/agent-tools/approvals/${pend[0].id}/decide`, 'POST', { approved: false, comment: '最终验收:保持 183,拒绝本次变更' })
    await sleep(1200)
    const now = (await J('/api/workshop/dcw')).data.nodes.find(n => n.id === dwTemp.id)
    const pendAfter = (await J(`/api/workshop/agent-tools/approvals?agentId=${worker}`)).data.approvals
    okIf(`T6 HITL 拒绝路径: 审批收敛(pending=${pendAfter.length})且值未被改动(${now.value})`, pendAfter.length === 0 && Math.abs(now.value - 183) < 0.01)
  }
  // 6c:daq_query 只列有权节点
  const q = await J('/api/workshop/agent-tools/invoke', 'POST', { agentId: worker, tool: 'daq_query', args: { last_minutes: 5 } }).then(r => r.data?.result)
  const qText = String(q?.text ?? '')
  okIf('T6 daq_query 仅列有权节点(压力/温度在列,真机-温度采集不在列)', qText.includes('压力变送器 01') && qText.includes('温度传感器 01') && !qText.includes('真机-温度采集'))
}

console.log('')
console.log(fails.length ? `=== 最终验收 FAILED(${fails.length}) ===` : '=== 最终验收 ALL PASS ===')
fails.forEach(f => console.log(' -', f))
process.exit(fails.length ? 1 : 0)
