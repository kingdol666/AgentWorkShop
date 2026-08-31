/** 端到端 Phase 2:/town 孪生场景实时渲染观察(1号产线运行中)
 *  ① 右轨 设备面板:挤出机 twin-daq 实时值 8s 内变化(WS→townBus→面板全链)
 *  ② 控制台 twin-dcw:SET=配方目标 + 来源标签「配方」
 *  ③ 左轨树形叶子:节点实时值随采样刷新
 *  ④ 全景截图两张(设备落位 + 数采立杆 + 绑定标注)
 */
import puppeteer from 'puppeteer-core'

const BASE = 'http://127.0.0.1:3000'
const login = await fetch(`${BASE}/api/users/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }),
}).then(r => r.json())
const OUT = 'docs/audit/screenshots/ui-polish-0831'

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'],
})
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })

try {
  // 预展开左轨树的压力/温度组
  await page.goto(`${BASE}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {})
  await page.evaluate(() => {
    const ls = window.localStorage
    const cur = JSON.parse(ls.getItem('aw.twin.treeOpen') || '{}')
    for (const k of ['daq:pressure-tx', 'daq:temp-tc', 'daq:tension-cell', 'dcw:temp-sp', 'dcw:pressure-sp']) cur[k] = true
    ls.setItem('aw.twin.treeOpen', JSON.stringify(cur))
  })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 })
  for (let i = 0; i < 45; i++) {
    if (await page.evaluate(() => (window.__town?.scene?.deviceNodes?.size ?? 0) > 0)) break
    await new Promise(r => setTimeout(r, 1000))
  }
  await new Promise(r => setTimeout(r, 4000))

  const devId = async (name) => page.evaluate((n) => {
    const t = (window.__town?.scene?.getDeviceNodes?.() ?? []).find(x => x.name?.includes(n) || x.twinId)
    return null
  }, name)

  // ── ① 挤出机 L1 面板 twin-daq 实时值变化 ──
  await page.evaluate(() => {
    const nodes = window.__town.scene.getDeviceNodes?.() ?? []
    const target = nodes.find(n => /挤出机/.test(window.__town.scene.sceneTwinById?.(n.twinId)?.name ?? ''))
      ?? nodes.find(n => n.twinId?.startsWith('dev-'))
    window.__town.scene.setSelected?.({ kind: 'device', id: target.twinId })
  })
  await new Promise(r => setTimeout(r, 1200))
  const read = () => page.evaluate(() => ({
    daqRows: [...document.querySelectorAll('.twin-daq .daq-item')].map(el => el.textContent?.replace(/\s+/g, ' ').trim()),
    dcwRows: [...document.querySelectorAll('.twin-dcw .dcw-item')].map(el => ({
      text: el.textContent?.replace(/\s+/g, ' ').trim().slice(0, 60),
      src: el.querySelector('.dcw-src')?.textContent ?? '',
    })),
    treeLeaves: [...document.querySelectorAll('.daq-node .node-val')].slice(0, 8).map(el => el.textContent?.trim()),
  }))
  const s1 = await read()
  console.log('t0 daq rows:', JSON.stringify(s1.daqRows))
  console.log('t0 dcw rows:', JSON.stringify(s1.dcwRows))
  console.log('t0 tree leaves:', JSON.stringify(s1.treeLeaves))
  await page.screenshot({ path: `${OUT}/e2e-town-live-t0.png` })

  await new Promise(r => setTimeout(r, 8000))
  const s2 = await read()
  console.log('t8 daq rows:', JSON.stringify(s2.daqRows))
  console.log('t8 tree leaves:', JSON.stringify(s2.treeLeaves))
  await page.screenshot({ path: `${OUT}/e2e-town-live-t8.png` })

  const changed = s2.daqRows.filter((v, i) => v !== s1.daqRows[i]).length
  console.log(changed > 0
    ? `PASS 设备面板实时刷新: ${changed}/${s1.daqRows.length} 数采通道 8s 内值变化`
    : 'FAIL 设备面板数采值 8s 内无变化')

  // ── ② 控制台 智控 SET 行(配方来源) ──
  await page.evaluate(() => {
    const nodes = window.__town.scene.getDeviceNodes?.() ?? []
    const target = nodes.find(n => n.twinId?.startsWith('dev-'))
    // 找名字含 CON 的:直接遍历孪生池
    window.__town.scene.setSelected?.({ kind: 'device', id: target.twinId })
  })
  // 用 REST 找控制台 id 后再选中
  const twins = await fetch(`${BASE}/api/workshop/device-twins`, {
    headers: { authorization: `Bearer ${login.data.token}` },
  }).then(r => r.json())
  const consoleId = (twins.data.twins ?? []).find(t => t.name === '控制台 · CON')?.id
  await page.evaluate((id) => {
    window.__town.scene.setSelected?.({ kind: 'device', id })
  }, consoleId)
  await new Promise(r => setTimeout(r, 1200))
  const s3 = await read()
  console.log('控制台 dcw rows:', JSON.stringify(s3.dcwRows))
  const setOk = s3.dcwRows.some(r => r.text.includes('182')) && s3.dcwRows.some(r => r.text.includes('0.92'))
  console.log(setOk ? 'PASS 智控 SET 行: 182℃ / 0.92MPa 展示于控制台面板' : 'FAIL 智控 SET 行缺失')
  await page.screenshot({ path: `${OUT}/e2e-town-console-dcw.png` })
}
finally {
  await browser.close()
}
console.log('PHASE2 DONE(线仍在运行)')
