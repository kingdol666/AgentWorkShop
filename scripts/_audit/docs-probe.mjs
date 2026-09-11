/**
 * docs-probe.mjs —— 文档站渲染诊断:正文段落计算样式 + 字体加载 + 首屏动画
 * 用于判定"文字发暗/重叠"是真实缺陷还是无头截图伪影。
 * 用法:node scripts/_audit/docs-probe.mjs [route]
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
const PORT = 3223
const ROUTE = process.argv[2] ?? '/guide/getting-started'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXEC = existsSync(EDGE) ? EDGE : CHROME

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.gif': 'image/gif', '.map': 'application/json' }

function serve() {
  return new Promise((ok) => {
    const s = createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      if (!p.startsWith(BASE_PATH)) { res.writeHead(404); res.end(); return }
      p = p.slice(BASE_PATH.length) || '/'
      let f = join(DIST, normalize(p).replace(/^(\.\.[/\\])+/, ''))
      if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html')
      if (!existsSync(f) && !extname(f)) f = `${f}.html`
      if (!existsSync(f)) { res.writeHead(404); res.end('nf'); return }
      res.writeHead(200, { 'content-type': MIME[extname(f)] ?? 'application/octet-stream' })
      res.end(readFileSync(f))
    })
    s.listen(PORT, '127.0.0.1', () => ok(s))
  })
}

const server = await serve()
const browser = await puppeteer.launch({
  executablePath: EXEC,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1', '--hide-scrollbars'],
  defaultViewport: { width: 1680, height: 1000 },
})
const page = await browser.newPage()
const failed = []
page.on('requestfailed', r => failed.push(`${r.url()} :: ${r.failure()?.errorText}`))
page.on('response', (r) => { if (r.status() >= 400) failed.push(`HTTP ${r.status()} ${r.url()}`) })
await page.goto(`http://127.0.0.1:${PORT}${BASE_PATH}${ROUTE}`, { waitUntil: 'networkidle2' })
await page.evaluate(() => document.fonts?.ready).catch(() => {})
await new Promise(r => setTimeout(r, 1500))

const out = await page.evaluate(() => {
  const pick = (el, props) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    const o = {}
    for (const p of props) o[p] = cs.getPropertyValue(p)
    const r = el.getBoundingClientRect()
    o._rect = `${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.x)},${Math.round(r.y)}`
    o._text = (el.textContent ?? '').slice(0, 30)
    return o
  }
  const props = ['color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'opacity', 'transform', 'filter', 'animation-name', 'text-rendering', 'font-variant-ligatures', 'visibility', 'mix-blend-mode', 'background-color', 'writing-mode']
  const ps = [...document.querySelectorAll('.vp-doc p')]
  return {
    bodyBg: getComputedStyle(document.body).backgroundColor,
    pCount: ps.length,
    samples: ps.slice(0, 3).map(p => pick(p, props)),
    h2: pick(document.querySelector('.vp-doc h2'), props),
    code: pick(document.querySelector('.vp-doc div[class*="language-"] code'), props),
    customBlock: pick(document.querySelector('.vp-doc .custom-block p'), props),
    fonts: [...document.fonts].map(f => `${f.family} ${f.weight} ${f.status}`),
    animations: document.getAnimations().map(a => `${a.animationName ?? a.constructor.name} @${a.playState}`),
  }
})

console.log(JSON.stringify(out, null, 2))
console.log('\n=== 失败请求 ===')
console.log(failed.length ? failed.join('\n') : '(无)')

// 1:1 元素截图:整体截图会被预览缩放,16px 中文在缩放后会被误判为"重叠不可读"。
// 这里对正文段落按 deviceScaleFactor=2 单独出图,作为可读性的判据。
await page.setViewport({ width: 1680, height: 1000, deviceScaleFactor: 2 })
await page.reload({ waitUntil: 'networkidle2' })
await page.evaluate(() => document.fonts?.ready).catch(() => {})
await new Promise(r => setTimeout(r, 800))
const cropDir = resolve(HERE, '..', '..', '.e2e-shots', 'docs-font')
mkdirSync(cropDir, { recursive: true })
const p = await page.$('.vp-doc p')
if (p) {
  const file = join(cropDir, `crop${ROUTE.replace(/\W+/g, '_')}.png`)
  await p.screenshot({ path: file })
  console.log(`\n正文段落 1:1 ×2 → ${file}`)
}
const h2 = await page.$('.vp-doc h2')
if (h2) {
  const file = join(cropDir, `crop-h2${ROUTE.replace(/\W+/g, '_')}.png`)
  await h2.screenshot({ path: file })
  console.log(`二级标题 1:1 ×2 → ${file}`)
}

await browser.close()
server.close()
