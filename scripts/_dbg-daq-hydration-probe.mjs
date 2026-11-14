// 一次性诊断:/daq 页水合是否崩溃(vpTier 不出现的真实原因)
// 用法:tsx --tsconfig .nuxt/tsconfig.server.json scripts/_dbg-daq-hydration-probe.mjs <port>
import { join } from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = process.argv[2] ?? '3997'
const BASE = `http://127.0.0.1:${port}`
process.env.AW_BASE = BASE
process.env.NO_PROXY = '127.0.0.1,localhost'

const { launch, openPage } = await import('./ui/lib.mjs')
const { spawn } = await import('node:child_process')
const { openSync } = await import('node:fs')

// 复用隔离 home 惯例:自建临时 home
const { mkdtempSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const HOME = mkdtempSync(join(tmpdir(), 'aw-daq-probe-'))
const logFd = openSync(join(HOME, 'dev.log'), 'a')
const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'dev', '--port', port], {
  cwd: REPO,
  env: { ...process.env, AW_MODE: 'home', AW_HOME: join(HOME, 'home'), AW_RATE_LIMIT_OFF: '1', NUXT_SESSION_PASSWORD: 'DaqProbe#2026-session-key-32chars', NO_PROXY: '127.0.0.1,localhost' },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})

const sleep = ms => new Promise(r => setTimeout(r, ms))
let healthy = false
for (let i = 0; i < 120; i++) {
  await sleep(1500)
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) })
    if (r.ok) { healthy = true; break }
  }
  catch { /* 未就绪 */ }
}
console.log('healthy:', healthy)
if (!healthy) process.exit(1)

// 注册 admin(响应形状 {status,code,data:{token}},与 E2E api() 助手一致)
const reg = await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'probe', email: `probe-${Date.now()}@awshop.local`, password: 'DaqProbe#2026' }) })
const regJson = await reg.json().catch(() => null)
const token = regJson?.data?.token ?? ''
console.log('token:', Boolean(token))

const browser = await launch({ width: 1600, height: 1000 })
const page = await openPage(browser, { token, width: 1600, height: 1000, deviceScaleFactor: 1 })
const consoleMsgs = []
page.on('console', m => { if (['error', 'warning'].includes(m.type())) consoleMsgs.push(`[${m.type()}] ${m.text().slice(0, 300)}`) })
page.on('pageerror', e => consoleMsgs.push(`[pageerror] ${String(e.message).slice(0, 300)}`))
page.on('response', (r) => {
  if (r.status() >= 400) consoleMsgs.push(`[http ${r.status()}] ${r.url().slice(0, 220)}`)
})

for (const path of ['/daq', '/dcw']) {
  const t0 = Date.now()
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  }
  catch (err) { console.log(path, 'goto failed:', String(err).slice(0, 120)) }
  for (let i = 0; i < 40; i++) {
    const state = await page.evaluate(() => ({
      vpTier: document.documentElement.dataset.vpTier ?? null,
      bodyLen: (document.body.textContent ?? '').length,
    })).catch(() => ({ vpTier: null, bodyLen: -1 }))
    if (state.vpTier !== null) {
      console.log(`${path} hydrated in ${Date.now() - t0}ms vpTier=${state.vpTier} bodyLen=${state.bodyLen}`)
      break
    }
    if (i === 39) console.log(`${path} NOT hydrated after ${Date.now() - t0}ms bodyLen=${state.bodyLen}`)
    await sleep(500)
  }
  await sleep(500)
}
console.log('--- console/page errors ---')
for (const m of consoleMsgs.slice(0, 30)) console.log(m)
await browser.close().catch(() => {})
child.kill()
process.exit(0)
