// Extra checks: (1) login card in EN via incognito context (no token), (2) zh regression on key routes.
import fs from 'node:fs'
import path from 'node:path'
import { launch, openPage, gotoReady, sleep, ensureVisualUser } from './ui/lib.mjs'

const OUT = '.e2e-shots/i18n-en'
fs.mkdirSync(OUT, { recursive: true })
const CJK = /[\u4e00-\u9fff]/
const token = await ensureVisualUser()

const browser = await launch({ width: 1440, height: 900 })

// ---- 1) EN login card, incognito (no cookies) ----
const ctx = await browser.createBrowserContext()
const anon = await ctx.newPage()
await anon.setViewport({ width: 1440, height: 900 })
await anon.evaluateOnNewDocument(() => {
  try {
    localStorage.setItem('aw.locale', 'en')
    localStorage.setItem('app', JSON.stringify({ isDark: true, sidebarCollapsed: false, accent: null, themeTouched: true }))
  }
  catch { /* about:blank 无 origin,忽略 */ }
})
await gotoReady(anon, '/workshop', { wait: 3000 })
await sleep(800)
const enText = await anon.evaluate(() => document.body.innerText)
const enCjk = enText.split('\n').map(l => l.trim()).filter(l => CJK.test(l))
await anon.screenshot({ path: path.join(OUT, 'login_card.png') })
console.log(`[login EN] cjk=${enCjk.length}${enCjk.length ? ' → ' + enCjk.join(' | ').slice(0, 200) : ''}`)
await ctx.close()

// ---- 2) zh regression: default locale (no aw.locale) ----
const zhPage = await openPage(browser, { token, dark: true, width: 1440, height: 900 })
// no token: use login-less routes? need auth → reuse stored token from report env
await zhPage.evaluateOnNewDocument(() => {
  try {
    localStorage.removeItem('aw.locale')
  }
  catch { /* 忽略 */ }
})
for (const p of ['/town', '/dcw', '/settings']) {
  try {
    await gotoReady(zhPage, p, { wait: 3500 })
    await sleep(500)
    await zhPage.screenshot({ path: path.join(OUT, `zh-regression${p.replace(/\//g, '_')}.png`) })
    const t = await zhPage.evaluate(() => document.body.innerText)
    const hasZh = CJK.test(t)
    console.log(`[zh] ${p} containsChinese=${hasZh}`)
  }
  catch (e) { console.log(`[zh] ${p} ERR ${String(e).slice(0, 120)}`) }
}
await browser.close()
console.log('DONE')
