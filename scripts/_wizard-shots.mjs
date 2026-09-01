/** 一次性:向导驱动表单截图(每个协议一张,含真连测试结果)—— 供协议配置文档使用 */
import puppeteer from 'puppeteer-core'

const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
// 每协议的演示配置:打本机 dev 模拟器(modbus 1502 / rtu 15030 / opcua 4840 / mqtt 1883 / http 1889)
const FILL = {
  'modbus-tcp': { host: '127.0.0.1', register: '40021' },
  'modbus-rtu': { host: '127.0.0.1', register: '40001' },
  'opcua': { endpoint: 'opc.tcp://127.0.0.1:4840', nodeId: 'ns=2;s=AW.Temp' },
  'mqtt': { host: '127.0.0.1', topic: 'aw/sim/temp', jsonPath: 'data.temp' },
  'http': { url: 'http://127.0.0.1:1889/api/value', jsonPath: 'data.value' },
}
const DRIVERS = ['modbus-tcp', 'modbus-rtu', 'opcua', 'mqtt', 'http']
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1920,1200'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1920, height: 1200, deviceScaleFactor: 1 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })

for (const kind of DRIVERS) {
  // 每个驱动独立加载,避免上一次的测试结果残留进画面
  await page.goto('http://127.0.0.1:3000/daq', { waitUntil: 'domcontentloaded', timeout: 90000 })
  await sleep(7000)

  const openRes = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const add = btns.find(b => (b.textContent ?? '').includes('添加节点'))
    add?.click()
    return !!add
  })
  void openRes
  await sleep(1200)
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const real = btns.find(b => (b.textContent ?? '').includes('真实设备'))
    real?.click()
  })
  await sleep(700)

  // 协议下拉:唯一一个 option value 命中驱动名的 select(模板下拉的 value 是模板 ref,不会撞)
  await page.evaluate((k) => {
    const selects = [...document.querySelectorAll('select')]
    const sel = selects.find(s => [...s.options].some(o => o.value === k))
    if (!sel)
      throw new Error(`protocol select not found for ${k}`)
    const set = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    set.call(sel, k)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  }, kind)
  await sleep(800)

  // 按 placeholder 填演示值(Vue v-model 监听 input 事件)
  await page.evaluate((kv) => {
    for (const [ph, val] of Object.entries(kv)) {
      const inp = [...document.querySelectorAll('input')].find(i => i.placeholder === ph)
      if (!inp)
        throw new Error(`input placeholder「${ph}」not found`)
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      set.call(inp, val)
      inp.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }, FILL[kind])
  await sleep(300)

  // 点「测试连接」,等结果条出现
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').includes('测试连接'))
    btn?.click()
  })
  try {
    await page.waitForFunction(() => {
      const el = document.querySelector('.test-result')
      return el && (el.textContent ?? '').length > 2
    }, { timeout: 10000 })
  }
  catch {
    console.log(`warn: ${kind} 测试结果未出现(照常截图)`)
  }
  await sleep(400)

  const modal = await page.$('.modal, [class*="wizard"]')
  await (modal ?? page).screenshot({ path: `docs/protocol-guides/wizard-${kind}.png` })
  console.log('shot:', kind)
}
await browser.close()
