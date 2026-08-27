/**
 * 工业 HMI 改版后的 /town 页面审计(一次性调试脚本):
 *  - 载入小镇 → 检查 HUD 骨架(顶部状态条/左右轨/底部日志带);
 *  - 选中 Agent → 会话台出现,校验历史行数;
 *  - 注入该 Agent 的实时事件 → 校验实时行入列(合并流);
 *  - 收集 pageerror + 三张截图(全景 / 会话台 / 气泡特写)。
 */
import puppeteer from 'puppeteer-core'

const BASE = process.env.AW_PAGE_BASE ?? 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-extensions', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 200)))
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => !!window.__town?.scene?.agents?.size)) break
  await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 4000))

// 1) HUD 骨架
const hud = await page.evaluate(() => ({
  agents: window.__town?.scene?.agents?.size ?? 0,
  blocks: window.__town?.scene?.blocks?.size ?? 0,
  topStrip: !!document.querySelector('.top-strip'),
  hudLeft: !!document.querySelector('.hud-left'),
  hudRight: !!document.querySelector('.hud-right'),
  tickerBox: !!document.querySelector('.ticker-box'),
  tickerRows: document.querySelectorAll('.ticker-row').length,
  tickerEmpty: document.querySelector('.tk-empty')?.textContent?.trim() ?? '',
  minimap: !!document.querySelector('.mini-map'),
  twinPanel: !!document.querySelector('.twin-panel'),
  libPanel: !!document.querySelector('.lib-panel'),
  channelDock: !!document.querySelector('.channel-dock'),
  dockCards: document.querySelectorAll('.dock-card').length,
}))
console.log('hud:', JSON.stringify(hud))
await page.screenshot({ path: 'docs/audit/screenshots/town-hmi-full.png' })

// 2) 选中调度主管 → 会话台
const sel = await page.evaluate(() => {
  const s = window.__town.scene
  const agent = [...s.agents.values()].find(a => a.name === '调度主管') ?? [...s.agents.values()][0]
  s.setSelected?.({ kind: 'agent', id: agent.agentId })
  return { id: agent.agentId, name: agent.name }
})
console.log('selected:', JSON.stringify(sel))
await new Promise(r => setTimeout(r, 2500))
const before = await page.evaluate(() => {
  const d = document.querySelector('.agent-chat')
  if (!d) return { err: 'no agent-chat' }
  return {
    name: d.querySelector('.chat-name')?.textContent,
    stateChip: d.querySelector('.chat-state')?.textContent,
    refresh: !!d.querySelector('.chat-refresh'),
    histCount: d.querySelectorAll('.rpg-line.hist').length,
    liveCount: d.querySelectorAll('.rpg-line.live').length,
    times: [...d.querySelectorAll('.rpg-time')].slice(0, 3).map(e => e.textContent),
    divider: [...d.querySelectorAll('.rpg-divider')].map(e => e.textContent.trim()),
    histSample: d.querySelector('.rpg-line.hist .rpg-text')?.textContent?.slice(0, 40) ?? '',
  }
})
console.log('chat(before live):', JSON.stringify(before))
await page.screenshot({ path: 'docs/audit/screenshots/town-agent-log.png' })

