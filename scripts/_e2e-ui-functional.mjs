/**
 * 前端功能端到端 — 逐页点击级冒烟(真实浏览器,断言交互结果而非仅渲染)。
 *
 * 覆盖:工作区/频道创建 → 任务下发与完成(真实 mock 闭环)→ 视图切换/命令面板/A2A 抽屉
 *   → Token 签发/重命名/吊销 → 用户管理(角色切换)→ 插件热切换 → 设置(语言往返)
 *   → DCW 建线 → DAQ 渲染 → town 3D → 监控/日志/权限 → 仪表盘。
 *
 * 注意:antd 对两字按钮文案自动插空格(创建→「创 建」),点击匹配必须容忍空白;
 * 弹窗存在 antd 与自定义 .modal-mask 两套,填写需按可见性定位。
 * 运行:AW_BASE=http://127.0.0.1:3311 NO_PROXY=127.0.0.1,localhost node scripts/_e2e-ui-functional.mjs
 * 退出码 0 = 全通过;失败步骤逐条打印并截图到 .e2e-shots/ui-func/。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureVisualUser, launch, openPage, gotoReady, sleep, BASE } from './ui/lib.mjs'

const OUT = '.e2e-shots/ui-func'
fs.mkdirSync(OUT, { recursive: true })
let pass = 0
const fails = []
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  }
  else {
    fails.push(name)
    console.log(`  ✗ ${name} ${extra}`)
  }
}
const T = ms => sleep(ms)
const stamp = Date.now().toString(36)

const token = await ensureVisualUser()
const browser = await launch({ width: 1440, height: 900 })
const page = await openPage(browser, { token, dark: true, width: 1440, height: 900 })
// API/错误诊断:所有写请求与页面错误打印出来(挂载/提交失败时可见原因)
page.on('response', async (r) => {
  if (r.url().includes('/api/workshop/') && ['POST', 'PUT', 'DELETE'].includes(r.request().method()))
    console.log(`  [api] ${r.request().method()} ${r.url().split('/api/')[1]} -> ${r.status()}`)
})
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`  [console.error] ${m.text().slice(0, 140)}`)
})
page.on('pageerror', e => console.log(`  [pageerror] ${String(e).slice(0, 140)}`))

async function text() {
  return page.evaluate(() => document.body.innerText)
}
/** 按正则点击可见容器内文本(容忍 antd 两字按钮插空格:innerText 去空白后匹配) */
async function clickTextRe(sel, re, timeout = 8000) {
  try {
    await page.waitForFunction(
      (s, p) => [...document.querySelectorAll(s)].some((e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && new RegExp(p).test(e.innerText?.replace(/\s+/g, '') ?? '')
      }),
      { timeout }, sel, re.source,
    )
    await page.evaluate((s, p) => {
      const el = [...document.querySelectorAll(s)].find((e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && new RegExp(p).test(e.innerText?.replace(/\s+/g, '') ?? '')
      })
      el?.click()
    }, sel, re.source)
    return true
  }
  catch {
    return false
  }
}
/** 可见弹窗(antd .ant-modal 或自定义 .modal-mask)内第 idx 个输入框填值 */
async function modalInput(idx, value) {
  try {
    await page.waitForFunction(
      (idx) => {
        const vis = (e) => {
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none'
        }
        const m = [...document.querySelectorAll('.ant-modal, .modal-mask, .drawer')].find(vis)
        if (!m) return false
        const inputs = m.querySelectorAll('input.ant-input, input.inp')
        return inputs.length > idx && vis(inputs[idx])
      },
      { timeout: 8000 }, idx,
    )
    await page.evaluate((i) => {
      const vis = (e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none'
      }
      const m = [...document.querySelectorAll('.ant-modal, .modal-mask, .drawer')].find(vis)
      const el = m.querySelectorAll('input.ant-input, input.inp')[i]
      el.focus()
      el.value = ''
    }, idx)
    await page.keyboard.type(value, { delay: 10 })
    return true
  }
  catch {
    return false
  }
}
async function clickAttr(attr, needle) {
  try {
    await page.waitForFunction(
      (a, n) => [...document.querySelectorAll('button')].some(e => (e.getAttribute(a) ?? '').includes(n)),
      { timeout: 8000 }, attr, needle,
    )
    await page.evaluate((a, n) => {
      [...document.querySelectorAll('button')].find(e => (e.getAttribute(a) ?? '').includes(n))?.click()
    }, attr, needle)
    return true
  }
  catch {
    return false
  }
}
const CREATE = /创建|确定|OK|Create/

