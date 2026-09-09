/** 一次性:cfB 产线详情页特写截图 */
import puppeteer from 'puppeteer-core'

const token = process.argv[2]
const lineId = process.argv[3]
const b = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--proxy-server=direct://', '--proxy-bypass-list=*', '--window-size=1920,1400'],
})
const p = await b.newPage()
await p.setViewport({ width: 1920, height: 1400 })
await p.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
await p.goto(`http://127.0.0.1:3001/dcw/${lineId}`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await new Promise(r => setTimeout(r, 9000))
await p.screenshot({ path: 'docs/experiments/results/castfilm-ui/06-line-detail-cfB.png' })
await b.close()
console.log('shot ok')
