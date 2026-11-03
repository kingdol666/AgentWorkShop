/**
 * v0.9.4 全功能 UI 实机走查(隔离实例):真实 Chrome 打开关键页面,
 * 断言非空白/无 pageerror,并落截图到证据目录。
 *
 * 运行:AW_BASE=http://127.0.0.1:3980 node scripts/_audit/ui-walkthrough-v094.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE, launch, openPage, gotoReady } from '../ui/lib.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = process.env.AW_UI_OUT ?? join(REPO, 'docs', 'audit', 'evidence', '2026-11-03-full-acceptance-v094', 'ui')
mkdirSync(OUT, { recursive: true })

const EMAIL = process.env.AW_UI_EMAIL ?? 'acc-v094@awshop.local'
const PASSWORD = process.env.AW_UI_PASSWORD ?? 'AccV094#2026'
const TOKEN = process.env.AW_UI_TOKEN ?? ''

const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})
const setCookie = login.headers.get('set-cookie') ?? ''
const session = /nuxt-session=([^;]+)/.exec(setCookie)?.[1]
if (!session) throw new Error(`login failed status=${login.status} set-cookie=${setCookie.slice(0, 80)}`)

const browser = await launch({ width: 1600, height: 1000 })
const results = []
const PAGES = [
  { path: '/daq', name: 'daq', title: '数采中心' },
  { path: '/dcw', name: 'dcw', title: '产线作业' },
  { path: '/ontology', name: 'ontology', title: '本体' },
  { path: '/aml', name: 'aml', title: '自动建模' },
  { path: '/optimizer', name: 'optimizer', title: '优化器' },
  { path: '/data', name: 'data', title: '数据管理台' },
  { path: '/plugins', name: 'plugins', title: '插件' },
  { path: '/settings', name: 'settings', title: '设置' },
]
try {
  for (const p of PAGES) {
    const page = await openPage(browser, TOKEN ? { token: TOKEN } : {})
    const errors = []
    page.on('pageerror', e => errors.push(String(e).slice(0, 200)))
    await page.setCookie({ name: 'nuxt-session', value: session, domain: '127.0.0.1', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' })
    let ok = false
    try {
      await gotoReady(page, p.path, { wait: 3000, timeout: 60_000 })
      const info = await page.evaluate(() => ({
        len: document.body?.innerText?.length ?? 0,
        text: (document.body?.innerText ?? '').slice(0, 400),
        hasError: /应用错误|Application error|500|Internal Server Error/i.test(document.body?.innerText ?? ''),
      }))
      const file = join(OUT, `${p.name}.png`)
      await page.screenshot({ path: file, fullPage: false })
      ok = info.len > 300 && !info.hasError && errors.length === 0
      results.push({ path: p.path, title: p.title, ok, len: info.len, errors, screenshot: file, text: info.text.slice(0, 120) })
      console.log(`${ok ? '✔' : '✘'} ${p.path} len=${info.len} errors=${errors.length} → ${file}`)
    }
    catch (err) {
      results.push({ path: p.path, title: p.title, ok: false, error: String(err).slice(0, 300) })
      console.log(`✘ ${p.path} ${String(err).slice(0, 200)}`)
    }
    finally {
      await page.close().catch(() => {})
    }
  }
}
finally {
  await browser.close().catch(() => {})
}
const pass = results.filter(r => r.ok).length
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ at: new Date().toISOString(), base: BASE, pass, total: results.length, results }, null, 2))
console.log(`\nUI WALKTHROUGH: ${pass}/${results.length} passed`)
process.exit(pass === results.length ? 0 : 1)