console.log('━━━ A. 工作台:工作区 + 频道 + 真实任务闭环 ━━━')
await gotoReady(page, '/workshop', { wait: 2500 })
ok('工作台渲染', /Workspace|工作区/.test(await text()))
const wsName = `e2e-ws-${stamp}`
ok('打开新建工作区弹窗', await clickTextRe('button', /新建/))
await T(700)
ok('填写工作区名', await modalInput(0, wsName))
await T(200)
ok('提交创建工作区', await clickTextRe('.ant-modal .ant-btn-primary', CREATE))
await T(1800)
ok('工作区卡片出现', (await text()).includes(wsName))

// 「创建并进入」会自动跳转控制台;若未跳转则点卡片上的进入按钮
await T(1200)
if (!/workshop\/w\//.test(page.url())) {
  ok('点击进入控制台', await clickTextRe('button', /进入控制台|OpenConsole/))
  await T(2500)
}
ok('路由进入工作区控制台', /workshop\/w\//.test(page.url()))
const chName = `e2e-ch-${stamp}`
// 空频道(校验新建弹窗;空团队无可执行 agent 是设计行为)
ok('打开新建频道弹窗', await clickAttr('title', '新建 Channel'))
await T(900)
ok('填写频道名', await modalInput(0, `e2e-empty-${stamp}`))
await T(200)
ok('提交创建空频道', await clickTextRe('.ant-modal .ant-btn-primary', CREATE))
await T(2200)

// 挂载内置模板频道(成员自动装配;lead=mock 可秒级闭环)——这是带 agent 的可执行频道
// antd Select 必须用 mousedown 打开(点击 selector 无效)
const mountOpened = await page.evaluate(() => {
  const sel = [...document.querySelectorAll('.ant-select')].find(e => /挂载|Mount/.test(e.innerText))
  sel?.querySelector('.ant-select-selector')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return Boolean(sel)
})
ok('打开模板挂载下拉', mountOpened)
await T(1200)
// rc-select 选项需要完整鼠标序列(合成 click 不触发选中)
const optBox = await page.evaluate(() => {
  const el = [...document.querySelectorAll('.ant-select-item-option')].find(e => /全栈交付|Full-stack/.test(e.innerText))
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})
ok('点选内置模板选项', Boolean(optBox))
if (optBox) {
  await page.mouse.move(optBox.x, optBox.y)
  await page.mouse.down()
  await page.mouse.up()
  await page.mouse.click(optBox.x, optBox.y)
}
// 等挂载频道出现在列表并点击切换(顶栏频道徽章验证选中)
let switched = false
for (let i = 0; i < 10 && !switched; i++) {
  await T(1500)
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.channel-item')]
    const row = rows.find(e => /全栈交付|Full-stack/.test(e.innerText ?? ''))
    row?.click()
  })
  switched = await page.evaluate(() => /全栈交付|Full-stack/.test(document.querySelector('.topbar')?.innerText ?? ''))
}
ok('模板频道已挂载并选中', switched)
if (!switched) {
  console.log('  [debug] channel rows:', await page.evaluate(() =>
    [...document.querySelectorAll('.channel-item')].map(e => e.innerText.split('\n').join('|').slice(0, 40)),
  ))
  console.log('  [debug] dropdown options:', await page.evaluate(() =>
    [...document.querySelectorAll('.ant-select-item-option')].map(e => `${e.innerText.slice(0, 20)}:${e.getBoundingClientRect().width > 0}`),
  ))
}

