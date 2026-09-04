/**
 * 真实产线场景综合 E2E(PLC 工艺模拟器 + Agent 绑定 + Channel + HITL + TUI + 可视化):
 *   node scripts/e2e-plc-scenario.mjs [--base http://127.0.0.1:3000]
 *
 * 场景:建产线(数采+数控节点,产品/配方)→ 开跑 → Channel(lead)+omp 工人 Agent →
 *       节点绑定(数采=auto / 数控=manual)→
 *   任务1  Agent 读数汇报(数采链路)→ TUI /monitor 看执行过程
 *   任务2  Agent 数控下发 182(manual 绑定 → HITL 审批)→ TUI /hitl 批准 →
 *          写入生效(readValue→182)→ Agent 复核判定 → 任务完成
 *   可视化 WebUI /daq /dcw 页面渲染节点实时值(截图)
 */
import puppeteer from 'puppeteer-core'

const BASE = (() => {
  const i = process.argv.indexOf('--base')
  return i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:3000'
})()
const WS_BASE = BASE.replace(/^http/, 'ws')
const TAG = Date.now().toString(36)

let failures = 0
let passed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitUntil(name, cond, timeoutMs = 300_000, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    try {
      last = await cond()
      if (last) return last
    }
    catch (e) { last = e }
    await sleep(intervalMs)
  }
  throw new Error(`waitUntil timeout: ${name} (last=${String(last).slice(0, 200)})`)
}

const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

/** AEP WS:连接即注册全局 peer(daq.reading/dcw.written 等全员帧)+ 订阅频道帧 */
function openAep(channelId, token) {
  const envelopes = []
  const ws = new WebSocket(`${WS_BASE}/api/workshop/ws?token=${encodeURIComponent(token)}`)
  ws.addEventListener('open', () => channelId && ws.send(JSON.stringify({ type: 'sub', channelId, token })))
  ws.addEventListener('message', (ev) => {
    try {
      const e = JSON.parse(ev.data)
      if (e.type && e.type !== 'pong') envelopes.push(e)
    }
    catch { /* ignore */ }
  })
  return { ws, envelopes }
}

