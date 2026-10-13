#!/usr/bin/env node
/**
 * tmp-e2e/prod-opt-ui-20261013.mjs —— 生产环境(3001 · 0.7.59 全新构建)完整优化场景验收:
 *   PLC 模拟(4031, cast-film-physics) → 建线(3 SV DCW + 3 PV DAQ + 3 SP 镜像 DAQ)
 *   → 基线配方(v2 授权面) → 优化作业频道(通用闭环优化模板 + KB 开 + 绑线 + 授权/委托)
 *   → 数采自动抓取(6 通道全有样本)
 *   → 优化闭环 R1:工艺工程师 recipe_propose → HITL 卡 → **前端 UI 真人批准(选方案+填意见+点批准)**
 *      → 整批下发 → PLC 读回 1.04 + SP 镜像通道证实 → 审计台账留痕
 *   → 优化闭环 R2:统一回退 recipe_rollback(dispatch)→ **后端 API 批准** → PLC 读回基线 1.00
 *   → 膜厚物理响应前后窗对比(模口↑ → 膜厚↑)
 *   → 频道智能:直派 lead 真引擎分析指令(有界等待回复)
 *   → UI 证据扫掠(/dcw/产线页 /operations /daq /aml /monitor 截图 + console 错误收集)
 *
 * 前置:3001=0.7.59 生产实例(admin@awshop.local 已注册);IDD 3210/8764;RAG 8770。
 * 用法:node tmp-e2e/prod-opt-ui-20261013.mjs [--keep]
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'http://127.0.0.1:3001'
const SIM_PORT = 4031
const SIM = `http://127.0.0.1:${SIM_PORT}`
const SIM_DIR = resolve(REPO, '..', 'plc-node-simulator-bench-4031')
const OUT_DIR = join(REPO, '.AgentWorkShop', 'analysis', 'prod-opt-20261013')
mkdirSync(OUT_DIR, { recursive: true })
// 本机 7890 代理会拦 localhost,进程级豁免
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.HTTP_PROXY = ''
process.env.HTTPS_PROXY = ''

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fails.push(name); console.log(`  ✖ ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJson = async (url, token) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: token ? { authorization: `Bearer ${token}` } : {} })
    return await r.json()
  }
  catch { return null }
}
let TOKEN = ''
const api = async (method, path, body, token = TOKEN) => {
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    return { status: r.status, ...(await r.json().catch(() => ({}))) }
  }
  catch (e) { return { status: 0, message: e.message } }
}
/** Agent 工具桥直调(返回 { text, isError }) */
const inv = async (agentId, tool, args, timeoutMs = 400_000) => {
  const res = await fetch(BASE + '/api/workshop/agent-tools/invoke', {
    method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify({ agentId, tool, args }), signal: AbortSignal.timeout(timeoutMs),
  })
  const j = await res.json().catch(() => ({}))
  return j?.data?.result ?? { text: JSON.stringify(j?.data ?? j).slice(0, 200), isError: j?.code !== 0 }
}

/* ═══ P0 平台健康门 ═══ */
console.log('\n[P0] 平台健康门(生产 3001)')
const health = await getJson(`${BASE}/api/health`)
ok('平台 3001 健康(0.7.59 全新构建)', health?.data?.status === 'ok' && String(health?.data?.version) === '0.7.59', `v=${health?.data?.version} mode=${health?.data?.mode}`)
const login = await api('POST', '/api/users/login', { email: 'admin@awshop.local', password: 'Admin@2026Closed' })
TOKEN = login?.data?.token ?? ''
ok('admin 登录', !!TOKEN, login?.message ?? '')
const diagH = await getJson(`${BASE}/api/plugins/diag-bridge/health`, TOKEN)
ok('IDD 插件桥(token 接受+远端 ok)', diagH?.token?.accepted === true && diagH?.remote?.status === 'ok', JSON.stringify(diagH?.remote ?? {}).slice(0, 100))
const ragH = await getJson(`${BASE}/api/plugins/rag-bridge/health`, TOKEN)
ok('RAG 插件桥(token 接受+后端 ok)', ragH?.token?.accepted === true && ragH?.backend?.ok === true, `kb=${ragH?.kb?.name}`)

