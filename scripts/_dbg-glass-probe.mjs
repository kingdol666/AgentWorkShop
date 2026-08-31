/** 一次性:亮色布局崩坏探针 */
import puppeteer from 'puppeteer-core'

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1200 })
await page.setCookie({ name: 'token', value: 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c', domain: '127.0.0.1', path: '/' })
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle2', timeout: 90000 })
// 用户真实路径:点 header 主题按钮(store.toggleDark)
await page.evaluate(() => localStorage.removeItem('app'))
await page.reload({ waitUntil: 'networkidle2', timeout: 90000 })
await new Promise(r => setTimeout(r, 4000))
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.icon-btn')]
  const themeBtn = btns.find(b => b.querySelector('.i-tabler-sun-high, .i-tabler-moon-stars'))
  themeBtn?.click()
})
await new Promise(r => setTimeout(r, 4000))
const probe = await page.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { w: Math.round(r.width), display: cs.display, flex: cs.flex, minWidth: cs.minWidth, pos: cs.position, bd: cs.backdropFilter }
  }
  const mainEl = document.querySelector('.app-main')
  let layoutRule = null
  for (const sheet of document.styleSheets) {
    let rules
    try { rules = sheet.cssRules } catch { continue }
    for (const r of rules) {
      if (r.selectorText && r.selectorText.includes('.ant-layout') && r.style && r.style.flex) {
        layoutRule = `${r.selectorText} { flex: ${r.style.flex} }`
        break
      }
    }
    if (layoutRule) break
  }
  return {
    mainClass: mainEl?.className,
    layoutRule,
    dark: document.documentElement.classList.contains('dark'),
    layout: pick('.app-layout'),
    main: pick('.app-main'),
    content: pick('.app-content'),
    hero: pick('.hero'),
    header: pick('.app-header'),
    bodyW: document.body.getBoundingClientRect().width,
  }
})
console.log(JSON.stringify(probe, null, 1))
await browser.close()
