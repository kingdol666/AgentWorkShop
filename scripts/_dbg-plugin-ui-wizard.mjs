/**
 * 插件扩展验证 D(浏览器 UI 真实操作):/daq 新增节点向导选择插件模板 →
 * 通过 UI 建节点 → 列表行实时值流入 → /town 孪生面板出现该节点。
 * 截图落 .e2e-shots/(向导/列表/孪生);节点保留(CLEANUP=1 删除)。
 * 运行: node scripts/_dbg-plugin-ui-wizard.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync } from 'node:fs'

const ROOT = process.env.E2E_ROOT ?? 'http://127.0.0.1:3000'
const CLEANUP = process.env.CLEANUP === '1'
const NODE_NAME = process.env.NODE_NAME ?? 'UI向导插件验证'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failed = 0
const check = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!cond) failed++ }
const shot = async (page, name) => {
  mkdirSync('.e2e-shots', { recursive: true })
  await page.screenshot({ path: `.e2e-shots/${name}.png` })
}

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())

const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
let createdNodeId = null
try {
  // ① 打开 /daq → 点「添加节点」→ 向导弹出
  await page.goto(`${ROOT}/daq`, { waitUntil: 'networkidle2', timeout: 90000 })
  await page.waitForSelector('tbody tr', { timeout: 30000 })
  await page.click('button.aw-pill.add-btn:not(.outline)')
  await page.waitForSelector('.modal .f-grid select.inp', { timeout: 15000 })

  // ② 模板下拉含插件模板(服务端目录直出)
  const opts = await page.$$eval('.modal .f-grid select.inp option', os => os.map(o => ({ v: o.value, t: o.textContent.replace(/\s+/g, ' ').trim() })))
  const plugOpt = opts.find(o => o.v === 'plug-verify-x2-profile')
  check('①向导模板下拉含插件模板', plugOpt != null, plugOpt?.t ?? `共 ${opts.length} 项`)
  check('①插件模板带自定义标记(非内置)', plugOpt != null && /自定义|插件/.test(plugOpt.t), plugOpt?.t)

  // ③ 选中插件模板 → 命名 → 截图 → UI 保存
  await page.select('.modal .f-grid select.inp', 'plug-verify-x2-profile')
  await page.type('.modal input.inp', NODE_NAME)
  await shot(page, 'wizard-plugin-template')
  await page.click('.m-actions button.aw-pill:not(.outline)')
  await sleep(4000)

  // ③b 行内产线下拉挂到运行中的产线(采集是配方驱动的:未分配不采样)
  const ctxFile = await import('node:fs')
  const runLine = process.env.RUN_LINE ?? JSON.parse(ctxFile.readFileSync('.e2e-plugin-ctx.json', 'utf-8')).lineId
  const lineName = ((await j('/api/workshop/dcw')).data.lines ?? []).find(l => l.id === runLine)?.name
  const lineOpts = await page.evaluate((nm) => {
    const row = [...document.querySelectorAll('tbody tr')].find(r => r.textContent?.includes(nm))
    const sel = row?.querySelector('select.line-sel')
    return sel ? Array.from(sel.options).map(o => ({ v: o.value, t: o.textContent.trim() })) : null
  }, NODE_NAME)
  const lineOpt = (lineOpts ?? []).find(o => o.t === lineName)
  check('③b 行内产线下拉含运行中产线', lineOpt != null, `${lineName} 选项=${lineOpt?.v ?? '无'}`)
  // puppeteer 的 page.select 需要全局选择器:行内直接派发 change 更稳
  await page.evaluate((nm, lineId) => {
    const row = [...document.querySelectorAll('tbody tr')].find(r => r.textContent?.includes(nm))
    const sel = row?.querySelector('select.line-sel')
    if (!sel) throw new Error('行内无产线下拉')
    sel.value = lineId
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  }, NODE_NAME, runLine)
  await sleep(2500)

  // ④ 列表行出现且实时值流入(WS 帧驱动)
  const rowVal = () => page.evaluate((nm) => {
    const row = [...document.querySelectorAll('tbody tr')].find(r => r.textContent?.includes(nm))
    const m = row?.textContent?.match(/(\d+\.\d+)\s*mm/)
    return { v: m ? m[1] : null, row: row?.textContent?.replace(/\s+/g, ' ').slice(0, 120) ?? '' }
  }, NODE_NAME)
  const r1 = await rowVal()
  await sleep(5000)
  const r2 = await rowVal()
  check('④UI 建出的插件节点出现在列表', r1.v != null, r1.row)
  check('④列表实时值变化(帧流入)', r1.v != null && r2.v != null && r1.v !== r2.v, `${r1.v} → ${r2.v}`)
  await shot(page, 'daq-list-plugin-node')
  const nodes = (await j('/api/workshop/daq')).data.nodes
  createdNodeId = nodes.find(n => n.name === NODE_NAME)?.id ?? null

  // ④b 行内设备下拉绑定设备(孪生面板按设备挂数采项)
  const devOpt = await page.evaluate((nm) => {
    const row = [...document.querySelectorAll('tbody tr')].find(r => r.textContent?.includes(nm))
    const sel = row?.querySelectorAll('select.line-sel')[1]
    const first = sel?.querySelector('option[value]:not([value=""])')
    if (!sel || !first) return null
    sel.value = first.value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return { v: first.value, t: first.textContent.trim() }
  }, NODE_NAME)
  check('④b 行内绑定设备(第一可绑定项)', devOpt != null, devOpt ? `${devOpt.t}(${devOpt.v})` : '无可绑定设备')
  await sleep(2000)

  // ⑤ /town 孪生面板出现该节点且实时
  await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await sleep(20000)
  // 面板项显示模板通道名(d.ch),节点挂在绑定设备卡下 → 按「设备卡 + 通道名」定位
  const panel = () => page.evaluate(() => {
    const card = [...document.querySelectorAll('.twin-card')].find(c => c.querySelector('.twin-name')?.textContent?.includes('循环泵 #01'))
    const item = card ? [...card.querySelectorAll('.daq-item')].find(e => e.textContent?.includes('标定轮廓')) : null
    return { card: !!card, text: item?.textContent?.replace(/\s+/g, '') ?? '', val: item?.querySelector('b')?.textContent?.replace(/\s+/g, '') ?? null }
  })
  const p1 = await panel()
  await sleep(5000)
  const p2 = await panel()
  check('⑤/town 设备卡(循环泵 #01)出现', p1.card)
  check('⑤/town 孪生面板出现插件节点通道(标定轮廓)', p1.text !== '', p1.text.slice(0, 60))
  check('⑤/town 面板实时值变化', p1.val != null && p2.val != null && p1.val !== p2.val, `${p1.val} → ${p2.val}`)
  await shot(page, 'town-panel-plugin-node')
}
finally {
  await browser.close().catch(() => {})
  if (CLEANUP && createdNodeId) {
    await j(`/api/workshop/daq/${createdNodeId}`, 'DELETE').catch(() => {})
    console.log(`(cleanup:节点 ${createdNodeId} 已删)`)
  }
}
writeFileSync('.e2e-plugin-ui-node.json', JSON.stringify({ nodeId: createdNodeId, name: NODE_NAME }))
console.log(failed === 0 ? '\nSTACK-D ALL PASS' : `\nSTACK-D FAILED(${failed})`)
process.exit(failed === 0 ? 0 : 1)