// 3) 经真实 townBus 总线注入该 Agent 的实时事件 → 实时行应入列(与 WS 同路径)
await page.evaluate((selId) => {
  const s = window.__town.scene
  const bus = window.__townBus
  const cid = s.blocks.keys().next().value
  bus?.emit?.({
    v: 1, type: 'agent.message', seq: 99001, at: Date.now(), channelId: cid, agentId: selId,
    payload: { parts: [{ text: '[实时注入] 泵组 P-201 遥测恢复正常,压力 1.82 MPa,温度 61℃' }] },
  })
  bus?.emit?.({
    v: 1, type: 'a2a.artifact', seq: 99002, at: Date.now() + 10, channelId: cid, agentId: selId,
    payload: { artifact: { artifactId: 'art-live-1', name: '巡检日报', parts: [{ text: 'P-201/P-202 运行平稳,建议保持当前转速' }] } },
  })
}, sel.id)
await new Promise(r => setTimeout(r, 1600))
const after = await page.evaluate(() => {
  const d = document.querySelector('.agent-chat')
  return {
    histCount: d?.querySelectorAll('.rpg-line.hist').length ?? -1,
    liveCount: d?.querySelectorAll('.rpg-line.live').length ?? -1,
    liveSample: d?.querySelector('.rpg-line.live .rpg-text')?.textContent?.slice(0, 40) ?? '',
    liveTime: d?.querySelector('.rpg-line.live .rpg-time')?.textContent ?? '',
    kindStamps: [...(d?.querySelectorAll('.rpg-kind') ?? [])].slice(0, 4).map(e => e.textContent),
  }
})
console.log('chat(after live):', JSON.stringify(after))

// 4) 气泡存在性(场景内 sprite)+ 近景特写 + 最终截图
await new Promise(r => setTimeout(r, 2000))
const bub = await page.evaluate(() => {
  const s = window.__town.scene
  const agents = [...s.agents.values()]
  return {
    withBubble: agents.filter(a => a.bubble).length,
    dbgBubbles: s.getDebugState?.()?.bubbles?.length ?? s.dbgBubbles?.length ?? -1,
    recentActivity: s.getRecentActivity?.().length ?? -1,
    tickerTimes: [...document.querySelectorAll('.tk-time')].slice(0, 3).map(e => e.textContent),
  }
})
console.log('bubbles:', JSON.stringify(bub))
// 近景:镜头聚焦选中 Agent,截取中央 720x520(验证名牌/气泡/投影近观质量)
await page.evaluate((selId) => {
  const s = window.__town.scene
  const a = s.agents.get(selId)
  if (a) s.focusTo(a.root.position.x, a.root.position.z)
}, sel.id)
await new Promise(r => setTimeout(r, 1800))
await page.screenshot({
  path: 'docs/audit/screenshots/town-closeup.png',
  clip: { x: 440, y: 240, width: 720, height: 520 },
})
await page.screenshot({ path: 'docs/audit/screenshots/town-hmi-live.png' })
// 5) 小地图(镜头居中):实体形状/准星/镜头平移 → viewBox 滑动但准星钉在图心
const mini1 = await page.evaluate(() => {
  const svg = document.querySelector('.mini-svg')
  if (!svg) return { err: 'no mini-svg' }
  const vb = svg.viewBox.baseVal
  return {
    viewBox: [Math.round(vb.x), Math.round(vb.y), Math.round(vb.width), Math.round(vb.height)],
    territoryShapes: svg.querySelectorAll('ellipse, rect').length,
    agentDots: svg.querySelectorAll('circle').length,
    reticle: !!svg.querySelector('.mini-reticle path'),
  }
})
console.log('minimap(before pan):', JSON.stringify(mini1))
await page.evaluate(() => {
  window.__town.scene.panBy(600, 400)
})
await new Promise(r => setTimeout(r, 500))
const mini2 = await page.evaluate(() => {
  const svg = document.querySelector('.mini-svg')
  if (!svg) return { err: 'no mini-svg' }
  const vb = svg.viewBox.baseVal
  const ret = svg.querySelector('.mini-reticle rect')
  const rb = ret ? ret.getBBox() : null
  return {
    viewBox: [Math.round(vb.x), Math.round(vb.y), Math.round(vb.width), Math.round(vb.height)],
    // 准星中心应仍在 viewBox 中心(镜头居中契约)
    reticleAtCenter: rb ? Math.abs((rb.x + rb.width / 2) - (vb.x + vb.width / 2)) < 2 : false,
  }
})
console.log('minimap(after pan):', JSON.stringify(mini2))

// 小地图特写(右下角导航图区域)
await page.screenshot({
  path: 'docs/audit/screenshots/town-minimap.png',
  clip: { x: 1368, y: 640, width: 224, height: 348 },
})

console.log('errors:', errors.slice(0, 8))
await browser.close()
