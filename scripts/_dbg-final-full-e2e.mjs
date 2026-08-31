/** 全功能端到端终验:产线-Recipe-数采-数控-孪生-断线重连-AgentTeam 一次跑通
 *  A 产线运行:product/Recipe 绑定节点,数采真实采集(produced/taggedSamples/节点值)
 *  B 数控下发:窗内直写 ACK 回读
 *  C 数字孪生:绑定节点实时渲染 + 场景同步(面板/树/设备极杆)
 *  D 断线重连:强杀→ws-dot 红→(外部重启)→恢复 active + dot live
 *  E AgentTeam:Leader 派发 → worker(omp) 分析+反馈控制(HITL)→ 参数生效
 */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const LINE = 'ln-af002514'
const WORKER = '0effc739-d9a0-4ab3-b14f-98596e0a44ca'
const CHANNEL = '52979e79-5592-46df-87eb-02658168f7ac'
const OUT = 'docs/audit/screenshots/ui-polish-0831'

const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const J = (u, m = 'GET', b) => fetch(BASE + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())
const fails = []
const okIf = (m, c) => { if (c) console.log(`PASS ${m}`); else { console.log(`FAIL ${m}`); fails.push(m) } }
const dcwAll = async () => (await J('/api/workshop/dcw')).data
const daqAll = async () => (await J('/api/workshop/daq')).data

// ════ PHASE A:产线-产品-Recipe 绑定 + 数采真实采集 ════
console.log('━━━ PHASE A 产线运行与数采采集 ━━━')
{
  const d = await dcwAll()
  const line = d.lines.find(l => l.id === LINE)
  const recipe = d.recipes.find(r => r.id === (d.lineStates?.find(s => s.lineId === LINE)?.recipeId))
  const product = d.products.find(p => p.id === recipe?.productId)
  okIf(`A1 产线运行: ${line?.name} | 产品「${product?.name}」| 配方「${recipe?.name}」(参数 ${recipe?.params.length} 条节点级绑定)`, !!recipe && recipe.params.every(p => p.nodeId))
  const daq = await daqAll()
  const lineNodes = daq.nodes.filter(n => n.lineId === LINE)
  okIf(`A2 产线节点 ${lineNodes.length} 个,全部有实时值: ${lineNodes.map(n => `${n.name}=${n.value}`).join(' | ')}`, lineNodes.length >= 3 && lineNodes.every(n => n.value != null))
  const meta0 = daq.meta
  await sleep(5000)
  const meta1 = (await daqAll()).meta
  okIf(`A3 数采真实采集: produced ${meta0.produced} → ${meta1.produced} | consumed=${meta1.consumed} | samplesStored=${meta1.samplesStored}`, meta1.produced > meta0.produced && meta1.samplesStored > 0)
  const tagged0 = d.lineStates?.find(s => s.lineId === LINE)?.taggedSamples ?? 0
  await sleep(3000)
  const tagged1 = (await dcwAll()).lineStates?.find(s => s.lineId === LINE)?.taggedSamples ?? 0
  okIf(`A4 产线打标隔离: taggedSamples ${tagged0} → ${tagged1}(仅本产线窗口内样本)`, tagged1 > tagged0)
}

// ════ PHASE B:数控下发 ════
console.log('━━━ PHASE B 数控下发 ━━━')
{
  const dw = (await dcwAll()).nodes.find(n => n.name === '温度设定器(示例)')
  const before = dw.value
  const target = before >= 184 ? before - 2 : before + 2
  const w = await fetch(`${BASE}/api/workshop/dcw/${dw.id}/write`, { method: 'POST', headers: H, body: JSON.stringify({ value: target }) }).then(r => r.json())
  const oc = w.data?.outcome
  okIf(`B1 数控下发 ACK: ${before} → ${oc?.eng ?? target}(raw=${oc?.raw}) ${oc?.message?.slice(0, 30)}`, w.code === 0 && oc?.ok === true)
  okIf(`B2 回读一致: readback=${oc?.readback}`, oc?.readback != null && Math.abs(oc.readback - target) < 0.01)
}

