/**
 * DCW 读写集成 UI 目视验证:/dcw/[line] 节点表「PLC 读数」列(含真实 Modbus 节点)
 * + /town 设备卡 ACT 读数行。截图落 .e2e-shots/。
 * 运行: node scripts/_dbg-dcw-read-ui.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const ROOT = process.env.E2E_ROOT ?? 'http://127.0.0.1:3000'
const LINE = process.env.LINE ?? 'ln-af002514'
const DEV = '循环泵 #01'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failed = 0
const check = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!cond) failed++ }
const shot = async (page, name) => {
  mkdirSync('.e2e-shots', { recursive: true })
  await page.screenshot({ path: `.e2e-shots/${name}.png` })
}

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())

const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
try {
  // ① /dcw/[line] 节点表:PLC 读数列 + 读取按钮 + 各节点读数值
  await page.goto(`${ROOT}/dcw/${LINE}`, { waitUntil: 'networkidle2', timeout: 90000 })
  await page.waitForSelector('.nodes-table tbody tr', { timeout: 30000 })
  await sleep(3000)
  const head = await page.evaluate(() => [...document.querySelectorAll('.nodes-table th')].map(t => t.textContent.trim()))
  check('①表头含「PLC 读数」列', head.some(t => t.includes('PLC 读数')), head.join('|'))
  const rows = await page.evaluate(() => [...document.querySelectorAll('.nodes-table tbody tr')].map((tr) => {
    const cells = [...tr.querySelectorAll('td')]
    const name = tr.querySelector('td b')?.textContent?.trim() ?? ''
    return { name, read: cells[4]?.textContent?.replace(/\s+/g, ' ').trim() ?? '', hasReadBtn: !!cells[4]?.querySelector('.read-btn') }
  }).filter(r => r.name.includes('读写验证')))
  check('①四个测试节点都在行内', rows.length >= 4, rows.map(r => `${r.name}:${r.read}`).join(' | ').slice(0, 160))
  check('①行内有「读取」按钮', rows.every(r => r.hasReadBtn) && rows.length > 0)
  check('①Modbus 真实节点 ACT 已回填', rows.some(r => r.name.includes('Modbus') && /\d/.test(r.read)), rows.find(r => r.name.includes('Modbus'))?.read)
  await shot(page, 'dcw-line-read-column')

  // ② 点「读取」按钮 → 读数刷新(手动读 UI 路径)
  const btnOk = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.nodes-table tbody tr')].find(tr => tr.textContent?.includes('mock 手动'))
    const btn = row?.querySelector('.read-btn')
    if (!btn) return false
    btn.click()
    return true
  })
  await sleep(1500)
  check('②点击「读取」按钮执行手动读', btnOk)

  // ③ /town 设备卡:SET + ACT 两行实时
  await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await sleep(20000)
  const act = () => page.evaluate((dev) => {
    const card = [...document.querySelectorAll('.twin-card')].find(c => c.querySelector('.twin-name')?.textContent?.includes(dev))
    const items = card ? [...card.querySelectorAll('.dcw-item')].map(e => ({
      set: e.querySelector('.dcw-set')?.textContent?.replace(/\s+/g, '') ?? '',
      act: e.querySelector('.dcw-act b')?.textContent?.replace(/\s+/g, '') ?? null,
    })) : []
    return items
  }, DEV)
  const a1 = await act()
  check('③/town 设备卡出现智控通道(SET)', a1.length > 0, JSON.stringify(a1).slice(0, 120))
  check('③通道带 ACT 读数行', a1.some(r => r.act != null && /\d/.test(r.act)), JSON.stringify(a1.map(r => r.act)))
  await shot(page, 'town-dcw-act')
}
finally {
  await browser.close().catch(() => {})
}
console.log(failed === 0 ? '\nDCW-READ-UI ALL PASS' : `\nDCW-READ-UI FAILED(${failed})`)
process.exit(failed === 0 ? 0 : 1)