/* ═══ P1 PLC 模拟器(4031 专用实例) ═══ */
console.log('\n[P1] PLC 模拟器(4031, cast-film-physics)')
{
  const psi = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-NetTCPConnection -LocalPort ${SIM_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`], { encoding: 'utf8' })
  const pid = Number(psi.stdout.trim())
  if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  await sleep(1500)
  process.env.SIM_BASE = SIM
  process.env.SIM_SHADOW_DIR = SIM_DIR
  const { ensureSimulator, applyPreset } = await import('../bench/lib/sim.mjs')
  await ensureSimulator({ log: () => {} })
  await applyPreset('cast-film-physics')
}
const simState = await getJson(`${SIM}/api/plant/state`)
ok('模拟器运行中(cast-film-physics)', simState?.data?.running === true, JSON.stringify(simState?.data ?? {}).slice(0, 100))
const simDevices = (await getJson(`${SIM}/api/nodes`))?.data ?? []
ok('模拟器节点在册', Array.isArray(simDevices) && simDevices.length > 0, `nodes=${simDevices.length}`)

/* ═══ MCP 通道(显式钉住 3001,防误连 3111) ═══ */
console.log('\n[MCP] 启动 stdio MCP(AW_BASE_URL=3001)')
const mcp = spawn(process.execPath, [join(REPO, 'mcp', 'aw-mcp-server.mjs')], {
  cwd: REPO,
  env: { ...process.env, AW_BASE_URL: BASE, AW_TOKEN: TOKEN },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const rl = createInterface({ input: mcp.stdout })
const pending = new Map(); let nextId = 1
rl.on('line', (line) => {
  try { const m = JSON.parse(line); if (m?.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
  catch { /* 跳过非 JSON 行 */ }
})
const call = async (name, args = {}, timeoutMs = 120_000) => {
  const res = await new Promise((res2, rej2) => {
    const id = nextId++
    const t = setTimeout(() => { pending.delete(id); rej2(new Error(`rpc 超时: ${name}`)) }, timeoutMs)
    pending.set(id, (m) => { clearTimeout(t); res2(m) })
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`)
  })
  const text = res?.result?.content?.[0]?.text ?? ''
  return { isError: Boolean(res?.result?.isError), text, data: (() => {
    try { return JSON.parse(text) }
    catch { return null }
  })() }
}

/* ═══ P2 建线(3 SV + 3 PV + 3 SP 镜像)+ 配方 + 开跑 ═══ */
console.log('\n[P2] 建线 + 节点 + 配方 + 开跑')
const line = await call('aw_line_create', { name: `产线验收线-${Date.now().toString(36)}` })
const lineId = line.data?.line?.id ?? line.data?.id
ok('产线创建', !!lineId, line.text.slice(0, 120))
const product = await call('aw_product_create', { lineId, name: '产线验收产品' })
const productId = product.data?.product?.id ?? product.data?.id
ok('产品创建', !!productId, product.text.slice(0, 100))