async function main() {
  console.log(`\n━━━ 真实产线场景综合 E2E @ ${BASE} ━━━`)

  const reg = await api('POST', '/api/users/register', {
    body: { email: `plc-${TAG}@test.local`, password: 'Passw0rd!123', name: `plc-${TAG}` },
  })
  const token = reg.data?.token
  if (!token) throw new Error(`注册失败: ${JSON.stringify(reg).slice(0, 160)}`)

  // ═══ Phase 1:产线搭建(PLC 模拟器) ═══
  console.log('  ── Phase 1:产线搭建 ──')
  const line = (await api('POST', '/api/workshop/dcw/lines', { body: { name: `产线-${TAG}` }, token })).data?.line
  const dq = (await api('POST', '/api/workshop/daq', {
    body: { templateRef: 'daq-temp-tc', name: `熔体温度-${TAG}`, lineId: line.id, intervalMs: 500 },
    token,
  })).data?.node
  const dw = (await api('POST', '/api/workshop/dcw', {
    body: { templateRef: 'dcw-temp-sp', name: `温度设定-${TAG}`, lineId: line.id },
    token,
  })).data?.node
  const prod = (await api('POST', '/api/workshop/dcw/products', { body: { name: `产品-${TAG}`, lineId: line.id }, token })).data?.product
  const recipe = (await api('POST', '/api/workshop/dcw/recipes', {
    body: {
      productId: prod.id,
      name: `配方-${TAG}`,
      params: [{ templateRef: 'dcw-temp-sp', nodeId: dw.id, value: 180, min: 176, max: 188 }],
      daqWindows: [{ nodeId: dq.id, min: 100, max: 260 }],
    },
    token,
  })).data?.recipe
  check('1.1 产线+数采/数控节点+产品/配方', Boolean(line?.id && dq?.id && dw?.id && prod?.id && recipe?.id))

  const start = await api('POST', `/api/workshop/dcw/lines/${line.id}/start`, { body: { recipeId: recipe.id }, token })
  check('1.2 产线开跑(工艺窗口激活)', start.code === 0)

  await sleep(6000)
  const samples = await api('GET', `/api/workshop/daq/${dq.id}/samples`, { token })
  check('1.3 数采模拟器持续出数', ((samples.data?.points ?? samples.data ?? []).length ?? 0) >= 3, `points=${(samples.data?.points ?? []).length}`)

  // ═══ Phase 2:Channel 团队组建 + Agent 节点绑定 ═══
  console.log('  ── Phase 2:团队组建与绑定 ──')
  const channelName = `plc-scenario-${TAG}`
  const ch = (await api('POST', '/api/workshop/channels', {
    body: { name: channelName, description: '产线控制场景', leadAgent: { name: '调度长', harness: 'mock', config: { delayMs: 60 } } },
    token,
  })).data
  const channelId = ch.channelId
  const workerTpl = (await api('POST', '/api/workshop/agents', {
    body: { name: `工艺员-${TAG}`, harness: 'omp', config: { systemPromptPrefix: '你是产线工艺操作员,严格按任务步骤使用工业工具,不做任何额外操作。' } },
    token,
  })).data
  await api('POST', `/api/workshop/channels/${channelId}/agents`, { body: { agentId: workerTpl.id, role: 'worker' }, token })
  const members = (await api('GET', `/api/workshop/channels/${channelId}/agents`, { token })).data ?? []
  const worker = members.find(a => a.role === 'worker')
  check('2.1 Channel 创建(lead)+ omp 工艺员入队', Boolean(channelId && worker?.id), `worker=${worker?.id?.slice(0, 8)}`)

  const b1 = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: worker.id, nodeId: dq.id, kind: 'daq', mode: 'auto' }, token })
  const b2 = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: worker.id, nodeId: dw.id, kind: 'dcw', mode: 'manual' }, token })
  check('2.2 节点绑定(数采=auto / 数控=manual 待审批)', b1.code === 0 && b2.code === 0)

  // ═══ Phase 3:任务1 —— 数采读数链路(Agent 控制) ═══
  console.log('  ── Phase 3:任务1 数采读数(Agent 执行)──')
  const aep = openAep(channelId, token)
  await sleep(500)

  // TUI 并行接入(仓库源码 headless)
  const { main: tuiMain } = await import('../tui/aw-tui.mjs')
  await tuiMain(['--headless', '--url', BASE, '--token', token, '--channel', channelName])
  const vt = globalThis.__tuiSmokeTerminal
  const type = async (text) => {
    for (const c of text) vt.emitInput(c)
    await sleep(50)
    vt.emitInput('\r')
    await sleep(400)
  }
  const waitTui = async (needle, timeoutMs = 300_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (vt.text().includes(needle)) return true
      await sleep(500)
    }
    return false
  }
  check('3.0 TUI 接入频道', await waitTui(`已切换到频道「${channelName}」`, 30_000))

  const task1 = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: {
      title: `读数汇报-${TAG}`,
      parts: [{ text: `用 daq_query 读取「熔体温度-${TAG}」最近 2 分钟数据,汇报均值与趋势。完成后调用 complete_task,把均值写进结论。` }],
      assigneeId: worker.id,
    },
    token,
  })
  const task1Id = task1.data?.task?.id ?? task1.data?.id
  check('3.1 任务1 下发(直派工艺员)', Boolean(task1Id), `task=${task1Id?.slice(0, 8)}`)

  console.log('  … 等待 omp spawn + Agent 读数(2-4 分钟)…')
  const t1State = await waitUntil('3.2 任务1 终态', async () => {
    const t = await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })
    const me = (t.data ?? []).find(x => x.id === task1Id)
    return ['COMPLETED', 'FAILED', 'CANCELED'].includes(me?.state) ? me.state : null
  }, 480_000).catch(() => null)
  check('3.2 任务1 COMPLETED(数采链路走通)', t1State === 'COMPLETED', `state=${t1State}`)

  // TUI 监控面板:看工艺员的执行过程
  await type('/monitor ' + `工艺员-${TAG}`)
  const monOn = await waitTui('监控已开启:', 20_000)
  const termFrames = await waitTui('已接入', 120_000)
  check('3.3 TUI /monitor 接入工艺员终端(实时执行过程)', monOn && termFrames)

  // ═══ Phase 4:任务2 —— 数控下发 + HITL 审批闭环 ═══
  console.log('  ── Phase 4:任务2 数控下发(manual 绑定 → HITL)──')
  const task2 = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: {
      title: `调参-${TAG}`,
      parts: [{ text: `用 dcw_read 读取「温度设定-${TAG}」当前值;再用 dcw_control 将其设定值调到 182(需要人工审批,若被拒绝则汇报被拒即可);批准后再次 dcw_read 复核确认到达 182 附近。完成后调用 complete_task。` }],
      assigneeId: worker.id,
    },
    token,
  })
  const task2Id = task2.data?.task?.id ?? task2.data?.id
  check('4.1 任务2 下发(数控调参)', Boolean(task2Id))

  // 等待 HITL 审批(AEP hitl.request 帧 + REST 待办)
  const hitlItem = await waitUntil('4.2 HITL 待审到达(dcw-approval)', async () => {
    const hitlFrame = aep.envelopes.find(e => e.type === 'hitl.request' && e.payload?.kind === 'dcw-approval')
    const p = await api('GET', `/api/workshop/hitl/pending?channelId=${channelId}`, { token })
    const item = (p.data?.items ?? []).find(i => i.kind === 'dcw-approval')
    return hitlFrame && item ? item : null
  }, 420_000).catch(() => null)
  check('4.2 HITL 审批到达(AEP 帧 + REST 待办)', Boolean(hitlItem), hitlItem ? `id=${hitlItem.id} detail=${String(hitlItem.detail).slice(0, 60)}` : 'timeout')

  // TUI 可视化待办并批准(Human-in-the-loop 的 TUI 侧闭环)
  await type('/hitl')
  check('4.3 TUI /hitl 渲染审批待办', await waitTui('待人工处理', 20_000))
  const row = await waitUntil('4.4 定位 dcw-approval 行', () => {
    const m = vt.text().match(/(\d+)\. \[dcw-approval\]/)
    return m ? m[1] : null
  }, 30_000).catch(() => null)
  check('4.4 审批行定位', Boolean(row), `序号=${row}`)
  await type(`/hitl ${row}`)
  check('4.5 进入审批卡', await waitTui('HITL 作答', 20_000))
  await type('y')
  check('4.6 批准提交回执', await waitTui('应答已提交', 30_000))

  const approved = await waitUntil('4.7 审批落定(REST)', async () => {
    const p = await api('GET', `/api/workshop/hitl/pending?channelId=${channelId}`, { token })
    return (p.data?.items ?? []).every(i => i.id !== hitlItem?.id) ? true : null
  }, 60_000).catch(() => null)
  check('4.7 批准落定(TUI → 服务端)', approved === true)

  // 写入生效:设定值收敛 182±2
  console.log('  … 等待设定值收敛(工艺响应)…')
  const converged = await waitUntil('4.8 设定值收敛 182±2', async () => {
    const list = await api('GET', '/api/workshop/dcw', { token })
    const nodes = Array.isArray(list.data) ? list.data : (list.data?.nodes ?? [])
    const v = Number(nodes.find(n => n.id === dw.id)?.readValue ?? NaN)
    return Number.isFinite(v) && Math.abs(v - 182) <= 2 ? v : null
  }, 60_000, 1500).catch(() => null)
  check('4.8 数控写入生效(经 Agent dcw_control)', converged !== null, `value=${converged}`)

  const dcwWritten = aep.envelopes.some(e => e.type === 'dcw.written')
  check('4.9 数控写入实时广播(dcw.written 帧)', dcwWritten)

  const t2State = await waitUntil('4.10 任务2 终态', async () => {
    const t = await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })
    const me = (t.data ?? []).find(x => x.id === task2Id)
    return ['COMPLETED', 'FAILED', 'CANCELED'].includes(me?.state) ? me.state : null
  }, 480_000).catch(() => null)
  check('4.10 任务2 COMPLETED(调参+复核闭环)', t2State === 'COMPLETED', `state=${t2State}`)

  // ═══ Phase 5:数控/数采可视化(WebUI) ═══
  console.log('  ── Phase 5:WebUI 可视化 ──')
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 },
  })
  const page = await browser.newPage()
  const me = await api('GET', '/api/users/me', { token })
  await page.evaluateOnNewDocument((inject) => {
    localStorage.setItem('workshop.user', JSON.stringify({ user: { ...inject.me, token: inject.token } }))
    document.cookie = `token=${inject.token}; path=/; max-age=31536000`
  }, { me: me.data ?? {}, token })
  const shot = async name => page.screenshot({ path: `gui-test-screenshots/plc-scenario-${name}.png` }).catch(() => {})

  await page.goto(`${BASE}/daq`, { waitUntil: 'networkidle2', timeout: 60_000 })
  await sleep(2500)
  const daqPage = await page.evaluate(() => document.body.textContent)
  check('5.1 数采中心渲染节点', daqPage.includes(`熔体温度-${TAG}`))
  await shot('daq')

  await page.goto(`${BASE}/dcw`, { waitUntil: 'networkidle2', timeout: 60_000 })
  await sleep(1500)
  const dcwPage = await page.evaluate(() => document.body.textContent)
  check('5.2 产线运营渲染产线卡片', dcwPage.includes(`产线-${TAG}`))
  await shot('dcw')

  // 节点卡片与实时值在产线详情页(/dcw/[id] 渲染 readValue)
  await page.goto(`${BASE}/dcw/${line.id}`, { waitUntil: 'networkidle2', timeout: 60_000 })
  await sleep(3000)
  const dcwDetail = await page.evaluate(() => document.body.textContent)
  check('5.3 产线详情渲染数控节点', dcwDetail.includes(`温度设定-${TAG}`))
  const valueShown = /18[0-9](\.[0-9]+)?/.test(dcwDetail)
  check('5.4 数控可视化含当前值(182 附近)', valueShown)
  await shot('dcw-value')

  await browser.close().catch(() => {})

  // ═══ 清理 + 汇总 ═══
  await api('DELETE', `/api/workshop/channels/${channelId}?purge=1`, { token }).catch(() => {})
  await api('POST', `/api/workshop/dcw/lines/${line.id}/stop`, { token }).catch(() => {})
  for (const [p, id] of [['/api/workshop/daq', dq.id], ['/api/workshop/dcw', dw.id]]) {
    await api('DELETE', `${p}/${id}`, { token }).catch(() => {})
  }
  await api('DELETE', `/api/workshop/dcw/lines/${line.id}`, { token }).catch(() => {})

  console.log(`\n━━━ 结果: ${passed} passed / ${failures} failed ━━━`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('FATAL', err.message)
  process.exit(1)
})
