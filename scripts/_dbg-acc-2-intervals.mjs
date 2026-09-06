// 验收阶段2:前端设置页修改数采采样间隔 + 时序查询默认间隔,验证生效
// 用法:node scripts/_dbg-acc-2-intervals.mjs <base> <user> <pass> <samplingMs> <bucketMs>
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.argv[2] ?? 'http://127.0.0.1:3021'
const [USER, PASS, SAMPLE_MS, BUCKET_MS] = [process.argv[3], process.argv[4], Number(process.argv[5]), Number(process.argv[6])]
const TAG = process.argv[7] ?? 'change'
mkdirSync('.e2e-shots', { recursive: true })

const api = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { 'content-type': 'application/json', ...opts.headers } })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const login = await api('/api/users/login', { method: 'POST', body: JSON.stringify({ email: `${USER}@awshop.local`, password: PASS }) })
const TOKEN = login.body?.data?.token
if (!TOKEN) { console.error('✖ admin 登录失败'); process.exit(1) }

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--no-proxy-server', '--window-size=1600,1000'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1.25 })
  await page.setCookie({ name: 'token', value: TOKEN, domain: new URL(BASE).hostname, path: '/' })
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle2', timeout: 60000 })
  await new Promise(r => setTimeout(r, 1200))
  // 切到「运行配置」tab(runtime 设置区)
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('.ant-tabs-tab,[role=tab],button,.section-title')].find(e => (e.textContent ?? '').trim() === '运行配置')
    tab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await page.waitForFunction(() => document.body.innerText.includes('节点采样默认间隔'), { timeout: 30000 })
  console.log('✔ 设置页呈现数采间隔项')

  // 定位行:rt-row 内 rt-title 含目标文本 → 行内 .ant-input-number input
  const setNumber = async (titleText, value) => {
    const ok = await page.evaluate((t, v) => {
      const rows = [...document.querySelectorAll('.rt-row')]
      const row = rows.find(r => r.querySelector('.rt-title')?.textContent?.includes(t))
      if (!row) return false
      const input = row.querySelector('.ant-input-number input')
      if (!input) return false
      input.focus()
      document.execCommand('selectAll', false, null)
      document.execCommand('insertText', false, String(v))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.blur()
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }, titleText, value)
    if (!ok) throw new Error(`未找到输入框: ${titleText}`)
    await new Promise(r => setTimeout(r, 400))
  }
  await setNumber('节点采样默认间隔', SAMPLE_MS)
  console.log(`✔ 采样默认间隔 → ${SAMPLE_MS}ms`)
  await setNumber('时序查询默认间隔', BUCKET_MS)
  console.log(`✔ 时序查询默认间隔 → ${BUCKET_MS}ms`)

  // 全局保存
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /保\s*存|Save/.test(b.textContent ?? ''))
    btn?.click()
  })
  await new Promise(r => setTimeout(r, 1500))
  await page.screenshot({ path: `.e2e-shots/acc-2-intervals-${TAG}.png` })
}
finally {
  await browser.close()
}

// API 确认 effective 生效
const cfg = await api('/api/system/config', { headers: { authorization: `Bearer ${await (async () => TOKEN)()}` } })
const eff = cfg.body?.data?.effective ?? {}
const sampleOk = eff['daq.sampling.defaultIntervalMs'] === SAMPLE_MS
const bucketOk = eff['daq.query.defaultBucketMs'] === BUCKET_MS
console.log(sampleOk ? `✔ effective daq.sampling.defaultIntervalMs=${SAMPLE_MS}` : `✖ sampling=${JSON.stringify(eff['daq.sampling.defaultIntervalMs'])}`)
console.log(bucketOk ? `✔ effective daq.query.defaultBucketMs=${BUCKET_MS}` : `✖ bucket=${JSON.stringify(eff['daq.query.defaultBucketMs'])}`)
process.exit(sampleOk && bucketOk ? 0 : 1)
