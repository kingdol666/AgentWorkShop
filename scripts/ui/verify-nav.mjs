/**
 * 抽屉导航交互验收 —— 断言"汉堡能开、遮罩能关、Esc 能关、路由跳转自动收"。
 * 这些是布局量测不到的行为,必须真的点。
 */
import { ensureVisualUser, launch, openPage, gotoReady, sleep } from './lib.mjs'

const token = await ensureVisualUser()
const browser = await launch()
const page = await openPage(browser, { token, dark: true, width: 390, height: 844, deviceScaleFactor: 1 })
const errs = []
page.on('pageerror', e => errs.push(String(e.message).slice(0, 160)))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? ' ok ' : 'FAIL'} ${name} ${detail}`)
}

await gotoReady(page, '/daq', { wait: 2500 })
const siderX = () => page.evaluate(() => {
  const s = document.querySelector('.app-sider')
  return s ? Math.round(s.getBoundingClientRect().x) : null
})
check('窄屏侧栏初始在画布外', (await siderX()) < 0, `x=${await siderX()}`)
check('body 带 nav-drawer', await page.evaluate(() => document.body.classList.contains('nav-drawer')))

await page.click('.collapse-btn')
await sleep(600)
check('点汉堡后抽屉进入画布', (await siderX()) >= -2, `x=${await siderX()}`)
check('遮罩出现', await page.evaluate(() => !!document.querySelector('.nav-scrim')))
check('画面滚动被锁', await page.evaluate(() => document.body.style.overflow === 'hidden'))

await page.keyboard.press('Escape')
await sleep(600)
check('Esc 关闭抽屉', (await siderX()) < 0, `x=${await siderX()}`)
check('滚动锁解除', await page.evaluate(() => document.body.style.overflow !== 'hidden'))

await page.click('.collapse-btn')
await sleep(500)
await page.evaluate(() => {
  const el = Array.from(document.querySelectorAll('.menu-item')).find(e => (e.textContent || '').includes('产线运营'))
  el?.click()
})
await sleep(2200)
check('点菜单后路由跳转', page.url().includes('/dcw'), page.url())
check('跳转后抽屉自动收起', (await siderX()) < 0, `x=${await siderX()}`)
check('无 pageerror', errs.length === 0, errs.join(' | ').slice(0, 200))

await browser.close()
const failed = results.filter(r => !r.ok).length
console.log(`\n=== 抽屉交互:${results.length - failed} 通过 / ${failed} 失败 ===`)
process.exit(failed ? 1 : 0)
