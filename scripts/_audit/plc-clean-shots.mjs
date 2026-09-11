/**
 * plc-clean-shots.mjs —— 全新环境演练的界面取证截图
 * ------------------------------------------------------------
 * 只做一件事:登录 → 逐页截图 → 断言页面上**真的出现了数据**(不是空壳),
 * 并把断言结果打出来。数据判据取自各页自身的语义,不看截图长相。
 *
 * 用法:node scripts/_audit/plc-clean-shots.mjs --base http://127.0.0.1:3112 [--out <dir>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const BASE = arg('base', 'http://127.0.0.1:3112').replace(/\/$/, '')
const STATE_FILE = arg('state', join(REPO, '.e2e-shots', 'plc-clean', 'state.json'))
const OUT = arg('out', join(REPO, '.e2e-shots', 'plc-clean'))
const ADMIN = { email: 'plant@awshop.local', password: 'Plant!2026' }
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const EXEC = existsSync(EDGE) ? EDGE : CHROME

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {}
const tempDaqFromState = state?.circuits?.temp?.daq
const lineIdFromState = state?.line?.id

/**
 * 页面 + 该页必须出现的数据判据(在 main 的 innerText 上做正则)。
 * ⚠️ 路由参数含义各不相同,别想当然:
 *   /dcw/:id   → **产线 id**(总览页「产线管理」进入;传节点 id 会渲染出一个空壳)
 *   /daq/:id   → **数采节点 id**
 *   /town      → 只渲染**已挂载到 workspace** 的频道,未挂载时显示"还没有挂载任何 Channel"
 */
const PAGES = [
  ['/town', '数字孪生小镇', /(挤出主机|收卷机组|MDO|设备|Agent)/, true],
  ['/daq', '数采中心', /(烘箱温度|采集|采样|℃)/, true],
  ['/dcw', '产线运营', /(涂布烘干线|运行中|节点|配方)/, true],
  ['/dcw/{line}', '产线详情(节点 SET/ACT + 台账 + 改动历史)', /(烘箱温度设定|SET|ACT|台账|182|186)/, true],
  ['/daq/{daq}', '数采节点详情(实时值 + 时序)', /(烘箱温度|℃|采样)/, true],
  ['/logs', '运维日志', /(write|recipe|alarm|line|daq|日志)/, true],
  ['/workshop/teams', 'Agent 团队(Channel)', /(烘干线工艺组|工艺员|调度长|worker|lead)/, false],
  ['/plugins', '插件管理', /(rag-bridge|diag-bridge|插件)/, false],
]

const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  ok ? pass++ : fail++
}

mkdirSync(OUT, { recursive: true })

const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(ADMIN),
}).then(r => r.json()).catch(() => null)
const token = login?.data?.token ?? ''
if (!token) {
  console.error('✖ 登录失败,无法截图')
  process.exit(2)
}
console.log(`服务 ${BASE} · token ok · 输出 ${OUT}`)

// 路由参数从**服务端**取,不依赖 state.json —— 该文件会被补跑步骤覆写,
// 一旦缺字段就会静默截出 /dcw/undefined 这种空壳页面(实际踩过)。
const auth = { authorization: `Bearer ${token}` }
const lines = (await fetch(`${BASE}/api/workshop/dcw/lines`, { headers: auth }).then(r => r.json()).catch(() => null))?.data?.lines ?? []
const daqNodes = (await fetch(`${BASE}/api/workshop/daq`, { headers: auth }).then(r => r.json()).catch(() => null))?.data?.nodes ?? []
const lineId = lineIdFromState ?? lines[0]?.id ?? ''
const tempDaq = tempDaqFromState ?? daqNodes.find(n => /温度/.test(n.name))?.id ?? daqNodes[0]?.id ?? ''
console.log(`路由参数:产线 ${lineId || '(缺)'} · 数采节点 ${tempDaq || '(缺)'}  [产线 ${lines.length} 条 / 数采节点 ${daqNodes.length} 个]`)
if (!lineId || !tempDaq) {
  console.error('✖ 缺少产线或数采节点 id,无法截取详情页')
  process.exit(2)
}
const resolvedPages = PAGES.map(([p, ...rest]) => [p.replace('{line}', lineId).replace('{daq}', tempDaq), ...rest])

const browser = await puppeteer.launch({
  executablePath: EXEC,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1', '--hide-scrollbars', '--use-gl=angle', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1680, height: 1050 },
})

const errors = []
try {
  const page = await browser.newPage()
  page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`HTTP ${r.status()} ${r.url()}`)
  })

  const seed = async () => {
    await page.evaluate((tok) => {
      document.cookie = `token=${encodeURIComponent(tok)}; path=/`
      document.cookie = 'aw-theme=light; path=/'
      localStorage.setItem('app', JSON.stringify({ isDark: false, sidebarCollapsed: false, accent: '', themeTouched: true }))
    }, token)
  }

  for (const [path, label, needle, full] of resolvedPages) {
    const before = errors.length
    try {
      await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await seed()
      await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 })
      // 等 WS 推数与 3D 首帧落定
      await page.evaluate(() => document.fonts?.ready).catch(() => {})
      await sleep(path === '/town' ? 6000 : 3500)

      const info = await page.evaluate(() => {
        const root = document.querySelector('main') ?? document.body
        const text = (root.innerText ?? '').replace(/\s+/g, ' ')
        const canvas = document.querySelector('canvas')
        return {
          len: text.length,
          text: text.slice(0, 20000),
          hasCanvas: Boolean(canvas),
          canvasSize: canvas ? `${canvas.width}x${canvas.height}` : '',
        }
      })

      const file = join(OUT, `${label.replace(/[^\w\u4e00-\u9fa5]+/g, '-')}.png`)
      await page.screenshot({ path: file, fullPage: full })
      const matched = needle.test(info.text)
      // 产线运营页是卡片式总览,正文天然短(约 250 字);门槛按页区分,避免误判
      const minLen = path === '/dcw' ? 180 : 300
      check(`${label} 渲染出内容`, info.len > minLen && matched, `文本 ${info.len} 字 · 命中判据=${matched}${info.hasCanvas ? ` · canvas ${info.canvasSize}` : ''} → ${file.split('\\').pop()}`)
      if (path === '/town') {
        check('数字孪生 canvas 已挂载(3D 场景)', info.hasCanvas, info.canvasSize)
      }
      if (errors.length > before) {
        check(`${label} 无失败请求`, false, errors.slice(before, before + 2).join(' | '))
      }
    }
    catch (err) {
      check(`${label} 渲染出内容`, false, String(err?.message ?? err).slice(0, 160))
    }
  }
}
finally {
  await browser.close()
}

const realErrors = [...new Set(errors)]
if (realErrors.length) {
  console.log('\n  失败请求/前端错误:')
  for (const e of realErrors.slice(0, 10)) console.log(`    · ${e}`)
}
writeFileSync(join(OUT, 'shot-errors.json'), JSON.stringify(realErrors, null, 2), 'utf8')

console.log(`\n${fail ? '✖' : '✅'} 界面取证:${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0