const dcw = {}, daq = {}
const wantAct = [
  { id: 'zone1-sp', col: 'zone1_sp', unit: '℃', sem: 'SV 设定点:一区加热温度,影响熔体温度进而影响膜厚' },
  { id: 'linespeed-sp', col: 'linespeed_sp', unit: 'm/min', sem: 'SV 设定点:产线速度,升速减薄、降速增厚' },
  { id: 'diegap-sp', col: 'diegap_sp', unit: 'mm', sem: 'SV 设定点:模口间隙,间隙增大膜厚近似线性增厚' },
]
const wantSen = [
  { id: 'melt-temp', col: 'melt_temp', unit: '℃', sem: 'PV 实时检测:熔体温度,跟随加热 SV 滞后 1-2 分钟' },
  { id: 'melt-pressure', col: 'melt_pressure', unit: 'MPa', sem: 'PV 实时检测:熔体压力,反映泵送与滤网状态' },
  { id: 'film-thickness', col: 'film_thickness', unit: 'μm', sem: 'PV 实时检测:流延膜厚度(核心质量指标,优化目标),随线速/模口滞后波动' },
]
const wantMirror = [
  { id: 'zone1-sp', col: 'zone1_sp_pv', unit: '℃', sem: 'SP 执行值读回镜像(DAQ 只读面):一区加热设定' },
  { id: 'linespeed-sp', col: 'linespeed_sp_pv', unit: 'm/min', sem: 'SP 执行值读回镜像(DAQ 只读面):产线速度设定' },
  { id: 'diegap-sp', col: 'diegap_sp_pv', unit: 'mm', sem: 'SP 执行值读回镜像(DAQ 只读面):模口间隙设定' },
]
for (const dev of simDevices) {
  const exp = (await getJson(`${SIM}/api/nodes/${dev.id}/export`))?.data?.items ?? []
  const sigOf = id => (dev.signals ?? []).find(s => s.id === id)
  for (const w of wantAct) {
    const sig = sigOf(w.id); if (!sig || dcw[w.id]) continue
    const item = exp.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
    const r = await call('aw_dcw_create', { name: `验收-${sig.name}`, templateRef: 'dcw-temp-sp', driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, holdIntervalMs: 0, stepLimit: 5, semantics: w.sem })
    dcw[w.id] = r.data?.node?.id ?? r.data?.id
  }
  for (const w of [...wantSen, ...wantMirror]) {
    const sig = sigOf(w.id); if (!sig) continue
    const key = w.col; if (daq[key]) continue
    const item = exp.find(i => i.signal === sig.name); if (!item?.driverConfig) continue
    const r = await call('aw_daq_create', { name: `验收-${sig.name}${w.col.endsWith('_pv') && !wantSen.some(s => s.id === w.id) ? '-回读' : ''}`, templateRef: 'daq-temp-tc', driver: dev.protocol, driverConfig: item.driverConfig, unit: sig.unit, min: sig.min, max: sig.max, decimals: sig.decimals ?? 2, lineId, intervalMs: 1000, semantics: w.sem })
    daq[key] = r.data?.node?.id ?? r.data?.id
  }
}
const pvIds = wantSen.map(w => daq[w.col])
const mirrorGap = daq['diegap_sp_pv']
ok('建节点 3 SV(DCW)+ 3 PV + 3 SP 镜像(DAQ)', wantAct.every(w => dcw[w.id]) && wantSen.every(w => daq[w.col]) && !!mirrorGap,
  `dcw=${Object.keys(dcw).length} daq=${Object.keys(daq).length}`)

const recipe = await call('aw_recipe_create', {
  productId, name: '产线验收基线配方', description: '流延膜验收基线(zone 200℃ / 线速 95 / 模口 1.0)',
  params: [
    { nodeId: dcw['zone1-sp'], value: 200, min: 190, max: 225 },
    { nodeId: dcw['linespeed-sp'], value: 95, min: 85, max: 110 },
    { nodeId: dcw['diegap-sp'], value: 1.0, min: 0.85, max: 1.15 },
  ],
})
const recipeId = recipe.data?.recipe?.id ?? recipe.data?.id
ok('基线配方创建(3 参数,v2 授权面)', !!recipeId, recipe.text.slice(0, 120))
const ctl = await call('aw_daq_controller', { action: 'start' })
ok('数采控制器启动(自动抓取)', !ctl.isError, ctl.text.slice(0, 100))
const lineStart = await call('aw_line_start', { lineId, recipeId })
ok('产线开跑(配方生效)', !lineStart.isError, lineStart.text.slice(0, 100))
const lineStartAt = Date.now()

/* ═══ P3 优化作业频道(模板实例化 + KB + 绑线 + 授权/委托) ═══ */
console.log('\n[P3] 优化作业频道')
const inst = await api('POST', '/api/workshop/channel-templates/chtpl-generic-optimize-default/instantiate',
  { name: `产线验收优化频道-${Date.now().toString(36)}`, bindLineId: lineId, enableKnowledgeBase: true })
