/**
 * Channel 设置弹窗插件开关区 UI 验证:建 workspace+channel → 打开工作台 → 设置 → 截图断言。
 * 用法:NO_PROXY='*' node scripts/_dbg-channel-plugin-ui.mjs
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3021'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const SHOT_DIR = '.design-verify'
const stamp = Date.now().toString(36)
const sleep = ms => new Promise(r => setTimeout(r, ms))
let fail = 0
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✔' : '✘'} ${label}${detail ? ` —— ${detail}` : ''}`)
  if (!cond) fail++
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true })
  // ① 注册 admin 测试用户(设置弹窗要 GET /channels/:id/plugins,user 即可,但顺手 admin)
  const email = `chplug-ui-${stamp}@test.local`
  const reg = await fetch(`${BASE}/api/users/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `chplugui-${stamp}`, email, password: 'Passw0rd!123' }),
  }).then(r => r.json()).catch(() => null)
  ok(Boolean(reg?.data?.token), 'API 注册测试用户', reg?.data?.user?.name ?? '')
  if (reg?.data?.user?.id) {
    const db = new DatabaseSync(join(resolve('.'), '.AgentWorkShop', 'data', 'users.sqlite'))
    db.exec('PRAGMA busy_timeout=4000')
    db.prepare('UPDATE users SET role = \'admin\' WHERE id = ?').run(reg.data.user.id)
    db.close()
  }
  const auth = { authorization: `Bearer ${reg.data.token}` }

  // ② 建 channel(带 mock lead)→ 建 workspace → 挂载 channel
  const ch = await fetch(`${BASE}/api/workshop/channels`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ name: `插件UI频道-${stamp}`, description: 'channel 设置弹窗插件区验证', leadAgent: { name: 'UI-lead', harness: 'mock' } }),
  }).then(r => r.json()).catch(() => null)
  ok(Boolean(ch?.data?.channelId), '创建 channel', ch?.data?.channelId ?? '')
  const ws = await fetch(`${BASE}/api/workshop/workspaces`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ name: `插件UI工作区-${stamp}` }),
  }).then(r => r.json()).catch(() => null)
  const wsId = ws?.data?.id
  ok(Boolean(wsId), '创建 workspace', wsId ?? JSON.stringify(ws).slice(0, 100))
  if (wsId && ch?.data?.channelId) {
    const mount = await fetch(`${BASE}/api/workshop/workspaces/${wsId}/channels/${ch.data.channelId}`, {
      method: 'POST', headers: { ...auth },
    }).then(r => r.json()).catch(() => null)
    ok(mount?.code === 0 || mount?.data != null, '挂载 channel 到 workspace', JSON.stringify(mount ?? {}).slice(0, 100))
  }

  // ③ 浏览器:cookie 登录 → 工作台 → 打开 channel 设置
  const browser = await puppeteer.launch({
    executablePath: EDGE, headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1440, height: 900 },
  })
  const page = await browser.newPage()
  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(2200)
  await page.evaluate((t) => { document.cookie = `token=${t}; path=/` }, reg.data.token)
  await page.goto(`${BASE}/workshop/w/${wsId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(4500)
  // 点 Channel 会话列表的「设置」(title = `设置 ${channelName}`;避免命中侧栏「系统设置」)
  let opened = false
  for (const el of await page.$$('button, [class*="op"], a, span')) {
    const t = (await el.evaluate(e => (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent) ?? '')) || ''
    if (t.includes('设置') && t.includes('插件UI频道')) {
      await el.click().catch(() => {})
      opened = true
      break
    }
  }
  console.log('  · 设置按钮点击:', opened)
  await sleep(2500)
  const dlg = await page.evaluate(() => document.body.innerText)
  ok(dlg.includes('插件'), 'Channel 设置弹窗含插件开关区', dlg.includes('rag-bridge') ? 'rag-bridge 行可见' : '')
  ok(dlg.includes('diag-bridge') && dlg.includes('rag-bridge'), '插件行渲染(diag-bridge/rag-bridge)')
  await page.screenshot({ path: `${SHOT_DIR}/plug-04-channel-settings.png` })
  console.log(`  · 截图 ${SHOT_DIR}/plug-04-channel-settings.png`)

  await page.goto('about:blank').catch(() => {})
  await sleep(1200)
  await browser.close()
  console.log(fail === 0 ? '\n★ Channel 插件 UI ALL PASS' : `\n✘ ${fail} 项失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
