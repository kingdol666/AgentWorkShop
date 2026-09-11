/**
 * docs-font-probe.mjs —— 判定"中文渲染重叠"是站点缺陷还是无头环境缺字体的伪影。
 * 方法:在目标浏览器里对同一串中文逐族测量 advance 宽度 + document.fonts.check(),
 * 再渲染一张纯 HTML 对照图(不加载站点 CSS)。若对照图同样重叠 → 环境缺 CJK 字体。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const OUT = join(REPO, '.e2e-shots', 'docs-font')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXEC = existsSync(EDGE) ? EDGE : CHROME

const FAMILIES = [
  'Punctuation SC', 'Inter', 'sans-serif', 'system-ui', 'ui-sans-serif',
  'Microsoft YaHei', 'Microsoft YaHei UI', 'SimSun', 'SimHei', 'NSimSun',
  'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', 'Noto Sans CJK SC', 'Source Han Sans SC',
  'DengXian', 'KaiTi', 'FangSong', 'Arial', 'Segoe UI', 'monospace', 'Consolas', 'Cascadia Mono',
]

mkdirSync(OUT, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: EXEC,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  defaultViewport: { width: 1200, height: 400 },
})
const page = await browser.newPage()

const report = await page.evaluate((fams) => {
  const SAMPLE = '首次启动时一切初始化进配置根'
  const cv = document.createElement('canvas').getContext('2d')
  const rows = []
  for (const f of fams) {
    cv.font = `16px "${f}"`
    const w = cv.measureText(SAMPLE).width
    const base = (() => { cv.font = '16px monospace'; return cv.measureText(SAMPLE).width })()
    rows.push({ family: f, width: Number(w.toFixed(2)), sameAsMonospace: Math.abs(w - base) < 0.5, check: document.fonts.check(`16px "${f}"`) })
  }
  cv.font = '16px monospace'
  const monoBase = Number(cv.measureText(SAMPLE).width.toFixed(2))
  return { sample: SAMPLE, chars: SAMPLE.length, monoBase, rows }
}, FAMILIES)

console.log(`样本 ${report.chars} 字 · monospace 基准宽 ${report.monoBase}px(每字 ${(report.monoBase / report.chars).toFixed(2)}px)\n`)
console.log('family'.padEnd(26), 'width'.padStart(9), '  sameAsMono  fonts.check')
for (const r of report.rows) {
  console.log(r.family.padEnd(26), String(r.width).padStart(9), '  ' + String(r.sameAsMonospace).padEnd(12) + String(r.check))
}

// 对照图:完全不使用站点 CSS 的最小 HTML,同一段中文
const plain = `<!doctype html><meta charset="utf-8"><body style="background:#070b13;color:#e8eef8;margin:0;padding:24px">
<p style="font:16px/1.8 sans-serif;max-width:640px">${report.sample} —— sans-serif 回退</p>
<p style="font:16px/1.8 'Microsoft YaHei',sans-serif;max-width:640px">${report.sample} —— Microsoft YaHei 优先</p>
<p style="font:16px/1.8 monospace;max-width:640px">${report.sample} —— monospace</p>
</body>`
const plainFile = join(OUT, 'plain.html')
writeFileSync(plainFile, plain, 'utf8')
await page.goto(`file:///${plainFile.replace(/\\/g, '/')}`, { waitUntil: 'load' })
await new Promise(r => setTimeout(r, 300))
await page.screenshot({ path: join(OUT, 'plain-contrast.png') })
console.log(`\n对照图 → ${join(OUT, 'plain-contrast.png')}`)

await browser.close()
