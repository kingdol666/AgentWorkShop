/** 一次性验证:①数采节点表行样式与表头/其它列表一致(行组件 scoped 隔离修复);
 *  ②系统设置里三个独立节拍(采集/WS 下发/趋势刷新)的默认值与下限可独立设定。 */
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_BASE ?? 'http://127.0.0.1:3001'
const OUT = process.env.AW_OUT ?? '.e2e-shots/rowstyle'
const EMAIL = process.env.E2E_USER ?? 'zhangwei@awshop.io'
const PASS = process.env.E2E_PASS ?? 'Awshop@123'

const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASS }),
}).then(r => r.json())
const token = login?.data?.token
if (!token) { console.error('登录失败', login); process.exit(1) }
console.log(`· 登录 ${login.data.user.name}(${login.data.user.role})`)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1760,1100'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1760, height: 1100 })
await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })

let fail = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '✔' : '✖'} ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) fail++
}

// ---------- ① 数采列表行样式 ----------
await page.goto(`${BASE}/daq`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.waitForFunction(() => document.querySelectorAll('.nodes-table tbody tr td b').length > 3, { timeout: 60_000 })
await new Promise(r => setTimeout(r, 2500))

const probe = await page.evaluate(() => {
  const th = document.querySelector('.nodes-table thead th')
  const row = document.querySelector('.nodes-table tbody tr')
  const tds = [...(row?.querySelectorAll('td') ?? [])]
  const cs = el => el ? getComputedStyle(el) : null
  const thCs = cs(th), td0 = cs(tds[0])
  const pill = row?.querySelector('.st-pill')
  const trend = row?.querySelector('.trend')
  const drv = row?.querySelector('.drv-tag')
  const toggle = row?.querySelector('.node-toggle')
  const sel = row?.querySelector('.line-sel')
  const runPill = row?.querySelector('.run-pill')
  return {
    rows: document.querySelectorAll('.nodes-table tbody tr').length,
    cols: tds.length,
    thPadding: thCs ? `${thCs.paddingTop}/${thCs.paddingLeft}` : null,
    tdPadding: td0 ? `${td0.paddingTop}/${td0.paddingLeft}` : null,
    tdBorder: td0?.borderBottomWidth ?? null,
    pill: pill ? { display: getComputedStyle(pill).display, bg: getComputedStyle(pill).backgroundColor, radius: getComputedStyle(pill).borderRadius } : null,
    trend: trend ? { w: getComputedStyle(trend).width, h: getComputedStyle(trend).height } : null,
    drv: drv ? { border: getComputedStyle(drv).borderTopWidth, radius: getComputedStyle(drv).borderRadius } : null,
    toggle: toggle ? { display: getComputedStyle(toggle).display, cursor: getComputedStyle(toggle).cursor } : null,
    sel: sel ? { maxWidth: getComputedStyle(sel).maxWidth } : null,
    runPill: runPill ? { display: getComputedStyle(runPill).display, radius: getComputedStyle(runPill).borderRadius } : null,
  }
})
console.log(JSON.stringify(probe, null, 1))
check('行数 > 3(真实节点)', probe.rows > 3, `rows=${probe.rows}`)
check('行单元格列数 = 12', probe.cols === 12, `cols=${probe.cols}`)
check('行单元格 padding 与表头一致', probe.tdPadding === probe.thPadding && probe.tdPadding === '9px/12px', `th=${probe.thPadding} td=${probe.tdPadding}`)
check('行单元格有分隔线', probe.tdBorder !== '0px', probe.tdBorder)
check('状态 pill 有底色+胶囊圆角', !!probe.pill && probe.pill.bg !== 'rgba(0, 0, 0, 0)' && probe.pill.radius !== '0px', JSON.stringify(probe.pill))
check('趋势图 120x26', probe.trend?.w === '120px' && probe.trend?.h === '26px', JSON.stringify(probe.trend))
check('驱动标签为 chip', probe.drv?.border === '1px' && probe.drv?.radius !== '0px', JSON.stringify(probe.drv))
check('启停按钮 inline-flex+pointer', probe.toggle?.display === 'inline-flex' && probe.toggle?.cursor === 'pointer', JSON.stringify(probe.toggle))
check('产线下拉 max-width 120px', probe.sel?.maxWidth === '120px', JSON.stringify(probe.sel))
check('产线运行 pill 胶囊化', probe.runPill?.display === 'inline-flex' && probe.runPill?.radius !== '0px', JSON.stringify(probe.runPill))
await page.screenshot({ path: `${OUT}-list.png` })

// ---------- ② 系统设置:三个独立节拍 ----------
await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await new Promise(r => setTimeout(r, 1500))
await page.evaluate(() => {
  const tab = [...document.querySelectorAll('button,a,div')].find(el => el.textContent?.trim() === '运行时配置')
  tab?.click()
})
await page.waitForFunction(() => document.body.textContent?.includes('WS 下发默认间隔'), { timeout: 30_000 }).catch(() => {})
const rt = await page.evaluate(() => {
  const txt = document.body.textContent ?? ''
  const labels = ['节点采样默认间隔(ms)', '节点采样下限(ms)', 'WS 下发默认间隔(ms)', 'WS 下发下限(ms)', '趋势图刷新间隔(ms)', '趋势图刷新下限(ms)']
  const rows = [...document.querySelectorAll('.rt-row')]
  const find = label => {
    const r = rows.find(el => el.querySelector('.rt-title')?.textContent?.includes(label))
    const inp = r?.querySelector('input')
    return inp ? { min: inp.getAttribute('aria-valuemin'), max: inp.getAttribute('aria-valuemax'), value: inp.value } : null
  }
  return {
    has: Object.fromEntries(labels.map(l => [l, txt.includes(l)])),
    intervals: Object.fromEntries(labels.map(l => [l, find(l)])),
  }
})
console.log(JSON.stringify(rt, null, 1))
for (const [k, v] of Object.entries(rt.has)) check(`设置项存在「${k}」`, v)
const iv = rt.intervals
check('采集:默认 5000 / 下限 1000', iv['节点采样默认间隔(ms)']?.value === '5000' && iv['节点采样下限(ms)']?.value === '1000', JSON.stringify(iv['节点采样默认间隔(ms)']))
check('WS 下发:默认 1000 / 下限 0(独立)', iv['WS 下发默认间隔(ms)']?.value === '1000' && iv['WS 下发下限(ms)']?.value === '0', JSON.stringify(iv['WS 下发默认间隔(ms)']))
check('趋势刷新:默认 5000 / 下限 500(独立)', iv['趋势图刷新间隔(ms)']?.value === '5000' && iv['趋势图刷新下限(ms)']?.value === '500', JSON.stringify(iv['趋势图刷新间隔(ms)']))
const minAttrs = ['节点采样下限(ms)', 'WS 下发下限(ms)', '趋势图刷新下限(ms)'].map(k => iv[k]?.min)
check('三组下限各自独立挂在输入框 min 上', new Set(minAttrs).size === 3, `aria-valuemin=${minAttrs.join(' / ')}`)
await page.screenshot({ path: `${OUT}-settings.png` })

await browser.close()
console.log(fail === 0 ? '全部通过' : `失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
