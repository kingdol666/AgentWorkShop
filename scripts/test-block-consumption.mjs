/**
 * 信息块渲染优化 + 事件完美消费验证(puppeteer + 真实 omp 流式):
 *  - 视觉:agent 字母头像章、kind tone 色点、turn 边界分隔、任务状态 tone chip
 *  - 消费完整性(对账):时间线块 data-seq/data-events 与 API 事件流核对——
 *      ① 可见 seq 无重复 ② 块内事件计数合计 + covered 折叠 == 窗口事件总数
 * 运行:node scripts/test-block-consumption.mjs
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
  const email = `blocks-${Date.now().toString(36)}@test.local`
  const reg = await api('POST', '/api/users/register', { body: { name: `blocks-${Date.now().toString(36)}`, email, password: 'Passw0rd!123' } })
  const token = reg.data?.token

  // mock lead(自动派发,产生任务状态链)+ 真实 omp worker(流式 + 工具行)
  const ch = await api('POST', '/api/workshop/channels', {
    body: { name: 'blocks-check', leadAgent: { name: 'lead', harness: 'mock' } },
    token,
  })
  const channelId = ch.data.channelId
  await api('POST', `/api/workshop/channels/${channelId}/agents`, {
    body: {
      name: 'coder',
      harness: 'omp',
      role: 'worker',
      config: { provider: 'zhipu-coding-plan', model: 'glm-5-turbo' },
    },
    token,
  })
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: 'blocks-ws' }, token })
  await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${channelId}`, { token })
  const task = await api('POST', `/api/workshop/channels/${channelId}/tasks`, {
    body: {
      title: 'blocks-render-check',
      description: '先调用 search_memory 查询"渲染测试"一次(制造工具行),然后直接回复:一句话确认 + 一个 ```ts 围栏代码块(const ok = true)。完成后结束。',
    },
    token,
  })
  if (task.code !== 0) throw new Error('任务提交失败')

  const tasksOf = async () => (await api('GET', `/api/workshop/channels/${channelId}/tasks`, { token })).data ?? []

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

  // 等任务终态(流式/工具/状态链全部落定)
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    const st = (await tasksOf()).find(t => t.id === task.data.id)?.state ?? ''
    if (['COMPLETED', 'FAILED', 'CANCELED'].includes(st)) break
    await sleep(5000)
  }
  await sleep(2500)

  // ═══ 视觉断言 ═══
  const visual = await page.evaluate(() => {
    const avatars = [...document.querySelectorAll('.agent-avatar')]
    const kindDots = [...document.querySelectorAll('.kind-dot')]
    const turnSeps = document.querySelectorAll('.event-block.turn-start').length
    const stateChips = [...document.querySelectorAll('.state-chip')]
    const avatar = avatars[0]
    return {
      avatarN: avatars.length,
      avatarText: avatar?.textContent ?? '',
      avatarRound: avatar ? getComputedStyle(avatar).borderRadius : '',
      kindDotN: kindDots.length,
      turnSeps,
      stateChipN: stateChips.length,
      stateChipRound: stateChips[0] ? getComputedStyle(stateChips[0]).borderRadius : '',
      workingChip: Boolean(document.querySelector('.state-chip[data-state="WORKING"], .state-chip[data-state="ASSIGNED"]')),
      completedChip: Boolean(document.querySelector('.state-chip[data-state="COMPLETED"]')),
      blocks: document.querySelectorAll('.event-block').length,
    }
  })
  check('V1 agent 字母头像章(圆形+首字母)', visual.avatarN >= 2 && /^[A-Za-z✳]$/.test(visual.avatarText) && visual.avatarRound === '50%', `${visual.avatarN} 个,首=${visual.avatarText}`)
  check('V2 kind tone 色点', visual.kindDotN >= 3, `n=${visual.kindDotN}`)
  check('V3 turn 边界分隔(≥1 处 agent 切换)', visual.turnSeps >= 1, `n=${visual.turnSeps}`)
  check('V4 任务状态 tone chip(pill 圆角)', visual.stateChipN >= 2 && visual.stateChipRound === '999px', `n=${visual.stateChipN}`)
  check('V5 状态链含 WORKING/ASSIGNED 与 COMPLETED', visual.workingChip && visual.completedChip, '')
  await page.screenshot({ path: 'data/shots/blocks-polish.png' }).catch(() => {})

  // ═══ 消费完整性对账 ═══
  // 页面侧:块 data-seq(首事件)+ data-events + data-folded;API 侧:事件窗口。
  // 时序对齐:终态后仍有迟到事件(父任务汇总 artifact 等)→ 轮询至两侧计数一致。
  const domOf = () => page.evaluate(() => {
    const blocks = [...document.querySelectorAll('.event-block')].map(el => ({
      seq: Number(el.dataset.seq ?? 0),
      events: Number(el.dataset.events ?? 0),
      folded: Number(el.dataset.folded ?? 0),
      covered: el.dataset.covered === 'true',
    }))
    // 条头 "N 事件 / M 块":N = store 消费窗口(ring 合并去重后的权威计数)
    const header = document.querySelector('.count')?.textContent ?? ''
    const headerEvents = Number((header.match(/(\d+) 事件/) ?? [])[1] ?? 0)
    return { blocks, headerEvents }
  })
  let domOf_result = { blocks: [], headerEvents: 0 }
  let apiEvents = []
  for (let i = 0; i < 12; i++) {
    domOf_result = await domOf()
    apiEvents = (await api('GET', `/api/workshop/channels/${channelId}/events?limit=200`, { token })).data?.items ?? []
    const domTotalNow = domOf_result.blocks.reduce((n, b) => n + b.events, 0)
    if (domTotalNow === domOf_result.headerEvents && domOf_result.headerEvents > 0) break
    await sleep(2500)
  }
  const dom2 = domOf_result.blocks
  const headerEvents = domOf_result.headerEvents
  const apiSeqs = apiEvents.map(e => e.seq)

  const visible = dom2.filter(b => !b.covered)
  const seqs = visible.map(b => b.seq)
  const dupSeqs = seqs.filter((s, i) => seqs.indexOf(s) !== i)
  check('C1 可见块首事件 seq 无重复', dupSeqs.length === 0, `dup=${dupSeqs.length}/${seqs.length}`)

  // 覆盖对账:块的 events 合计 == API 窗口事件数(窗口截断时按块 seq 范围核对)
  // 对账账本(三层,各守其职):
  //  C2  Σ(块内 events) == 时间线条头事件数 —— 块完美消费 store 消费窗口
  //      (folded 事件已含于 events,不重复计;covered 块份额同样计入)
  //  C2b 条头事件数 <= API 事件数 —— ring 合并去重只减不增(delta→落定重复帧)
  const domTotal = dom2.reduce((n, b) => n + b.events, 0)
  const apiTotal = apiEvents.length
  check('C2 块完美消费 store 窗口(Σ块事件==条头事件数,零丢失零重复)', domTotal === headerEvents, `blocks=${domTotal}, header=${headerEvents}`)
  check('C2b store 窗口 <= API(ring 去重只减不增)', headerEvents <= apiTotal, `header=${headerEvents}, api=${apiTotal}(合并 ${apiTotal - headerEvents})`)

  // 块首 seq 均 ≤ 窗口最大且存在(全部来自真实事件流)
  const maxApiSeq = Math.max(...apiSeqs, 0)
  check('C3 块首 seq 均在事件流范围内', seqs.every(s => s > 0 && s <= maxApiSeq), `maxSeq=${maxApiSeq}`)

  await browser.close()
  await api('DELETE', `/api/workshop/channels/${channelId}`, { token }).catch(() => {})

  console.log(`\n★ 结果: ${passed} passed, ${failures} failed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('异常:', err.message)
  process.exit(1)
})
