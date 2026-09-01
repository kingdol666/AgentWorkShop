/** 一次性:向导驱动表单截图(每个协议一张)—— 供协议配置文档使用 */
import puppeteer from 'puppeteer-core'

const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const drivers = [
  ['modbus-tcp', 'modbus-tcp'],
  ['modbus-rtu', 'modbus-rtu'],
  ['opcua', 'opcua'],
  ['mqtt', 'mqtt'],
  ['http', 'http'],
]
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1200'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.goto('http://127.0.0.1:3000/daq', { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 8000))

// 打开添加节点向导
const addBtn = await page.evaluateHandle(() => {
  const btns = [...document.querySelectorAll('button')]
  return btns.find(b => (b.textContent ?? '').includes('添加节点'))
})
await addBtn.asElement()?.click()
await new Promise(r => setTimeout(r, 1200))
// 切到真实设备模式
const realBtn = await page.evaluateHandle(() => {
  const btns = [...document.querySelectorAll('button')]
  return btns.find(b => (b.textContent ?? '').includes('真实设备'))
})
if (realBtn.asElement()) {
  await realBtn.asElement().click()
  await new Promise(r => setTimeout(r, 600))
}

for (const [kind, file] of drivers) {
  await page.evaluate((k) => {
    // 向导中的驱动下拉:DAQ_DRIVERS 驱动的 select
    const selects = [...document.querySelectorAll('.modal select, [class*="wizard"] select')]
    const sel = selects[0]
    if (sel) {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
      nativeSetter.call(sel, k)
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }, kind)
  await new Promise(r => setTimeout(r, 800))
  // 找向导 modal 容器截图
  const modal = await page.$('.modal, [class*="wizard"]')
  if (modal) {
    await page.evaluate(() => document.querySelector('.modal')?.scrollIntoView({ block: 'start' }))
  }
  await new Promise(r => setTimeout(r, 300))
  await (modal ? modal.asElement() : page).screenshot({ path: `docs/protocol-guides/wizard-${file}.png` })
  console.log('shot:', file)
}
await browser.close()
