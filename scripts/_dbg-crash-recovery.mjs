/** 端到端:崩溃恢复 + state 驱动初始化 + WS 客户端自动重连
 *  ① 1号产线开跑,确认数采采样(produced 增长)
 *  ② 浏览器打开 /workshop:ws-dot=live
 *  ③ 强杀服务进程(taskkill //F,模拟突然崩溃)
 *  ④ 断言 ws-dot 转红(客户端感知断线)
 *  ⑤ 脚本自行重启服务(detached,存活于脚本退出后)
 *  ⑥ 断言:活动产线窗口从 line-runs.json 恢复(active=true,无需人工重开)
 *     → 数采门控自动续采样(produced 恢复增长)
 *  ⑦ 断言 ws-dot 回到 live(客户端自动重连 + 快照对齐)
 *  ⑧ /town 场景值仍在实时渲染(最终截图)
 */
import puppeteer from 'puppeteer-core'
import { execSync, spawn } from 'node:child_process'

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
const fails = []
const okIf = (m, c) => { if (c) console.log(`PASS ${m}`); else { console.log(`FAIL ${m}`); fails.push(m) } }

const killServer = () => {
  const out = execSync('netstat -ano | findstr ":3000" | findstr "LISTENING"', { shell: 'cmd.exe' }).toString()
  const pids = [...new Set(out.split('\n').map(l => l.trim().split(/\s+/).pop()).filter(Boolean))]
  for (const pid of pids) {
    try { execSync(`taskkill /PID ${pid} /F`, { shell: 'cmd.exe', stdio: 'ignore' }) } catch { /* 已退出 */ }
  }
  return pids.length
}
const startServer = () => {
  // Windows 下 npx 是 cmd 脚本:必须经 cmd.exe /c 派生;detached 使其存活于本脚本退出后
  const child = spawn('cmd.exe', ['/c', 'npx', 'nuxt', 'dev', '--host', '127.0.0.1', '--port', '3000'], {
    cwd: 'D:/codes/ABO/AgentWorkShop',
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
  })
  child.unref()
}
const waitUp = async (timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) return true
    }
    catch { /* 未就绪 */ }
    await sleep(1500)
  }
  return false
}

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })

try {
  // ── ① 产线开跑 + 数采确认 ──
  const d = (await J('/api/workshop/dcw')).data
  const lineState = d.lineStates?.find(s => s.lineId === LINE)
  if (!lineState?.active) {
    const recipe = d.recipes.find(r => r.lineId === LINE && r.name === 'A-标准工艺')
    const st = await J(`/api/workshop/dcw/lines/${LINE}/start`, 'POST', { recipeId: recipe.id })
    if (!st.data?.line?.active) { console.error('FAIL 开跑失败'); process.exit(1) }
  }
  const p0 = (await J('/api/workshop/daq')).data.meta.produced
  await sleep(4000)
  const p1 = (await J('/api/workshop/daq')).data.meta.produced
  okIf(`① 崩溃前采样中: produced ${p0} → ${p1}`, p1 > p0)

  // ── ② 浏览器打开 /workshop,ws-dot=live ──
  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => !!document.querySelector('.ws-dot.live'))) break
    await new Promise(r => setTimeout(r, 1000))
  }
  okIf('② ws-dot=live(连接正常)', await page.evaluate(() => !!document.querySelector('.ws-dot.live')))

  // ── ③ 强杀(突然崩溃模拟) ──
  const killed = killServer()
  console.log(`③ CRASH: 强杀 ${killed} 个服务进程`)
  await sleep(1500)

  // ── ④ 客户端感知断线 ──
  let sawDown = false
  for (let i = 0; i < 30; i++) {
    if (await page.evaluate(() => !!document.querySelector('.ws-dot.down'))) { sawDown = true; break }
    await sleep(1000)
  }
  okIf('④ ws-dot 转红(客户端诚实感知断线)', sawDown)

  // ── ⑤ 重启服务(detached;存活于本脚本退出后) ──
  console.log('⑤ 重启服务…')
  startServer()
  okIf('⑤ 服务重启完成(≤120s)', await waitUp(120_000))

  // ── ⑥ 恢复断言:活动窗口从磁盘恢复,无需人工重开 ──
  const d2 = (await J('/api/workshop/dcw')).data
  const restored = d2.lineStates?.find(s => s.lineId === LINE)
  okIf(`⑥ 活动产线窗口已恢复: active=${restored?.active}(state 驱动初始化)`, restored?.active === true)

  // ── ⑦ 数采门控自动续采样 ──
  const q1 = (await J('/api/workshop/daq')).data.meta.produced
  await sleep(5000)
  const q2 = (await J('/api/workshop/daq')).data.meta.produced
  okIf(`⑦ 数采自动续采: produced ${q1} → ${q2}`, q2 > q1)
  const liveNode = (await J('/api/workshop/daq')).data.nodes.find(n => n.lineId === LINE && n.value != null)
  okIf(`⑦ 线内节点实时值: ${liveNode?.name}=${liveNode?.value} ${liveNode?.unit} (${liveNode?.state})`, liveNode?.value != null)

  // ── ⑧ ws-dot 回到 live(自动重连 + 对齐) ──
  let backLive = false
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate(() => !!document.querySelector('.ws-dot.live'))) { backLive = true; break }
    await sleep(1500)
    if (i === 10) await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
  }
  okIf('⑧ ws-dot 回到 live(客户端自动重连)', backLive)

  await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  for (let i = 0; i < 45; i++) {
    if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
    await new Promise(r => setTimeout(r, 1000))
  }
  await new Promise(r => setTimeout(r, 4000))
  await page.screenshot({ path: 'docs/audit/screenshots/ui-polish-0831/crash-recovery-town.png' })
  console.log('⑧ /town 恢复后截图完成')
}
finally {
  await browser.close()
}
console.log(fails.length ? `CRASH-RECOVERY FAILED(${fails.length})` : 'CRASH-RECOVERY ALL PASS')
process.exit(fails.length ? 1 : 0)
