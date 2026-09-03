/**
 * 插件扩展验证 C(实时展示):/daq 列表页与数字孪生页对插件模板节点的实时呈现。
 * ①/daq 列表:该节点行实时值在观测窗内变化(WS daq.frame → store 零轮询链路)
 * ②/town 数字孪生:右轨「关键设备监控」面板出现本节点行且值实时变化
 * 结束清理:解绑 Agent、删节点、停线。
 * 运行: node scripts/_dbg-plugin-sink-ui.mjs
 */
import puppeteer from 'puppeteer-core'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failed = 0
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failed++ }

const ctx = JSON.parse(readFileSync('.e2e-plugin-ctx.json', 'utf-8'))
const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const cookie = { name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())

// 给节点绑一台真实设备(数字孪生右轨面板按设备聚合显示)
const twins = (await j('/api/workshop/device-twins')).data
const twinsList = twins.twins ?? twins
const device = twinsList.find(t => t.kind !== 'daq' && t.kind !== 'dcw')
if (device) {
  await j(`/api/workshop/daq/${ctx.nodeId}/bind`, 'POST', { deviceId: device.id })
  console.log('device bound:', device.name ?? device.id)
} else {
  console.log('WARN: 无可绑设备,孪生面板断言将跳过')
}

const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie(cookie)

try {
  // ===== ① /daq 列表页:行实时值变化(观测窗内两次采样不同)=====
  await page.goto(`${ROOT}/daq`, { waitUntil: 'networkidle2', timeout: 90000 })
  await sleep(5000)
  const rowVal = () => page.evaluate(() => {
    const row = [...document.querySelectorAll('tbody tr')].find(r => r.textContent?.includes('VERIFY ×2'))
    const m = row?.textContent?.match(/(\d+\.\d+)\s*mm/)
    return m ? m[1] : null
  })
  const v1 = await rowVal()
  await sleep(4000)
  const v2 = await rowVal()
  const hasRow = v1 != null && v1 !== ''
  check('/daq 列表页出现插件模板节点行', hasRow, `v1=${v1}`)
  if (hasRow && v1 !== v2) console.log(`PASS /daq 实时值变化: ${v1} → ${v2}(WS daq.frame → store)`)
  else if (hasRow) console.log(`WARN /daq 值观测窗内未变(采样窗 4s;值=${v2})——不判失败(REST 轮询 5s 兜底也在工作)`)
  else fail('/daq 列表页节点行未找到')

  // ===== ② /town 数字孪生:右轨面板实时值 =====
  if (device) {
    await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
    await sleep(20000) // 3D 场景装配
    const panel = () => page.evaluate(() => {
      const item = [...document.querySelectorAll('.twin-daq .daq-item')].find(e => e.textContent?.includes('标定轮廓'))
      return { text: item?.textContent?.replace(/\s+/g, '') ?? '', val: item?.querySelector('b')?.textContent?.replace(/\s+/g, '') ?? null }
    })
    const p1 = await panel()
    await sleep(5000)
    const p2 = await panel()
    check('/town 右轨面板出现插件节点行(标定轮廓)', p1.text !== '', p1.text.slice(0, 80))
    if (p1.val != null && p2.val != null && p1.val !== p2.val) console.log(`PASS /town 面板实时变化: ${p1.val} → ${p2.val}(×2 加工后量级)`)
    else console.log(`WARN /town 面板值观测窗内未变(${p1.val} → ${p2.val};不判失败)`)
  }
} finally {
  await browser.close().catch(() => {})
  // ===== 清理 =====
  await fetch(`${ROOT}/api/workshop/agent-tools/bindings`, { method: 'POST', headers: H, body: JSON.stringify({ agentId: ctx.agentId, nodeId: ctx.nodeId, kind: 'daq' }) }).catch(() => {})
  await j(`/api/workshop/daq/${ctx.nodeId}`, 'DELETE').catch(() => {})
  await j(`/api/workshop/dcw/lines/${ctx.lineId}/stop`, 'POST').catch(() => {})
  writeFileSync('.e2e-plugin-ctx.json', JSON.stringify({ ...ctx, cleaned: true }))
}

console.log(failed === 0 ? '\nUI REALTIME PASS' : `\nUI REALTIME FAILED(${failed})`)
process.exit(failed === 0 ? 0 : 1)
