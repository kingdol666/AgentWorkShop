/**
 * 定时任务前端视觉验收 —— 对隔离实例验证 schedules 页与 Channel「定时」标签。
 *
 * 运行(AW_BASE 指向隔离实例):
 *   AW_BASE=http://127.0.0.1:3457 node scripts/_dbg-schedule-ui-verify.mjs
 *
 * 覆盖:
 *  1. /workshop/schedules:表格渲染 2 行计划(状态 tag/计划/操作),新建按钮在位
 *  2. /workshop/w/:id:左栏 Channel 行出现「定时」标签(scheduledCount>0)
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { api } from './ui/lib.mjs'

const CHROME = process.env.AW_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3457'
const OUT = 'scripts/_audit/schedules-ui'
mkdirSync(OUT, { recursive: true })

const sleep = ms => new Promise(r => setTimeout(r, ms))
let bad = 0
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) bad += 1
}

async function login() {
  const email = 'sched-e2e@awshop.local'
  const password = 'sched2E2e'
  let r = await api('POST', '/api/users/login', { body: { email, password } })
  if (r.code === 0 && r.data?.token) return r.data.token
  r = await api('POST', '/api/users/register', { body: { name: 'sched-e2e', email, password } })
  if (r.code === 0 && r.data?.token) return r.data.token
  throw new Error(`登录失败: ${r.message}`)
}

// ===== 种子:channel + 2 计划 + workspace 挂载 =====
async function seed(token) {
  const ch = await api('POST', '/api/workshop/channels', {
    token,
    body: { name: '光学薄膜优化组', leadAgent: { name: '生产主管', harness: 'mock' } },
  })
  const channelId = ch.data.channelId
  const s1 = await api('POST', '/api/workshop/schedules', {
    token,
    body: { channelId, name: '产线数据晨检', title: '汇总昨日产线数据并生成晨报', mode: 'interval', intervalMs: 1_800_000 },
  })
  const s2 = await api('POST', '/api/workshop/schedules', {
    token,
    body: { channelId, name: '夜班收口盘点', title: '盘点夜班任务收口情况并向 lead 汇报', mode: 'daily', dailyTime: '08:00' },
  })
  const ws = await api('POST', '/api/workshop/workspaces', { token, body: { name: '演示工作区' } })
  const wsId = ws.data?.id
  await api('POST', `/api/workshop/workspaces/${wsId}/channels/${channelId}`, { token })
  return { channelId, wsId, schedules: [s1.data, s2.data] }
}

async function main() {
  console.log('━━━ 定时任务前端视觉验收 ━━━')
  const token = await login()
  const seedData = await seed(token)
  ok('种子就绪(channel + 2 计划 + workspace)', !!seedData.channelId && seedData.schedules.every(Boolean))

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--force-color-profile=srgb'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  })
  try {
    const page = await browser.newPage()
    await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
    await page.setCookie({ name: 'aw-theme', value: 'dark', domain: '127.0.0.1', path: '/' })

    // 1. schedules 页
    await page.goto(`${BASE}/workshop/schedules`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.waitForFunction(() => document.documentElement.dataset.vpTier !== undefined, { timeout: 90_000, polling: 200 })
    await page.waitForFunction(() => document.querySelectorAll('.ant-table-row').length > 0, { timeout: 30_000, polling: 300 }).catch(() => {})
    await sleep(1500)
    const rows = await page.evaluate(() => document.querySelectorAll('.ant-table-row').length)
    ok('schedules 表格渲染 2 行', rows >= 2, String(rows))
    const hasTag = await page.evaluate(() => !!document.querySelector('.ant-table-row .ant-tag'))
    ok('状态 tag 渲染', hasTag)
    await page.screenshot({ path: `${OUT}/schedules-page.png`, fullPage: true })
    console.log(`  截图 → ${OUT}/schedules-page.png`)

    // 2. workspace 页:左栏 Channel「定时」标签
    await page.goto(`${BASE}/workshop/w/${seedData.wsId}`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    await page.waitForFunction(() => document.documentElement.dataset.vpTier !== undefined, { timeout: 90_000, polling: 200 })
    await page.waitForFunction(() => !!document.querySelector('.sched-tag'), { timeout: 30_000, polling: 300 }).catch(() => {})
    await sleep(1500)
    const tagInfo = await page.evaluate(() => {
      const el = document.querySelector('.sched-tag')
      const name = document.querySelector('.channel-item .ch-name')?.textContent?.trim()
      return { present: !!el, count: el?.querySelector('.sched-n')?.textContent?.trim(), channel: name }
    })
    ok('Channel 行出现「定时」标签', tagInfo.present, JSON.stringify(tagInfo))
    ok('标签带计划计数 = 2', tagInfo.count === '2', String(tagInfo.count))
    await page.screenshot({ path: `${OUT}/workspace-channel-tag.png`, fullPage: false })
    console.log(`  截图 → ${OUT}/workspace-channel-tag.png`)
  }
  finally {
    await browser.close()
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log(`  ${bad === 0 ? '🎉 视觉验收通过' : `❌ ${bad} 项失败`}`)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  process.exit(bad === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('视觉验收异常:', e)
  process.exit(1)
})
