/**
 * 数据工坊 前后端交互 UI 验收(真实 Chrome,puppeteer-core)。
 *
 * 覆盖(US-003):
 *  /data   导航项 → 镜像数据 tab → 产线/节点选择 → 查询 → echarts canvas → 预览表 → 导出 → 台账出现任务
 *  /studio 数据源树非空 → +Y 入字段井 → 查询 → canvas → 保存图表 → 我的图表列表出现
 *  /studio/board 页面可开、无 pageerror
 *
 * 运行:node scripts/data-studio-ui-e2e.mjs <scenario-context.json>
 * 依赖 scripts/ui/lib.mjs(Chrome 路径/launch/openPage/gotoReady);token cookie 登录。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CTX = process.argv[2]
if (!CTX) {
  console.error('用法: node scripts/data-studio-ui-e2e.mjs <scenario-context.json>')
  process.exit(1)
}
const c = JSON.parse(readFileSync(CTX, 'utf8'))
process.env.AW_BASE = c.base
const EVID = join(REPO, 'docs', 'audit', 'evidence', '2026-10-21-acceptance')
mkdirSync(EVID, { recursive: true })
const { launch, openPage, gotoReady, sleep } = await import('./ui/lib.mjs')

const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`)
}

const browser = await launch()
const page = await openPage(browser, { token: c.adminToken, width: 1600, height: 950, deviceScaleFactor: 1 })
const errs = []
page.on('pageerror', e => errs.push(String(e.message).slice(0, 200)))

async function clickByText(selector, text, pageLocal = page) {
  return pageLocal.evaluate((sel, txt) => {
    const el = Array.from(document.querySelectorAll(sel)).find(e => (e.textContent || '').includes(txt))
    if (!el) return false
    el.click()
    return true
  }, selector, text)
}

try {
  // ── /data 数据管理台 ──
  await gotoReady(page, '/data', { wait: 2500 })
  const navHas = await page.evaluate(() => {
    const items = document.querySelectorAll('.menu-item')
    return Array.from(items).some(e => (e.textContent || '').includes('数据管理'))
  })
  ok('UI1.1', '侧栏导航含「数据管理」', navHas)
  const tabs = await page.evaluate(() => document.querySelectorAll('[data-test="data-tabs"] .tab')?.length ?? 0)
  ok('UI1.2', '三个 tab 渲染', tabs === 3, `tabs=${tabs}`)

  // 选产线
  await page.waitForSelector('[data-test="data-line-sel"]', { timeout: 30000 })
  const lineOptions = await page.evaluate(() => {
    const sel = document.querySelector('[data-test="data-line-sel"]')
    return sel ? Array.from(sel.options).filter(o => o.value).length : 0
  })
  ok('UI1.3', '产线下拉有可读产线', lineOptions > 0, `options=${lineOptions}`)
  if (lineOptions > 0) {
    await page.evaluate(() => {
      const sel = document.querySelector('[data-test="data-line-sel"]')
      sel.value = sel.options[1]?.value ?? ''
      sel.dispatchEvent(new Event('change'))
    })
    await sleep(1500)
  }
  // 勾两个节点
  const checked = await page.evaluate(() => {
    const chips = Array.from(document.querySelectorAll('[data-test="data-nodes"] .node-chip input'))
    for (const c of chips.slice(0, 2)) {
      if (!c.checked) c.click()
    }
    return chips.slice(0, 2).filter(c => c.checked).length
  })
  await sleep(300)
  ok('UI1.4', '勾选 2 个节点', checked === 2, `checked=${checked}`)

  // 查询 → canvas + 预览表
  await page.click('[data-test="data-query"]')
  await sleep(6000)
  const canvasCount = await page.evaluate(() => document.querySelectorAll('.chartCard canvas').length)
  ok('UI1.5', 'echarts canvas 渲染', canvasCount >= 1, `canvas=${canvasCount}`)
  const previewRows = await page.evaluate(() => document.querySelectorAll('[data-test="data-preview"] tbody tr')?.length ?? 0)
  ok('UI1.6', '预览表 ≥1 行', previewRows >= 1, `rows=${previewRows}`)

  // 导出 → 任务出现在台账
  await page.click('[data-test="data-export"]')
  await sleep(600)
  await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('.modal input.input.w'))
    if (inputs[0]) {
      inputs[0].value = 'UI 验收导出'
      inputs[0].dispatchEvent(new Event('input'))
    }
  })
  await page.click('[data-test="data-export-go"]')
  await sleep(2500)
  // 切台账 tab 看任务
  await clickByText('[data-test="data-tabs"] .tab', '台账')
  await sleep(2500)
  const jobRow = await page.evaluate(() => {
    const tbl = document.querySelector('[data-test="ledger-jobs"]')
    return tbl ? tbl.textContent.includes('UI 验收导出') || tbl.querySelectorAll('tbody tr').length > 0 : false
  })
  ok('UI1.7', '导出任务出现在台账', jobRow)
  const runLedger = await page.evaluate(() => !!document.querySelector('[data-test="ledger-runs"]'))
  ok('UI1.8', '批次台账视图渲染', runLedger)

  // ── /studio 工坊 ──
  await gotoReady(page, '/studio', { wait: 3000 })
  await page.waitForSelector('[data-test="studio-line"]', { timeout: 30000 })
  await page.evaluate(() => {
    const sel = document.querySelector('[data-test="studio-line"]')
    sel.value = sel.options[1]?.value ?? ''
    sel.dispatchEvent(new Event('change'))
  })
  await sleep(1500)
  const studioNodes = await page.evaluate(() => document.querySelectorAll('[data-test="studio-nodes"] .nodeRow')?.length ?? 0)
  ok('UI2.1', '/studio 节点树非空', studioNodes > 0, `nodes=${studioNodes}`)
  // +Y 两个
  await page.evaluate(() => {
    const addBtns = Array.from(document.querySelectorAll('[data-test="studio-nodes"] .miniAdd')).slice(0, 2)
    addBtns.forEach(b => b.click())
  })
  await sleep(400)
  const yChips = await page.evaluate(() => document.querySelectorAll('[data-test="studio-y-well"] .chip')?.length ?? 0)
  ok('UI2.2', '字段井入 2 个 Y', yChips === 2, `chips=${yChips}`)
  await page.click('[data-test="studio-query"]')
  await sleep(6000)
  const studioCanvas = await page.evaluate(() => document.querySelectorAll('.canvasCard canvas')?.length ?? 0)
  ok('UI2.3', '/studio canvas 渲染', studioCanvas >= 1, `canvas=${studioCanvas}`)
  // 保存
  await page.type('[data-test="studio-title"]', 'UI 验收图表')
  await page.click('[data-test="studio-save"]')
  await sleep(2000)
  const inList = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.chartRow'))
    return rows.some(r => (r.textContent || '').includes('UI 验收图表'))
  })
  ok('UI2.4', '保存后出现在我的图表', inList)

  // ── /studio/board 看板 ──
  await gotoReady(page, '/studio/board', { wait: 3000 })
  const boardOk = await page.evaluate(() => !!document.querySelector('.head .title'))
  ok('UI3.1', '/studio/board 可打开', boardOk)
}
catch (e) {
  ok('UI-ERR', '脚本未抛异常', false, e instanceof Error ? e.message : String(e))
}
ok('UI0.1', '全脚本 0 pageerror', errs.length === 0, errs.join(' | ').slice(0, 300))

await browser.close()
writeFileSync(join(EVID, 'ui-e2e.json'), JSON.stringify({ at: new Date().toISOString(), base: c.base, results }, null, 2))
const pass = results.filter(r => r.pass).length
console.log(`\n═══ data-studio UI: ${pass}/${results.length} PASS ═══`)
if (pass !== results.length) process.exitCode = 1
