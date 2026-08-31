/** 一次性:bind-pop 高度钳制验证 —— 弹层 top 不越出 Inspector 卡片顶缘 */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
let TOKEN = ''
const H = () => ({ 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' })
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
TOKEN = login.data.token
const OUT = 'docs/audit/screenshots/ui-polish-0831'

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=2560,1271'],
})
const page = await browser.newPage()
await page.setViewport({ width: 2560, height: 1271 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })

try {
  await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  for (let i = 0; i < 45; i++) {
    if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
    await new Promise(r => setTimeout(r, 1000))
  }
  await new Promise(r => setTimeout(r, 3500))

  const segBtns = await page.$$('.nav-tabs .seg button')
  await segBtns[1].click()
  await new Promise(r => setTimeout(r, 600))
  // 选中第一台设备(挤出机)
  await page.evaluate(() => {
    const dev = [...(window.__town.scene.getDeviceNodes?.() ?? [])][0]
    if (dev) window.__town.scene.setSelected?.({ kind: 'device', id: dev.twinId })
  })
  await new Promise(r => setTimeout(r, 900))

  const check = async (idx, name, shot) => {
    const btn = (await page.$$('.bind-add-wrap .bind-add'))[idx]
    await btn.evaluate(el => el.scrollIntoView({ block: 'center' }))
    await new Promise(r => setTimeout(r, 300))
    await btn.click()
    await new Promise(r => setTimeout(r, 500))
    const r = await page.evaluate(() => {
      const pop = document.querySelector('.bind-pop')
      const panel = pop?.closest('.panel')
      if (!pop || !panel) return null
      const pr = panel.getBoundingClientRect()
      const por = pop.getBoundingClientRect()
      return {
        popTop: Math.round(por.top),
        panelTop: Math.round(pr.top),
        overshoot: Math.round(pr.top - por.top),
        popBottom: Math.round(por.bottom),
        popHeight: Math.round(por.height),
        scrollable: pop.scrollHeight > pop.clientHeight,
      }
    })
    console.log(`${name}:`, JSON.stringify(r), '| top 在面板内:', r && r.overshoot <= 0 ? 'OK' : 'OVERSHOOT')
    await page.screenshot({ path: `${OUT}/${shot}` })
    // 关闭
    const btns = await page.$$('.bind-add-wrap .bind-add')
    await btns[idx].click()
    await new Promise(r => setTimeout(r, 300))
  }

  await check(0, 'T1 daq picker bounds', 'round4-daq-pop-clamped.png')
  await check(1, 'T2 dcw picker bounds', 'round4-dcw-pop-clamped.png')
}
finally {
  await browser.close()
}
console.log('round4 done')
