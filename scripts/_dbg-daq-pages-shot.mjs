/** 一次性:数采中心 + 节点控制台 页面截图(v0.2.0 验证) */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const token = login.data.token
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

// 取一个真实节点 id(优先非 legacy,便于展示)
const nodes = await fetch(`${BASE}/api/workshop/daq`, { headers: H }).then(r => r.json())
const first = nodes.data?.nodes?.[0]?.id
console.log('node =', first)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })

await page.goto(`${BASE}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 6500))
await page.screenshot({ path: 'docs/audit/screenshots/daq-console-list.png' })

if (first) {
  await page.goto(`${BASE}/daq/${first}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await new Promise(r => setTimeout(r, 6500))
  await page.screenshot({ path: 'docs/audit/screenshots/daq-console-node.png' })
}
console.log('shots ok')
await browser.close()
