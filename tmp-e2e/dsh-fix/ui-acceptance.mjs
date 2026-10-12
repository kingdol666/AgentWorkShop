// dsh web 验收 v2:按 placeholder 定位真聊天框 → 发送 → 等回复 → 截图 + 会话存储断言
import puppeteer from 'puppeteer-core'
import * as fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const { mkdirSync, readFileSync } = fs

const SHOTS = 'tmp-e2e/dsh-fix/shots'
mkdirSync(SHOTS, { recursive: true })
const URL = readFileSync('tmp-e2e/dsh-web.out.log', 'utf8').match(/http:\/\/127\.0\.0\.1:[0-9]+\/\?token=[A-Za-z0-9_-]+/)?.[0]
if (!URL) throw new Error('读不到 dsh web 入口')
const CHROME = 'C:\\Users\\87287\\.cache\\puppeteer\\chrome\\win64-155.0.8059.39\\chrome-win64\\chrome.exe'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, protocolTimeout: 300_000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] })
const page = await browser.newPage()
await page.setViewport({ width: 1500, height: 900 })
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
await sleep(6000)

// 聊天输入:contenteditable(uV2eYG_input;侧栏搜索框是 input,不会误中)
let target = await page.$('.uV2eYG_input')
if (!target) target = await page.$('[contenteditable="true"]')
if (!target) {
  for (const el of await page.$$('[contenteditable="true"]')) {
    const ph = await el.evaluate(e => (e.getAttribute('data-placeholder') ?? e.innerText ?? '').slice(0, 20))
    if (ph.includes('描述你想要构建')) {
      target = el
      break
    }
  }
}
if (!target) {
  console.log('未定位到聊天输入框')
  await page.screenshot({ path: `${SHOTS}/02-定位失败.png` })
  await browser.close()
  process.exit(1)
}
await target.click()
await target.type('验收测试:请回复 received 四个字母,不要做任何其他事', { delay: 5 })
await page.screenshot({ path: `${SHOTS}/01-已输入.png` })
// 点发送钮(输入框右侧圆形 ↑)
const sent = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')]
  const send = btns.find(b => b.querySelector('svg') && (b.ariaLabel ?? '').match(/send|发送/i))
  if (!send) return 'enter'
  send.click()
  return 'aria'
})
if (sent === 'enter') await target.press('Enter')
console.log('已发送(', sent, '),等回复…')
await sleep(25000)
const bodyText = await page.evaluate(() => document.body.innerText)
const gotReply = /received/i.test(bodyText)
const badFormat = bodyText.includes('producer-owned') || bodyText.includes('format v4')
await page.screenshot({ path: `${SHOTS}/02-回复后.png` })
console.log(JSON.stringify({ gotReply, badFormat }))
await browser.close()

// 会话存储断言:新 user/message + assistant/message,且零 plugin kind
const S = 'C:/Users/87287/.dsh/sessions/--D-codes-AgentWorkShop--'
const newest = fs.readdirSync(S).map(d => ({ d, m: fs.statSync(path.join(S, d)).mtimeMs })).sort((a, b) => b.m - a.m)[0].d
const txt = execFileSync('D:/ProgramData/anaconda3/Library/bin/zstd.exe', ['-d', '-c', path.join(S, newest, 'session.v4.jsonl.zstd')], { maxBuffer: 512 * 1024 * 1024 }).toString('utf8')
const userMsg = txt.includes('验收测试:请回复 received')
const replyMsg = txt.includes('received')
const bad = (txt.match(/"kind":"plugin"/g) ?? []).length
console.log(JSON.stringify({ store: newest.slice(0, 10), userMsg, replyMsg, pluginKind: bad }))
process.exit(gotReply && !badFormat && userMsg && replyMsg && bad === 0 ? 0 : 1)