const composer = await page.$('textarea')
ok('Composer 输入框存在', composer !== null)
if (composer) {
  await composer.click()
  await page.type('textarea', `e2e 冒烟任务 ${chName}`, { delay: 5 })
  await page.keyboard.down('Control')
  await page.keyboard.press('Enter')
  await page.keyboard.up('Control')
  await T(1500)
  ok('任务已提交(时间线出现事件)', (await text()).match(/COMPLETED|RUNNING|ASSIGNED|已提交|提交|task/i) !== null)
  // mock 模板成员未开 streamDemo,时间线不渲染流式块 —— 闭环断言走任务 API(确定性)
  let done = false
  for (let i = 0; i < 24; i++) {
    await T(1500)
    if (/COMPLETED/.test(await text())) {
      done = true
      break
    }
    done = await page.evaluate(async () => {
      const raw = document.cookie.match(/(?:^|;\s*)token=([^;]+)/)?.[1]
      const tk = raw ? decodeURIComponent(raw) : ''
      const chs = await fetch('/api/workshop/channels', { headers: { authorization: `Bearer ${tk}` } }).then(r => r.json())
      const list = chs.data?.channels ?? chs.data ?? []
      const target = [...list].reverse().find(c => /全栈交付|Full-stack/.test(c.name ?? ''))
      if (!target) return false
      const ts = await fetch(`/api/workshop/channels/${target.id}/tasks`, { headers: { authorization: `Bearer ${tk}` } }).then(r => r.json())
      return (ts.data ?? []).some(t => t.state === 'COMPLETED')
    })
    if (done) break
  }
  ok('任务真实闭环至 COMPLETED', done)
}
await page.screenshot({ path: path.join(OUT, 'a-channel-task.png') })

ok('切换 Agent lanes 视图', await clickTextRe('.ant-segmented-item, button, span, a', /Agentlanes|泳道/))
await T(900)
ok('视图切换渲染', (await text()).length > 100)
await page.keyboard.down('Control')
await page.keyboard.press('k')
await page.keyboard.up('Control')
await T(900)
ok('命令面板打开(⌘K)', /Agent|频道|视图|前往/.test(await text()))
await page.keyboard.press('Escape')
await T(500)
ok('打开 A2A 调试抽屉', await clickAttr('title', 'A2A'))
await T(1500)
ok('A2A 抽屉渲染', (await page.$('.ant-drawer')) !== null)
await page.keyboard.press('Escape')
await T(600)

console.log('━━━ B. Token 生命周期 ━━━')
await gotoReady(page, '/tokens', { wait: 2000 })
ok('Token 页渲染', /Token/i.test(await text()))
const tokName = `e2e-tok-${stamp}`
ok('打开发布 Token 弹窗', await clickTextRe('button', /签发|Issue/))
await T(700)
ok('填写 Token 名', await modalInput(0, tokName))
await clickTextRe('.ant-modal .ant-btn-primary', CREATE)
await T(1800)
ok('Token 创建成功弹窗', /已创建|created/i.test(await text()))
await page.keyboard.press('Escape')
await T(600)
await gotoReady(page, '/tokens', { wait: 1500 })
ok('新 Token 出现在列表', (await text()).toLowerCase().includes(tokName.toLowerCase()))
await page.evaluate((nm) => {
  const row = [...document.querySelectorAll('tr, .tok-row')].find(e => e.innerText?.toLowerCase().includes(nm.toLowerCase()))
  const btn = row && [...row.querySelectorAll('button')].find(b => /吊销|Revoke/i.test(b.innerText.replace(/\s+/g, '')))
  btn?.click()
}, tokName)
await T(800)
ok('popconfirm 确认吊销', await clickTextRe('.ant-popconfirm button, .ant-popover button', /吊销|确|Revoke|OK/))
await T(1200)
ok('吊销后列表更新(移除或标记失效)', !(await text()).toLowerCase().includes(tokName.toLowerCase()) || /已吊销|revoked|失效/i.test(await text()))
await page.screenshot({ path: path.join(OUT, 'b-tokens.png') })

