/** 一次性:仪表盘不绘制根因 —— 逐层计算样式检查 */
import puppeteer from 'puppeteer-core'

const loginRes = await fetch('http://127.0.0.1:3000/api/users/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const token = loginRes?.data?.token

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 6000))

const info = await page.evaluate(() => {
  const out = { chain: [], invisibles: [] }
  // 从 body 往下找包含"实时工况趋势"的元素链
  const all = [...document.querySelectorAll('*')]
  const target = all.find(el => el.children.length === 0 && /实时工况趋势/.test(el.textContent || ''))
  if (target) {
    let el = target
    let depth = 0
    while (el && depth < 14) {
      const cs = getComputedStyle(el)
      out.chain.push({
        tag: el.tagName + '.' + String(el.className).slice(0, 60),
        opacity: cs.opacity,
        visibility: cs.visibility,
        display: cs.display,
        animationName: cs.animationName,
        animationPlayState: cs.animationPlayState,
        rect: `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`,
      })
      el = el.parentElement
      depth++
    }
  }
  // 找 opacity=0 的可见文本容器
  for (const el of all.slice(0, 3000)) {
    const cs = getComputedStyle(el)
    if (cs.opacity === '0' && (el.textContent || '').trim().length > 20 && el.getBoundingClientRect().height > 50) {
      out.invisibles.push({
        cls: String(el.className).slice(0, 80),
        anim: cs.animationName,
        playState: cs.animationPlayState,
        h: Math.round(el.getBoundingClientRect().height),
      })
      if (out.invisibles.length >= 5) break
    }
  }
  return out
})
console.log(JSON.stringify(info, null, 2))
await browser.close()
