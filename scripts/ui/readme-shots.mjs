/**
 * README 用真实截图(与 record.mjs 的 GIF 配套)。
 * 全部 1600×1000 @2x 出图,固定暗色控制室主题 —— README 首屏是深色语境,
 * 混入亮色截图会让整页忽明忽暗。
 */
import path from 'node:path'
import { ensureVisualUser, launch, openPage, gotoReady } from './lib.mjs'

const OUT = 'docs/readme-assets'
const W = 1600
const H = 1000

const SHOTS = [
  { file: 'town.png', route: '/town', wait: 11000 },
  { file: 'daq.png', route: '/daq', wait: 8000 },
  { file: 'shot-workshop.png', route: '/workshop', wait: 7000 },
  { file: 'shot-monitor.png', route: '/monitor', wait: 6000 },
  { file: 'shot-settings.png', route: '/settings', wait: 6000 },
  { file: 'shot-plugins.png', route: '/plugins', wait: 6000 },
  { file: 'shot-dcw.png', route: '/dcw', wait: 7000 },
  { file: 'shot-aml.png', route: '/aml', wait: 7000 },
  { file: 'shot-logs.png', route: '/logs', wait: 6000 },
]

const token = await ensureVisualUser()
const browser = await launch()
for (const s of SHOTS) {
  const page = await openPage(browser, { token, dark: true, width: W, height: H, deviceScaleFactor: 2 })
  const errs = []
  page.on('pageerror', e => errs.push(String(e.message).slice(0, 120)))
  try {
    await gotoReady(page, s.route, { wait: s.wait })
    await page.screenshot({ path: path.join(OUT, s.file) })
    console.log('  ok  ' + s.file.padEnd(22) + s.route + (errs.length ? '  errs=' + errs.length : ''))
  }
  catch (e) {
    console.log('  FAIL ' + s.file + ' — ' + String(e.message).slice(0, 120))
  }
  await page.close()
}
await browser.close()
console.log('-> ' + OUT)
