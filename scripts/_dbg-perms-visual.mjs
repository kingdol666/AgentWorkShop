// 权限页浏览器目视:admin 管理矩阵 + plain 用户受限视图
import puppeteer from 'puppeteer-core'
const BASE = 'http://127.0.0.1:3021'
const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server', '--window-size=1600,1000'] })

const loginTok = async (email, password) => (await fetch(`${BASE}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }).then(r => r.json())).data?.token

const shoot = async (path, name, token, wait = 3500) => {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
  await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 60000 })
  await new Promise(r => setTimeout(r, wait))
  await page.screenshot({ path: `.e2e-shots/perm-${name}.png` })
  console.log(`📷 perm-${name}`)
  await page.close()
}

// 1) admin:权限管理页
const adminTok = await loginTok('admin@awshop.local', 'admin123')
await shoot('/permissions', 'admin-page', adminTok)

// 2) plain 用户(产线2=operate 授权还在):侧栏无权限管理入口 + /dcw 仅见授权产线
// 取 E2E 里那个 plain(重新注册一个新的拿授权?简化:直接注册 per-shot 用户并经 API 给产线2 operate)
const ov = await fetch(`${BASE}/api/workshop/permissions`, { headers: { authorization: `Bearer ${adminTok}` } }).then(r => r.json())
const stamp = Date.now().toString(36)
const pu = { name: `v-${stamp}`, email: `v-${stamp}@awshop.local`, password: 'Plain2026' }
const reg = await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pu) }).then(r => r.json())
const plainTok = reg.data.token
const uid = (await fetch(`${BASE}/api/workshop/permissions`, { headers: { authorization: `Bearer ${plainTok}` } }).then(r => r.json())).status // 403 expected
console.log('plain 拉管理面:', uid === 403 ? '403 ✔' : `异常 ${uid}`)
const pid = ov.data.users.find(u => u.email === pu.email)?.id
await fetch(`${BASE}/api/workshop/permissions`, { method: 'PUT', headers: { authorization: `Bearer ${adminTok}`, 'content-type': 'application/json' }, body: JSON.stringify({ userId: pid, grants: [{ lineId: ov.data.lines.find(l => l.name.includes('2号')).id, mode: 'operate' }] }) })
await shoot('/dcw', 'plain-dcw', plainTok)
await shoot('/daq', 'plain-daq', plainTok)
await browser.close()
