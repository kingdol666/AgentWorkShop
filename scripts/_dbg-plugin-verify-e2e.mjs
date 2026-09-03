/**
 * 插件扩展全栈验证 A(数据管线 + 前端 + 孪生):
 * ①插件模板+插件驱动建节点 → 产线开跑 → mock 一次性 vector 采样
 * ②sink 加工断言(×2 确定性签名:argmax=6、points[6]≈1.08、points[0]≈0.90、verifyTag=1)
 * ③DB 事实(REST frames = Timescale 读取)
 * ④/daq 列表页实时值变化(浏览器)
 * ⑤/town 数字孪生右轨面板实时变化(浏览器)
 * 产出 .e2e-plugin-ctx.json 供 Agent 读库段使用;节点保留(--cleanup=1 时清理)。
 * 运行: node scripts/_dbg-plugin-verify-e2e.mjs
 */
import puppeteer from 'puppeteer-core'
import { writeFileSync, readFileSync } from 'node:fs'

const ROOT = process.env.E2E_ROOT ?? 'http://127.0.0.1:3000'
const CLEANUP = process.env.CLEANUP === '1'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failed = 0
const check = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!cond) failed++ }

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const cookie = { name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())

// ===== ① 插件模板/驱动在目录 =====
const daq0 = (await j('/api/workshop/daq')).data
const tpl = daq0.templates.find(t => t.key === 'plug-verify-x2-profile')
check('①插件模板在目录(plugin 标记,vector)', !!tpl && tpl.plugin != null && tpl.signalKind === 'vector')

// ===== ② 开跑 + 插件模板 + 插件驱动建节点 =====
const d = (await j('/api/workshop/dcw')).data
const cand = d.lines.map(l => ({ line: l, recipe: d.recipes.find(r => r.lineId === l.id) })).find(x => x.recipe)
await j(`/api/workshop/dcw/lines/${cand.line.id}/stop`, 'POST').catch(() => {})
await sleep(800)
await j(`/api/workshop/dcw/lines/${cand.line.id}/start`, 'POST', { recipeId: cand.recipe.id })
const node = (await j('/api/workshop/daq', 'POST', {
  templateRef: 'plug-verify-x2-profile',
  driver: 'verify-burst',
  lineId: cand.line.id,
  name: '全栈验证 ×2 轮廓',
  posX: 120, posZ: 120,
})).data.node
check('②节点创建(插件模板+插件驱动)', node?.driver === 'verify-burst', `driver=${node?.driver}`)

// ===== ③ 等帧 → sink 加工确定性断言 =====
let frames = []
for (let i = 0; i < 15; i++) {
  await sleep(2000)
  frames = (await j(`/api/workshop/daq/${node.id}/frames?limit=5`)).data.frames
  if (frames.length >= 3) break
}
check('③帧入库(Rest = Timescale 事实源)', frames.length >= 3, `${frames.length} 帧`)
if (frames.length >= 3) {
  const f = frames[0]
  const pts = f.points ?? []
  const argmax = pts.reduce((best, p, i) => (p > pts[best] ? i : best), 0)
  check('一次性 vector:24 点完整轮廓', pts.length === 24, `len=${pts.length}`)
  check('×2 标定签名:argmax=6(尖峰位)', argmax === 6, `argmax=${argmax}`)
  check('×2 标定签名:points[6]∈[1.06,1.12](=2×0.54)', pts[6] >= 1.06 && pts[6] <= 1.12, String(pts[6]))
  check('×2 标定签名:points[0]∈[0.88,0.92](=2×0.45)', pts[0] >= 0.88 && pts[0] <= 0.92, String(pts[0]))
  check('插件处理器指纹:metrics.verifyTag=1', f.metrics.verifyTag === 1)
  check('内置 derive-metric 在插件后执行:max=points[6]', Math.abs((f.metrics.max ?? 0) - pts[6]) < 0.001, `max=${f.metrics.max}`)
  check('产线打标继承', f.lineId === cand.line.id)
}

// ===== ④/⑤ 浏览器:/daq 列表实时 + /town 孪生面板实时 =====
const twins = (await j('/api/workshop/device-twins')).data
const twinsList = twins.twins ?? twins
const device = twinsList.find(t => t.kind !== 'daq' && t.kind !== 'dcw')
if (device) await j(`/api/workshop/daq/${node.id}/bind`, 'POST', { deviceId: device.id })

const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie(cookie)
try {
  // ④ /daq 列表页
  await page.goto(`${ROOT}/daq`, { waitUntil: 'networkidle2', timeout: 90000 })
  await sleep(5000)
  const rowVal = () => page.evaluate(() => {
    const row = [...document.querySelectorAll('tbody tr')].find(r => r.textContent?.includes('全栈验证'))
    const m = row?.textContent?.match(/(\d+\.\d+)\s*mm/)
    return m ? m[1] : null
  })
  const v1 = await rowVal()
  await sleep(4500)
  const v2 = await rowVal()
  check('④/daq 列表页出现插件节点行', v1 != null, `v1=${v1}`)
  check('④/daq 实时值变化(WS 帧驱动)', v1 != null && v2 != null && v1 !== v2, `${v1} → ${v2}`)

  // ⑤ /town 数字孪生
  await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await sleep(20000)
  const panel = () => page.evaluate(() => {
    const item = [...document.querySelectorAll('.twin-daq .daq-item')].find(e => e.textContent?.includes('标定轮廓'))
    return { text: item?.textContent?.replace(/\s+/g, '') ?? '', val: item?.querySelector('b')?.textContent?.replace(/\s+/g, '') ?? null }
  })
  const p1 = await panel()
  await sleep(5000)
  const p2 = await panel()
  check('⑤/town 孪生面板出现插件节点行(标定轮廓)', p1.text !== '', p1.text.slice(0, 60))
  check('⑤/town 面板实时值变化(加工后量级)', p1.val != null && p2.val != null && p1.val !== p2.val, `${p1.val} → ${p2.val}`)
} finally {
  await browser.close().catch(() => {})
}

// ===== Agent 绑定(供读库段)=====
const agents = (await j('/api/workshop/agents')).data
const list = agents.agents ?? agents
const agent = list.find(a => a.enabled !== 0 && a.role === 'worker') ?? list[0]
await fetch(`${ROOT}/api/workshop/agent-tools/bindings`, { method: 'POST', headers: H, body: JSON.stringify({ agentId: agent.id, nodeId: node.id, kind: 'daq', mode: 'manual' }) }).then(r => r.json())
writeFileSync('.e2e-plugin-ctx.json', JSON.stringify({ nodeId: node.id, agentId: agent.id, lineId: cand.line.id }))

if (CLEANUP) {
  await j(`/api/workshop/daq/${node.id}`, 'DELETE').catch(() => {})
  await j(`/api/workshop/dcw/lines/${cand.line.id}/stop`, 'POST').catch(() => {})
  console.log('(cleanup 模式:节点已删/线已停)')
} else {
  console.log(`(节点 ${node.id} 与产线运行保留,供 Agent 段/浏览器复验;CLEANUP=1 可清理)`)
}

console.log(failed === 0 ? '\nSTACK-A ALL PASS' : `\nSTACK-A FAILED(${failed})`)
process.exit(failed === 0 ? 0 : 1)
