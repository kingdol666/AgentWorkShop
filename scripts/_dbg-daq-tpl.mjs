/** 一次性:/daq 转圈回归 + 模板管理 UI 端到端(创建自定义模板 → 向导用它建节点 → 清理) */
import puppeteer from 'puppeteer-core'

const TOKEN = process.env.DAQ_TOKEN ?? 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const NAME = `烘箱湿度${Date.now() % 100000}`
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1200'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1200 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })

const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
// evaluate 只能传可序列化参数:传 token,页内拼 headers

// 1) 加载 /daq:spin 必须在 15s 内消失(loaded 状态修复回归)
await page.goto('http://127.0.0.1:3000/daq', { waitUntil: 'domcontentloaded', timeout: 60000 })
// 0) 清场:历史遗留的 ct-* 模板与其节点(此前乱码测试数据)
const pre = await page.evaluate(async (token) => {
  const h = () => ({ 'authorization': `Bearer ${token}`, 'content-type': 'application/json' })
  const list = await fetch('/api/workshop/daq', { headers: h() }).then(r => r.json())
  for (const n of list.data.nodes.filter(n => n.templateRef.startsWith('daq-ct-'))) {
    await fetch(`/api/workshop/daq/${n.id}`, { method: 'DELETE', headers: h() })
  }
  const tpls = list.data.templates.filter(t => String(t.key).startsWith('ct-'))
  for (const t of tpls) await fetch(`/api/workshop/daq/templates/${t.key}`, { method: 'DELETE', headers: h() })
  return { removedTpls: tpls.map(t => t.key) }
}, TOKEN)
console.log('pre-clean:', JSON.stringify(pre))
let spinGone = false
for (let i = 0; i < 30; i++) {
  spinGone = await page.evaluate(() => !document.querySelector('.ant-spin-spinning'))
  if (spinGone) break
  await sleep(500)
}
if (spinGone) console.log('PASS spin cleared (no infinite loading)')
else fail('ant-spin still spinning after 15s')

await sleep(1500)
const rows = await page.evaluate(() => document.querySelectorAll('.nodes-table tbody tr').length)
console.log('node rows rendered:', rows)
if (rows === 0) fail('no node rows and no empty-state row rendered')

// 内置/自定义分区正确性(builtin 标记回归)
const split = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')]
  btns.find(b => b.textContent.includes('模板管理'))?.click()
  return new Promise((resolve) => {
    setTimeout(() => {
      const tables = [...document.querySelectorAll('.modal .tpl-table')]
      const customNames = [...tables[0].querySelectorAll('td b')].map(b => b.textContent)
      const builtinNames = [...tables[1].querySelectorAll('td b')].map(b => b.textContent)
      resolve({ customNames, builtinCount: builtinNames.length })
    }, 400)
  })
})
if (split.customNames.length === 0 && split.builtinCount === 6) console.log('PASS builtin/custom split correct')
else fail(`template split wrong: ${JSON.stringify(split)}`)

// 2) 填表创建自定义模板(唯一名)
await page.evaluate((name) => {
  const modal = document.querySelector('.modal')
  const inputs = [...modal.querySelectorAll('.f-grid')[0].querySelectorAll('input.inp')]
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  const set = (el, v) => {
    setter.call(el, String(v))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  set(inputs[0], name)
  set(inputs[1], '%RH')
  set(inputs[2], '烘箱相对湿度')
  set(inputs[3], 'OVEN · RH')
  set(inputs[4], '20')
  set(inputs[5], '90')
  set(inputs[6], '1')
  set(inputs[7], '45')
  set(inputs[8], '1.5')
  const btn = [...modal.querySelectorAll('button')].find(b => b.textContent.includes('保存模板'))
  btn?.click()
}, NAME)
await sleep(900)
const listed = await page.evaluate(name => document.querySelector('.modal .tpl-table').textContent.includes(name), NAME)
if (listed) console.log('PASS custom template appears in manager list')
else fail('custom template not in manager list after save')

await page.screenshot({ path: 'docs/audit/screenshots/daq-tpl-manager.png' })

// 3) 关管理,开向导,选自定义模板,创建节点(mock)
await page.evaluate(() => document.querySelector('.modal-mask').click())
await sleep(300)
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')]
  btns.find(b => b.textContent.includes('添加节点'))?.click()
})
await sleep(400)
const picked = await page.evaluate((name) => {
  const sel = document.querySelector('.modal select.inp')
  const opt = [...sel.options].find(o => o.textContent.includes(name))
  if (!opt) return null
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
  setter.call(sel, opt.value)
  sel.dispatchEvent(new Event('change', { bubbles: true }))
  return opt.value
}, NAME)
if (picked) console.log('PASS wizard picked custom template:', picked)
else fail('custom template option missing in wizard dropdown')

const rowsBefore = await page.evaluate(() => document.querySelectorAll('.nodes-table tbody tr').length)
await page.evaluate(() => {
  const modal = document.querySelector('.modal')
  const btn = [...modal.querySelectorAll('button')].find(b => b.textContent.includes('创建节点'))
  btn?.click()
})
await sleep(1200)
const created = await page.evaluate(name =>
  [...document.querySelectorAll('.nodes-table tbody tr')].some(tr => tr.textContent.includes(name)), NAME)
const rowsAfter = await page.evaluate(() => document.querySelectorAll('.nodes-table tbody tr').length)
if (created && rowsAfter === rowsBefore + 1) console.log(`PASS node created from custom template (${rowsBefore}→${rowsAfter} rows)`)
else fail(`node creation not reflected: matched=${created} rows ${rowsBefore}→${rowsAfter}`)

await page.screenshot({ path: 'docs/audit/screenshots/daq-custom-node.png' })

// 4) 清理本_run 数据
const del = await page.evaluate(async (ref, token) => {
  const h = () => ({ 'authorization': `Bearer ${token}`, 'content-type': 'application/json' })
  const list = await fetch('/api/workshop/daq', { headers: h() }).then(r => r.json())
  const node = list.data.nodes.find(n => n.templateRef === `daq-${ref}`)
  if (node) await fetch(`/api/workshop/daq/${node.id}`, { method: 'DELETE', headers: h() })
  await fetch(`/api/workshop/daq/templates/${ref}`, { method: 'DELETE', headers: h() })
  const after = await fetch('/api/workshop/daq', { headers: h() }).then(r => r.json())
  return { customsLeft: after.data.templates.filter(t => String(t.key).startsWith('ct-')).length }
}, picked, TOKEN)
console.log('cleanup:', JSON.stringify(del))
if (del.customsLeft === 0) console.log('PASS cleanup complete')
else fail('custom template not removed')

await browser.close()
console.log(process.exitCode ? 'AUDIT FAILED' : 'AUDIT ALL PASS')
