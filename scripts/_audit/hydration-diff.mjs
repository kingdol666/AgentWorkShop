/**
 * 水合差异定位 —— 把 SSR 产出的 HTML 与"水合前"的客户端 HTML 做结构对照。
 *
 * 思路:服务端渲染的 HTML 直接 fetch 得到;客户端 DOM 在 **hydration 之前**读不到
 * (hydrate 与首帧几乎同拍),所以改为对照"服务端 HTML"与"水合后 DOM",
 * 并把差异限定在**文本节点**上 —— 水合修复会改文本,结构差异则说明组件树分支不同。
 * 输出前 N 条差异,足够指认是哪个字段在 SSR/CSR 两侧不一致。
 *
 * 用法:node scripts/_audit/hydration-diff.mjs [base] [path]
 */
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const BASE = (process.argv[2] ?? 'http://127.0.0.1:3111').replace(/\/$/, '')
const PATH = process.argv[3] ?? '/dcw'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXEC = existsSync(EDGE) ? EDGE : CHROME

/** 从整页 HTML 里切出 #__nuxt 容器(与服务端对照必须同一区域,否则会把 <head> 的
 *  <title> 算成一条 SSR 独有文本节点 → 后续全部错位,得到一整屏假差异) */
function nuxtContainer(html) {
  const start = html.indexOf('<div id="__nuxt"')
  if (start < 0) return html
  const end = html.lastIndexOf('</div>')
  return html.slice(start, end > start ? end : undefined)
}

/** 粗略取文本节点序列(去掉标签与多余空白),用于逐段对照 */
function textNodes(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, '\u0001')
    .split('\u0001')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** 元素标签流(class 简写),用于定位结构分支差异 */
function tagStream(html) {
  const out = []
  const re = /<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g
  let m
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase()
    if (tag === 'script' || tag === 'style') continue
    const cls = /class="([^"]*)"/.exec(m[2] ?? '')?.[1] ?? ''
    const short = cls.split(/\s+/).filter(c => c && !c.startsWith('data-v-') && !c.startsWith('css-')).slice(0, 3).join('.')
    out.push(`${tag}${short ? `.${short}` : ''}`)
  }
  return out
}

async function main() {
  // 服务端 HTML(不带 cookie,模拟全新访客)
  const ssrRes = await fetch(`${BASE}${PATH}`)
  const ssr = nuxtContainer(await ssrRes.text())
  const ssrTexts = textNodes(ssr)

  const browser = await puppeteer.launch({ executablePath: EXEC, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1400, height: 900 } })
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.goto(`${BASE}${PATH}`, { waitUntil: 'networkidle2' })
  // 直接取容器 outerHTML(已水合)
  const dom = await page.evaluate(() => document.querySelector('#__nuxt')?.outerHTML ?? document.body.outerHTML)
  const domTexts = textNodes(dom)
  await browser.close()

  // 结构对照优先:结构差异才是"组件树分支不同"的直接证据,文本差异常是其后果
  const a = tagStream(ssr)
  const b = tagStream(dom)
  console.log(`元素数 SSR=${a.length} DOM=${b.length}`)
  let shownStruct = 0
  for (let i = 0; i < Math.max(a.length, b.length) && shownStruct < 10; i++) {
    if (a[i] === b[i]) continue
    shownStruct++
    const from = Math.max(0, i - 2)
    console.log(`\n  [结构首个差异 @${i}]`)
    console.log(`    SSR: ${a.slice(from, i + 3).join(' > ')}`)
    console.log(`    DOM: ${b.slice(from, i + 3).join(' > ')}`)
    break
  }
  if (shownStruct === 0) console.log('  标签流完全一致(差异仅在文本/属性)')

  console.log(`SSR 文本节点 ${ssrTexts.length} 个 / 水合后 ${domTexts.length} 个`)
  const n = Math.max(ssrTexts.length, domTexts.length)
  let shown = 0
  for (let i = 0; i < n && shown < 25; i++) {
    const a = ssrTexts[i]
    const b = domTexts[i]
    if (a === b) continue
    shown++
    console.log(`  [${i}] SSR=${JSON.stringify(a)?.slice(0, 90)}`)
    console.log(`      DOM=${JSON.stringify(b)?.slice(0, 90)}`)
  }
  if (shown === 0) console.log('  未发现文本差异(不匹配可能来自属性而非文本)')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
