/**
 * 视觉走查截图(设计评审用)—— 全站关键页 × 亮/暗双主题。
 *
 * 为什么单独一支:设计验收必须看**生产构建下的真实渲染**(玻璃材质依赖 backdrop-filter
 * 与真实极光层,dev 模式下 HMR 注入的样式顺序会让玻璃层级失真)。
 *
 * 用法:node scripts/_audit/design-shots.mjs [base] [--out=dir]
 * 依赖:puppeteer-core + 本机 Edge/Chrome(无需下载 Chromium)。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const BASE = (process.argv[2] ?? process.env.AW_BASE ?? 'http://127.0.0.1:3111').replace(/\/$/, '')
const OUT = (process.argv.find(a => a.startsWith('--out='))?.slice(6)) ?? join(REPO, '.e2e-shots', 'design')
const VIEWPORT = { width: 1680, height: 1050 }

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXEC = existsSync(EDGE) ? EDGE : CHROME

/** 关键页(路径 + 中文名)。控制在能覆盖全部视觉声部的范围内,不追求页数。 */
const PAGES = [
  ['/', '仪表盘'],
  ['/daq', '数采中心'],
  ['/dcw', '数控中心'],
  ['/aml', '建模平台'],
  ['/monitor', '监控'],
  ['/logs', '运维日志'],
  ['/tokens', '令牌'],
  ['/settings', '系统设置'],
  ['/plugins', '插件'],
  ['/permissions', '权限'],
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await puppeteer.launch({
    executablePath: EXEC,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1', '--hide-scrollbars'],
    defaultViewport: VIEWPORT,
  })

  const errors = []
  const shots = []
  try {
    // 鉴权:优先用显式管理员登录(视觉走查要看**有数据的真实界面**,普通用户会被 403 挡成空壳)
    const ADMIN_EMAIL = process.env.AW_ADMIN_EMAIL ?? 'admin@awshop.local'
    const ADMIN_PASS = process.env.AW_ADMIN_PASS ?? 'admin123'
    const login = await fetch(`${BASE}/api/users/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
    }).then(r => r.json()).catch(() => null)
    let token = login?.data?.token ?? ''
    let role = login?.data?.user?.role ?? ''
    if (!token) {
      const reg = await fetch(`${BASE}/api/workshop/users/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `shot-${Date.now().toString(36)}` }),
      }).then(r => r.json()).catch(() => null)
      token = reg?.data?.token ?? ''
      role = 'registered'
    }
    console.log(`服务:${BASE}  token:${token ? 'ok' : '无'}  role:${role}`)

    const page = await browser.newPage()
    page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`[console] ${m.text().slice(0, 200)}`)
    })

    // 鉴权走 cookie `token`(apiClient 从这里取 Bearer),不是 localStorage;
    // 主题走 pinia persistedstate 的 'app' 键 + aw-theme cookie 镜像。
    const seed = async (theme) => {
      await page.evaluate((t, tok) => {
        document.cookie = `token=${encodeURIComponent(tok)}; path=/`
        document.cookie = `aw-theme=${t}; path=/`
        localStorage.setItem('app', JSON.stringify({
          isDark: t === 'dark', sidebarCollapsed: false, accent: '', themeTouched: true,
        }))
      }, theme, token)
    }

    for (const theme of ['light', 'dark']) {
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await seed(theme)
      for (const [path, label] of PAGES) {
        const url = `${BASE}${path}`
        try {
          // 先落地再种 cookie,保证服务端 SSR 首帧就带鉴权与主题
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
          await seed(theme)
          await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 })
          await sleep(1100)
          const name = `${theme}-${(path === '/' ? 'dashboard' : path.replace(/\//g, '_').replace(/^_/, ''))}.png`
          const file = join(OUT, name)
          await page.screenshot({ path: file, fullPage: false })
          shots.push({ theme, path, label, file })
          console.log(`  ✔ ${theme}  ${label.padEnd(6)} ${path}`)
        }
        catch (err) {
          console.log(`  ✘ ${theme}  ${label} ${path} — ${err.message.slice(0, 90)}`)
          errors.push(`[nav ${path}] ${err.message.slice(0, 160)}`)
        }
      }
    }
  }
  finally {
    await browser.close()
  }

  const manifest = join(OUT, 'MANIFEST.md')
  writeFileSync(manifest, [
    `# 视觉走查截图(${new Date().toISOString()})`,
    '',
    `服务:${BASE}  viewport:${VIEWPORT.width}×${VIEWPORT.height}`,
    '',
    '| 主题 | 页面 | 路径 | 文件 |',
    '| --- | --- | --- | --- |',
    ...shots.map(s => `| ${s.theme} | ${s.label} | ${s.path} | ${s.file.split(/[\\/]/).pop()} |`),
    '',
    `页面错误:${errors.length}`,
    ...errors.slice(0, 40).map(e => `- ${e}`),
    '',
  ].join('\n'), 'utf8')

  console.log(`\n输出:${OUT}`)
  console.log(`截图 ${shots.length} 张,页面错误 ${errors.length} 条`)
  if (errors.length) {
    console.log(errors.slice(0, 12).join('\n'))
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
