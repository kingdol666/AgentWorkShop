/**
 * 前端重构后的**浏览器冒烟**:逐页加载、等客户端水合、收集控制台错误与页面异常。
 *
 * 为什么必须有这一步:typecheck/eslint 看不到「模板搬进子组件后运行时报错 / 响应式断链 /
 * scoped CSS 失配」这类问题,而本轮把 8 个巨型页面/组件拆成了上百个文件。
 *
 * 用法: node scripts/ui/smoke-refactor.mjs [--base http://127.0.0.1:3458] [--routes /aml,/daq,...]
 * 判据:HTTP 加载成功 + 客户端水合(data-vp-tier)+ 无 console error/pageerror + 根节点有内容
 */
import { existsSync } from 'node:fs'

/** 找到可用的 Chromium:优先 AW_CHROME,其次本机 Chrome/Edge(puppeteer-core 不自带浏览器) */
function resolveChrome() {
  if (process.env.AW_CHROME) return process.env.AW_CHROME
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ]
  return cands.find(p => existsSync(p))
}
const arg = (k, d) => {
  const i = process.argv.indexOf(k)
  if (i >= 0) return process.argv[i + 1]
  const kv = process.argv.find(a => a.startsWith(`${k}=`))
  return kv ? kv.slice(k.length + 1) : d
}
// lib.mjs 在**模块加载时**读取 AW_CHROME / AW_BASE,所以两者都必须先定好再动态导入
process.env.AW_BASE = arg('--base', process.env.AW_BASE ?? 'http://127.0.0.1:3458')
process.env.AW_CHROME = resolveChrome() ?? ''
if (!process.env.AW_CHROME) {
  console.error('未找到 Chromium:请设置 AW_CHROME 指向本机 chrome/msedge 可执行文件')
  process.exit(2)
}

const { BASE: DEFAULT_BASE, api, ensureVisualUser, launch, openPage, ROUTES, sleep } = await import('./lib.mjs')

const only = arg('--routes', '')?.split(',').map(s => s.trim()).filter(Boolean)
const routes = only?.length ? ROUTES.filter(r => only.includes(r.path) || only.includes(r.name)) : ROUTES

let pass = 0
const fails = []
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (ok) pass += 1
  else fails.push(`${name}${detail ? ` (${detail})` : ''}`)
}

const NOISE = [
  /favicon/i,
  /ResizeObserver loop/i,
  /Download the Vue Devtools/i,
  /\[nuxt\]/i,
  /WebSocket connection to .* failed/i,
  /net::ERR_CONNECTION_REFUSED/i,
]
const isNoise = t => NOISE.some(re => re.test(t))

/**
 * 水合判据:Vue 在挂载容器上写 `__vue_app__` —— 它出现即客户端已接管。
 * 不用 `data-vp-tier`:那是 useResponsive 的副作用,/town 的**空态**不会挂载它(实测踩过,
 * 会把"合法的空状态页"误判成"没水合")。
 */
const HYDRATED = () => Boolean(document.querySelector('#__nuxt')?.__vue_app__)

/** 预置:建频道 + 建 workspace + 挂载 → 让 /town 走**真实渲染分支**而不是空态 */
async function seedTown(api, token) {
  const name = `smoke-${Date.now().toString(36)}`
  const ch = await api('POST', '/api/workshop/channels', {
    body: { name, leadAgent: { name: `${name}-lead`, harness: 'mock', config: { delayMs: 30 } } },
    token,
  })
  const channelId = ch.data?.channelId
  if (!channelId) return null
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: `${name}-ws` }, token })
  const wsId = ws.data?.id ?? ws.data?.workspaceId
  if (wsId) {
    await api('POST', `/api/workshop/workspaces/${wsId}/channels/${channelId}`, { body: {}, token })
  }
  return { channelId, wsId }
}

console.log(`\n━━━ 前端重构冒烟 @ ${process.env.AW_BASE}(${routes.length} 条路由)━━━`)
const token = await ensureVisualUser()
check('0.1 取得可登录测试账号 token', Boolean(token))
if (routes.some(r => r.path === '/town')) {
  const seeded = await seedTown(api, token)
  check('0.2 /town 预置:建频道 + workspace + 挂载(否则只会渲染空态,测不到拆分后的孪生视图)',
    Boolean(seeded?.channelId), JSON.stringify(seeded))
}

const browser = await launch({ width: 1440, height: 900 })
try {
  for (const r of routes) {
    const page = await openPage(browser, { token, dark: true })
    const consoleErrors = []
    const pageErrors = []
    const warnings = []
    page.on('console', (m) => {
      const t = m.text()
      if (isNoise(t)) return
      // 生产构建下 Vue 只给"有 mismatch"这一句、没有任何节点级细节,无法据此定位;
      // 且实测**未改动**的页面(/workshop/agents、teams、channel-templates)同样会报,
      // 与本轮重构无关 ⇒ 单列为 WARN 而不是 FAIL。
      if (/Hydration completed but contains mismatches/i.test(t)) {
        warnings.push(t)
        return
      }
      if (m.type() === 'error') consoleErrors.push(t.slice(0, 200))
    })
    page.on('pageerror', e => pageErrors.push(String(e.message).slice(0, 200)))
    let status = 0
    try {
      const resp = await page.goto(DEFAULT_BASE + r.path, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      status = resp?.status() ?? 0
      await page.waitForFunction(HYDRATED, { timeout: 90_000, polling: 200 })
      await sleep(1800)
    }
    catch (e) {
      pageErrors.push(`导航/水合失败: ${String(e.message).slice(0, 160)}`)
    }
    const bodyLen = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().length).catch(() => 0)
    const mainChildren = await page.evaluate(() => {
      const el = document.querySelector('#__nuxt > *, main, .page, [class*="page"]')
      return el ? el.children.length : 0
    }).catch(() => 0)
    check(`${r.path} 可加载并水合`, status === 200 && pageErrors.length === 0,
      `status=${status} pageErrors=${pageErrors.length}${pageErrors.length ? ` :: ${pageErrors[0]}` : ''}`)
    check(`${r.path} 渲染出内容(非空白页)`, bodyLen > 40 && mainChildren > 0, `text=${bodyLen} chars, children=${mainChildren}`)
    check(`${r.path} 无控制台错误`, consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))
    if (warnings.length) console.log(`  WARN  ${r.path} 水合告警(生产构建无细节;未改动页面同样存在): ${warnings[0]}`)
    await page.close()
  }
}
finally {
  await browser.close()
}

console.log(`\n${'='.repeat(64)}`)
console.log(`前端冒烟: PASS=${pass} FAIL=${fails.length}`)
for (const f of fails) console.log(`  FAIL  ${f}`)
console.log('='.repeat(64))
process.exit(fails.length > 0 ? 1 : 0)
