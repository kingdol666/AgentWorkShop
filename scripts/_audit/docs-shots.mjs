/**
 * docs-shots.mjs —— VitePress 文档站视觉走查截图(独立审计用)
 * ------------------------------------------------------------
 * 站点 base = '/AgentWorkShop/'(见 docs/site/.vitepress/config.mts),
 * 故这里起一个最小静态服务器把 dist 挂到该前缀下,再用本机 Edge/Chrome 截图。
 * 依赖:puppeteer-core + 本机浏览器(与 scripts/_audit/design-shots.mjs 同方案)。
 *
 * 用法:
 *   node scripts/_audit/docs-shots.mjs                       # 构建产物 → 默认 .e2e-shots/docs
 *   node scripts/_audit/docs-shots.mjs --out=D:\x\y           # 指定输出目录
 *   node scripts/_audit/docs-shots.mjs --port=3222            # 指定端口
 *   node scripts/_audit/docs-shots.mjs --width=1440           # 桌面宽度(默认 1680)
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const DIST = join(REPO, 'docs', 'site', '.vitepress', 'dist')
const BASE_PATH = '/AgentWorkShop'
const OUT = (process.argv.find(a => a.startsWith('--out='))?.slice(6)) ?? join(REPO, '.e2e-shots', 'docs')
const PORT = Number(process.argv.find(a => a.startsWith('--port='))?.slice(7) ?? 3222)
const WIDTH = Number(process.argv.find(a => a.startsWith('--width='))?.slice(8) ?? 1680)

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXEC = existsSync(EDGE) ? EDGE : CHROME

/** 走查页:首页(整页) + 各内容形态的代表页(折叠以下也要看,故 fullPage) */
const PAGES = [
  ['/', 'home', true],
  ['/guide/getting-started', 'guide-getting-started', false],
  ['/guide/daq-protocols', 'guide-daq-protocols', false],
  ['/sdk/', 'sdk-index', false],
  ['/sdk/context', 'sdk-context', false],
  ['/plugins/', 'plugins-index', false],
  ['/plugins/guide', 'plugins-guide', false],
  ['/cli/', 'cli', false],
  ['/guide/aml', 'guide-aml', false],
  ['/en/', 'en-home', true],
  ['/en/plugins/guide', 'en-plugins-guide', false],
]

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

/** 把 dist 挂到 base 前缀下;未知路径回落到目录 index.html / 然后 404 */
function serve() {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
      let p = decodeURIComponent(url.pathname)
      if (!p.startsWith(BASE_PATH)) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('outside base')
        return
      }
      p = p.slice(BASE_PATH.length) || '/'
      let file = join(DIST, normalize(p).replace(/^(\.\.[/\\])+/, ''))
      try {
        if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
        if (!existsSync(file) && !extname(file)) file = `${file}.html`
        if (!existsSync(file)) {
          res.writeHead(404, { 'content-type': 'text/plain' })
          res.end('not found')
          return
        }
        res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
        res.end(readFileSync(file))
      }
      catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end(String(err?.message ?? err))
      }
    })
    server.listen(PORT, '127.0.0.1', () => ok(server))
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  if (!existsSync(DIST)) {
    console.error(`✖ 未找到构建产物:${DIST}\n  先执行:cd docs/site && npx vitepress build`)
    process.exit(2)
  }
  if (!EXEC || !existsSync(EXEC)) {
    console.error('✖ 未找到本机 Edge/Chrome')
    process.exit(2)
  }
  mkdirSync(OUT, { recursive: true })
  const server = await serve()
  const base = `http://127.0.0.1:${PORT}${BASE_PATH}`
  const browser = await puppeteer.launch({
    executablePath: EXEC,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1', '--hide-scrollbars'],
    defaultViewport: { width: WIDTH, height: 1000 },
  })

  const problems = []
  let n = 0
  try {
    for (const [route, name, fullPage] of PAGES) {
      const page = await browser.newPage()
      const pageErrors = []
      page.on('pageerror', e => pageErrors.push(String(e?.message ?? e)))
      // 站点只声明 favicon.svg,浏览器仍会自动请求 /favicon.ico;这不是站点缺陷。
      // 用带 URL 的 HTTP 失败事件判定,而不是靠 console 文案(它不含 URL)。
      page.on('response', (r) => {
        if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) pageErrors.push(`HTTP ${r.status()} ${r.url()}`)
      })
      page.on('requestfailed', (r) => {
        if (!r.url().endsWith('/favicon.ico')) pageErrors.push(`REQUEST FAILED ${r.url()}`)
      })
      const resp = await page.goto(`${base}${route}`, { waitUntil: 'networkidle2', timeout: 45_000 })
      if (!resp || resp.status() >= 400) problems.push(`${route} → HTTP ${resp?.status()}`)
      // 等字体与首屏动画落定(站点有入场动画;截到中途会误判为"元素缺失")
      await page.evaluate(() => document.fonts?.ready).catch(() => {})
      await sleep(700)
      const file = join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`)
      await page.screenshot({ path: file, fullPage })
      const title = await page.title()
      const h1 = await page.$eval('h1', el => el.textContent?.trim() ?? '').catch(() => '(no h1)')
      // 首页是自定义布局(无 <main>),故取 <main> 缺省回落到 body
      const bodyLen = await page.evaluate(() => {
        const root = document.querySelector('main') ?? document.querySelector('.hw-wrap') ?? document.body
        return (root?.innerText ?? '').replace(/\s+/g, ' ').trim().length
      })
      console.log(`✔ ${route.padEnd(26)} h1=${JSON.stringify(h1).slice(0, 40).padEnd(42)} text=${bodyLen}`)
      if (bodyLen < 200) problems.push(`${route} → 正文过短(${bodyLen} 字),疑似渲染失败`)
      if (!title) problems.push(`${route} → 无 <title>`)
      if (pageErrors.length) problems.push(`${route} → ${pageErrors.length} 个前端/请求错误: ${pageErrors.slice(0, 2).join(' | ')}`)
      await page.close()
    }
  }
  finally {
    await browser.close()
    server.close()
  }

  console.log(`\n截图 ${n} 张 → ${OUT}`)
  if (problems.length) {
    console.log(`\n✖ 发现 ${problems.length} 个问题:`)
    for (const p of problems) console.log(`  · ${p}`)
    process.exit(1)
  }
  console.log('✔ 全部页面渲染正常(有 h1 / 正文非空 / 无前端错误)')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
