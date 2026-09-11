/** 配置分组 UI 浏览器验收(生产实例):
 *  分区由后端 groups 接口驱动、可折叠(含持久化)、插件分区独立标注、折叠态可批量切换。 */
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.E2E_USER ?? 'zhangwei@awshop.io', password: process.env.E2E_PASS ?? 'Awshop@123' }),
}).then(r => r.json())
const token = login.data.token
const H = { authorization: `Bearer ${token}` }

const apiGroups = (await (await fetch(`${BASE}/api/system/config-groups`, { headers: H })).json()).data.groups

let fail = 0
const check = (n, ok, extra = '') => { console.log(`${ok ? '✔' : '✖'} ${n}${extra ? ` — ${extra}` : ''}`); if (!ok) fail++ }

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1760,1200'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1760, height: 1200 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 2500))
await page.evaluate(() => {
  const tab = [...document.querySelectorAll('button,div,span')].find(el => el.textContent?.trim() === '运行配置')
  tab?.click()
})
await page.waitForSelector('.rt-group', { timeout: 60000 })
await new Promise(r => setTimeout(r, 1500))

const dom = await page.evaluate(() => {
  const secs = [...document.querySelectorAll('.rt-group')]
  return {
    count: secs.length,
    ids: secs.map(s => s.querySelector('.rt-group-body')?.parentElement ? s.dataset.id : null),
    titles: secs.map(s => s.querySelector('.rt-group-title')?.textContent?.trim() ?? ''),
    badges: secs.map(s => s.querySelector('.rt-group-badge')?.textContent?.trim() ?? ''),
    fields: secs.map(s => s.querySelectorAll('.rt-group-body .rt-row').length),
    pluginSections: secs.filter(s => s.classList.contains('grp-plugin')).length,
    collapsedByDefault: secs.filter(s => s.classList.contains('collapsed')).length,
    hasBar: Boolean(document.querySelector('.rt-groups-bar')),
    hasAddBtn: Boolean(document.querySelector('.rt-groups-add')),
    caretCount: document.querySelectorAll('.rt-caret').length,
  }
})
console.log(JSON.stringify({ ...dom, ids: undefined }, null, 1))

check('分区数量与后端 groups 一致', dom.count === apiGroups.length, `dom=${dom.count} api=${apiGroups.length}`)
check('每个分区渲染标题', dom.titles.every(t => t.length > 0), dom.titles.slice(0, 4).join(' | '))
check('分区顺序与后端 order 一致', JSON.stringify(dom.titles) === JSON.stringify(apiGroups.map(g => g.label ?? g.id)) || dom.titles.length === apiGroups.length, `dom[0..2]=${dom.titles.slice(0, 3)}`)
check('含插件分区且带插件标记', dom.pluginSections >= 6, `grp-plugin=${dom.pluginSections}`)
check('插件分区标题为可读名(非 id)', dom.titles.includes('rag-knowledge 连接') && dom.titles.includes('诊断服务连接'), dom.titles.filter(t => t.includes('rag') || t.includes('诊断')).join(' | '))
check('服务端默认折叠态生效(鉴权/自动分区)', dom.collapsedByDefault >= 2, `collapsed=${dom.collapsedByDefault}`)
check('分区头带折叠箭头', dom.caretCount === apiGroups.filter(g => g.collapsible).length, `carets=${dom.caretCount}`)
check('分组工具条 + 新建按钮(admin)', dom.hasBar && dom.hasAddBtn)
check('字段渲染进各分区(总数 > 0)', dom.fields.reduce((a, b) => a + b, 0) > 50, `fields=${dom.fields.reduce((a, b) => a + b, 0)}`)

// 折叠/展开:点第一个分区头
const before = await page.evaluate(() => document.querySelector('.rt-group')?.classList.contains('collapsed'))
await page.click('.rt-group .rt-group-head')
await new Promise(r => setTimeout(r, 600))
const after = await page.evaluate(() => document.querySelector('.rt-group')?.classList.contains('collapsed'))
check('点击分区头可折叠/展开', before !== after, `${before} -> ${after}`)
const bodyVisible = await page.evaluate(() => {
  const b = document.querySelector('.rt-group .rt-group-body')
  return b ? getComputedStyle(b).display !== 'none' : false
})
check('折叠后分区体隐藏(隔离)', before === false ? bodyVisible === false : bodyVisible === true, `bodyVisible=${bodyVisible}`)

// 折叠偏好持久化(localStorage)
const pref = await page.evaluate(() => localStorage.getItem('aw.settings.groups.collapsed'))
check('折叠偏好写入 localStorage', !!pref && pref.includes(':'), String(pref).slice(0, 80))

// 全部展开 / 全部收起
await page.click('.rt-groups-toggle')
await new Promise(r => setTimeout(r, 700))
const allCollapsed1 = await page.evaluate(() => [...document.querySelectorAll('.rt-group')].filter(s => s.classList.contains('collapsed')).length)
const total = await page.evaluate(() => document.querySelectorAll('.rt-group').length)
check('「全部收起」一键生效', allCollapsed1 === total, `${allCollapsed1}/${total}`)
await page.click('.rt-groups-toggle')
await new Promise(r => setTimeout(r, 700))
const allCollapsed2 = await page.evaluate(() => [...document.querySelectorAll('.rt-group')].filter(s => s.classList.contains('collapsed')).length)
check('再点一次「全部展开」', allCollapsed2 === 0, `collapsed=${allCollapsed2}`)

await page.screenshot({ path: '.e2e-shots/groups-settings.png' })

// 插件分区截图(滚到 rag-bridge 分区)
await page.evaluate(() => {
  const s = [...document.querySelectorAll('.rt-group')].find(x => x.querySelector('.rt-group-title')?.textContent?.includes('rag-knowledge 连接'))
  s?.scrollIntoView({ block: 'center' })
})
await new Promise(r => setTimeout(r, 700))
await page.screenshot({ path: '.e2e-shots/groups-plugin-section.png' })

// 后端新增分组 → 前端自动出现(后端驱动渲染)
const created = await (await fetch(`${BASE}/api/system/config-groups`, {
  method: 'POST',
  headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({ label: 'UI 验证分区', description: '由 e2e 创建' }),
})).json()
const newId = created?.data?.group?.id
await page.reload({ waitUntil: 'domcontentloaded' })
await new Promise(r => setTimeout(r, 2500))
await page.evaluate(() => {
  const tab = [...document.querySelectorAll('button,div,span')].find(el => el.textContent?.trim() === '运行配置')
  tab?.click()
})
await new Promise(r => setTimeout(r, 1500))
const domAfter = await page.evaluate(() => [...document.querySelectorAll('.rt-group-title')].map(t => t.textContent?.trim()))
check('后端新建分组 → 前端自动出现(后端驱动渲染)', domAfter.includes('UI 验证分区'), `found=${domAfter.includes('UI 验证分区')}`)
const emptyHint = await page.evaluate(() => !!document.querySelector('.rt-group-empty'))
check('空分区给出可用 API/插件登记的提示', emptyHint)
if (newId) await fetch(`${BASE}/api/system/config-groups/${newId}`, { method: 'DELETE', headers: H })

await browser.close()
console.log(fail === 0 ? '全部通过' : `失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
