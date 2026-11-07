/**
 * ARK-7 可用性修复版验收（2026-11-06）
 * 运行：node docs/audit/evidence/2026-11-06-project-continue/game-acceptance.mjs
 * 产物：game-acceptance.json + 控制台摘要；需要本机 Chrome + puppeteer-core。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const ROOT = 'D:/codes/ABO/aw-router-demo-20261105/data/workspaces/89d72e64-3782-43c9-b207-545bdcaa6b55'
const GAME = path.join(ROOT, 'game.html')
const OUT = 'D:/codes/ABO/aw-router-v3/docs/audit/evidence/2026-11-06-project-continue/game-acceptance.json'
const CHROME = process.env.AW_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const html = fs.readFileSync(GAME, 'utf8')
const checks = []
const check = (id, name, pass, detail = '') => {
  checks.push({ id, name, pass: Boolean(pass), detail: String(detail).slice(0, 500) })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}${pass ? '' : ` — ${detail}`}`)
}

check('S1', '单文件存在且 >= 8000 字节', Buffer.byteLength(html) >= 8000, `${Buffer.byteLength(html)} bytes`)
for (const [id, needle] of [['S2', '<!DOCTYPE'], ['S3', '<canvas'], ['S4', 'devicePixelRatio'], ['S5', 'touchstart'], ['S6', 'touchmove'], ['S7', 'visibilitychange'], ['S8', 'blur'], ['S9', '__game'], ['S10', 'debug=1']]) {
  check(id, `源码包含 ${needle}`, html.includes(needle))
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const errors = []
try {
  // 生产：无 debug API
  {
    const page = await browser.newPage()
    page.on('pageerror', e => errors.push(String(e)))
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(pathToFileURL(GAME).href, { waitUntil: 'load' })
    const api = await page.evaluate(() => typeof window.__game)
    check('R1', '无 ?debug=1 时 window.__game 不暴露', api === 'undefined', api)
    await page.close()
  }

  const page = await browser.newPage()
  page.on('pageerror', e => errors.push(String(e)))
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true, isMobile: true })
  await page.goto(`${pathToFileURL(GAME).href}?debug=1`, { waitUntil: 'load' })
  await page.waitForFunction('window.__game')
  check('R2', '?debug=1 时提供测试入口', await page.evaluate(() => typeof window.__game === 'object'))

  const canvas = await page.evaluate(() => {
    const c = document.querySelector('canvas')
    const r = c.getBoundingClientRect()
    return { cssW: r.width, cssH: r.height, w: c.width, h: c.height, dpr: devicePixelRatio, overflowX: document.documentElement.scrollWidth > innerWidth }
  })
  check('R3', '移动端无横向溢出', !canvas.overflowX, JSON.stringify(canvas))
  check('R4', 'canvas backing store 按 DPR 放大', canvas.w === Math.round(1280 * canvas.dpr) && canvas.h === Math.round(720 * canvas.dpr), JSON.stringify(canvas))

  const buttons = await page.evaluate(() => ['bPause', 'bMute', 'bFull'].map((id) => {
    const r = document.getElementById(id).getBoundingClientRect()
    return { id, x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width >= 44 && r.height >= 44 && r.right <= innerWidth && r.left >= 0 }
  }))
  check('R5', '暂停/静音/全屏按钮可见且触摸目标 >=44', buttons.every(b => b.visible), JSON.stringify(buttons))

  // 触屏拖动 + 自动开火
  const box = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })
  const sx = box.x + box.w * 0.3
  const sy = box.y + box.h * 0.7
  await page.touchscreen.tap(sx, sy)
  await new Promise(r => setTimeout(r, 300))
  const before = await page.evaluate(() => ({ st: __game.state(), px: __game.G.px, py: __game.G.py }))
  await page.touchscreen.touchStart(sx, sy)
  await page.touchscreen.touchMove(sx + 80, sy - 45)
  await new Promise(r => setTimeout(r, 700))
  const during = await page.evaluate(() => ({ st: __game.state(), px: __game.G.px, py: __game.G.py, bullets: __game.G.b.length }))
  await page.touchscreen.touchEnd()
  check('R6', '390×844 触屏拖动改变飞船坐标', Math.abs(during.px - before.px) > 5 || Math.abs(during.py - before.py) > 5, JSON.stringify({ before, during }))
  check('R7', '触屏移动时自动开火', during.bullets > 0, String(during.bullets))

  // 暂停按钮
  await page.click('#bPause')
  await new Promise(r => setTimeout(r, 80))
  check('R8', '暂停按钮进入 pause', (await page.evaluate(() => __game.state())) === 'pause')
  await page.click('#bPause')
  await new Promise(r => setTimeout(r, 80))

  // 失焦清键 + 暂停
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2, hasTouch: false })
  await page.evaluate(() => __game.start(1))
  await new Promise(r => setTimeout(r, 100))
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' })))
  await new Promise(r => setTimeout(r, 250))
  const px1 = await page.evaluate(() => __game.G.px)
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await new Promise(r => setTimeout(r, 350))
  const afterBlur = await page.evaluate(() => ({ st: __game.state(), px: __game.G.px }))
  check('R9', 'blur 后停止移动并自动暂停', Math.abs(afterBlur.px - px1) < 2 && afterBlur.st === 'pause', JSON.stringify({ px1, afterBlur }))

  // visibilitychange 清键
  await page.evaluate(() => { __game.start(1); Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')) })
  await new Promise(r => setTimeout(r, 120))
  check('R10', 'visibilitychange(hidden) 自动暂停', (await page.evaluate(() => __game.state())) === 'pause')

  // 桌面键鼠回归
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); __game.start(1) })
  await new Promise(r => setTimeout(r, 100))
  const px0 = await page.evaluate(() => __game.G.px)
  await page.keyboard.down('d'); await new Promise(r => setTimeout(r, 250)); await page.keyboard.up('d')
  const pxD = await page.evaluate(() => __game.G.px)
  await page.keyboard.down(' '); await new Promise(r => setTimeout(r, 220)); await page.keyboard.up(' ')
  const bullets = await page.evaluate(() => __game.G.b.length)
  check('R11', '桌面 D 键移动 + Space 开火', pxD > px0 + 5 && bullets > 0, JSON.stringify({ px0, pxD, bullets }))

  // 关卡/胜利/重开/失败
  await page.evaluate(() => { __game.start(1); __game.G.res = 12; __game.G.px = 640; __game.G.py = 78 })
  await new Promise(r => setTimeout(r, 350))
  const l1 = await page.evaluate(() => ({ st: __game.state(), score: __game.score() }))
  check('R12', '第 1 关配额达成进入升级', l1.st === 'upgrade' && l1.score > 0, JSON.stringify(l1))
  await page.keyboard.press('1'); await new Promise(r => setTimeout(r, 180))
  const l2 = await page.evaluate(() => ({ st: __game.state(), l: __game.G.l }))
  check('R13', '升级选择进入第 2 关', l2.st === 'play' && l2.l === 2, JSON.stringify(l2))
  await page.evaluate(() => __game.win()); await new Promise(r => setTimeout(r, 100))
  const win = await page.evaluate(() => __game.state())
  check('R14', '第 3 关胜利状态', win === 'win', win)
  await page.keyboard.press('r'); await new Promise(r => setTimeout(r, 150))
  const restart = await page.evaluate(() => ({ st: __game.state(), l: __game.G.l, score: __game.score() }))
  check('R15', 'R 重开回到第 1 关', restart.st === 'play' && restart.l === 1 && restart.score === 0, JSON.stringify(restart))
  await page.evaluate(() => { __game.G.di = 0; __game.hurt(999) }); await new Promise(r => setTimeout(r, 100))
  const over = await page.evaluate(() => ({ st: __game.state(), hull: __game.P.hull }))
  check('R16', '船体归零进入 GAME OVER', over.st === 'over' && over.hull === 0, JSON.stringify(over))
  await page.close()
  check('R17', '全流程 0 pageerror', errors.length === 0, errors.join(' | '))
}
finally {
  await browser.close()
}
const result = { game: GAME, bytes: Buffer.byteLength(html), checks, pass: checks.filter(c => c.pass).length, total: checks.length, generatedAt: new Date().toISOString() }
fs.writeFileSync(OUT, JSON.stringify(result, null, 2))
console.log(`SUMMARY ${result.pass}/${result.total}`)
if (result.pass !== result.total) process.exitCode = 1
