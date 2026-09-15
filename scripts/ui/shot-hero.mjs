/**
 * 把 docs/readme-assets/hero.html 渲成 2 倍图 hero.png(README 首屏).
 * hero.html 里的截图是同目录下的真实运行截图(town.png / daq.png),
 * 所以出图前必须先跑 scripts/ui/shots.mjs 更新它们。
 */
import puppeteer from 'puppeteer-core'
import path from 'node:path'
import { CHROME } from './lib.mjs'

const dir = path.resolve('docs/readme-assets')
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--force-color-profile=srgb', '--font-render-hinting=none'],
  defaultViewport: { width: 1300, height: 520, deviceScaleFactor: 2 },
})
const page = await browser.newPage()
const errs = []
page.on('pageerror', e => errs.push(e.message))
page.on('requestfailed', r => errs.push('failed: ' + r.url()))
await page.goto('file:///' + path.join(dir, 'hero.html').replace(/\\/g, '/'), { waitUntil: 'networkidle0' })
await new Promise(r => setTimeout(r, 400))
await page.screenshot({ path: path.join(dir, 'hero.png'), type: 'png' })
console.log('hero.png written', errs.length ? '⚠ ' + errs.join(' | ') : '')
await browser.close()
