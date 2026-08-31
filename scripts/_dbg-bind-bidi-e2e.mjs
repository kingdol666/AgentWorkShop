/** 一次性:节点级双向绑定 + 树形拖拽 + 选择器滚动 验证轮(场景清空 + 产线设备重建后)
 *  T1 空场景(设备保留)
 *  T2 设备卡「添加数采通道」节点选择器(分组/滚动/直绑)→ 面板 twin-daq 行
 *  T3 合成拖放:未绑定节点落到 devB 旁 → 落位 + 自动绑
 *  T4 节点检查器反向:绑定设备行 + 下拉换绑(双向同步)
 *  T5 智控同构:选择器直绑 → 设备面板 SET 行
 *  T6 /daq 表格绑定设备下拉换绑(server 落库)
 *  T7 还原
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

const daq0 = await fetch(`${BASE}/api/workshop/daq`, { headers: H() }).then(r => r.json())
const devRes = await fetch(`${BASE}/api/workshop/device-twins`, { headers: H() }).then(r => r.json())
const twins = (devRes?.data?.twins ?? devRes?.data ?? []).filter(t => typeof t.posX === 'number')
const devA = twins.find(t => /挤出机/.test(t.name)) ?? twins[0]
const devB = twins.find(t => t.id !== devA.id && /收卷机|拉/.test(t.name)) ?? twins[1]
const valued = daq0.data.nodes.find(n => n.value != null && !n.deviceBindingId)
const freeDaq = daq0.data.nodes.find(n => !n.deviceBindingId && n.id !== valued?.id)
const dcwNodes = await fetch(`${BASE}/api/workshop/dcw`, { headers: H() }).then(r => r.json())
const unboundDcw = dcwNodes.data.nodes.find(n => !n.deviceBindingId)
console.log('fixtures → devA:', devA?.name, '| devB:', devB?.name, '| valued daq:', valued?.name, valued?.value, '| free daq:', freeDaq?.name, '| free dcw:', unboundDcw?.name)

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

try {
  await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  for (let i = 0; i < 45; i++) {
    if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
    await new Promise(r => setTimeout(r, 1000))
  }
  await new Promise(r => setTimeout(r, 3500))
  console.log('T1 scene deviceNodes(设备):', await page.evaluate(() => window.__town?.scene?.deviceNodes?.size))
  await page.screenshot({ path: `${OUT}/round3-empty-scene.png` })

  // 编辑模式
  const segBtns = await page.$$('.nav-tabs .seg button')
  await segBtns[1].click()
  await new Promise(r => setTimeout(r, 600))

  // ── T2 设备卡「添加数采通道」节点选择器直绑 ──
  await page.evaluate((devId) => {
    window.__town.scene.setSelected?.({ kind: 'device', id: devId })
  }, devA.id)
  await new Promise(r => setTimeout(r, 800))
  const daqAddBtn = (await page.$$('.bind-add-wrap .bind-add'))[0]
  await daqAddBtn.evaluate(el => el.scrollIntoView({ block: 'center' }))
  await new Promise(r => setTimeout(r, 300))
  await daqAddBtn.click()
  await new Promise(r => setTimeout(r, 500))
  const pop = await page.evaluate(() => {
    const el = document.querySelector('.bind-pop')
    if (!el) return null
    return {
      groups: el.querySelectorAll('.bp-group').length,
      buttons: el.querySelectorAll('button').length,
      overflowY: getComputedStyle(el).overflowY,
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
    }
  })
  console.log('T2 daq picker:', JSON.stringify(pop))
  await page.screenshot({ path: `${OUT}/round3-daq-picker.png` })
  const clicked = await page.evaluate((nodeId) => {
    const btn = document.querySelector(`.bind-pop button[data-node-id="${nodeId}"]`)
    if (!btn) return false
    btn.scrollIntoView({ block: 'nearest' })
    btn.click()
    return true
  }, valued.id)
  await new Promise(r => setTimeout(r, 1500))
  const daq1 = await fetch(`${BASE}/api/workshop/daq`, { headers: H() }).then(r => r.json())
  const b1 = daq1.data.nodes.find(n => n.id === valued.id)
  console.log('T2 click node row:', clicked, '| bound to devA:', b1?.deviceBindingId === devA.id ? 'OK' : b1?.deviceBindingId)
  // 面板出现 twin-daq 行(该节点有实时值)
  await page.evaluate((devId) => {
    window.__town.scene.setSelected?.({ kind: 'device', id: devId })
  }, devA.id)
  await new Promise(r => setTimeout(r, 1000))
  const rowsTxt = await page.evaluate(() => [...document.querySelectorAll('.twin-daq .daq-item')].map(el => el.textContent?.replace(/\s+/g, ' ').trim()))
  console.log('T2 device panel twin-daq rows:', JSON.stringify(rowsTxt))
  await page.screenshot({ path: `${OUT}/round3-device-daq-bound.png` })

  // ── T3 合成拖放:freeDaq 落到 devB 旁 → 落位 + 自动绑 devB ──
  const tx = devB.posX + 40
  const tz = devB.posZ + 30
  const pt = await page.evaluate((wx, wz) => {
    const p = window.__town.scene.worldToScreen(wx, 0, wz)
    return { x: p?.x ?? p?.[0], y: p?.y ?? p?.[1] }
  }, tx, tz)
  await page.evaluate((nodeId, cx, cy) => {
    const canvas = document.querySelector('#town-host canvas')
    const dt = new DataTransfer()
    dt.setData('application/x-aw-daq-node', nodeId)
    canvas.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt }))
    canvas.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt }))
  }, freeDaq.id, pt.x, pt.y)
  await new Promise(r => setTimeout(r, 1800))
  const daq2 = await fetch(`${BASE}/api/workshop/daq`, { headers: H() }).then(r => r.json())
  const placedNode = daq2.data.nodes.find(n => n.id === freeDaq.id)
  console.log('T3 drag drop → posX:', placedNode?.posX, `(expect ~${Math.round(tx)})`, '| auto-bind devB:', placedNode?.deviceBindingId === devB.id ? 'OK' : placedNode?.deviceBindingId)

  // ── T4 节点检查器反向换绑(placedNode:devB → devA,双向同步) ──
  await page.evaluate((nodeId) => {
    window.__town.scene.setSelected?.({ kind: 'device', id: nodeId })
  }, placedNode.id)
  await new Promise(r => setTimeout(r, 1000))
  const insp = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.daq-info-row')]
    const bindRow = rows.find(r => /绑定设备/.test(r.textContent ?? ''))
    const sel = document.querySelector('.daq-bind-bar select')
    return { bindRowText: bindRow?.textContent?.replace(/\s+/g, ' ').trim() ?? null, hasSelect: !!sel }
  })
  console.log('T4 inspector bind row:', JSON.stringify(insp.bindRowText), '| select:', insp.hasSelect)
  // 检查器换绑流程:先解绑(按钮) → 下拉选 devA → 再点绑定
  await page.evaluate(() => {
    ;(document.querySelector('.daq-bind-bar .bind-add-btn'))?.click()
  })
  await new Promise(r => setTimeout(r, 1200))
  await page.evaluate((devAId) => {
    const sel = document.querySelector('.daq-bind-bar select')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(sel, devAId)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  }, devA.id)
  await new Promise(r => setTimeout(r, 600))
  await page.evaluate(() => {
    ;(document.querySelector('.daq-bind-bar .bind-add-btn'))?.click()
  })
  await new Promise(r => setTimeout(r, 1400))
  const daq3 = await fetch(`${BASE}/api/workshop/daq`, { headers: H() }).then(r => r.json())
  const rebound = daq3.data.nodes.find(n => n.id === placedNode.id)
  console.log('T4 unbind → select devA → bind:', rebound?.deviceBindingId === devA.id ? 'OK' : rebound?.deviceBindingId)
  await page.screenshot({ path: `${OUT}/round3-node-inspector.png` })

  // ── T5 智控选择器直绑 devB → 设备面板 SET 行 ──
  await page.evaluate((devId) => {
    window.__town.scene.setSelected?.({ kind: 'device', id: devId })
  }, devB.id)
  await new Promise(r => setTimeout(r, 800))
  const wraps = await page.$$('.bind-add-wrap .bind-add')
  const dcwAddBtn = wraps[1]
  await dcwAddBtn.evaluate(el => el.scrollIntoView({ block: 'center' }))
  await new Promise(r => setTimeout(r, 300))
  await dcwAddBtn.click()
  await new Promise(r => setTimeout(r, 500))
  const dcwClicked = await page.evaluate((nodeId) => {
    const btn = document.querySelector(`.bind-pop button[data-node-id="${nodeId}"]`)
    if (!btn) return false
    btn.scrollIntoView({ block: 'nearest' })
    btn.click()
    return true
  }, unboundDcw.id)
  await new Promise(r => setTimeout(r, 1500))
  const dcwAfter = await fetch(`${BASE}/api/workshop/dcw`, { headers: H() }).then(r => r.json())
  const dcwBound = dcwAfter.data.nodes.find(n => n.id === unboundDcw.id)
  await page.evaluate((devId) => {
    window.__town.scene.setSelected?.({ kind: 'device', id: devId })
  }, devB.id)
  await new Promise(r => setTimeout(r, 1000))
  const dcwRow = await page.evaluate(() => ({
    rows: document.querySelectorAll('.twin-dcw').length,
    hasWrite: !!document.querySelector('.twin-dcw input, .twin-dcw button'),
  }))
  console.log('T5 dcw picker bind:', dcwClicked, '| bound devB:', dcwBound?.deviceBindingId === devB.id ? 'OK' : dcwBound?.deviceBindingId, '| SET rows:', dcwRow.rows, '| write ctl:', dcwRow.hasWrite)
  await page.screenshot({ path: `${OUT}/round3-dcw-panel.png` })

  // ── T6 /daq 表格绑定设备下拉换绑 ──
  await page.goto(`${BASE}/daq`, { waitUntil: 'networkidle0', timeout: 90000 })
  await new Promise(r => setTimeout(r, 5000))
  const devSelIdx = await page.evaluate(() => {
    const sels = [...document.querySelectorAll('select.line-sel')]
    const empty = sels.findIndex(s => [...s.options].some(o => /未绑定/.test(o.textContent ?? '')) && s.value === '')
    return empty >= 0 ? empty : sels.findIndex(s => [...s.options].some(o => /未绑定/.test(o.textContent ?? '')))
  })
  const devOptCount = await page.evaluate((idx) => {
    const sels = [...document.querySelectorAll('select.line-sel')]
    return sels[idx]?.options?.length ?? 0
  }, devSelIdx)
  console.log('T6 /daq device select idx:', devSelIdx, '| options:', devOptCount)
  // 找一个当前「未绑定」的行(value=''),换绑到 devA → devA 上节点数必须 +1
  const preCount = (await fetch(`${BASE}/api/workshop/daq`, { headers: H() }).then(r => r.json())).data.nodes.filter(n => n.deviceBindingId === devA.id).length
  const changed = await page.evaluate((devId, idx) => {
    const sels = [...document.querySelectorAll('select.line-sel')]
    const sel = sels[idx]
    if (!sel) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(sel, devId)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }, devA.id, devSelIdx)
  await new Promise(r => setTimeout(r, 1500))
  const daqPage = await fetch(`${BASE}/api/workshop/daq`, { headers: H() }).then(r => r.json())
  const onDevA = daqPage.data.nodes.filter(n => n.deviceBindingId === devA.id).length
  console.log('T6 /daq select change:', changed, `| devA nodes ${preCount} → ${onDevA} (+${onDevA - preCount})`)
  await page.screenshot({ path: `${OUT}/round3-daq-page.png` })
}
finally {
  // ── T7 还原:解绑测试绑定 + 解除测试落位 ──
  try {
    const d = await fetch(`${BASE}/api/workshop/daq`, { headers: H() }).then(r => r.json())
    for (const n of d.data.nodes) {
      if (n.id === valued?.id || n.id === freeDaq?.id) {
        await fetch(`${BASE}/api/workshop/daq/${n.id}/bind`, { method: 'POST', headers: H(), body: JSON.stringify({ deviceId: null }) })
        if (typeof n.posX === 'number') {
          await fetch(`${BASE}/api/workshop/daq/${n.id}`, { method: 'PATCH', headers: H(), body: JSON.stringify({ posX: null, posZ: null }) })
        }
      }
    }
    await fetch(`${BASE}/api/workshop/dcw/${unboundDcw.id}/bind`, { method: 'POST', headers: H(), body: JSON.stringify({ deviceId: null }) })
    console.log('cleanup done')
  }
  catch (e) {
    console.log('cleanup error:', String(e).slice(0, 120))
  }
  await browser.close()
}
console.log('page errors:', issues.length)
issues.slice(0, 6).forEach(i => console.log(i))
console.log('round3 done')
