/**
 * 页面冒烟:无头浏览器打开 AgentWorkShop 首页 / 小镇(3D),截图留档。
 * 运行: node scripts/verify-page-smoke.mjs   (env: AW_PAGE_TOKEN 可选自动登录 token)
 */
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const BASE = process.env.AW_PAGE_BASE ?? 'http://127.0.0.1:3000'
const TOKEN = process.env.AW_PAGE_TOKEN ?? ''
const OUT = 'docs/audit/screenshots'
mkdirSync(OUT, { recursive: true })

const browser = await puppeteer.launch({
  executablePath: process.env.AW_BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1560,1040'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1560, height: 1040 })

let ok = false, err = ''
try {
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 45000 })
  await page.screenshot({ path: `${OUT}/home.png` })
  console.log('home ok, title=' + await page.title())

  if (TOKEN) {
    // 会话 = 'token' cookie + session-restore 插件恢复登录态
    await page.setCookie({ name: 'token', value: TOKEN, domain: '127.0.0.1', path: '/' })
    await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    // 轮询等待场景就绪(WS/快照/布局异步;避免 networkidle2 被长连接卡死)
    for (let i = 0; i < 30; i++) {
      const ready = await page.evaluate(() => !!window.__town?.scene)
      if (ready) break
      await new Promise(r => setTimeout(r, 1000))
    }
    await new Promise(r => setTimeout(r, 5000))
    const state = await page.evaluate(() => ({
      logged: !!window.__town?.scene,
      title: document.title,
      hasEmpty: !!document.querySelector('[data-hud="town-empty"]'),
    }))
    console.log('town state:', JSON.stringify(state))
    await page.screenshot({ path: `${OUT}/town-3d.png` })

    // 选中第一个 Agent → 触发员工会话台(大字号会话窗)
    const agentSel = await page.evaluate(() => {
      const s = window.__town?.scene
      if (!s) return null
      const agent = s.agents?.values?.().next?.().value
      if (!agent) return null
      s.setSelected?.({ kind: 'agent', id: agent.agentId })
      return { id: agent.agentId, name: agent.name }
    })
    console.log('agent selected:', JSON.stringify(agentSel))

    // 注入实时对话(演示头顶大字号气泡 + 员工会话台实时消费)
    const demoCh = await fetch(`${BASE}/api/workshop/channels`, { headers: { authorization: `Bearer ${TOKEN}` } }).then(r => r.json())
    const targetCh = (demoCh.data ?? [])[0]
    if (targetCh?.id) {
      const agents = await fetch(`${BASE}/api/workshop/channels/${targetCh.id}/agents`, { headers: { authorization: `Bearer ${TOKEN}` } }).then(r => r.json())
      const lead = (agents.data ?? []).find(a => a.role === 'lead')
      const workers = (agents.data ?? []).filter(a => a.role === 'worker')
      for (let i = 0; i < 3; i++) {
        const to = workers[i % workers.length]
        if (lead?.token && to?.id) {
          await fetch(`${BASE}/api/workshop/a2a/send`, {
            method: 'POST',
            headers: { 'authorization': `Bearer ${lead.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ toAgentId: to.id, parts: [{ text: `第 ${i + 1} 批巡检数据已收到:泵组 ${i + 1} 号运行正常,继续跟进。` }] }),
          }).catch(() => {})
        }
      }
    }
    await new Promise(r => setTimeout(r, 2600))
    await page.screenshot({ path: `${OUT}/town-agent-chat.png` })
  }
  else {
    await page.goto(`${BASE}/workshop`, { waitUntil: 'networkidle2', timeout: 30000 })
    await page.screenshot({ path: `${OUT}/workshop.png` })
  }
  ok = true
}
catch (e) { err = String(e) }
await browser.close()
console.log(ok ? 'SMOKE OK' : `SMOKE FAIL: ${err}`)
process.exit(ok ? 0 : 1)
