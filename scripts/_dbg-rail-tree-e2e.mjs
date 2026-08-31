/** 一次性:左轨树形目录 + 节点落位绑定 E2E
 *  1) 模板头不可拖/点击展开;叶子编辑态可拖、运行态不可拖
 *  2) ＋ 新建节点(不落位) → 合成拖放入场景(节点 id 载荷) → PATCH 落位 + 就近自动绑定
 *  3) 选中设备 → 面板出现 twin-daq / twin-dcw 监控行(daq 数值 / dcw SET 下发入口)
 *  4) 清理测试节点
 */
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
let createdDaq = ''
let createdDcw = ''

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
const issues = []
page.on('pageerror', (err) => issues.push(`[pageerror] ${String(err).slice(0, 200)}`))
page.on('console', (m) => {
  if (m.type() === 'error' && !/vue-devtools|Devtools/i.test(m.text())) issues.push(`[console] ${m.text().slice(0, 160)}`)
})

try {
  await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
    await new Promise(r => setTimeout(r, 1000))
  }
  await new Promise(r => setTimeout(r, 3000))
  console.log('scene ready:', await page.evaluate(() => window.__town?.scene?.deviceNodes?.size))

  // ── 1) 收起态:模板头不可拖 ──
  const tplEl = await page.$('.daq-card.tpl')
  await tplEl.evaluate(el => el.scrollIntoView({ block: 'center' }))
  await new Promise(r => setTimeout(r, 400))
  const hdrDraggable = await tplEl.evaluate(el => el.getAttribute('draggable'))
  console.log('T1 template header draggable attr:', JSON.stringify(hdrDraggable), '(expect null)')
  await page.screenshot({ path: `${OUT}/tree-collapsed.png` })

  // ── 2) 点击展开(daq 第一组) ──
  await tplEl.click()
  await new Promise(r => setTimeout(r, 500))
  const expanded = await page.evaluate(() => ({
    children: document.querySelectorAll('.daq-children').length,
    nodes: document.querySelectorAll('.daq-node').length,
  }))
  console.log('T2 expand → children groups:', expanded.children, '| leaf count:', expanded.nodes)
  await page.screenshot({ path: `${OUT}/tree-expanded.png` })

  // ── 3) 运行模式叶子不可拖 ──
  const leafDragBrowse = await page.evaluate(() => document.querySelector('.daq-node')?.getAttribute('draggable'))
  console.log('T3 leaf draggable in browse:', JSON.stringify(leafDragBrowse), '(expect null/false)')

  // ── 4) 切编辑模式(真实点击) ──
  const segBtns = await page.$$('.nav-tabs .seg button')
  await segBtns[1].click()
  await new Promise(r => setTimeout(r, 800))
  const leafDragEdit = await page.evaluate(() => document.querySelector('.daq-node')?.getAttribute('draggable'))
  console.log('T4 leaf draggable in edit:', JSON.stringify(leafDragEdit), '(expect "true")')

  // ── 5) ＋ 新建 daq 节点(不落位) ──
  const before = await fetch(`${BASE}/api/workshop/daq`, { headers: H() }).then(r => r.json())
  const cntBefore = before.data.nodes.length
  const addBtn = await page.$('.daq-card.tpl .daq-add')
  await addBtn.click()
  await new Promise(r => setTimeout(r, 1500))
  const after = await fetch(`${BASE}/api/workshop/daq`, { headers: H() }).then(r => r.json())
  const created = after.data.nodes.find(n => !before.data.nodes.some(b => b.id === n.id))
  createdDaq = created?.id ?? ''
  console.log('T5 + created daq node:', !!created, '| total', cntBefore, '→', after.data.nodes.length, '| unplaced:', created && typeof created.posX !== 'number')
  console.log('   new node:', created?.name, created?.id)

  // ── 6) 合成拖放:节点落位到设备旁 + 自动绑定 ──
  const dev = await fetch(`${BASE}/api/workshop/device-twins`, { headers: H() }).then(r => r.json())
  const twinsRaw = dev?.data?.twins ?? dev?.data ?? []
  const twins = twinsRaw.filter(t => typeof t.posX === 'number' && !String(t.id).startsWith('dn-'))
  const target = twins[0]
  const tx = target.posX + 40
  const tz = target.posZ + 30
  const pt = await page.evaluate((wx, wz) => {
    const s = window.__town.scene
    const p = s.worldToScreen(wx, 0, wz)
    return { x: p?.x ?? p?.[0], y: p?.y ?? p?.[1] }
  }, tx, tz)
  const dropped = await page.evaluate((nodeId, cx, cy) => {
    const canvas = document.querySelector('#town-host canvas')
    const dt = new DataTransfer()
    dt.setData('application/x-aw-daq-node', nodeId)
    canvas.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt }))
    canvas.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt }))
    return true
  }, created.id, pt.x, pt.y)
  await new Promise(r => setTimeout(r, 1800))
  const nodesNow = await fetch(`${BASE}/api/workshop/daq`, { headers: H() }).then(r => r.json())
  const placed = nodesNow.data.nodes.find(n => n.id === created.id)
  console.log('T6 drop dispatched:', dropped, '| posX:', placed?.posX, `(expect ~${Math.round(tx)})`, '| bound:', placed?.deviceBindingId === target.id ? `OK ${target.name}` : placed?.deviceBindingId)

  // ── 7) 选中设备 → 面板 twin-daq 监控行 ──
  await page.evaluate((devId) => {
    const s = window.__town.scene
    s.setSelected?.({ kind: 'device', id: devId })
  }, target.id)
  await new Promise(r => setTimeout(r, 1200))
  const daqRows = await page.evaluate(() => document.querySelectorAll('.twin-daq .daq-item').length)
  console.log('T7 device panel twin-daq rows:', daqRows)
  await page.screenshot({ path: `${OUT}/tree-device-daq-panel.png` })

  // ── 8) DCW:展开 + ＋ 新建 + 拖放绑定 → 设备面板 SET 行 ──
  const dcwSec = await page.$$('.daq-list')
  const dcwList = dcwSec[1]
  const dcwTpl = await dcwList.$('.daq-card.tpl')
  await dcwTpl.evaluate(el => el.scrollIntoView({ block: 'center' }))
  await new Promise(r => setTimeout(r, 300))
  await dcwTpl.click()
  await new Promise(r => setTimeout(r, 500))
  const dcwBefore = await fetch(`${BASE}/api/workshop/dcw`, { headers: H() }).then(r => r.json())
  const dcwAdd = await dcwList.$('.daq-card.tpl .daq-add')
  await dcwAdd.click()
  await new Promise(r => setTimeout(r, 1500))
  const dcwAfter = await fetch(`${BASE}/api/workshop/dcw`, { headers: H() }).then(r => r.json())
  const dcwCreated = dcwAfter.data.nodes.find(n => !dcwBefore.data.nodes.some(b => b.id === n.id))
  createdDcw = dcwCreated?.id ?? ''
  console.log('T8 dcw node created:', !!dcwCreated, dcwCreated?.name)
  const dcwPt = await page.evaluate((wx, wz) => {
    const p = window.__town.scene.worldToScreen(wx, 0, wz)
    return { x: p?.x ?? p?.[0], y: p?.y ?? p?.[1] }
  }, target.posX - 40, target.posZ - 30)
  await page.evaluate((nodeId, cx, cy) => {
    const canvas = document.querySelector('#town-host canvas')
    const dt = new DataTransfer()
    dt.setData('application/x-aw-dcw-node', nodeId)
    canvas.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt }))
    canvas.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt }))
  }, dcwCreated.id, dcwPt.x, dcwPt.y)
  await new Promise(r => setTimeout(r, 1800))
  const dcwNow = await fetch(`${BASE}/api/workshop/dcw`, { headers: H() }).then(r => r.json())
  const dcwPlaced = dcwNow.data.nodes.find(n => n.id === dcwCreated.id)
  console.log('T8 dcw placed posX:', dcwPlaced?.posX, `(expect ~${Math.round(target.posX - 40)})`, '| bound:', dcwPlaced?.deviceBindingId === target.id ? 'OK' : dcwPlaced?.deviceBindingId)

  // 设备面板 dcw SET 行(dcw.written 下发入口)
  await new Promise(r => setTimeout(r, 800))
  const dcwRow = await page.evaluate(() => ({
    rows: document.querySelectorAll('.twin-dcw').length,
    set: !!document.querySelector('.twin-dcw .dcw-set, .twin-dcw input, .twin-dcw button'),
  }))
  console.log('T8 device panel twin-dcw rows:', dcwRow.rows, '| SET/write control present:', dcwRow.set)
  await page.screenshot({ path: `${OUT}/tree-device-dcw-panel.png` })

  // ── 9) 点击叶子定位(已落位节点) ──
  const camBefore = await page.evaluate(() => window.__town.scene.getCameraPose?.())
  const leaf = await page.$('.daq-node.placed')
  if (leaf) {
    await leaf.evaluate(el => el.scrollIntoView({ block: 'center' }))
    await new Promise(r => setTimeout(r, 300))
    await leaf.click()
    await new Promise(r => setTimeout(r, 1000))
    const camAfter = await page.evaluate(() => window.__town.scene.getCameraPose?.())
    console.log('T9 leaf click focuses camera:', JSON.stringify(camBefore?.target) !== JSON.stringify(camAfter?.target) ? 'OK moved' : 'no move')
  }
}
finally {
  // ── 清理测试节点(避免孤儿 fixture) ──
  if (createdDaq) await fetch(`${BASE}/api/workshop/daq/${createdDaq}`, { method: 'DELETE', headers: H() }).catch(() => {})
  if (createdDcw) await fetch(`${BASE}/api/workshop/dcw/${createdDcw}`, { method: 'DELETE', headers: H() }).catch(() => {})
  console.log('cleanup:', createdDaq, createdDcw)
  await browser.close()
}
console.log('page errors:', issues.length)
issues.slice(0, 6).forEach(i => console.log(i))
console.log('rail-tree e2e done')
