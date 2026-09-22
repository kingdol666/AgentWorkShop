/**
 * UI 全路由爬测(admin 登录态):20 条路由逐页访问,收集
 *   ① 控制台 error / pageerror(含 hydration mismatch)
 *   ② 全部 /api/ 响应中 >=400 的「死 API」
 *   ③ 渲染完整性(正文非空 + 无错误边界)
 *   ④ 每页可交互元素计数(异常归零 = 页面壳没挂上)
 * 运行: AW_BASE=http://127.0.0.1:3001 node scripts/_dbg-ui-fullcrawl.mjs
 */
import { launch, openPage, sleep } from './ui/lib.mjs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const api = async (m, p, body, token) => {
  const h = { 'content-type': 'application/json' }
  if (token) h.authorization = `Bearer ${token}`
  const r = await fetch(BASE + p, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined })
  return r.json().catch(() => ({}))
}

const login = await api('POST', '/api/users/login', { email: process.env.E2E_USER ?? 'admin@awshop.local', password: process.env.E2E_PASS ?? 'admin123' })
const token = login.data?.token
if (!token) { console.error('FATAL 管理员登录失败', login.message); process.exit(1) }

// 真实实体 id → 详情路由
const first = (d, k) => (Array.isArray(d) ? d : d?.[k] ?? [])[0]
const daqNode = first((await api('GET', '/api/workshop/daq', null, token)).data, 'nodes')
const dcwNode = first((await api('GET', '/api/workshop/dcw', null, token)).data, 'nodes')
const ws = first((await api('GET', '/api/workshop/workspaces', null, token)).data, undefined)

const ROUTES = [
  ['/', '仪表盘'],
  ['/workshop', 'Agent 工作台'],
  ['/workshop/agents', 'Agent 管理'],
  ['/workshop/teams', '团队/频道'],
  ['/workshop/channel-templates', '频道模板'],
  ['/workshop/schedules', '定时任务'],
  ['/workshop/w/' + (ws?.id ?? 'none'), '工作区详情'],
  ['/monitor', '实时监控 HITL'],
  ['/daq', '数采中心'],
  ['/daq/' + (daqNode?.id ?? 'none'), '数采详情'],
  ['/dcw', '产线作业'],
  ['/dcw/' + (dcwNode?.id ?? 'none'), '产线详情'],
  ['/aml', '自动建模实验室'],
  ['/town', '数字孪生'],
  ['/logs', '审计日志'],
  ['/permissions', '产线权限'],
  ['/plugins', '插件'],
  ['/settings', '设置'],
  ['/tokens', 'API Token'],
  ['/users', '用户'],
]

const browser = await launch({ width: 1440, height: 900 })
let failed = 0, passed = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed++; else failed++
}

for (const [path, name] of ROUTES) {
  const page = await openPage(browser, { token })
  const consoleErrs = []
  const deadApis = []
  page.on('pageerror', e => consoleErrs.push(String(e?.message ?? e).slice(0, 160)))
  page.on('console', (m) => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 160)) })
  page.on('response', (r) => {
    const u = r.url()
    if (u.includes('/api/') && r.status() >= 400) deadApis.push(`${r.status()} ${u.replace(BASE, '').slice(0, 90)}`)
  })
  try {
    await page.goto(BASE + path, { waitUntil: 'networkidle2', timeout: 30000 })
  }
  catch { await sleep(3000) }
  await sleep(2500)
  const info = await page.evaluate(() => ({
    textLen: (document.body.innerText || '').trim().length,
    buttons: document.querySelectorAll('button, [role="button"], .ant-btn').length,
    errBoundary: /Application error|发生错误|页面走丢了|Internal Server Error/.test(document.body.innerText || ''),
  }))
  const ok = info.textLen > 40 && !info.errBoundary
  check(`${name}(${path})`, ok, `text=${info.textLen} btns=${info.buttons}${info.errBoundary ? ' [错误边界!]' : ''}`)
  const hydration = consoleErrs.filter(e => /Hydration|hydration/.test(e))
  const hardErrs = consoleErrs.filter(e => !/Hydration|hydration/.test(e))
  for (const e of hardErrs.slice(0, 5)) console.log(`      · console: ${e}`)
  for (const d of deadApis.slice(0, 6)) console.log(`      · deadapi: ${d}`)
  if (hydration.length) console.log(`      · hydration: ${hydration.length} 条(已知 8 页挂账,单独跟踪)`)
  if (hardErrs.length || deadApis.length) { failed++; passed-- }
  await page.close()
}
await browser.close()
console.log(`\n━━━ 全路由爬测: ${passed} pass / ${failed} fail ━━━`)
process.exit(failed > 0 ? 1 : 0)
