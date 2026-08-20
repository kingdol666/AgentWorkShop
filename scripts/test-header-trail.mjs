/**
 * Header 航迹导航实测(puppeteer-core 驱动 Edge headless):
 *  - 依次访问 仪表盘 → 运行时监控 → 系统设置 → 仪表盘(重复)
 *  - 断言:航迹节点按访问顺序累积;重复路径去重后移至末尾;当前页节点高亮
 *  - 点击旧航点 → 路由返回对应页面;进度线元素存在
 *  - 截图:亮色/暗色各一张供视觉核验
 * 运行:node scripts/test-header-trail.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3101'
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = ms => new Promise(r => setTimeout(r, ms))

let passed = 0, failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}

async function main() {
  mkdirSync('data/shots', { recursive: true })
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,900'],
    defaultViewport: { width: 1500, height: 900 },
  })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 160)))

  const goto = async (path) => {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
    await sleep(900)
  }
  const trailTitles = async () =>
    page.$$eval('.trail-node', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()))
  const activeTitle = async () =>
    page.$eval('.trail-node.active', e => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => '(none)')

  // ── 1. 依次访问,航迹累积 ──
  await goto('/')
  await goto('/monitor')
  await goto('/settings')
  let titles = await trailTitles()
  check('航迹按访问顺序累积(3 节点)', titles.length === 3, JSON.stringify(titles))
  check('节点含序号+图标+标题', titles[0]?.includes('01') && titles[0]?.includes('仪表盘'), titles[0] ?? '')
  check('当前页节点高亮(系统设置)', (await activeTitle()).includes('系统设置'), await activeTitle())

  // ── 2. 重复访问去重移末尾 ──
  await goto('/')
  titles = await trailTitles()
  check('重复路径去重并移至末尾', titles.length === 3 && titles[2]?.includes('仪表盘'), JSON.stringify(titles))

  // ── 3. 点击旧航点返回 ──
  const nodes = await page.$$('.trail-node')
  // 点击第 1 个航点(应为 运行时监控)
  await nodes[0]?.click()
  await sleep(1200)
  const url = page.url()
  check('点击旧航点返回对应页面', url.endsWith('/monitor'), url)
  check('返回后该节点变为当前高亮', (await activeTitle()).includes('运行时监控'), await activeTitle())

  // ── 4. 进度线元素与 workbench 页兼容 ──
  check('绘图仪进度线元素存在', (await page.$('.plotter-line')) !== null)
  await goto('/workshop')
  await sleep(1200)
  titles = await trailTitles()
  check('工作台页入轨(workshop)', titles.some(t => t.includes('Agent 工作台') || t.includes('Agent')), JSON.stringify(titles))

  // ── 5. 视觉核验截图(亮/暗) ──
  await page.screenshot({ path: 'data/shots/header-trail-light.png' })
  await page.click('.icon-btn:nth-of-type(1)').catch(() => {})
  // 用标题定位主题按钮(太阳/月亮)
  for (const b of await page.$$('.icon-btn')) {
    const html = await b.evaluate(el => el.innerHTML)
    if (html.includes('sun-high') || html.includes('moon-stars')) {
      await b.click()
      break
    }
  }
  await sleep(600)
  await page.screenshot({ path: 'data/shots/header-trail-dark.png' })

  await browser.close()
  console.log(`\n★ 结果: ${passed} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('异常:', err.message)
  process.exit(1)
})
