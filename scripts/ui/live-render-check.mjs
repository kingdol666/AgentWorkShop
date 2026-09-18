/**
 * 验证"PLC 模拟数据 → 主项目前端"是真·实时渲染(而不是打开时拍一张快照)。
 *
 * 做法:同一个页面停留 15 秒,取两次 DOM 文本做逐字符 diff。
 * 只在有值变化时才算通过 —— 这是"实时"唯一诚实的判据。
 *
 * 用法: node scripts/ui/live-render-check.mjs [--route daq] [--secs 15]
 */
import { launch, openPage, gotoReady, sleep } from './lib.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf('--' + k)
  return i >= 0 ? argv[i + 1] : d
}
// 路由要归一成以 / 开头:BASE + 'daq' 会拼出 http://127.0.0.1:3021daq(非法 URL)
const ROUTE = '/' + arg('route', 'daq').replace(/^\/+/, '')
const SECS = Number(arg('secs', 15))
const FILTER = arg('filter', '-cfA')
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3021'

const login = await (await fetch(BASE + '/api/users/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }),
})).json()
const token = login.data.token
const browser = await launch()
const page = await openPage(browser, { token, dark: true, width: 1440, height: 900, deviceScaleFactor: 1 })
await gotoReady(page, ROUTE, { wait: 8000 })

if (FILTER) {
  await page.evaluate((f) => {
    const input = document.querySelector('input[placeholder*="节点名称"]')
      || Array.from(document.querySelectorAll('input')).find(i => /搜索|search/i.test(i.placeholder || ''))
    if (!input) return
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(input, f)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, FILTER)
  await sleep(3000)
}

// 滚到节点表,保证读的是表内容
await page.evaluate(() => document.querySelector('.nodes-table')?.scrollIntoView({ block: 'start' }))
await sleep(1500)

const grab = () => page.evaluate(() => {
  const t = document.querySelector('.nodes-table') || document.body
  return t.innerText.replace(/\s+/g, ' ')
})
const a = await grab()
await sleep(SECS * 1000)
const c = await grab()

let diff = 0
const spots = []
for (let i = 0; i < Math.max(a.length, c.length); i++) {
  if (a[i] !== c[i]) {
    diff++
    if (spots.length < 8) spots.push(i)
  }
}
console.log('路由:', ROUTE, ' 过滤:', FILTER || '(无)', ' 观察窗口:', SECS + 's')
console.log('文本长度:', a.length, '->', c.length, ' 变化字符数:', diff)
console.log('判据:', diff > 0 ? '✔ 实时渲染(值在变)' : '✘ 静止(只是快照)')
console.log('')
for (const i of spots.slice(0, 6)) {
  console.log('  ' + a.slice(Math.max(0, i - 24), i + 24).trim() + '   =>   ' + c.slice(Math.max(0, i - 24), i + 24).trim())
}
await page.screenshot({ path: `.e2e-shots/admin/live-${ROUTE.replace(/\//g, '_')}.png` })
await browser.close()
