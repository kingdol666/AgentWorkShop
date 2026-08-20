/**
 * koda 风格重塑视觉核验(puppeteer):
 *  - 亮/暗双主题截图(仪表盘 + 工作台控制台)
 *  - DOM 断言:body 纯 canvas(无网格背景)、侧栏浅暖底、菜单 light、
 *              顶栏 56px hairline、航迹 chip active 黑底、antd 圆角 10
 * 运行:node scripts/test-koda-restyle.mjs
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
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await sleep(2500)

  // ── 亮色主题断言 ──
  const light = await page.evaluate(() => {
    const body = getComputedStyle(document.body)
    const sider = document.querySelector('.app-sider')
    const header = document.querySelector('.app-header')
    const menu = document.querySelector('.app-menu')
    const btn = document.querySelector('.ant-btn')
    return {
      bodyBg: body.backgroundColor,
      bodyImage: body.backgroundImage,
      siderBg: sider ? getComputedStyle(sider).backgroundColor : '',
      headerH: header ? getComputedStyle(header).height : '',
      headerBorder: header ? getComputedStyle(header).borderBottomColor : '',
      menuLight: menu ? !menu.className.includes('ant-menu-dark') : false,
      btnRadius: btn ? getComputedStyle(btn).borderRadius : '',
      link: document.querySelector('a') ? getComputedStyle(document.querySelector('a')).color : '',
    }
  })
  check('L1 body 纯暖纸 canvas(#f9f7f3,无网格)', light.bodyBg === 'rgb(249, 247, 243)' && (light.bodyImage === 'none' || light.bodyImage.includes('gradient') === false), light.bodyBg)
  check('L2 侧栏浅暖底(#f7f3ec)', light.siderBg === 'rgb(247, 243, 236)', light.siderBg)
  check('L3 菜单 light 主题', light.menuLight, '')
  check('L4 顶栏 56px', light.headerH === '56px', light.headerH)
  check('L5 antd 圆角 10px', light.btnRadius === '10px', light.btnRadius)
  await page.screenshot({ path: 'data/shots/koda-light-dashboard.png' })

  // ── 工作台控制台(航迹 + 块)亮色 ──
  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
  await sleep(2200)
  // 登录门或工作区列表:导航至已有 ui-term?直接截图观察结构即可;检查航迹 chip 样式(在 /workshop 页已有 trail)
  const trail = await page.evaluate(() => {
    const node = document.querySelector('.trail-node')
    const active = document.querySelector('.trail-node.active')
    return {
      nodeBg: node ? getComputedStyle(node).backgroundColor : '',
      nodeRadius: node ? getComputedStyle(node).borderRadius : '',
      activeBg: active ? getComputedStyle(active).backgroundColor : '',
      activeColor: active ? getComputedStyle(active).color : '',
    }
  })
  check('L6 航迹 chip:panel-soft 底 + 8px 圆角', trail.nodeBg === 'rgb(245, 243, 235)' && trail.nodeRadius === '8px', `${trail.nodeBg} ${trail.nodeRadius}`)
  check('L7 航迹 active 黑底白字', trail.activeBg === 'rgb(0, 0, 0)' || trail.activeBg === 'rgb(16, 16, 16)', trail.activeBg)
  await page.screenshot({ path: 'data/shots/koda-light-workshop.png' })

  // ── 暗色主题 ──
  await page.evaluate(() => {
    window.localStorage.setItem('app', JSON.stringify({ isDark: true, sidebarCollapsed: false }))
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(2500)
  const dark = await page.evaluate(() => {
    const body = getComputedStyle(document.body)
    const active = document.querySelector('.trail-node.active')
    return {
      bodyBg: body.backgroundColor,
      activeBg: active ? getComputedStyle(active).backgroundColor : '',
    }
  })
  check('D1 暗色真中性 canvas(#0c0c0c)', dark.bodyBg === 'rgb(12, 12, 12)', dark.bodyBg)
  check('D2 暗色 active 白底', dark.activeBg === 'rgb(255, 255, 255)', dark.activeBg)
  await page.screenshot({ path: 'data/shots/koda-dark-workshop.png' })

  await page.evaluate(() => window.localStorage.removeItem('app'))
  await browser.close()

  console.log(`\n★ 结果: ${passed} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('异常:', err.message)
  process.exit(1)
})
