/** 插件面板注入截图验证:/plugins 页应出现 rag-bridge KB 面板 + diag-bridge 诊断记录面板 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3001'
const stamp = Date.now().toString(36)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let fail = 0
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✔' : '✘'} ${label}${detail ? ` —— ${detail}` : ''}`)
  if (!cond) fail++
}

async function main() {
  mkdirSync('.design-verify', { recursive: true })
  const reg = await fetch(`${BASE}/api/users/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `panelui-${stamp}`, email: `panelui-${stamp}@test.local`, password: 'Passw0rd!123' }),
  }).then(r => r.json()).catch(() => null)
  ok(Boolean(reg?.data?.token), '注册测试用户')

  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: 'new', args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1440, height: 1200 },
  })
  const page = await browser.newPage()
  await page.goto(`${BASE}/plugins`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(2000)
  await page.evaluate((t) => { document.cookie = `token=${t}; path=/` }, reg.data.token)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(6000) // 等插件 client 装载 + 面板首帧数据

  const text = await page.evaluate(() => document.body.innerText)
  ok(text.includes('工业知识库'), 'rag-bridge 面板标题渲染(i18n 中文)')
  ok(text.includes('深度诊断'), 'diag-bridge 面板标题渲染(i18n 中文)')
  ok(text.includes('检索'), 'rag-bridge 面板检索框渲染')
  ok(text.includes('诊断记录') || text.includes('Run'), 'diag-bridge 面板表格渲染')

  const slotEl = await page.$$eval('[data-plugin-panel]', els => els.map(e => e.dataset.pluginPanel))
  ok(slotEl.some(s => s?.startsWith('rag-bridge/')), '插槽 DOM 含 rag-bridge 面板容器', slotEl.join(','))
  ok(slotEl.some(s => s?.startsWith('diag-bridge/')), '插槽 DOM 含 diag-bridge 面板容器')

  await page.screenshot({ path: '.design-verify/plug-05-client-panels.png' })
  console.log('  · 截图 .design-verify/plug-05-client-panels.png')

  await page.goto('about:blank').catch(() => {})
  await sleep(1200)
  await browser.close()
  console.log(fail === 0 ? '\n★ 面板注入 ALL PASS' : `\n✘ ${fail} 项失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
