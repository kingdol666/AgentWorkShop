/** 一次性:调控闭环 UI 验证 —— /daq 优化记录面板展开 + /dcw/[id] 参数台账截图 */
import puppeteer from 'puppeteer-core'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1200'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 120)))
await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })

// ---- /daq:展开优化记录面板 ----
await page.goto('http://127.0.0.1:3000/daq', { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 8000))
const hasOptCard = await page.evaluate(() => !!document.querySelector('.opt-card'))
if (hasOptCard) {
  await page.click('.opt-head')
  await new Promise(r => setTimeout(r, 2500))
  await page.evaluate(() => document.querySelector('.opt-card')?.scrollIntoView({ block: 'start' }))
  await new Promise(r => setTimeout(r, 600))
  // 有记录时点开第一条序列
  const btn = await page.$('.opt-row .mini-act')
  if (btn) {
    await btn.click()
    await new Promise(r => setTimeout(r, 2500))
  }
}
await page.screenshot({ path: 'docs/audit/screenshots/huashu-survey2/daq-opt-panel.png' })
console.log('shot: daq-opt-panel (panel:', hasOptCard, ')')

// ---- /dcw/[id]:选节点看台账 ----
// 找 1号产线 id
const lineId = await page.evaluate(async () => {
  const r = await fetch('/api/workshop/dcw', { headers: { authorization: `Bearer ${document.cookie.match(/token=([^;]+)/)?.[1] ?? ''}` } }).then(x => x.json())
  return r?.data?.lines?.find(l => l.name === '1号产线')?.id ?? ''
})
if (lineId) {
  await page.goto(`http://127.0.0.1:3000/dcw/${lineId}`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await new Promise(r => setTimeout(r, 8000))
  const hasLedger = await page.evaluate(() => !!document.querySelector('.ledger-card'))
  if (hasLedger) {
    await page.evaluate(() => document.querySelector('.ledger-card')?.scrollIntoView({ block: 'center' }))
    // 选第一个节点
    const sel = await page.$('.ledger-head select')
    if (sel) {
      await page.evaluate(() => {
        const s = document.querySelector('.ledger-head select')
        s.selectedIndex = 1
        s.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await new Promise(r => setTimeout(r, 2500))
    }
    await page.screenshot({ path: 'docs/audit/screenshots/huashu-survey2/dcw-ledger.png' })
    console.log('shot: dcw-ledger (card:', hasLedger, ')')
  }
}
await browser.close()
console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors')