// ════ PHASE C:数字孪生实时渲染 + 场景同步 ════
console.log('━━━ PHASE C 数字孪生实时渲染 ━━━')
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
  const scene = await page.evaluate(() => ({
    total: window.__town.scene.deviceNodes.size,
    ids: [...window.__town.scene.deviceNodes.keys()].slice(0, 20),
  }))
  okIf(`C1 场景同步: ${scene.total} 个实体在场景中(设备+落位的数采/数控节点)`, scene.total >= 8)
  const twins = (await J('/api/workshop/device-twins')).data.twins
  const ext = twins.find(t => t.name === '挤出机 L1')
  await page.evaluate((id) => { window.__town.scene.setSelected?.({ kind: 'device', id }) }, ext.id)
  await new Promise(r => setTimeout(r, 1200))
  const read = () => page.evaluate(() => ({
    panel: [...document.querySelectorAll('.twin-daq .daq-item')].map(e => e.textContent?.replace(/\s+/g, ' ').trim()),
    tree: [...document.querySelectorAll('.daq-node .node-val')].slice(0, 6).map(e => e.textContent?.trim()),
  }))
  const c1 = await read()
  await sleep(8000)
  const c2 = await read()
  const changed = c2.panel.filter((v, i) => v !== c1.panel[i]).length
  okIf(`C2 面板实时渲染: ${changed}/${c1.panel.length} 通道 8s 内变化(${JSON.stringify(c1.panel)})`, changed > 0)
  const trendDrawn = await page.evaluate(() => {
    const c = document.querySelector('.trend-cv')
    if (!c) return false
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true
    return false
  })
  okIf('C3 趋势曲线实时绘制(与卡片同源)', trendDrawn)
  await page.screenshot({ path: `${OUT}/final-e2e-town.png` })
} catch (e) { fails.push('C 异常: ' + String(e).slice(0, 120)) }

// ════ PHASE D:断线重连(强杀→感知→外部重启→恢复+live) ════
console.log('━━━ PHASE D 断线重连 ━━━')
let dOk = false
try {
  // 状态点挂在 workshop WS 会话上:必须先停在 /workshop 再杀
  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
  await sleep(4000)
  okIf('D0 杀前 ws-dot=live', await page.evaluate(() => !!document.querySelector('.ws-dot.live')))

  const { execSync } = await import('node:child_process')
  // 整树强杀:监听 PID + 全部 nuxt 命令行的 node 进程(模拟服务突然崩溃)
  const out = execSync('netstat -ano | findstr ":3000" | findstr "LISTENING"', { shell: 'cmd.exe' }).toString()
  const pids = [...new Set(out.split('\n').map(l => l.trim().split(/\s+/).pop()).filter(Boolean))]
  let wmicOut = ''
  try { wmicOut = execSync('wmic process where "name=\'node.exe\'" get processid,commandline', { shell: 'cmd.exe' }).toString() } catch { /* wmc 可选 */ }
  const nuxtPids = wmicOut.split('\n')
    .filter(l => /nuxt/i.test(l))
    .map(l => l.trim().split(/\s+/)[0])
    .filter(Boolean)
  const killPids = [...new Set([...pids, ...nuxtPids])]
  for (const pid of killPids) {
    try { execSync(`taskkill /PID ${pid} /T /F`, { shell: 'cmd.exe', stdio: 'ignore' }) } catch { /* 已退出 */ }
  }
  console.log(`D1 CRASH: 整树强杀 ${killPids.length} 个进程(${killPids.join(',')}),等待客户端感知断线…`)
  let sawDown = false
  for (let i = 0; i < 40; i++) {
    // down(闭)与 syncing(重连中)都是诚实的断线感知;强杀后半开连接靠 15s 心跳超时发现
    if (await page.evaluate(() => !!document.querySelector('.ws-dot.down, .ws-dot.syncing'))) { sawDown = true; break }
    await sleep(1000)
  }
  okIf('D2 ws-dot 感知断线(down/syncing)', sawDown)
  console.log('D3 等待外部重启(≤180s)…')
  let up = false
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) { up = true; break }
    } catch { /* 未就绪 */ }
    await sleep(1500)
  }
  okIf('D4 服务重启完成', up)
  await sleep(2500)
  const d2 = (await J('/api/workshop/dcw')).data
  okIf('D5 活动产线窗口自动恢复(state 驱动)', d2.lineStates?.find(s => s.lineId === LINE)?.active === true)
  let backLive = false
  for (let i = 0; i < 60; i++) {
    // live 状态点挂在 workshop WS 会话上:/workshop 页挂载会话,/town 独立会话不挂
    if (i === 0 || i === 20) await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' }).catch(() => {})
    if (await page.evaluate(() => !!document.querySelector('.ws-dot.live'))) { backLive = true; break }
    await sleep(1500)
  }
  okIf('D6 ws-dot 回到 live(/workshop 自动重连+对齐)', backLive)
  dOk = true
} catch (e) { fails.push('D 异常: ' + String(e).slice(0, 120)) }