const channelId = inst?.data?.channelId ?? inst?.data?.channel?.id ?? ''
ok('频道实例化(generic-optimize,KB 开,绑线)', !!channelId, JSON.stringify(inst?.data ?? inst?.message ?? {}).slice(0, 140))
const chListOf = async () => {
  const d = (await api('GET', '/api/workshop/channels'))?.data
  return d?.items ?? (Array.isArray(d) ? d : [])
}
let leadId = inst?.data?.leadAgentId ?? ''
for (let i = 0; i < 15 && !leadId; i++) {
  await sleep(2000)
  leadId = (await chListOf()).find(c => c.id === channelId)?.leadAgentId ?? ''
}
ok('lead 身份可读', !!leadId, `lead=${String(leadId).slice(0, 10)}`)
let members = []
for (let i = 0; i < 10; i++) {
  const membersRaw = (await api('GET', `/api/workshop/channels/${channelId}/agents`))?.data
  members = membersRaw?.items ?? (Array.isArray(membersRaw) ? membersRaw : membersRaw?.agents ?? [])
  if (members.length >= 4) break
  await sleep(2000)
}
ok('四成员编成在册(lead+3 worker)', members.length >= 4, `members=${members.length}: ${members.map(m => m.name).join('/')}`)
const byName = n => members.find(m => String(m.name).includes(n))?.agentId ?? members.find(m => String(m.name).includes(n))?.id ?? ''
const procEngId = byName('工艺工程师')
const analystId = byName('数据分析师')

const allDaqIds = Object.values(daq)
let bindOk = 0; const bindErrs = []
// 权限 v2:DCW 节点不直接绑定 —— 写走 recipe(kind='recipe')操作面;DAQ 只读面按节点绑
for (const [nodeId, kind] of [[recipeId, 'recipe'], ...allDaqIds.map(id => [id, 'daq'])]) {
  const g = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: leadId, nodeId, kind, mode: 'manual' })
  if (g?.code === 0 || g?.status === 200) bindOk += 1
  else bindErrs.push(`${kind}:${String(nodeId).slice(0, 8)} ${g?.message ?? g?.code}`)
}
ok('lead 绑定(recipe + 6 DAQ, v2 面)', bindOk === 7, bindOk === 7 ? '7/7' : bindErrs.join(' | ').slice(0, 160))
const grantProc = await api('POST', '/api/workshop/agent-tools/bindings/grant', { channelId, agentId: procEngId, nodeIds: [recipeId, ...allDaqIds], mode: 'manual' })
const grantAnalyst = await api('POST', '/api/workshop/agent-tools/bindings/grant', { channelId, agentId: analystId, nodeIds: allDaqIds, mode: 'manual' })
ok('lead→工艺工程师/数据分析师 委托', (grantProc?.code === 0) && (grantAnalyst?.code === 0), `${grantProc?.code}/${grantAnalyst?.code}`)
const act = await api('POST', `/api/workshop/channels/${channelId}/activate`, {})
ok('频道激活', act?.code === 0 || act?.status === 200, act?.message ?? '')

/* ═══ P4 数采自动抓取验证(6 通道) ═══ */
console.log('\n[P4] 数采自动抓取(等 75s 验证样本流)')
await sleep(75_000)
let sampleOk = 0
for (const w of [...wantSen, ...wantMirror]) {
  const s = await call('aw_daq_samples', { id: daq[w.col], fromMs: lineStartAt, toMs: Date.now(), bucketMs: 5000, limit: 200 })
  const n = s.data?.points?.length ?? 0
  if (n > 0) sampleOk++
  console.log(`    ↳ ${w.col}: ${n} pts`)
}
ok('6 通道全部有自动样本(3 PV + 3 SP 镜像)', sampleOk === 6, `${sampleOk}/6`)

/* ═══ 工具函数:膜厚窗口均值 ═══ */
const thicknessMean = async (fromMs, toMs) => {
  const s = await call('aw_daq_samples', { id: daq['film-thickness'], fromMs, toMs, bucketMs: 2000, limit: 400 })
  const pts = (s.data?.points ?? []).map(p => Number(p.avg ?? p.value)).filter(Number.isFinite)
  if (!pts.length) return null
  return pts.reduce((a, b) => a + b, 0) / pts.length
}

/* ═══ P5 优化闭环 R1:提案 → 前端 UI 真人批准 → 下发 → 设备证实 ═══ */
console.log('\n[P5] R1:recipe_propose → UI 批准 → PLC 读回')
const preMean = await thicknessMean(Date.now() - 60_000, Date.now())
ok(`调整前膜厚基线均值=${Number(preMean).toFixed(2)}μm`, Number.isFinite(preMean), '')

