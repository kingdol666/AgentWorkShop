import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_PAGE_BASE ?? 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 160)))
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => !!window.__town?.scene?.agents?.size)) break
  await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 5000))

const state = await page.evaluate(() => {
  const s = window.__town?.scene
  const previews = [...document.querySelectorAll('.model-card .model-preview-3d canvas')].map(c => ({
    w: c.width, h: c.height,
  }))
  const uploadBoxText = document.querySelector('.upload-box .upload-name')?.textContent?.trim() ?? ''
  const hasDrop = !!document.querySelector('.upload-box')
  return {
    previewCount: previews.length,
    previewSizes: previews.slice(0, 3),
    uploadBoxText,
    hasDrop,
    agentCount: s?.agents?.size ?? 0,
  }
})
console.log('library:', JSON.stringify(state))

// 选中调度主管 → RPG 对话窗(历史+实时)
const sel = await page.evaluate(() => {
  const s = window.__town.scene
  const agent = [...s.agents.values()].find(a => a.name === '调度主管') ?? [...s.agents.values()][0]
  s.setSelected?.({ kind: 'agent', id: agent.agentId })
  return { id: agent.agentId, name: agent.name }
})
console.log('selected:', JSON.stringify(sel))
await page.evaluate(() => {
  const s = window.__town.scene
  // 注入几个实时消息,触发对话窗 live 内容
  s.handleTownEvent?.({
    v: 1, type: 'a2a.message', seq: 9001, at: Date.now(), channelId: s.blocks.keys().next().value,
    agentId: 'x',
    payload: { fromAgentId: 'lead', parts: [{ text: '泵组巡检数据已汇总,一切正常' }] },
  })
})
await new Promise(r => setTimeout(r, 2600))
const dialog = await page.evaluate(() => {
  const d = document.querySelector('.rpg-dialog')
  if (!d) return { err: 'no rpg-dialog' }
  return {
    head: d.querySelector('.rpg-nameplate .agent-chat-name')?.textContent,
    tag: d.querySelector('.rpg-tag')?.textContent,
    histCount: d.querySelectorAll('.rpg-line.hist').length,
    liveCount: d.querySelectorAll('.rpg-line.live').length,
    divider: [...d.querySelectorAll('.rpg-divider')].map(e => e.textContent.trim()),
    hasPortrait: !!d.querySelector('.rpg-portrait'),
  }
})
console.log('dialog:', JSON.stringify(dialog))
console.log('errors:', errors.slice(0, 6))
await page.screenshot({ path: 'docs/audit/screenshots/town-rpg-dialog.png' })
await browser.close()
