/**
 * 侧边信息重构审计:
 *  1) 选中精魂 → 会话记录在右轨 Inspector(.rail-right 内 chat-embed),场景舞台(#town-host)无悬浮会话台;
 *  2) 设备控制台:数采节点卡为绿色(.daq),设备卡显示绑定通道实时值(.twin-daq);
 *  3) 截图:agent 会话在右轨 + 设备控制台绿色数采卡。
 */
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_PAGE_BASE ?? 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const H = { 'authorization': `Bearer ${TOKEN}`, 'content-type': 'application/json' }

const spec = [
  { name: 'TD 拉幅机 L1', ref: 'dev-folder-tdo', x: 1700, z: 600, kind: 'device' },
  { name: '温度传感器 01', ref: 'daq-temp-tc', x: 1750, z: 690, kind: 'daq' },
]
const created = []
for (const s of spec) {
  const res = await fetch(`${BASE}/api/workshop/device-twins`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: s.name, modelRef: s.ref, kind: s.kind, posX: s.x, posZ: s.z }),
  })
  const j = await res.json().catch(() => ({}))
  const id = j?.data?.twin?.id ?? j?.data?.id
  if (res.ok && id) created.push({ ...s, id })
}
const byName = Object.fromEntries(created.map(c => [c.name, c.id]))
const bindings = { [byName['温度传感器 01']]: byName['TD 拉幅机 L1'] }
console.log(`created ${created.length}/${spec.length}`)

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.evaluateOnNewDocument((b) => {
  localStorage.setItem('aw.twin.daqBindings', JSON.stringify(b))
}, bindings)
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 160)))
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => (window.__town?.scene?.agents?.size ?? 0) > 0)) break
  await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 5000)) // 等模拟 tick 产出实时值

// ---- 1) 选中精魂 → 会话在右轨 ----
await page.evaluate(() => {
  const s = window.__town.scene
  const agent = [...s.agents.values()][0]
  s.setSelected({ kind: 'agent', id: agent.agentId })
})
await new Promise(r => setTimeout(r, 2500))
const chatLoc = await page.evaluate(() => {
  const embed = document.querySelector('.rpg-lines.chat-embed')
  const rail = embed?.closest('.rail-right') ?? null
  return {
    inRail: !!rail,
    inStage: !!document.querySelector('#town-host .agent-chat, .stage .agent-chat'),
    name: document.querySelector('.rail-right .chat-name')?.textContent ?? '',
    rows: document.querySelectorAll('.rail-right .rpg-line').length,
  }
})
console.log('chat:', JSON.stringify(chatLoc), chatLoc.inRail && !chatLoc.inStage ? '(OK 会话入右轨)' : '(FAIL)')

// ---- 2) 设备控制台实时数采 + 绿卡 ----
const panel = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.twin-card')]
  const daqCard = cards.find(c => c.classList.contains('daq'))
  const devCard = cards.find(c => (c.textContent ?? '').includes('TD 拉幅机') && c.querySelector('.twin-daq'))
  return {
    total: cards.length,
    daqGreen: !!daqCard,
    daqCode: daqCard?.querySelector('.twin-code')?.textContent ?? '',
    devDaqRow: devCard?.querySelector('.daq-item')?.textContent?.replace(/\s+/g, ' ')?.trim() ?? '',
    devCtrlHidden: devCard ? !devCard.querySelector('.twin-ctrl') || false : null,
    daqCtrlHidden: daqCard ? !daqCard.querySelector('.twin-ctrl') : null,
  }
})
console.log('panel:', JSON.stringify(panel), panel.daqGreen && panel.devDaqRow ? '(OK 绿卡+实时值)' : '(FAIL)')

// ---- 3) 截图:选中精魂的右轨 + 滚动到设备控制台 ----
await page.screenshot({ path: 'docs/audit/screenshots/town-sideinfo-agent.png' })
await page.evaluate(() => {
  const rail = document.querySelector('.rail-right')
  if (rail) rail.scrollTop = rail.scrollHeight
})
await new Promise(r => setTimeout(r, 400))
await page.screenshot({ path: 'docs/audit/screenshots/town-sideinfo-panel.png' })
console.log('pageerrors:', errors.length ? errors : 'none')

await page.close().catch(() => {})
await browser.close()
for (const c of created) {
  await fetch(`${BASE}/api/workshop/device-twins/${c.id}`, { method: 'DELETE', headers: H }).catch(() => {})
}
console.log(`cleanup done (${created.length})`)
