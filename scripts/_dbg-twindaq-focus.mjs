/** 一次性:设备面板数采监控行聚焦验证 —— 存量有值节点临时绑定 → twin-daq 行出现 → 还原 */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
let TOKEN = ''
const H = () => ({ 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' })
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
TOKEN = login.data.token
const OUT = 'docs/audit/screenshots/ui-polish-0831'

const daq = await fetch(`${BASE}/api/workshop/daq`, { headers: H() }).then(r => r.json())
const valued = daq.data.nodes.filter(n => n.value != null && n.state !== 'offline')
const node = valued[0]
console.log('probe node:', node.id, node.name, 'value =', node.value, '| original binding:', node.deviceBindingId)

const dev = await fetch(`${BASE}/api/workshop/device-twins`, { headers: H() }).then(r => r.json())
const twinsRaw = dev?.data?.twins ?? dev?.data ?? []
const target = twinsRaw.find(t => typeof t.posX === 'number' && !String(t.id).startsWith('dn-'))
console.log('target device:', target.id, target.name)

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })

try {
  await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
    await new Promise(r => setTimeout(r, 1000))
  }
  await new Promise(r => setTimeout(r, 2500))

  // 展开该节点所在模板组(按 node.templateRef 找 daq-<key>)
  const tplKey = node.templateRef.startsWith('daq-') ? node.templateRef.slice(4) : node.templateRef
  await page.evaluate((key) => {
    const ls = window.localStorage
    const cur = JSON.parse(ls.getItem('aw.twin.treeOpen') || '{}')
    cur[`daq:${key}`] = true
    ls.setItem('aw.twin.treeOpen', JSON.stringify(cur))
  }, tplKey)
  await page.reload({ waitUntil: 'domcontentloaded' })
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
    await new Promise(r => setTimeout(r, 1000))
  }
  await new Promise(r => setTimeout(r, 2000))

  // 绑定(REST;WS 收敛到面板)
  await fetch(`${BASE}/api/workshop/daq/${node.id}/bind`, { method: 'POST', headers: H(), body: JSON.stringify({ deviceId: target.id }) })
  await new Promise(r => setTimeout(r, 1800))

  await page.evaluate((devId) => {
    window.__town.scene.setSelected?.({ kind: 'device', id: devId })
  }, target.id)
  await new Promise(r => setTimeout(r, 1200))

  const res = await page.evaluate((nodeName) => {
    const rows = [...document.querySelectorAll('.twin-daq .daq-item')].map(el => el.textContent?.trim())
    const leaf = [...document.querySelectorAll('.daq-node')].find(el => el.textContent?.includes(nodeName))
    return { rows, leafText: leaf?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? null }
  }, node.name)
  console.log('twin-daq rows:', res.rows.length, JSON.stringify(res.rows.slice(0, 4)))
  console.log('rail leaf row:', res.leafText)
  await page.screenshot({ path: `${OUT}/tree-device-daq-panel.png` })
}
finally {
  // 还原原绑定
  await fetch(`${BASE}/api/workshop/daq/${node.id}/bind`, { method: 'POST', headers: H(), body: JSON.stringify({ deviceId: node.deviceBindingId ?? null }) })
  console.log('binding restored →', node.deviceBindingId ?? 'null')
  await browser.close()
}
console.log('done')
