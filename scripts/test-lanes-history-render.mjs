/**
 * Lanes 历史回填渲染验证(浏览器级,dev server 127.0.0.1:3000 + Edge):
 *  1. REST 建用户/channel(mock lead + worker,streamDemo 流式帧)+ 提交任务产生事件;
 *  2. UI 登录进入控制台;
 *  3. 刷新页面(ring 清空,只剩 WS 快照 + lane 回填路径)直达 ?view=lanes;
 *  4. 断言:泳道渲染出历史事件块(非「暂无事件」)—— lane 历史按需加载生效;
 *  5. 截图存证 gui-test-screenshots/lanes-history/。
 * 运行: node scripts/test-lanes-history-render.mjs
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://127.0.0.1:3000'
const OUT = 'gui-test-screenshots/lanes-history'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const api = async (method, ep, { body, token } = {}) => {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${ep}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return res.json()
}

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const tag = Date.now().toString(36)
  const email = `lanes-${tag}@test.local`
  const password = 'Passw0rd!123'
  const reg = await api('POST', '/api/users/register', { body: { name: `lanes-${tag}`, email, password } })
  const token = reg.data.token

  // channel:mock lead/worker;lead 任务产生 task/状态/消息事件
  const ch = await api('POST', '/api/workshop/channels', {
    body: {
      name: `lanes-hist-${tag}`,
      leadAgent: { name: 'lead-mock', harness: 'mock', config: { delayMs: 100 } },
    },
    token,
  })
  const cid = ch.data.channelId
  await api('POST', `/api/workshop/channels/${cid}/agents`, {
    body: { name: 'worker-mock', harness: 'mock', role: 'worker', config: { delayMs: 120, streamDemo: true } },
    token,
  })
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: `ws-${tag}` }, token })
  await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${cid}`, token && { token })
  await api('POST', `/api/workshop/channels/${cid}/activate`, { token })
  await api('POST', `/api/workshop/channels/${cid}/tasks`, {
    body: { title: 'hist', description: ' lanes 历史回填验证', mode: 'goal', modeConfig: { goalCriteria: '全部完成' } },
    token,
  })
  // 等事件落库(WORKING 阶段即产生 task.status/a2a.message/agent.status)
  await sleep(4000)
  const ev = await api('GET', `/api/workshop/channels/${cid}/events?limit=500`, { token })
  const persisted = (ev.data?.items ?? []).length
  console.log(`channel ${cid.slice(0, 8)} · 持久化事件 ${persisted} 帧`)
  check('事件已持久化', persisted >= 4, `events=${persisted}`)

  // ── 浏览器:登录 → 刷新后直达 lanes 视图 ──
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox'],
    defaultViewport: { width: 1600, height: 1000 },
  })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', e => pageErrors.push(e.message.slice(0, 160)))

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
    const txt = ((await b.evaluate(el => el.textContent)) || '').trim()
    if (txt.replace(/\s/g, '') === '登录') {
      await b.click()
      break
    }
  }
  await sleep(4500)
  if (!page.url().includes('/workshop/w/')) {
    for (const b of await page.$$('button')) {
      const txt = ((await b.evaluate(el => el.textContent)) || '').trim()
      if (txt.includes('进入控制台')) {
        await b.click()
        break
      }
    }
    await sleep(3500)
  }
  const wsUrl = page.url()
  console.log('控制台 URL:', wsUrl)

  // 刷新(ring 清空)→ 直达 lanes 视图:历史只能来自 DB 回填路径
  await page.goto(`${wsUrl.split('?')[0]}?view=lanes`, { waitUntil: 'domcontentloaded' })
  await sleep(5000)
  await page.screenshot({ path: `${OUT}/01-lanes-after-reload.png` })

  const lanesInfo = await page.evaluate(() =>
    [...document.querySelectorAll('.lane')].map(lane => ({
      name: lane.querySelector('.lane-name')?.textContent?.trim() ?? '?',
      blocks: lane.querySelectorAll('.event-block').length,
      emptyText: lane.querySelector('.lane-empty')?.textContent?.trim() ?? '',
      earlierBtn: !!lane.querySelector('.lane-earlier'),
    })))
  console.log('泳道渲染:', JSON.stringify(lanesInfo))
  check('泳道列已渲染', lanesInfo.length >= 2, `lanes=${lanesInfo.length}`)
  const withHistory = lanesInfo.filter(l => l.blocks > 0)
  check('刷新后泳道渲染出历史事件块', withHistory.length >= 1,
    withHistory.map(l => `${l.name}:${l.blocks}块`).join(' '))
  const totalBlocks = lanesInfo.reduce((s, l) => s + l.blocks, 0)
  check('历史块总量与持久化量级匹配', totalBlocks >= Math.min(4, persisted), `rendered=${totalBlocks} persisted=${persisted}`)
  check('无页面错误', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))

  await browser.close()
  console.log(failures === 0 ? '\n全部通过 ✔(截图见 ' + OUT + ')' : `\n${failures} 项失败 ✘`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
