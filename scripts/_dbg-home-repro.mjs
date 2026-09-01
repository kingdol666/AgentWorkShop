/** 复现扫谱序列:先 town 后 home,抓 dispose 堆栈。 */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())

const bA = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const pA = await bA.newPage()
await pA.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 })
await pA.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await pA.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(15000)
await bA.close()

const bB = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] })
const pB = await bB.newPage()
await pB.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
await pB.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
pB.on('pageerror', e => console.log('HOME PAGEERROR:\n', e.stack?.slice(0, 1500) ?? String(e)))
await pB.goto(`${ROOT}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(9000)
console.log('done')
await bB.close()
