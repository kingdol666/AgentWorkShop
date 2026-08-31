/** 一次性:选中高亮环 / 运行弧 / 角色光环 运行时探针 */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => (window.__town?.scene?.agents?.size ?? 0) > 0)) break
  await new Promise(r => setTimeout(r, 1000))
}
await new Promise(r => setTimeout(r, 2000))
const r = await page.evaluate(() => {
  const s = window.__town.scene
  const a = [...s.agents.values()][0]
  const d = [...s.deviceNodes.values()].find(x => !x.modelRef.startsWith('daq'))
  s.selected = { kind: 'agent', id: a.agentId }
  return new Promise(resolve => setTimeout(() => {
    const agentRing = s.selRing.visible ? { vis: true, scale: Math.round(s.selRing.scale.x) } : { vis: false }
    s.selected = { kind: 'device', id: d.twinId }
    setTimeout(() => {
      const devRing = { vis: s.selRing.visible, scale: Math.round(s.selRing.scale.x) }
      const devArc = { arcVisible: !!d.arc?.visible, arcLocal: { x: Math.round(d.arc?.position.x ?? 0), z: Math.round(d.arc?.position.z ?? 0) } }
      const agentAura = { auraMats: a.auraMats.length, ringColor: '#' + (a.auraMats[0]?.color.getHexString() ?? '') }
      resolve({ agentRing, devRing, devArc, agentAura, devId: d.twinId, devPos: { x: d.root.position.x, z: d.root.position.z } })
    }, 100)
  }, 100))
})
console.log(JSON.stringify(r))
// 选中态截图:琥珀高亮环观感
await page.evaluate((dev) => {
  const s = window.__town.scene
  s.focusTo(dev.pos.x, dev.pos.z)
  s.zoomBy(-0.5)
  s.selected = { kind: 'device', id: dev.devId }
}, { devId: r.devId, pos: r.devPos })
await new Promise(r2 => setTimeout(r2, 1800))
await page.screenshot({ path: 'docs/audit/screenshots/scene-polish-v4/view-selected.png' })
console.log('selected shot saved')
await browser.close()