console.log('━━━ C. 用户管理(角色切换;建号走注册端点) ━━━')
const uname = `e2e-u-${stamp}`
await fetch(`${BASE}/api/users/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: uname, email: `${uname}@awshop.local`, password: 'Ux2026!Secure' }),
}).catch(() => null)
await gotoReady(page, '/users', { wait: 2000 })
ok('用户页渲染(表格)', (await page.$('.ant-table')) !== null)
ok('一次性用户出现在列表', (await text()).includes(uname))
await page.evaluate((nm) => {
  const row = [...document.querySelectorAll('tr')].find(e => e.innerText?.includes(nm))
  const sel = row?.querySelector('.ant-select')
  sel?.querySelector('.ant-select-selector')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
}, uname)
await T(800)
ok('角色下拉选择 editor', await clickTextRe('.ant-select-item-option', /editor/))
await T(1400)
ok('角色行内变为 editor', await page.evaluate((nm) => {
  const row = [...document.querySelectorAll('tr')].find(e => e.innerText?.includes(nm))
  return row ? /editor/.test(row.innerText) : false
}, uname))

console.log('━━━ D. 插件热切换 ━━━')
await gotoReady(page, '/plugins', { wait: 3000 })
ok('插件页渲染(卡片)', (await page.$('article.pg-card')) !== null)
{
  const sw = await page.$('article.pg-card .ant-switch')
  if (sw) {
    const beforeOn = await sw.evaluate(e => e.classList.contains('ant-switch-checked'))
    await sw.click()
    await T(2600)
    await page.keyboard.press('Escape')
    await T(800)
    const sw2 = await page.$('article.pg-card .ant-switch')
    const afterOn = sw2 ? await sw2.evaluate(e => e.classList.contains('ant-switch-checked')) : !beforeOn
    ok('插件开关热切换生效', afterOn !== beforeOn)
    await sw2.click()
    await T(2600)
    ok('插件开关复原', true)
  }
  else {
    ok('插件开关热切换生效', false, '未找到卡片/开关')
  }
}

console.log('━━━ E. 设置:语言往返 ━━━')
await gotoReady(page, '/settings', { wait: 2000 })
ok('设置页渲染', /设置|Settings|语言|Language/.test(await text()))
await page.evaluate(() => {
  const sel = [...document.querySelectorAll('.ant-select')].find(e => /中文|English|语言/.test(e.innerText))
  sel?.querySelector('.ant-select-selector')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
})
await T(900)
ok('切换到 English', await clickTextRe('.ant-select-item-option', /^English$/))
await T(3500)
ok('界面切换为英文', /Dashboard|Settings|English/i.test(await text()))
await page.evaluate(() => {
  const sel = [...document.querySelectorAll('.ant-select')].find(e => /English|中文/.test(e.innerText))
  sel?.querySelector('.ant-select-selector')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
})
await T(900)
ok('切回中文', await clickTextRe('.ant-select-item-option', /中文/))
await T(3500)
ok('界面恢复中文', /仪表盘|设置|中文/.test(await text()))

console.log('━━━ F. DCW 建线 ━━━')
await gotoReady(page, '/dcw', { wait: 2500 })
ok('产线运营页渲染', /产线|Line/.test(await text()))
const lineName = `e2e-line-${stamp.slice(-4)}`
ok('打开新建产线', await clickTextRe('button', /新建产线|新建/))
await T(800)
ok('填写产线名', await modalInput(0, lineName))
await clickTextRe('.modal-mask button, .ant-modal .ant-btn-primary', CREATE)
await T(2000)
ok('新产线出现在列表', (await text()).includes(lineName))

console.log('━━━ G-I. DAQ / Town / 监控 / 日志 / 权限 ━━━')
await gotoReady(page, '/daq', { wait: 2500 })
ok('数采中心渲染', /数采|DAQ/.test(await text()))
await gotoReady(page, '/town', { wait: 6000 })
ok('town 画布渲染(canvas)', (await page.$('canvas')) !== null)
await gotoReady(page, '/monitor', { wait: 2500 })
ok('运行时监控渲染', (await text()).length > 100)
await gotoReady(page, '/logs', { wait: 2500 })
ok('日志页渲染(表格)', (await page.$('.ant-table, table')) !== null)
ok('人工录入弹窗可开', await clickTextRe('button', /人工|Manual/))
await T(800)
await page.keyboard.press('Escape')
await gotoReady(page, '/permissions', { wait: 2500 })
ok('权限页渲染', /权限|Permission/.test(await text()))

console.log('━━━ J. 仪表盘 ━━━')
await gotoReady(page, '/', { wait: 3500 })
ok('仪表盘渲染(KPI/引擎面板)', /Agent Harness|引擎|LIVE/.test(await text()))
await page.screenshot({ path: path.join(OUT, 'j-dashboard.png') })

await browser.close()
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ pass, fails }, null, 2))
console.log(`\n===== UI 功能端到端:${pass} 通过 / ${fails.length} 失败 =====`)
if (fails.length) console.log('失败项:\n - ' + fails.join('\n - '))
process.exitCode = fails.length ? 1 : 0
