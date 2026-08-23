/**
 * UI 改版视觉走查截图 — 在当前设计体系(warm-editorial / ink-pill)下
 * 对时间线 / lanes / 总览做真实渲染截图,供人工比对。
 * 依赖:dev server(127.0.0.1:3000) + Edge + puppeteer-core。
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://127.0.0.1:3000'
const OUT = 'gui-test-screenshots/ui-redesign'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const api = async (method, ep, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${ep}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return res.json()
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const email = `shot-${Date.now().toString(36)}@test.local`
  const password = 'Passw0rd!123'
  const reg = await api('POST', '/api/users/register', { body: { name: `shot-${Date.now().toString(36)}`, email, password } })

  const { token } = reg.data

  // channel:mock lead/worker + streamDemo,保证时间线有丰富种类事件(状态/工具/流/任务/收口)
  const ch = await api('POST', '/api/workshop/channels', {
    body: {
      name: 'ui-walk',
      scenarioPrompt: 'UI 走查场景',
      leadAgent: { name: 'ui-lead', harness: 'mock', config: { delayMs: 300 } },
    },
    token,
  })
  const cid = ch.data.channelId
  await api('POST', `/api/workshop/channels/${cid}/agents`, {
    body: { name: 'ui-worker', harness: 'mock', role: 'worker', config: { delayMs: 320, streamDemo: true } },
    token,
  })
  await api('POST', `/api/workshop/channels/${cid}/agents`, {
    body: { name: 'ui-worker2', harness: 'mock', role: 'worker', config: { delayMs: 380, streamDemo: true } },
    token,
  })
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: 'ui-ws' }, token })
  await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${cid}`, { token })

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox'],
    defaultViewport: { width: 1600, height: 1000 },
  })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 200)))

  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
  await sleep(2500)
  const setInput = (sel, v) => page.$eval(sel, (el, val) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set
    set.call(el, val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, v)
  await setInput('input[type="email"]', email)
  await setInput('input[type="password"]', password)
  await sleep(200)
  for (const b of await page.$$('button')) {
    const txt = (await b.evaluate(el => el.textContent) || '').trim()
    if (txt.replace(/\s/g, '') === '登录') {
      await b.click()
      break
    }
  }
  await sleep(4500)
  await page.screenshot({ path: `${OUT}/01-overview.png` })

  if (!page.url().includes('/workshop/w/')) {
    await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
    await sleep(2500)
    for (const b of await page.$$('button')) {
      const txt = (await b.evaluate(el => el.textContent) || '').trim()
      if (txt.includes('进入控制台')) {
        await b.click()
        break
      }
    }
    await sleep(3500)
  }

  // 提交任务,等 mock 出流;期间截时间线多帧 + lanes
  await page.evaluate(() => {
    const ta = document.querySelector('.composer textarea')
    if (!ta) return
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, '实现一个极简的待办 API:list/add/done 三个端点,附测试要点与验收清单。')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
  })
  await sleep(6000)
  await page.screenshot({ path: `${OUT}/02-timeline-streaming.png` })
  await sleep(14000)
  await page.screenshot({ path: `${OUT}/03-timeline-settled.png` })

  // lanes 视图
  await page.evaluate(() => {
    document.querySelectorAll('.view-switch .ant-segmented-item').forEach((s, i) => {
      if (i === 1) s.click()
    })
  })
  await sleep(3000)
  await page.screenshot({ path: `${OUT}/04-lanes.png` })

  // 悬停首块:工具条浮出
  await page.hover('.event-block')
  await sleep(600)
  await page.screenshot({ path: `${OUT}/05-hover-toolbar.png` })

  await browser.close()
  console.log('screenshots saved ->', OUT)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
