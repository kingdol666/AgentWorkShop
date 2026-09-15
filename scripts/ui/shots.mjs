/**
 * 全站视觉走查截图 —— 视口 × 主题 矩阵批量出图。
 *   node scripts/ui/shots.mjs [--out .e2e-shots/new/base] [--theme dark|light|both]
 *                             [--vp 1440x900] [--routes workshop,daq,...] [--wait 6000]
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureVisualUser, launch, openPage, gotoReady, ROUTES } from './lib.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 ? argv[i + 1] : d
}
const OUT = arg('out', '.e2e-shots/new/base')
const THEME = arg('theme', 'dark')
const VP = arg('vp', '1440x900')
const ONLY = arg('routes', '')
const WAIT = Number(arg('wait', 6500))
const [WV, HV] = VP.split('x').map(Number)

const themes = THEME === 'both' ? [true, false] : [THEME === 'dark']
// 'all' 与不传等价:两个验收脚本的参数语义必须一致,
// 否则 `--routes all` 会被当成"找一个名叫 all 的路由"而筛出空集(实测踩过:
// 跑完只留下一份空报告,还打印了 "saved")。
const picks = (!ONLY || ONLY === 'all')
  ? ROUTES
  : ROUTES.filter(r => ONLY.split(',').includes(r.name))

fs.mkdirSync(OUT, { recursive: true })
const token = await ensureVisualUser()
const browser = await launch({ width: WV, height: HV })
const report = []

for (const dark of themes) {
  for (const r of picks) {
    const page = await openPage(browser, { token, dark, width: WV, height: HV })
    const errs = []
    const consoleErrs = []
    page.on('pageerror', e => errs.push(String(e.message).slice(0, 200)))
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 200))
    })
    try {
      await gotoReady(page, r.path, { wait: WAIT })
      const geo = await page.evaluate(() => {
        const de = document.documentElement
        return {
          scrollW: de.scrollWidth,
          clientW: de.clientWidth,
          scrollH: de.scrollHeight,
          clientH: de.clientHeight,
          url: location.pathname,
        }
      })
      const file = path.join(OUT, `${dark ? 'dark' : 'light'}__${r.name}.png`)
      await page.screenshot({ path: file })
      report.push({
        route: r.name, path: r.path, theme: dark ? 'dark' : 'light',
        landed: geo.url, overflowX: geo.scrollW - geo.clientW,
        scrollH: geo.scrollH, pageErrors: errs, consoleErrors: consoleErrs.slice(0, 3), file,
      })
      console.log(`  ${dark ? 'dark ' : 'light'} ${r.name.padEnd(12)} overflowX=${geo.scrollW - geo.clientW} landed=${geo.url} errs=${errs.length}`)
    }
    catch (e) {
      report.push({ route: r.name, theme: dark ? 'dark' : 'light', error: String(e.message).slice(0, 200) })
      console.log(`  FAIL ${r.name}: ${String(e.message).slice(0, 120)}`)
    }
    await page.close()
  }
}

fs.writeFileSync(path.join(OUT, '_report.json'), JSON.stringify(report, null, 2))
await browser.close()
console.log('\nsaved ->', OUT)
