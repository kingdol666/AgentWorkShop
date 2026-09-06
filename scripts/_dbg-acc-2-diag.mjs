// 诊断:settings 页文本结构
import puppeteer from 'puppeteer-core'
const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox', '--no-proxy-server'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
const login = await fetch('http://127.0.0.1:3021/api/users/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }) }).then(r => r.json())
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto('http://127.0.0.1:3021/settings', { waitUntil: 'networkidle2', timeout: 60000 })
await new Promise(r => setTimeout(r, 2500))
console.log('BODY-HEAD:', await page.evaluate(() => document.body.innerText.slice(0, 400).replace(/\n/g, ' / ')))
console.log('TITLES:', await page.evaluate(() => [...document.querySelectorAll('.section-title,h3,h4,.ant-tabs-tab')].map(e => e.textContent?.trim()).filter(Boolean).slice(0, 30).join(' | ')))
console.log('HAS-DAQ-LABEL:', await page.evaluate(() => document.body.innerText.includes('节点采样默认间隔')))
console.log('RT-ROWS:', await page.evaluate(() => document.querySelectorAll('.rt-row').length))
await browser.close()
