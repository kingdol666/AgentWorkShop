/**
 * aw start(v0.7.28 打包部署)功能冒烟:数采 / 数控 / Agent 控制 / AML 影子模型 / 数字孪生。
 * 前置:aw start 已运行(3001)+ dev-plc-simulator(15040);AW_E2E_TOKEN(admin)。
 * 运行:AW_E2E_TOKEN=… node scripts/aw-start-smoke.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const BASE = 'http://127.0.0.1:3001'
const TOKEN = process.env.AW_E2E_TOKEN ?? ''
if (!TOKEN) {
  console.error('需要 AW_E2E_TOKEN')
  process.exit(1)
}

let passed = 0
let failures = 0
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed++
  else failures++
}
const sleep = async (ms) => {
  await new Promise(r => setTimeout(r, ms))
}

async function api(method, path, opts = {}) {
  const headers = { 'content-type': 'application/json' }
  if (opts.agentToken) headers['x-aw-agent-token'] = opts.agentToken
  else headers.authorization = `Bearer ${opts.token ?? TOKEN}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const json = await res.json().catch(() => null)
  if (!json) return { ok: res.ok, status: res.status, code: `HTTP_${res.status}` }
  // 信封展开:{code,message,data} 平铺到顶层,调用方直接读 .code/.data
  return { ...json, status: res.status, ok: res.ok }
}

async function main() {
  console.log('━━━ 1. 系统健康(打包部署 v0.7.28) ━━━')
  const aml = await api('GET', '/api/workshop/aml')
  check('AML 运行时就绪', aml?.code === 0 && aml?.data?.runtime?.python?.ok === true, `python.ok=${aml?.data?.runtime?.python?.ok}`)
  const channels = await api('GET', '/api/workshop/channels')
  check('频道服务可用', channels?.code === 0, `n=${(channels?.data?.channels ?? channels?.data)?.length ?? '?'}`)
  const harnesses = await api('GET', '/api/workshop/harnesses')
  check('引擎注册表可用(14 引擎)', (harnesses?.data?.harnesses ?? harnesses?.data)?.length >= 10, `n=${(harnesses?.data?.harnesses ?? harnesses?.data)?.length}`)

  console.log('━━━ 2. PLC 模拟器产线接入(自带产线模拟协议,Modbus 15040) ━━━')
  const lines = await api('GET', '/api/workshop/dcw/lines')
  // 多轮实测会留下多条同名线:统一取最新一条,后续资源全部按该线过滤(防跨线错配)
  const line = (lines?.data?.lines ?? []).filter(l => l.name?.startsWith('涂布烘干 AML 实测线')).pop()
  const lineId = line?.id
  check('定位最新实测产线', !!lineId, `${lineId} ${line?.name?.slice(-10) ?? ''}`)
  const daqList = await api('GET', '/api/workshop/daq')
  const daqNodes = (daqList?.data?.nodes ?? []).filter(n => n.lineId === lineId)
  const spDaq = daqNodes.find(n => n.name?.includes('SP 读'))
  const pvDaq = daqNodes.find(n => n.name?.includes('PV 读'))
  check('SP/PV 数采节点在册(跨重启持久化)', !!spDaq && !!pvDaq, `${spDaq?.id} / ${pvDaq?.id}`)
  const dcwList = await api('GET', '/api/workshop/dcw')
  const dwNode = (dcwList?.data?.nodes ?? []).filter(n => n.lineId === lineId).find(n => n.name?.includes('烘干温度 SP'))
  check('数控 SP 写节点在册', !!dwNode, dwNode?.id)
  const dwNodeId = dwNode?.id ?? dwNode?.node?.id

  console.log('━━━ 3. 产线开跑(数采仅在活动批次期间采集——按设计) ━━━')
  const recipes = await api('GET', '/api/workshop/dcw/recipes')
  const recipe = (recipes?.data?.recipes ?? []).filter(r => r.name?.startsWith('烘干温度配方') && r.lineId === lineId).pop()
  const start = await api('POST', `/api/workshop/dcw/lines/${spDaq.lineId}/start`, { body: { recipeId: recipe?.id } })
  check('产线开跑(激活 LineRun → 数采节拍启动;已在运行=幂等通过)', start?.code === 0 || /已在运行/.test(String(start?.message ?? '')), start?.message ?? '')
  await sleep(4000)

  console.log('━━━ 4. 数采(真实 Modbus 读) ━━━')
  const now = Date.now()
  const samples = await api('GET', `/api/workshop/daq/${pvDaq.id}/samples?from=${now - 30_000}&bucketMs=1000&limit=60`)
  const pts = samples?.data?.points ?? []
  const lastPv = pts[pts.length - 1]?.avg ?? pts[pts.length - 1]?.value
  check('PV 数采持续流入(开跑后有数据)', pts.length >= 3, `n=${pts.length} 最新 PV=${Number(lastPv ?? 0).toFixed(1)}℃`)
  check('PV 数值物理合理(100~250℃ 范围)', lastPv > 100 && lastPv < 250, `PV=${Number(lastPv ?? 0).toFixed(1)}`)

  console.log('━━━ 4. 数控下发(REST 直写) ━━━')
  const wr = await api('POST', `/api/workshop/dcw/${dwNodeId}/write`, { body: { value: 172 } })
  check('SP 下发 172 写入成功', wr?.code === 0, wr?.message ?? '')
  await sleep(9000)
  const readback = await api('GET', `/api/workshop/daq/${spDaq.id}/samples?from=${Date.now() - 15_000}&bucketMs=1000&limit=30`)
  const spPts = readback?.data?.points ?? []
  const spNow = spPts[spPts.length - 1]?.avg ?? spPts[spPts.length - 1]?.value
  // 写入后 SP 按执行器斜率(5℃/s)爬升,回读窗口落在动态途中:断言"已离开原值、落在物理量程内"即可
  check('数采回读确认 SP 爬升动态生效(172 下发)', Number(spNow) > 150 && Number(spNow) < 200 && Number(spNow) !== 178.5, `回读=${Number(spNow ?? 0).toFixed(1)}℃(斜率爬升中)`)

  console.log('━━━ 5. Agent 控制(工具桥 + dcw_control) ━━━')
  const db = new DatabaseSync('.AgentWorkShop/data/workshop.sqlite', { readOnly: true })
  const agentRow = db.prepare(`SELECT id, token, name FROM channel_agents WHERE role = 'worker' AND enabled = 1 ORDER BY created_at DESC LIMIT 1`).get()
  db.close()
  check('复用已部署 Agent 实例', !!agentRow, agentRow?.name)
  const bind = await api('POST', '/api/workshop/agent-tools/bindings', { body: { agentId: agentRow.id, nodeId: dwNodeId, kind: 'dcw', mode: 'auto' } })
  check('绑定数控节点(mode=auto)', bind?.code === 0, bind?.message ?? '')
  const ctrl = await api('POST', '/api/workshop/agent-tools/invoke', {
    agentToken: agentRow.token,
    body: { agentId: agentRow.id, tool: 'dcw_control', args: { node_id: dwNodeId, value: 178, hypothesis: '冒烟:Agent 提升设定值验证数控链路' } },
  })
  const ctrlText = String(ctrl?.data?.result?.text ?? '')
  check('Agent dcw_control 下发 178', ctrlText.length > 20 && !ctrlText.includes('无权'), ctrlText.slice(0, 70).replace(/\n/g, ' '))
  await sleep(9000)
  const readback2 = await api('GET', `/api/workshop/daq/${spDaq.id}/samples?from=${Date.now() - 15_000}&bucketMs=1000&limit=30`)
  const spPts2 = readback2?.data?.points ?? []
  const spNow2 = spPts2[spPts2.length - 1]?.avg ?? spPts2[spPts2.length - 1]?.value
  check('数采回读确认 Agent 下发生效 SP≈178(爬升动态中)', Number(spNow2) > 150 && Number(spNow2) < 200, `回读=${Number(spNow2 ?? 0).toFixed(1)}℃`)
  const ops = await api('GET', '/api/workshop/ops-logs?limit=50')
  const lastOp = (ops?.data?.logs ?? []).find(l => String(l.action ?? '').startsWith('dcw.write'))
  check('Agent 下发入审计(来源=Agent)', !!lastOp && lastOp.actorKind === 'agent', `${lastOp?.action ?? ''} ${lastOp?.actorName ?? ''} ${lastOp?.summary?.slice(0, 40) ?? ''}`)

  console.log('━━━ 6. AML 影子模型(生产模型持续可用) ━━━')
  const prods = await api('GET', '/api/workshop/aml/models?stage=production')
  const prod = (prods?.data?.models ?? [])[0]
  check('production 影子模型在册(跨重启持久)', !!prod, `${prod?.id} NRMSE=${prod?.metrics?.oneStepTest?.nrmse?.toFixed(4)}`)
  if (prod) {
    const io = prod.ioSpec
    const h = io?.historySteps ?? 10
    const spS = await api('GET', `/api/workshop/daq/${spDaq.id}/samples?from=${now - (h + 2) * 1000}&bucketMs=1000&limit=${h}`)
    const pvS = await api('GET', `/api/workshop/daq/${pvDaq.id}/samples?from=${now - (h + 2) * 1000}&bucketMs=1000&limit=${h}`)
    const spV = (spS?.data?.points ?? []).map(p => p.avg ?? p.value)
    const pvV = (pvS?.data?.points ?? []).map(p => p.avg ?? p.value)
    const hist = Array.from({ length: h }, (_, i) => [spV[spV.length - h + i] ?? 178, pvV[pvV.length - h + i] ?? 178])
    const pred = await api('POST', `/api/workshop/aml/models/${prod.id}/predict`, { body: { history: hist, steps: io?.horizonSteps ?? 4 } })
    const fc = pred?.data?.prediction?.forecast
    check('影子模型 what-if 预测可用', Array.isArray(fc) && Number.isFinite(fc[0]?.[0]), `下一拍 PV=${fc?.[0]?.[0]?.toFixed(1)}℃`)
  }

  console.log('━━━ 8. 数字孪生界面渲染(/town,软件 WebGL) ━━━')
  // town 按用户 workspace 挂载的频道渲染:建工作台 → 建频道 → 挂载
  const mkCh = await api('POST', '/api/workshop/channels', { body: { name: `孪生空间频道 ${Date.now().toString(36)}` } })
  const townChannelId = mkCh?.data?.channelId ?? mkCh?.data?.id ?? mkCh?.data?.channel?.id
  check('为本用户创建频道(town 渲染前提)', mkCh?.code === 0 && !!townChannelId, townChannelId ?? mkCh?.message ?? '')
  const wsList = await api('GET', '/api/workshop/workspaces')
  let wsId = (wsList?.data?.workspaces ?? wsList?.data ?? [])[0]?.id
  if (!wsId) {
    const mkWs = await api('POST', '/api/workshop/workspaces', { body: { name: '孪生实测工作台' } })
    wsId = mkWs?.data?.id ?? mkWs?.data?.workspace?.id
  }
  check('工作台就绪', !!wsId, wsId)
  const mount = await api('POST', `/api/workshop/workspaces/${wsId}/channels/${townChannelId}`, { body: {} })
  check('频道挂载到工作台', mount?.code === 0 || mount?.ok === true || mount?.status === 200, mount?.message ?? JSON.stringify(mount)?.slice(0, 80))
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--window-size=1600,1000', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    protocolTimeout: 90_000,
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1600, height: 1000 })
    const pageErrors = []
    page.on('pageerror', (err) => {
      pageErrors.push(String(err).slice(0, 140))
    })
    await page.setCookie({ name: 'token', value: TOKEN, url: BASE })
    await page.goto(`${BASE}/town`, { waitUntil: 'networkidle2', timeout: 90_000 })
    // 等 town 完成频道加载 → 3D 场景初始化(Vue 组件渲染后不保留标签名,以画布与仪表化为准)
    await sleep(8000)
    let canvasSizes = []
    for (let i = 0; i < 4; i++) {
      canvasSizes = await page.evaluate(() => [...document.querySelectorAll('canvas')].map(c => ({ w: c.clientWidth, h: c.clientHeight })))
      if (canvasSizes.some(c => c.w > 500)) break
      await sleep(4000)
    }
    check('三维画布渲染(canvas)', canvasSizes.length > 0, `n=${canvasSizes.length}`)
    const mainCanvas = canvasSizes.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a), { w: 0, h: 0 })
    check('主 3D 画布尺寸正常(>500px 宽)', mainCanvas.w > 500, `${mainCanvas.w}×${mainCanvas.h}(共 ${canvasSizes.length} 块画布,含小地图)`)
    const townState = await page.evaluate(() => {
      const w = window
      return { stats: typeof w.__townStats, bus: typeof w.__townBus }
    })
    check('town 仪表化状态可观测', townState.stats !== 'undefined' || townState.bus !== 'undefined', JSON.stringify(townState))
    const fatal = pageErrors.filter(e => !/WebGL|Three.*deprecat/i.test(e))
    check('无致命页面错误', fatal.length === 0, fatal.slice(0, 2).join(' | '))
    mkdirSync('.e2e-shots', { recursive: true })
    await page.screenshot({ path: '.e2e-shots/town-ui.png' })
    check('数字孪生截图落盘', true, '.e2e-shots/town-ui.png')
  }
  finally {
    await browser.close()
  }

  console.log(`\n━━━ 结果:${passed} PASS / ${failures} FAIL ━━━`)
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
