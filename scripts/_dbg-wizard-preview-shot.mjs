/** 一次性:preview 修复验证(town 左轨模型库裁剪)+ 添加节点向导截图(真实场景动态表单) */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const token = login.data.token

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })

// ---- 1) town 左轨模型库:裁剪左轨区域(preview 缩略图) ----
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 9000))
const lib = await page.$('.rail-left')
if (lib) {
  const box = await lib.boundingBox()
  if (box) await lib.screenshot({ path: 'docs/audit/screenshots/preview-fix-library.png' })
}
// 额外:数采模板面板那一段(能看到卡片 3D 缩略)
await page.evaluate(() => { const el = document.querySelector('.rail-left'); if (el) el.scrollTop = 360 })
await new Promise(r => setTimeout(r, 1500))
if (lib) await lib.screenshot({ path: 'docs/audit/screenshots/preview-fix-library-scrolled.png' })
console.log('library shots ok')

// ---- 2) /daq 添加节点向导:真实场景动态表单 + 测试连接 ----
await page.goto(`${BASE}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 4500))
const addBtn = await page.$('.add-btn')
if (addBtn) {
  await addBtn.click()
  await new Promise(r => setTimeout(r, 600))
  // 切到真实设备采集
  const segs = await page.$$('.seg')
  if (segs[1]) await segs[1].click()
  await new Promise(r => setTimeout(r, 600))
  // 填入模拟器参数(不点测试,截静态表单)
  await page.type('input[placeholder="192.168.1.10"]', '127.0.0.1').catch(() => {})
  await page.screenshot({ path: 'docs/audit/screenshots/daq-add-wizard-real.png' })
  // 点测试连接(打到 1502 模拟器)
  const btns = await page.$$('.test-row .pill-btn')
  if (btns[0]) {
    await btns[0].click()
    await new Promise(r => setTimeout(r, 2500))
    await page.screenshot({ path: 'docs/audit/screenshots/daq-add-wizard-tested.png' })
  }
  console.log('wizard shots ok')
}
await browser.close()
