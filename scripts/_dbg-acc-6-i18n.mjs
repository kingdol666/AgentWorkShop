// i18n 分组标题修复目视验证
import puppeteer from 'puppeteer-core'
const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
const login = await fetch('http://127.0.0.1:3021/api/users/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@awshop.local', password: 'admin123' }) }).then(r => r.json())
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
await page.goto('http://127.0.0.1:3021/settings', { waitUntil: 'networkidle2', timeout: 60000 })
await new Promise(r => setTimeout(r, 1500))
await page.evaluate(() => {
  const tab = [...document.querySelectorAll('.ant-tabs-tab,[role=tab],button,.section-title')].find(e => (e.textContent ?? '').trim() === '运行配置')
  tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await new Promise(r => setTimeout(r, 1500))
const text = await page.evaluate(() => document.body.innerText)
console.log('缺键残留(settings.runtime.groupXxx):', /settings\.runtime\.group/.test(text) ? '仍有 ✖' : '已清零 ✔')
console.log('分组标题样例:', ['记忆系统', 'Agent Harness', '数控写控', '数据备份', 'Harness 接入'].filter(t => text.includes(t)).join(' / '))
await page.screenshot({ path: '.e2e-shots/acc-6-i18n-groups.png' })
await browser.close()
