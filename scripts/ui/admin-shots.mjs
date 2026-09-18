/**
 * 以 **admin 账号** 登录并给数采 / 数控 / 数字孪生出图。
 * 与 lib.mjs 的视觉走查账号(visual)区分:admin 是文档里写的管理员账号,
 * 能看见全量节点与全部产线;演示工作区由 scripts/ui/seed-admin.mjs 准备。
 */
import { launch, openPage, gotoReady } from './lib.mjs'
import fs from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3021'
const OUT = process.env.AW_OUT ?? '.e2e-shots/admin'
fs.mkdirSync(OUT, { recursive: true })

const loginRes = await fetch(BASE + '/api/users/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }),
})
const login = await loginRes.json()
if (login.code !== 0) throw new Error('admin 登录失败: ' + JSON.stringify(login).slice(0, 200))
const token = login.data.token
console.log('登录成功:', login.data.user.name, '(' + login.data.user.role + ')')

const browser = await launch()
const routes = [
  { path: '/', name: '01-dashboard', wait: 9000 },
  { path: '/daq', name: '02-daq', wait: 12000 },
  { path: '/dcw', name: '03-dcw', wait: 9000 },
  { path: '/town', name: '04-town', wait: 16000 },
  { path: '/monitor', name: '05-monitor', wait: 7000 },
]
for (const r of routes) {
  const page = await openPage(browser, { token, dark: true, width: 1440, height: 900, deviceScaleFactor: 2 })
  const errs = []
  page.on('pageerror', e => errs.push(String(e.message).slice(0, 120)))
  await gotoReady(page, r.path, { wait: r.wait })
  const file = OUT + '/' + r.name + '.png'
  await page.screenshot({ path: file })
  const info = await page.evaluate(() => ({
    nodes: document.querySelectorAll('*').length,
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 120),
  }))
  console.log('  ok ' + r.name.padEnd(16) + ' dom=' + String(info.nodes).padStart(6) + ' errs=' + errs.length)
  await page.close()
}
await browser.close()
console.log('->', OUT)
