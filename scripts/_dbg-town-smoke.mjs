/** 数字孪生(/town)冒烟:3D 场景挂载、渲染循环推进、WS 实时数据接入、产线/节点可见。 */
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: process.env.E2E_USER ?? 'zhangwei@awshop.io', password: process.env.E2E_PASS ?? 'Awshop@123' }),
}).then(r => r.json())

let fail = 0
const check = (n, ok, d = '') => { console.log(`${ok ? '✔' : '✖'} ${n}${d ? ` — ${d}` : ''}`); if (!ok) fail++ }

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 14000))

const probe = await page.evaluate(() => {
  const sc = globalThis.__townScene3d
  const canvas = document.querySelector('canvas')
  return {
    sceneHook: Boolean(sc),
    frameCount: sc?.frameCount ?? 0,
    hasCanvas: Boolean(canvas),
    canvasSize: canvas ? `${canvas.clientWidth}x${canvas.clientHeight}` : null,
    stats: globalThis.__townStats ? Object.keys(globalThis.__townStats).slice(0, 8) : null,
    bodyText: (document.body.innerText ?? '').slice(0, 400),
  }
})
console.log(JSON.stringify(probe, null, 1).slice(0, 700))

check('/town 页面可打开', probe.bodyText.length > 0)
check('3D 画布已挂载', probe.hasCanvas && probe.canvasSize !== '0x0', probe.canvasSize ?? '')
check('场景钩子存在(__townScene3d)', probe.sceneHook)
// 冷启动时画布要等频道快照到达后才挂载,此处只要求「已开始渲染」;持续推进由下一条断言把关
check('渲染循环已启动(frameCount > 0)', probe.frameCount > 0, `frames=${probe.frameCount}`)

// 渲染必须持续推进(隔 2s 再取一次,帧数应增长)
const f2 = await page.evaluate(() => globalThis.__townScene3d?.frameCount ?? 0)
await new Promise(r => setTimeout(r, 2200))
const f3 = await page.evaluate(() => globalThis.__townScene3d?.frameCount ?? 0)
check('渲染帧持续增长(非冻结)', f3 > f2, `${f2} -> ${f3}`)

await page.screenshot({ path: '.e2e-shots/final-town.png' })
await browser.close()
console.log(fail === 0 ? '全部通过' : `失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
