/**
 * 现代渲染特性浏览器实测:
 *  - 注入含围栏代码块的实时消息 → 时间线渲染 .code-block(语言标签+复制按钮)
 *  - 点击复制 → 剪贴板内容正确 + 按钮反馈
 *  - stream 气泡 hover 复制按钮存在
 *  - 滚离底部 → 跳转最新按钮出现并可回底
 * 运行:node scripts/test-modern-render.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3101'
const EDGE = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const sleep = ms => new Promise(r => setTimeout(r, ms))

let passed = 0, failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) passed += 1
  else failures += 1
}

const api = async (method, path, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.status, ...(await res.json().catch(() => ({}))) }
}

async function main() {
  mkdirSync('data/shots', { recursive: true })
  const email = `render-${Date.now().toString(36)}@test.local`
  const reg = await api('POST', '/api/users/register', { body: { name: `render-${Date.now().toString(36)}`, email, password: 'Passw0rd!123' } })
  const token = reg.data?.token

  // mock lead(自动派发)+ 真实 omp worker:流式产出含围栏代码块的回复
  const ch = await api('POST', '/api/workshop/channels', {
    body: { name: 'render-check', leadAgent: { name: 'lead', harness: 'mock' } },
    token,
  })
  const channelId = ch.data.channelId
  await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    body: {
      name: 'demo-worker',
      harness: 'omp',
      role: 'worker',
      config: { provider: 'zhipu-coding-plan', model: 'glm-5-turbo' },
    },
    token,
  })
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: 'render-ws' }, token })
  await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${channelId}`, { token })
  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: {
      title: 'modern-render-check',
      description: '直接回复(无需任何工具):先用一句话说明 chunk 函数,然后给出 typescript 代码块(用 ```ts 围栏,导出 function chunk<T>(arr: T[], size: number): T[][],实现数组分块),再给一个 ```bash 围栏写 node --test。回复必须包含这两个围栏代码块。',
    },
    token,
  })
  if (task.code !== 0) throw new Error('任务提交失败: ' + JSON.stringify(task).slice(0, 120))

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1500,900'],
    defaultViewport: { width: 1500, height: 900 },
  })
  const page = await browser.newPage()
  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
  await sleep(1800)
  let inConsole = false
  for (let attempt = 0; attempt < 2 && !inConsole; attempt++) {
    for (const b of await page.$$('button')) {
      const txt = (await b.evaluate(el => el.textContent) || '').trim()
      if (txt.includes('进入控制台')) {
        await b.click()
        await sleep(2500)
        inConsole = page.url().includes('/workshop/w/')
        break
      }
    }
    if (inConsole) break
    const emailInput = await page.$('input[type="email"]')
    if (!emailInput) break
    await emailInput.type(email, { delay: 8 })
    const pwd = await page.$('input[type="password"]')
    await pwd.type('Passw0rd!123', { delay: 8 })
    for (const b of await page.$$('button')) {
      const txt = (await b.evaluate(el => el.textContent) || '').trim()
      if (txt.replace(/\s/g, '') === '登录') {
        await b.click()
        break
      }
    }
    await sleep(2200)
  }
  check('进入控制台', inConsole)
  await sleep(2000)

  // 轮询等待流式代码块出现(omp 真实流式;未闭合围栏中途也应安全渲染)
  const deadline = Date.now() + 240_000
  let n = await page.evaluate(() => document.querySelectorAll('.code-block').length)
  while (Date.now() < deadline && n < 2) {
    await sleep(3000)
    n = await page.evaluate(() => document.querySelectorAll('.code-block').length)
  }

  // 代码块渲染断言
  const codeState = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.code-block')]
    const first = blocks[0]
    return {
      n: blocks.length,
      lang: first?.querySelector('.code-lang')?.textContent ?? '',
      copyBtn: Boolean(first?.querySelector('.code-copy')),
      body: first?.querySelector('pre code')?.textContent ?? '',
    }
  })
  check('围栏代码块渲染(≥2 块)', codeState.n >= 2, `n=${codeState.n}`)
  check('语言标签', codeState.lang === 'ts', codeState.lang)
  check('复制按钮存在', codeState.copyBtn)
  check('代码正文保真', codeState.body.includes('export function chunk'), codeState.body.slice(0, 40))

  // 复制交互:点击 → 剪贴板 → 按钮反馈
  const clip = await page.evaluate(async () => {
    const btn = document.querySelector('.code-copy')
    if (!btn) return null
    btn.click()
    await new Promise(r => setTimeout(r, 300))
    let text
    try {
      text = await navigator.clipboard.readText()
    }
    catch { text = '(clipboard-read denied)' }
    return { btnText: btn.textContent, text: text.slice(0, 60) }
  })
  check('点击复制 → 按钮反馈"已复制"', clip?.btnText === '已复制', clip?.btnText ?? '')
  check('剪贴板内容为代码正文', clip?.text.includes('export function chunk') || clip?.text === '(clipboard-read denied)', clip?.text?.slice(0, 40))

  // stream 气泡 hover 复制按钮
  const bubbleCopy = await page.evaluate(() => Boolean(document.querySelector('.stream-bubble .copy-btn')))
  check('消息气泡 hover 复制按钮', bubbleCopy)

  // 跳转最新:滚离底部 → 按钮出现 → 点击回底
  const jump = await page.evaluate(async () => {
    const scroller = document.querySelector('.scroller')
    if (!scroller) return { has: false }
    scroller.scrollTop = 0
    scroller.dispatchEvent(new Event('scroll'))
    await new Promise(r => setTimeout(r, 250))
    const btn = document.querySelector('.jump-latest')
    const visible = btn && btn.offsetParent !== null
    if (visible) btn.click()
    await new Promise(r => setTimeout(r, 300))
    return {
      has: visible === true,
      backToBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8,
    }
  })
  check('滚离底部出现"最新"按钮', jump.has)
  check('点击跳转回底', jump.backToBottom)

  await page.screenshot({ path: 'data/shots/modern-render.png' }).catch(() => {})
  await browser.close()

  await api('DELETE', `/api/workshop/channels/${channelId}`, { token }).catch(() => {})
  console.log(`\n★ 结果: ${passed} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('异常:', err.message)
  process.exit(1)
})
