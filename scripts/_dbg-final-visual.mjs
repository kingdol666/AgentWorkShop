// home 生产实例:workspace 会话页 + permissions + town 截图
import puppeteer from 'puppeteer-core'
const BASE = 'http://127.0.0.1:3001'
const CHANNEL_ID = process.argv[2] ?? '8515751a-e250-4d53-9f5b-97ed8c48e7a9'
const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
const login = await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }) }).then(r => r.json())
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
const api = async (p, opts) => fetch(`${BASE}${p}`, { ...opts, headers: { authorization: `Bearer ${login.data.token}`, ...(opts?.headers ?? {}) } }).then(r => r.json())
let wsId = (await api('/api/workshop/workspaces')).data?.[0]?.id
if (!wsId) {
  const created = await api('/api/workshop/workspaces', { method: 'POST', body: JSON.stringify({ name: '验收空间' }) })
  wsId = created.data.id
  await api(`/api/workshop/workspaces/${wsId}/channels/${CHANNEL_ID}`, { method: 'POST' })
}
await page.goto(`${BASE}/workshop/w/${wsId}`, { waitUntil: 'networkidle2', timeout: 90000 })
await new Promise(r => setTimeout(r, 6000))
await page.screenshot({ path: '.e2e-shots/final-workshop-channel.png' })
console.log('📷 workshop-channel')
await page.goto(`${BASE}/permissions`, { waitUntil: 'networkidle2', timeout: 60000 })
await new Promise(r => setTimeout(r, 2500))
await page.screenshot({ path: '.e2e-shots/final-permissions.png' })
console.log('📷 permissions')
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await new Promise(r => setTimeout(r, 14000))
await page.screenshot({ path: '.e2e-shots/final-town.png' })
console.log('📷 town')
await browser.close()
