/**
 * 插件配置 UI 目视验证:登录 → /settings(运行配置插件组)→ /workshop/teams(插件对话框)。
 * 断言:新插件配置键渲染 / 团队插件对话框开关渲染;截图留档 .design-verify/。
 * 用法:NO_PROXY='*' node scripts/_dbg-plugin-config-ui.mjs
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
  // ① API 注册(带密码,供表单登录)
  const email = `plug-ui-${stamp}@test.local`
  const reg = await fetch(`${BASE}/api/users/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `plugui-${stamp}`, email, password: 'Passw0rd!123' }),
  }).then(r => r.json()).catch(() => null)
  ok(reg?.data?.token, 'API 注册测试用户', reg?.data?.user?.name ?? JSON.stringify(reg).slice(0, 100))
  // 设置页运行配置是 admin 门控(GET /api/system/settings)→ 测试用户提权(与 e2e 夹具同法)
  if (reg?.data?.user?.id) {
    const db = new DatabaseSync(join(resolve('.'), '.AgentWorkShop', 'data', 'users.sqlite'))
    db.exec('PRAGMA busy_timeout=4000')
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(reg.data.user.id)
    db.close()
    console.log('  · 测试用户已提权 admin(设置页运行配置需要)')
  }

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'],
    defaultViewport: { width: 1440, height: 900 },
  })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 160)))

  // ② 登录:直接种 cookie(表单按钮匹配在 headless 下不稳定;user.ts 以 cookie 'token' 为会话载体)
  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(2200)
  await page.evaluate((t) => { document.cookie = `token=${t}; path=/` }, reg?.data?.token ?? '')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(3000)
  ok((await page.evaluate(() => location.pathname)) !== '/login', 'cookie 登录成功', await page.evaluate(() => location.pathname))

  // ③ /settings → 运行配置 Tab → 插件分组
  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(3000)
  const who = await page.evaluate(() => document.body.innerText.match(/访客|admin|管理员/g)?.slice(0, 3) ?? [])
  console.log('  · 登录态徽标:', JSON.stringify(who))
  // 点击「运行配置」Tab(文本匹配)
  let tabClicked = false
  for (const el of await page.$$('.ant-tabs-tab, [role="tab"], button, a')) {
    const txt = (await el.evaluate(e => e.textContent) || '').trim()
    if (txt.includes('运行配置')) { await el.click(); tabClicked = true; break }
  }
  console.log('  · 运行配置 Tab 点击:', tabClicked)
  await sleep(2500)
  // 滚动到插件分组
  const pluginText = await page.evaluate(() => {
    const els = [...document.querySelectorAll('h4, h3, .rt-group-title')]
    const hit = els.find(e => (e.textContent || '').includes('插件'))
    if (hit) hit.scrollIntoView({ block: 'start' })
    return hit ? hit.textContent.trim() : ''
  })
  await sleep(800)
  const bodyText = await page.evaluate(() => document.body.innerText)
  for (const key of ['rag-knowledge 后端地址', 'rag-knowledge Web 地址', 'rag-knowledge API Token', '诊断服务地址', '诊断 API Token', '诊断引擎', '诊断最大轮数', '诊断超时(分钟)', '自动诊断', '自动诊断规则']) {
    ok(bodyText.includes(key), `设置页渲染插件配置项「${key}」`)
  }
  await page.screenshot({ path: `${SHOT_DIR}/plug-01-settings-runtime.png` })
  console.log(`  · 截图 ${SHOT_DIR}/plug-01-settings-runtime.png`)

  // ④ /workshop/teams → 建队(带插件勾选默认全选)→ 插件对话框
  await page.goto(`${BASE}/workshop/teams`, { waitUntil: 'domcontentloaded' })
  await sleep(2500)
  await page.screenshot({ path: `${SHOT_DIR}/plug-02-teams.png` })
  // 打开建队弹窗看插件勾选区
  for (const b of await page.$$('button')) {
    const txt = (await b.evaluate(el => el.textContent) || '').replace(/\s/g, '')
    if (txt.includes('建队') || txt.includes('新建') || txt.includes('创建')) { await b.click(); break }
  }
  await sleep(1500)
  const dlgText = await page.evaluate(() => document.body.innerText)
  ok(dlgText.includes('插件'), '建队弹窗含插件勾选区', dlgText.includes('rag-bridge') ? '含 rag-bridge 行' : '')
  await page.screenshot({ path: `${SHOT_DIR}/plug-03-team-create.png` })
  console.log(`  · 截图 ${SHOT_DIR}/plug-03-team-create.png`)

  // 优雅断开:nuxt dev 父进程对浏览器硬断开(SSE RST)会产生未处理拒绝并拖垮 dev
  // server —— 先导航空白页让 SSE 正常 FIN,再关浏览器
  await page.goto('about:blank').catch(() => {})
  await sleep(1200)
  await browser.close()
  console.log(fail === 0 ? '\n★ UI 验证 ALL PASS' : `\n✘ ${fail} 项失败`)
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
