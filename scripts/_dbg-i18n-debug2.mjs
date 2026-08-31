/** 一次性:检查 /daq 页面是否渲染了 error.vue */
import puppeteer from 'puppeteer-core'

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
})
const page = await browser.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 300)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })
await page.setCookie({ name: 'token', value: 'ut-ffc1dfbbc0c1444c87c1ec69a9e8208c', domain: '127.0.0.1', path: '/' })
await page.goto('http://127.0.0.1:3000/workshop/agents', { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.evaluate(() => localStorage.setItem('aw.locale', 'en'))
await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise(r => setTimeout(r, 4000))
const dbg = await page.evaluate(() => ({
  hasErrPage: !!document.querySelector('.err-page'),
  errText: document.querySelector('.err-message')?.textContent ?? '',
  hasDaqTable: document.querySelectorAll('.nodes-table').length,
  bodyLang: document.documentElement.lang,
}))
console.log(JSON.stringify(dbg))
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none')
await browser.close()
