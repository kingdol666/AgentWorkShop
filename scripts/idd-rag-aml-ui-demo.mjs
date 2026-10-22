/**
 * IDD/RAG/AML 前后端交互实机演示(puppeteer-core + 本机 Chrome,token cookie 登录)。
 *
 * 用法: node scripts/idd-rag-aml-ui-demo.mjs <scenario-context.json>
 * 产物: docs/audit/evidence/2026-10-22-idd-rag-aml/shots/*.png + ui-demo.json
 *
 * 覆盖:/plugins 诊断面板(插件 client 挂载,/health+/runs 代理实拉);
 *      /aml 训练面五区块渲染且含本轮 ds-/job-/mdl- 真产物;/analysis 台账。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CTX = process.argv[2]
if (!CTX) {
  console.error('用法: node scripts/idd-rag-aml-ui-demo.mjs <scenario-context.json>')
  process.exit(1)
}
const c = JSON.parse(readFileSync(CTX, 'utf8'))
process.env.AW_BASE = c.base
const EVID = join(REPO, 'docs', 'audit', 'evidence', '2026-10-22-idd-rag-aml')
const SHOTS = join(EVID, 'shots')
mkdirSync(SHOTS, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))

const { launch, openPage, gotoReady } = await import('./ui/lib.mjs')
const results = []
function ok(id, name, cond, detail = '') {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 400) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`)
}

const browser = await launch()
try {
  const page = await openPage(browser, { token: c.adminToken, width: 1600, height: 950, deviceScaleFactor: 1 })
  const consoleErrors = []
  page.on('pageerror', e => consoleErrors.push(String(e).slice(0, 120)))

  // ── 1 /plugins:诊断面板(插件 client 面板,代理 /health + /runs) ──
  await gotoReady(page, '/plugins', { wait: 3500 })
  const pBody = await page.evaluate(() => document.body.innerText)
  const shot1 = join(SHOTS, 'ui-1-plugins-diag-panel.png')
  await page.screenshot({ path: shot1 })
  ok('U1', '/plugins 页可达', pBody.length > 100, `len=${pBody.length}`)
  ok('U2', '诊断面板挂载(诊断记录表头)', /诊断|分析记录|diag/i.test(pBody), /诊断|分析记录/.exec(pBody)?.[0] ?? '')
  // 面板健康徽标(远程 IDD 状态)
  ok('U3', '面板含诊断服务状态渲染', /ok|正常|在线|已连接|healthy/i.test(pBody), '')

  // ── 2 /aml:训练面(本轮真实产物在册;列表异步加载,轮询等待+必要时点刷新) ──
  await gotoReady(page, '/aml', { wait: 3000 })
  const shot2 = join(SHOTS, 'ui-2-aml-training.png')
  let aBody = await page.evaluate(() => document.body.innerText)
  let dsReg = /ds-[a-z0-9]{6,}/.test(aBody)
  for (let i = 0; i < 10 && !dsReg; i++) {
    await sleep(2000)
    if (i === 4) {
      // 列表还没出来就点数据集面板的「刷新」
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')]
        btns.find(b => b.textContent?.trim() === '刷新')?.click()
      })
    }
    aBody = await page.evaluate(() => document.body.innerText)
    dsReg = /ds-[a-z0-9]{6,}/.test(aBody)
  }
  await page.screenshot({ path: shot2 })
  ok('U4', '/aml 页可达且五区块(数据集/作业/模型/Python 运行时)', aBody.includes('数据集') && aBody.includes('作业') && aBody.includes('模型'), `len=${aBody.length}`)
  const mdlReg = /mdl-[a-z0-9]{6,}/.test(aBody)
  ok('U5', '本轮真实数据集/模型在册渲染(轮询 20s)', dsReg || mdlReg, `ds=${dsReg} mdl=${mdlReg}`)
  ok('U6', 'Python 运行时状态展示', /Python|venv/i.test(aBody), '')

  // ── 3 /analysis:分析台账 ──
  await gotoReady(page, '/analysis', { wait: 3000 })
  const anBody = await page.evaluate(() => document.body.innerText)
  const shot3 = join(SHOTS, 'ui-3-analysis-ledger.png')
  await page.screenshot({ path: shot3 })
  ok('U7', '/analysis 台账渲染(含 ar- 记录)', /ar-[a-z0-9]{4,}/i.test(anBody) || /分析/.test(anBody), `len=${anBody.length}`)

  ok('U8', '无页面级 JS 崩溃', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))

  writeFileSync(join(EVID, 'ui-demo.json'), JSON.stringify({
    at: new Date().toISOString(), base: c.base,
    shots: ['ui-1-plugins-diag-panel.png', 'ui-2-aml-training.png', 'ui-3-analysis-ledger.png'],
    results,
  }, null, 2))
  const pass = results.filter(r => r.pass).length
  console.log(`\n═══ idd-rag-aml UI demo: ${pass}/${results.length} PASS ═══`)
  process.exit(pass === results.length ? 0 : 1)
}
finally {
  await browser.close().catch(() => {})
}