const NEW_GAP = 1.04
const propP = inv(procEngId, 'recipe_propose', {
  recipe_id: recipeId,
  emergency: true,
  packages: [{
    name: 'AC-1 模口微调增厚',
    rationale: '膜厚偏薄,按物理语义模口间隙↑→膜厚近似线性↑,有界单变量(1.00→1.04,≤步限)',
    params: [{ node_id: dcw['diegap-sp'], to: NEW_GAP, basis: 'P4 数采观测:6 通道样本流正常;膜厚基线取 60s 窗', exp_ref: '产线验收 P4/P5 台账' }],
  }],
})
// 等审批卡出现(最长 120s)
let card = null
for (let i = 0; i < 60 && !card; i++) {
  await sleep(2000)
  const pend = await api('GET', '/api/workshop/hitl/pending')
  const items = pend?.data?.items ?? pend?.data?.cards ?? []
  card = items.filter(x => x.kind === 'dcw-approval' && /recipe-propose:/.test(String(x.nodeId ?? '')))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
}
ok('HITL 审批卡已生成(dcw-approval/recipe-propose)', !!card, card ? card.id : '120s 未出现')

/* ── 前端 UI 真人路径:打开产线页 → 选方案 → 填意见 → 点批准 ── */
let uiApproved = false; let uiErr = ''
if (card) {
  const { default: puppeteer } = await import('puppeteer-core')
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1680,1050', '--lang=zh-CN'],
    protocolTimeout: 180000,
  })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1680, height: 1050, deviceScaleFactor: 1 })
    const consoleErrs = []
    page.on('pageerror', e => consoleErrs.push(`pageerror: ${e.message.slice(0, 160)}`))
    page.on('console', (m) => { if (m.type() === 'error' && consoleErrs.length < 20) consoleErrs.push(`console: ${m.text().slice(0, 160)}`) })
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
    await page.setCookie({ name: 'token', value: TOKEN, url: BASE, httpOnly: false })
    await page.goto(`${BASE}/dcw/${lineId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    // 等审批卡渲染(最长 40s)
    const hasCard = await page.waitForSelector('.rp-card', { timeout: 40_000 }).then(() => true).catch(() => false)
    ok('UI:产线页渲染出配方下发审批卡', hasCard, `${BASE}/dcw/${lineId}`)
    if (hasCard) {
      await page.screenshot({ path: join(OUT_DIR, 'ui-r1-card-before.png'), timeout: 30000 })
      // 选方案 tab(第一个)
      const tab = await page.$('.rp-tab')
      await tab?.click()
      await sleep(600)
      // 填意见
      const comment = await page.$('.rp-comment')
      await comment?.type('产线验收:批准该有界微调(模口 1.00→1.04),观察膜厚响应', { delay: 10 })
      await page.screenshot({ path: join(OUT_DIR, 'ui-r1-card-selected.png'), timeout: 30000 })
      // 点批准
      const okBtn = await page.$('.rp-ok')
      await okBtn?.click()
      // 等卡片消失(裁决完成)
      const gone = await page.waitForFunction(() => !document.querySelector('.rp-card'), { timeout: 90_000 }).then(() => true).catch(() => false)
      await sleep(1500)
      await page.screenshot({ path: join(OUT_DIR, 'ui-r1-card-after.png'), timeout: 30000 })
      uiApproved = gone
      uiErr = gone ? '' : '90s 卡片未消失'
      consoleErrs.length && console.log(`    ↳ UI console: ${consoleErrs.slice(0, 3).join(' | ')}`)
    }
    // 浏览器留给 P8 复用:挂到全局
    globalThis.__browser = browser
    globalThis.__page = page
  }
  catch (e) {
    uiErr = e.message
    await browser.close().catch(() => {})
  }
}
ok('UI:真人点击批准成功(卡片裁决消失)', uiApproved, uiErr)
const prop = await propP
const propTxt = String(prop.text ?? '')
ok('提案回执:已获批并受理下发', /已获批/.test(propTxt) && !/未获批准|超时未批/.test(propTxt), propTxt.split('\n')[0]?.slice(0, 150))
const runId = /runId[:：]\s*(rr-[\w-]+)/.exec(propTxt)?.[1] ?? ''
ok('回执携带 runId(可回访)', !!runId, runId)

// 设备证实:PLC 读回 diegap == 1.04
let devVal = null
for (let i = 0; i < 12; i++) {
  await sleep(5000)
  const rd = await call('aw_dcw_read', { id: dcw['diegap-sp'] })
  const v = Number(rd.data?.value ?? rd.data?.node?.value ?? NaN)
  devVal = v
  if (Number.isFinite(v) && Math.abs(v - NEW_GAP) < 0.005) break
}
ok(`设备证实:PLC 读回模口=${NEW_GAP}(写穿生效)`, Math.abs(Number(devVal) - NEW_GAP) < 0.005, `device=${devVal}`)
// SP 镜像通道证实(DAQ 只读面看到同一物理值)
let mirrorVal = null
for (let i = 0; i < 10; i++) {
  await sleep(4000)
  const s = await call('aw_daq_samples', { id: mirrorGap, fromMs: Date.now() - 20_000, toMs: Date.now(), bucketMs: 1000, limit: 20 })
  const last = (s.data?.points ?? []).slice(-1)[0]
  if (last) {
    mirrorVal = Number(last.avg ?? last.value)
    if (Math.abs(mirrorVal - NEW_GAP) < 0.01) break
  }
}
ok(`镜像通道证实:DAQ 读回模口=${NEW_GAP}`, Math.abs(Number(mirrorVal) - NEW_GAP) < 0.01, `mirror=${mirrorVal}`)
// 审计台账留痕(审批 + 下发)
const audit = await api('GET', '/api/workshop/audit?limit=100')
const apprRow = (audit?.data?.entries ?? []).find(l => /approv/i.test(String(l.action ?? '')) && String(JSON.stringify(l.detail ?? {})).includes(channelId))
ok('HITL 审批留痕入审计台账', !!apprRow, apprRow ? `${apprRow.action}@${String(apprRow.at ?? '').slice(11, 19)}` : `(audit ${(audit?.data?.entries ?? []).length} 条)`)

/* ═══ P6 R2:膜厚物理响应 + 统一回退(API 批准)→ 读回基线 ═══ */
console.log('\n[P6] R2:膜厚响应观察 → recipe_rollback → API 批准 → 读回基线')
console.log('    ↳ 等膜厚对模口阶跃响应(120s)…')
await sleep(120_000)
const postMean = await thicknessMean(Date.now() - 90_000, Date.now())
const shift = Number(postMean) - Number(preMean)
ok(`膜厚响应:模口↑后均值 ${Number(preMean).toFixed(2)}→${Number(postMean).toFixed(2)}μm(Δ=${shift.toFixed(2)})`, Number.isFinite(postMean) && shift > 0, `shift=${shift.toFixed(2)}μm`)

const roll = await inv(procEngId, 'recipe_rollback', {
  recipe_id: recipeId, to_last_good: true, dispatch: true, emergency: true,
  reason: '产线验收:调整验证完成,统一回退至基线配方(治理闭环恢复)',
})
const rollTxt = String(roll.text ?? '')
let rollCardId = /(?:ap-[\w-]+)/.exec(rollTxt)?.[0] ?? ''
// 回退也走 HITL:等卡(用 pending 快照匹配)
let rollCard = null
for (let i = 0; i < 45 && !rollCard; i++) {
  await sleep(2000)
  const pend = await api('GET', '/api/workshop/hitl/pending')
  const items = pend?.data?.items ?? pend?.data?.cards ?? []
  rollCard = items.filter(x => x.kind === 'dcw-approval' && /rollback/i.test(String(x.nodeId ?? '') + String(x.title ?? '')))[0]
    ?? items.filter(x => x.kind === 'dcw-approval' && !/recipe-propose:/.test(String(x.nodeId ?? '')))[0]
}
ok('回退审批卡已生成(治理门同样拦截回退)', !!rollCard, rollCard ? rollCard.id : rollTxt.split('\n')[0]?.slice(0, 120))
if (rollCard) {
  // 后端 API 人工批准(与 R1 的 UI 路径互补 —— 前后端双路径都验)
  const resp = await api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: rollCard.id, confirmed: true, choice: 0, comment: '产线验收:批准统一回退,恢复基线配方' })
  ok('API 路径批准回退', resp?.code === 0 || resp?.status === 200, JSON.stringify(resp?.message ?? resp?.data ?? {}).slice(0, 120))
}
await sleep(8000)
let backVal = null
for (let i = 0; i < 12; i++) {
  const rd = await call('aw_dcw_read', { id: dcw['diegap-sp'] })
  const v = Number(rd.data?.value ?? rd.data?.node?.value ?? NaN)
  backVal = v
  if (Number.isFinite(v) && Math.abs(v - 1.0) < 0.005) break
  await sleep(5000)
}
ok('设备证实:PLC 读回模口=1.0(回退写穿恢复基线)', Math.abs(Number(backVal) - 1.0) < 0.005, `device=${backVal}`)
const rollDispatched = /已获批|已回退|已下发/.test(rollTxt) || Math.abs(Number(backVal) - 1.0) < 0.005
ok('回退链闭合(提案→批准→整批恢复)', rollDispatched, rollTxt.split('\n')[0]?.slice(0, 120))

/* ═══ P7 频道智能:直派 lead 真引擎分析(有界) ═══ */
console.log('\n[P7] 频道智能:lead 真引擎分析指令')
const sendAt = Date.now()
const send = await api('POST', `/api/workshop/channels/${channelId}/messages`, {
  toAgentId: leadId,
  text: `请结合最近 5 分钟数采数据(膜厚/熔温/熔压,含模口 1.00→1.04→回退 1.00 两次操作)评估当前膜厚稳定性,并给出下一步配方调整建议(有界、可执行)。`,
  priority: 'task', requireReply: true,
})
ok('分析指令送达频道', send?.code === 0 || send?.status === 200, JSON.stringify(send?.message ?? {}).slice(0, 100))
let reply = ''
for (let i = 0; i < 27; i++) {
  await sleep(20_000)
  const msgs = (await api('GET', `/api/workshop/channels/${channelId}/messages?limit=40`))?.data
  const arr = msgs?.items ?? (Array.isArray(msgs) ? msgs : msgs?.messages ?? [])
  const hit = arr.find(m => String(m.agentId ?? m.fromAgentId ?? '') === leadId
    && Date.parse(String(m.at ?? m.createdAt ?? '')) > sendAt
    && /膜厚|模口|稳定性|建议/.test(String(m.text ?? m.content ?? '')))
  if (hit) { reply = String(hit.text ?? hit.content ?? ''); break }
  if (i % 3 === 0) console.log(`    ↳ (${(i + 1) * 20 / 60 | 0}min) 等待 lead 回复…`)
}
ok('lead 真引擎回复分析(数据面+建议)', reply.length > 60, reply.slice(0, 120) || '(9min 未回——引擎相位延迟)')

/* ═══ P8 UI 证据扫掠 ═══ */
console.log('\n[P8] UI 证据扫掠(截图)')
{
  const browser = globalThis.__browser
  const page = globalThis.__page
  if (browser && page) {
    const SHOTS = [
      ['dcw-line', `/dcw/${lineId}`, 8000],
      ['operations', '/operations', 8000],
      ['daq', '/daq', 8000],
      ['aml', '/aml', 8000],
      ['monitor', `/monitor?channelId=${channelId}`, 9000],
    ]
    for (const [name, path, settle] of SHOTS) {
      try {
        await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
        await new Promise(r => setTimeout(r, settle))
        await page.screenshot({ path: join(OUT_DIR, `ui-${name}.png`), fullPage: false, timeout: 30000 })
        console.log(`    ↳ ${name} → ui-${name}.png`)
      }
      catch (e) { console.log(`    ↳ ${name} FAILED: ${e.message.slice(0, 100)}`) }
    }
    await browser.close().catch(() => {})
  }
  else console.log('    ↳ (浏览器未保留,跳过扫掠)')
}

/* ═══ 清场与结论 ═══ */
console.log('\n[清场]')
mcp.stdin.end(); mcp.kill()
writeFileSync(join(OUT_DIR, 'state.json'), JSON.stringify({
  at: new Date().toISOString(), base: BASE, lineId, channelId, recipeId,
  dcw, daq, runId, preMean, postMean, devGap: devVal, backGap: backVal,
  replyHead: reply.slice(0, 200),
}, null, 2))
console.log(`(产物目录:${OUT_DIR} —— 截图+state.json;模拟器 4031 与产线保留运行供查验)`)

console.log('')
console.log('════════════════════════════════════════')
console.log(`  生产环境优化场景验收:${pass} PASS / ${fails.length} FAIL`)
for (const f of fails) console.log(`  ✖ ${f}`)
console.log('════════════════════════════════════════')
console.log(`频道: ${channelId}`)
console.log(`产线: ${lineId}  配方: ${recipeId}`)
process.exit(fails.length ? 1 : 0)
