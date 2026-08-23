/**
 * 小镇·大世界(P1)走查截图 —— 新 3200×2400 世界 + 环形布点 + 2.5D 挤出。
 * 依赖:dev server(127.0.0.1:3000)+ Edge + puppeteer-core。
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const BASE = 'http://127.0.0.1:3000'
const OUT = 'gui-test-screenshots/wuwa-world'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = async (m, ep, { body, token } = {}) => {
  const h = { 'content-type': 'application/json' }
  if (token) h.authorization = `Bearer ${token}`
  const r = await fetch(`${BASE}${ep}`, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined })
  return r.json()
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const email = `world-${Date.now().toString(36)}@test.local`
  const reg = await api('POST', '/api/users/register', { body: { name: `w-${Date.now().toString(36)}`, email, password: 'Passw0rd!123' } })
  const { token } = reg.data
  // 4 频道(各 lead+worker) → 环形布点
  const mkCh = async (name) => {
    const ch = await api('POST', '/api/workshop/channels', { body: { name, scenarioPrompt: 't', leadAgent: { name: `${name}-lead`, harness: 'mock' } }, token })
    await api('POST', `/api/workshop/channels/${ch.data.channelId}/agents`, { body: { name: `${name}-w`, harness: 'mock', role: 'worker' }, token })
    return ch.data.channelId
  }
  const cids = []
  for (const n of ['海港', '苔原', '工坊', '实验室']) cids.push(await mkCh(n))
  const ws = await api('POST', '/api/workshop/workspaces', { body: { name: 'world-ws' }, token })
  for (const c of cids) await api('POST', `/api/workshop/workspaces/${ws.data.id}/channels/${c}`, { token })

  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox'], defaultViewport: { width: 1400, height: 900 } })
  const page = await browser.newPage()
  page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 160)))
  await page.goto(`${BASE}/workshop`, { waitUntil: 'domcontentloaded' })
  await sleep(2500)
  const si = (s, v) => page.$eval(s, (el, val) => {
    const pr = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(pr, 'value').set.call(el, val)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, v)
  await si('input[type=email]', email)
  await si('input[type=password]', 'Passw0rd!123')
  await sleep(200)
  for (const bt of await page.$$('button')) {
    if (((await bt.evaluate(el => el.textContent)) || '').trim().replace(/\s/g, '') === '登录') {
      await bt.click()
      break
    }
  }
  await sleep(4500)
  await page.goto(`${BASE}/workshop/w/${ws.data.id}?view=town`, { waitUntil: 'domcontentloaded' })
  await sleep(5500)
  let ready = false
  for (let i = 0; i < 30 && !ready; i++) {
    ready = await page.evaluate(() => window.__town?.scene?.getDebugState?.()?.blocks > 0)
    if (!ready) await sleep(500)
  }
  await page.screenshot({ path: `${OUT}/01-world.png` })
  const st = await page.evaluate(() => window.__town.scene.getDebugState())
  console.log('blocks:', st.blocks, 'agents:', st.agents.length, 'player:', st.player)
  console.log('agents:', st.agents.map(a => `${a.name}@${a.channelId.slice(0, 4)} (${a.x},${a.y})`).join(' | '))
  await browser.close()
  if (!ready) {
    console.error('NOT READY')
    process.exit(2)
  }
  console.log('DONE')
}
main().catch((e) => {
  console.error(e)
  process.exit(2)
})
