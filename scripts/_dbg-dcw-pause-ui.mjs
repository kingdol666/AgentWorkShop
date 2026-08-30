/**
 * 一次性审计:产线详情页(/dcw/{id})新增 UI 端到端。
 * ①「添加控制模板」button → Modal 填表创建自定义模板 → 成功提示 + chips 出现
 *   → 「添加控制节点」向导自动选中新模板(数据源同 store)。
 * ② 节点行「控制」开关:暂停 → 行转已暂停 + 下发禁用 + 服务端 enabled=false
 *   → 恢复 → 控制中 + 可写。截图留档,清理夹具。
 */
import puppeteer from 'puppeteer-core'

const TOKEN = process.env.DAQ_TOKEN ?? 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROOT = 'http://127.0.0.1:3000'
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const SFX = Math.random().toString(36).slice(2, 7)
const TPL_NAME = `UI审计模板-${SFX}`
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1 }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 选一条控制节点最多的产线(保证节点表有行可验开关)
const lines = (await fetch(`${ROOT}/api/workshop/dcw`, { headers: H }).then(r => r.json())).data
const nodeCountByLine = new Map()
for (const n of lines.nodes) nodeCountByLine.set(n.lineId, (nodeCountByLine.get(n.lineId) ?? 0) + 1)
const target = lines.lines
  .map(l => ({ id: l.id, name: l.name, nodes: nodeCountByLine.get(l.id) ?? 0 }))
  .sort((a, b) => b.nodes - a.nodes)[0]
if (!target || target.nodes === 0) { console.error('FAIL: 没有带控制节点的产线可验'); process.exit(1) }
console.log('target line:', target.name, `(${target.nodes} nodes)`)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1200'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1200 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.goto(`${ROOT}/dcw/${target.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(4000)

// ===== 1. 「添加控制模板」按钮存在 → 点击开弹窗(hydration 就绪前重试) =====
let modalUp = false
for (let i = 0; i < 8 && !modalUp; i++) {
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('添加控制模板'))
    if (!b) return false
    b.click()
    return true
  })
  if (!clicked) { await sleep(800); continue }
  await sleep(500)
  modalUp = await page.evaluate(() => {
    const m = document.querySelector('.modal')
    return !!m && m.textContent.includes('添加控制节点模板') && m.textContent.includes('新建自定义模板')
  })
  if (!modalUp) await sleep(600)
}
if (modalUp) console.log('PASS 添加控制模板 modal opened')
else { fail('template modal did not open'); await page.screenshot({ path: 'docs/audit/screenshots/dcw-pause-ui-fail.png' }); await browser.close(); process.exit(1) }

// ===== 2. 填表创建自定义模板 =====
await page.evaluate((name) => {
  const modal = document.querySelector('.modal')
  const grid = modal.querySelector('.f-grid.tpl-form')
  const inputs = [...grid.querySelectorAll('input.inp')]
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  const set = (el, v) => { setter.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })) }
  set(inputs[0], name) // 名称
  set(inputs[1], '测试扭矩') // 参数语义
  set(inputs[2], `SPINDLE · T-${name.slice(-5)}`) // 位号代号
  set(inputs[3], 'N·m') // 单位
  set(inputs[4], '10') // 量程下限
  set(inputs[5], '50') // 量程上限
  set(inputs[6], '1') // 小数位
}, TPL_NAME)
await sleep(250) // v-model nextTick(输入+点击分两拍)
await page.evaluate(() => {
  const m = document.querySelector('.modal')
  ;[...m.querySelectorAll('button')].find(b => b.textContent.includes('创建模板'))?.click()
})
await sleep(900)
const created = await page.evaluate((name) => {
  const m = document.querySelector('.modal')
  return {
    okBanner: m.querySelector('.banner.good')?.textContent ?? '',
    chip: [...m.querySelectorAll('.tpl-chip')].some(c => c.textContent.includes(name) && c.textContent.includes('自定义')),
  }
}, TPL_NAME)
if (created.okBanner.includes(TPL_NAME) && created.okBanner.includes('已创建')) console.log('PASS template created with success banner')
else fail(`creation banner wrong: "${created.okBanner.trim()}"`)
if (created.chip) console.log('PASS new template visible in modal chips (自定义 tag)')
else fail('new template chip missing')
await page.screenshot({ path: 'docs/audit/screenshots/dcw-pause-ui-tpl-modal.png' })

