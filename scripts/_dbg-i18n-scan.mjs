/**
 * 一次性:en 模式全站 CJK 残留扫描 + 截图。
 * localStorage aw.locale=en + 刷新(AppHeader 恢复逻辑生效)后逐路由扫描 innerText。
 */
import puppeteer from 'puppeteer-core'

const TOKEN = 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c'
const ROUTES = ['/', '/daq', '/daq/x', '/dcw', '/dcw/x', '/tokens', '/users', '/monitor', '/settings', '/workshop', '/workshop/agents', '/workshop/teams', '/workshop/channel-templates', '/town']
const CJK = /[\u4e00-\u9fff]/

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1200'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1200 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.evaluate(() => localStorage.setItem('aw.locale', 'en'))

const total = { lines: 0 }
for (const r of ROUTES) {
  await page.goto(`http://127.0.0.1:3000${r}`, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {})
  await new Promise(r2 => setTimeout(r2, 3500))
  const res = await page.evaluate(() => {
    const text = document.body.innerText
    const lines = text.split('\n').map(s => s.trim()).filter(s => /[\u4e00-\u9fff]/.test(s))
    const uniq = [...new Set(lines)]
    return { title: document.title, n: uniq.length, samples: uniq.slice(0, 8) }
  })
  total.lines += res.n
  console.log(`${r} [${res.title}] CJK-lines: ${res.n}`)
  if (res.n > 0) console.log('   ', JSON.stringify(res.samples))
  if (r === '/' || r === '/dcw' || r === '/daq') await page.screenshot({ path: `docs/audit/screenshots/i18n-en${r.replace(/\//g, '-').replace(/^-$/, '-root')}.png` })
}
console.log('TOTAL residual CJK lines:', total.lines)
await browser.close()
