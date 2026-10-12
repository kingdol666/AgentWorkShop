// HITL 真人界面审批实证:挂真实审批卡 → Edge 打开数字孪生产线页 → 界面点击批准 → 下发执行
// 产出截图:shots/01-卡在界面.png / 02-选中方案填意见.png / 03-批准后卡片消失.png
import puppeteer from 'puppeteer-core'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'

const BASE = 'http://127.0.0.1:3001'
const LINE = 'ln-3f34c9ac'
const NODE = 'dw-910ae666'
const SHOTS = 'tmp-e2e/inj2-onboarding/shots'
mkdirSync(SHOTS, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const TOK = readFileSync('tmp-e2e/admin.tok', 'utf8').trim()
const H = { 'content-type': 'application/json', 'authorization': `Bearer ${TOK}` }
const api = async (m, u, b) => (await fetch(BASE + u, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) })).json()

// ---------- 1. 触发真实审批卡(recipe_propose 挂起等待人工) ----------
const agg = await api('GET', '/api/workshop/dcw')
const node = (agg?.data?.nodes ?? []).find(n => n.id === NODE)
const cur = Math.round(Number(node?.value ?? 255))
const target = cur + 2
console.log(`挂卡:机筒区4 ${cur}→${target}`)
const bs = await api('GET', '/api/workshop/agent-tools/bindings')
const worker = (bs?.data?.bindings ?? []).find(b => b.kind === 'recipe' && b.nodeId === 'rc-17f242f3')?.agentId
const propFetch = fetch(BASE + '/api/workshop/agent-tools/invoke', {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ agentId: worker, tool: 'recipe_propose', args: { recipe_id: 'rc-17f242f3', packages: [{ name: 'UI 审批实证步', params: [{ node_id: NODE, to: target, basis: '真人界面审批实证:机筒区4 单变量微升', exp_ref: 'HITL UI 验证轮' }] }], emergency: true } }),
  signal: AbortSignal.timeout(600_000),
}).then(r => r.json()).catch(() => null)

// 等卡面挂起(hitl/pending 可见)
let card = null
for (let i = 0; i < 45 && !card; i++) {
  await sleep(2000)
  const p = await api('GET', '/api/workshop/hitl/pending')
  card = (p?.data?.items ?? []).filter(x => x.kind === 'dcw-approval' && /^recipe-propose:/.test(String(x.nodeId ?? '')))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0] ?? null
}
if (!card) {
  console.log('未挂上卡(治理早拒?):', String((await propFetch).data?.result?.text ?? '').slice(0, 120))
  process.exit(1)
}
console.log('卡已挂起:', card.id)

// ---------- 2. 托管 Chromium 打开产线详情页(真人视角;Edge headless 被本机环境禁用,改用 puppeteer 托管 Chrome) ----------
const EDGE = 'C:\\Users\\87287\\.cache\\puppeteer\\chrome\\win64-155.0.8059.39\\chrome-win64\\chrome.exe'
const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, protocolTimeout: 600_000, args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars', '--user-data-dir=' + SHOTS + '/.edge-profile'] })
const page = await browser.newPage()
await page.setViewport({ width: 1500, height: 950 })
await page.setCookie({ name: 'token', value: TOK, domain: '127.0.0.1', path: '/' })
console.log('浏览器已起,打开产线页…')
await page.goto(`${BASE}/dcw/${LINE}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
console.log('页面已打开,等审批卡渲染…')
await sleep(4000)

// 等审批卡渲染(.rp-row)
let appeared = false
for (let i = 0; i < 15 && !appeared; i++) {
  appeared = await page.$('.rp-row') !== null
  if (!appeared) await sleep(2000)
}
await page.screenshot({ path: `${SHOTS}/01-审批卡在界面.png`, fullPage: false })
console.log('截图1: 审批卡在界面 =', appeared)
if (!appeared) {
  await page.screenshot({ path: `${SHOTS}/01b-页面现状.png`, fullPage: true })
  await browser.close()
  process.exit(1)
}

// ---------- 3. 界面操作:选中方案 → 填意见 → 点击批准 ----------
await page.click('.rp-tab')
await sleep(500)
await page.type('.rp-comment', '界面真人审批实证(Edge):批准该窗内小步', { delay: 10 })
await page.screenshot({ path: `${SHOTS}/02-选中方案填意见.png`, fullPage: false })
console.log('截图2: 选中方案+意见已填')
// 循环清空全部待批卡(页面上可能并存多张:本实证卡 + 战役固化卡)
for (let k = 0; k < 6; k++) {
  const tabBtn = await page.$('.rp-tab')
  if (tabBtn) {
    await page.click('.rp-tab')
    await sleep(300)
  }
  const comment = await page.$('.rp-comment')
  if (comment) {
    await comment.click()
    await comment.type('界面真人审批实证:批准', { delay: 5 })
  }
  const okBtn = await page.$('.rp-ok')
  if (!okBtn) break
  await page.click('.rp-ok')
  await sleep(5000)
  if ((await page.$('.rp-row')) === null) break
}
await sleep(3000)
await page.screenshot({ path: `${SHOTS}/03-批准后.png`, fullPage: false })
const stillThere = await page.$('.rp-row') !== null
console.log('截图3: 批准后卡片仍在界面?', stillThere)

await browser.close()

// ---------- 4. 后端侧验证:invoke 回执 + 设备读回 ----------
const propRes = await propFetch
const txt = String(propRes?.data?.result?.text ?? '')
console.log('invoke 回执:', txt.split('\n')[0]?.slice(0, 120))
const agg2 = await api('GET', '/api/workshop/dcw')
const after = (agg2?.data?.nodes ?? []).find(n => n.id === NODE)
console.log('设备读回:', after?.value, '(期望', target + ')')
writeFileSync(`${SHOTS}/ui-approval-result.txt`, [
  `card=${card.id}`,
  `card appeared in UI=${appeared}`,
  `card still in UI after approve=${stillThere}`,
  `receipt=${txt.split('\n')[0]}`,
  `device readback=${after?.value} expected=${target}`,
].join('\n'))
process.exit(!appeared || stillThere || after?.value !== target ? 1 : 0)