// ===== 3. 向导自动选中新模板 =====
await page.evaluate(() => {
  const m = document.querySelector('.modal')
  ;[...m.querySelectorAll('button')].find(b => b.textContent.trim() === '关闭')?.click()
})
await sleep(300)
const wizardSel = await page.evaluate((name) => {
  ;[...document.querySelectorAll('button')].find(x => x.textContent.includes('添加控制节点') && !x.textContent.includes('模板'))?.click()
  return new Promise((resolve) => {
    setTimeout(() => {
      const m = document.querySelector('.modal')
      const sel = m?.querySelector('.f-grid select.inp')
      resolve(sel ? sel.selectedOptions[0]?.textContent ?? '' : '(no modal)')
    }, 400)
  })
}, TPL_NAME)
if (wizardSel.includes(TPL_NAME)) console.log('PASS add-node wizard auto-selected the new template')
else fail(`wizard selection wrong: "${wizardSel.trim()}"`)
await page.evaluate(() => document.querySelector('.modal-mask')?.click())
await sleep(300)

// ===== 4. 节点「控制」开关:暂停 → 已暂停 + 下发禁用 + 服务端同步 =====
const toggle1 = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.nodes-table tbody tr')].filter(r => r.querySelector('.ctrl-toggle'))
  const row = rows[0]
  if (!row) return null
  const before = row.querySelector('.ctrl-toggle').textContent.trim()
  row.querySelector('.ctrl-toggle').click()
  return { before, rowIndex: 0, lineNodeCount: rows.length }
})
if (!toggle1) { fail('no node row with ctrl-toggle found'); await browser.close(); process.exit(1) }
await sleep(800)
const afterPause = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.nodes-table tbody tr')].find(r => r.querySelector('.ctrl-toggle'))
  return {
    btn: row.querySelector('.ctrl-toggle').textContent.trim(),
    pill: row.querySelector('.st-pill')?.textContent.trim() ?? '',
    inputDisabled: row.querySelector('.write-inp')?.disabled ?? null,
    writeBtnDisabled: row.querySelector('.write-btn')?.disabled ?? null,
  }
})
// 行序 = store 序 = 本产线 API 节点序(行内 id 是 slice(0,8) 截断展示,不能反查)
const lineNodesApi = (await fetch(`${ROOT}/api/workshop/dcw`, { headers: H }).then(r => r.json())).data.nodes
  .filter(n => n.lineId === target.id)
const serverView = lineNodesApi[toggle1.rowIndex]
if (toggle1.before === '控制中' && afterPause.btn === '已暂停' && afterPause.pill === '已暂停'
  && afterPause.inputDisabled === true && afterPause.writeBtnDisabled === true
  && serverView?.enabled === false && serverView?.state === 'offline') {
  console.log('PASS node paused: toggle=已暂停, pill=已暂停, 下发禁用, server enabled=false/offline (状态同步)')
} else {
  fail(`pause toggle wrong: ${JSON.stringify({ toggle1, afterPause, server: serverView && { enabled: serverView.enabled, state: serverView.state } })}`)
}
await page.screenshot({ path: 'docs/audit/screenshots/dcw-pause-ui-node-paused.png' })

// ===== 5. 恢复控制 → 控制中 + 可写 =====
await page.evaluate(() => {
  const row = [...document.querySelectorAll('.nodes-table tbody tr')].find(r => r.querySelector('.ctrl-toggle'))
  row.querySelector('.ctrl-toggle').click()
})
await sleep(800)
const afterResume = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.nodes-table tbody tr')].find(r => r.querySelector('.ctrl-toggle'))
  return {
    btn: row.querySelector('.ctrl-toggle').textContent.trim(),
    inputDisabled: row.querySelector('.write-inp')?.disabled ?? null,
  }
})
const serverView2 = lineNodesApi[toggle1.rowIndex]
const serverView2Fresh = (await fetch(`${ROOT}/api/workshop/dcw`, { headers: H }).then(r => r.json())).data.nodes
  .find(n => n.id === serverView2?.id)
if (afterResume.btn === '控制中' && afterResume.inputDisabled === false && serverView2Fresh?.enabled === true) {
  console.log('PASS node resumed: toggle=控制中, 下发可用, server enabled=true')
} else fail(`resume wrong: ${JSON.stringify({ afterResume, server: serverView2Fresh && { enabled: serverView2Fresh.enabled } })}`)

// ===== 清理:删除 UI 创建的模板 =====
const dir = (await fetch(`${ROOT}/api/workshop/dcw`, { headers: H }).then(r => r.json())).data
const tpl = dir.templates.find(t => t.name === TPL_NAME)
if (tpl) {
  await fetch(`${ROOT}/api/workshop/dcw/templates/${tpl.key}`, { method: 'DELETE', headers: H })
  console.log('cleanup: template removed')
}
await browser.close()
console.log(process.exitCode ? '\n=== UI AUDIT FAILED ===' : '\n=== UI ALL PASS ===')