// ════ PHASE E:AgentTeam 团队作业(Leader 派发 → worker 分析+反馈控制) ════
console.log('━━━ PHASE E AgentTeam 团队作业 ━━━')
try {
  const dNow = await dcwAll()
  const dwTemp = dNow.nodes.find(n => n.name === '温度设定器(示例)')
  const valueBefore = dwTemp.value
  const daqLine = (await daqAll()).nodes.filter(n => n.lineId === LINE)
  console.log(`E1 绑定节点(已授权): 温度设定器=${dwTemp.value}℃ | 数采 ${daqLine.length} 节点(auto)`)

  const goal = `产线「1号产线」反馈控制任务(确定性指令):请将烘箱温度设定精确调整到 185℃ 并通过 dcw_control 下发(工艺窗口 176~188℃,185 在窗口内;该节点为手动确认模式,发起后等待用户批准)。步骤:1) 用数采工具读取你绑定节点的最近工况;2) 下发 185;3) 批准执行后复测设定值并汇报前后对比。`
  const task = (await J(`/api/workshop/channels/${CHANNEL}/tasks`, 'POST', {
    title: '烘箱温度反馈控制(终验)',
    parts: [{ text: goal }],
    mode: 'loop',
  })).data
  const taskId = task?.task?.id ?? task?.id
  if (!taskId) { fails.push('E 任务派发失败'); throw new Error('dispatch fail') }
  console.log(`E2 任务已派发 ${taskId.slice(0, 8)}(设定 ${valueBefore} → 目标 ~185)`)

  let subSeen = false, hitlSeen = false, valueSeen = false, detail = ''
  for (let i = 0; i < 200; i++) {
    await sleep(2000)
    const tasks = (await J(`/api/workshop/channels/${CHANNEL}/tasks`)).data
    const arr = Array.isArray(tasks) ? tasks : tasks?.tasks ?? []
    const sub = arr.find(t => t.parentId === taskId)
    if (sub && !subSeen) { subSeen = true; console.log(`[t+${i * 2}s] lead 派发子任务 → ${sub.assigneeId?.slice(0, 8)} (${sub.state})`) }
    const pend = (await J(`/api/workshop/agent-tools/approvals?agentId=${WORKER}`)).data.approvals
    if (pend.length > 0 && !hitlSeen) {
      hitlSeen = true
      detail = pend[0].detail
      console.log(`[t+${i * 2}s] HITL 待审: ${detail.slice(0, 70)}`)
      await J(`/api/workshop/agent-tools/approvals/${pend[0].id}/decide`, 'POST', { approved: true, comment: '终验:窗口内反馈控制,批准' })
      console.log('[HITL] 已批准')
    }
    const now = (await dcwAll()).nodes.find(n => n.id === dwTemp.id)
    if (now?.value != null && now.value !== valueBefore) valueSeen = true
    const done = sub && ['COMPLETED', 'FAILED', 'CANCELED'].includes(sub.state)
    if (done && valueSeen) { console.log(`[t+${i * 2}s] 子任务 ${sub.state},设定值=${now.value}`); break }
    if (i === 199) console.log(`[超时] 子任务=${sub?.state}`)
  }
  okIf('E3 Leader 调度:子任务已派发', subSeen)
  okIf(`E4 HITL: Agent 发起下发并获批准(${detail.slice(0, 50)})`, hitlSeen)
  const dwFinal = (await dcwAll()).nodes.find(n => n.id === dwTemp.id)
  okIf(`E5 参数真实下发生效: ${valueBefore} → ${dwFinal.value}(确定性指令目标 185)`, valueSeen && Math.abs(dwFinal.value - 185) < 0.01)
  const states = (await J('/api/workshop/dcw/lines')).data.states
  okIf(`E6 打标持续: taggedSamples=${states.find(s => s.lineId === LINE)?.taggedSamples}`, (states.find(s => s.lineId === LINE)?.taggedSamples ?? 0) > 0)
  const q = await J('/api/workshop/agent-tools/invoke', 'POST', { agentId: WORKER, tool: 'daq_query', args: { last_minutes: 5 } }).then(r => r.data?.result)
  console.log('E7 worker daq_query 复测:', String(q?.text ?? '').slice(0, 120).replace(/\n/g, ' '))
}
catch (e) { fails.push('E 异常: ' + String(e).slice(0, 150)) }
finally { await browser.close() }

console.log('')
console.log(fails.length ? `═══ 终验 FAILED(${fails.length}) ═══` : '═══ 终验 ALL PASS ═══')
fails.forEach(f => console.log(' ✗', f))
process.exit(fails.length ? 1 : 0)
