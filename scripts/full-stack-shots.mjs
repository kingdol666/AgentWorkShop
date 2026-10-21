/**
 * 全栈验收 UI 截图包(US-308):仪表盘/数采详情/产线作业/数据管理/EDA 工坊/看板/分析台账。
 * 运行:node scripts/full-stack-shots.mjs <scenario-context.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CTX = process.argv[2]
const c = JSON.parse(readFileSync(CTX, 'utf8'))
const EVID = join(REPO, 'docs', 'audit', 'evidence', '2026-10-21-acceptance', 'shots')
mkdirSync(EVID, { recursive: true })
process.env.AW_BASE = c.base
const { launch, openPage, gotoReady, sleep } = await import('./ui/lib.mjs')

const browser = await launch()
const page = await openPage(browser, { token: c.adminToken, width: 1680, height: 1000, deviceScaleFactor: 1 })
const shots = []
const shot = async (name) => {
  await page.screenshot({ path: join(EVID, `${name}.png`), fullPage: false })
  shots.push(`${name}.png`)
  console.log(`  📸 ${name}.png`)
}

// 仪表盘
await gotoReady(page, '/', { wait: 4000 })
await shot('fs-1-dashboard')
// 数采中心(节点列表)
await gotoReady(page, '/daq', { wait: 4000 })
await shot('fs-2-daq-list')
// 数采详情(标量实时)
await gotoReady(page, `/daq/${c.daq?.['part-weight'] ?? c.daq?.[Object.keys(c.daq ?? {})[0]] ?? ''}`, { wait: 6000 })
await shot('fs-3-daq-detail')
// 产线作业
await gotoReady(page, '/dcw', { wait: 4000 })
await shot('fs-4-dcw-line')
// 数据管理台(镜像数据 tab+查询)
await gotoReady(page, '/data', { wait: 3000 })
await page.evaluate(() => {
  const sel = document.querySelector('[data-test="data-line-sel"]')
  if (sel && sel.options[1]) {
    sel.value = sel.options[1].value
    sel.dispatchEvent(new Event('change'))
  }
})
await sleep(1500)
await page.evaluate(() => {
  const chips = Array.from(document.querySelectorAll('[data-test="data-nodes"] .node-chip input'))
  let n = 0
  for (const cEl of chips) {
    if (n >= 2) break
    if (!cEl.checked) {
      cEl.click()
      n++
    }
  }
})
await page.click('[data-test="data-query"]')
await sleep(6000)
await shot('fs-5-data-query')
// EDA 工坊
await gotoReady(page, '/studio', { wait: 3000 })
await page.evaluate(() => {
  const sel = document.querySelector('[data-test="studio-line"]')
  if (sel && sel.options[1]) {
    sel.value = sel.options[1].value
    sel.dispatchEvent(new Event('change'))
  }
})
await sleep(1500)
await page.evaluate(() => {
  Array.from(document.querySelectorAll('[data-test="studio-nodes"] .miniAdd')).slice(0, 2).forEach(b => b.click())
})
await page.click('[data-test="studio-query"]')
await sleep(6000)
await shot('fs-6-studio')
// 看板:先经 API 建图表+看板(本实例可能为空),选中后截图栅格
const nodesNow = (await fetch(c.base + '/api/workshop/daq', { headers: { authorization: `Bearer ${c.adminToken}` } }).then(r => r.json())).data?.nodes ?? []
const twoNodes = nodesNow.filter(n => n.enabled).slice(0, 2).map(n => n.id)
let chartId = null
if (twoNodes.length >= 1) {
  const mkChart = await fetch(c.base + '/api/workshop/eda/charts', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${c.adminToken}` },
    body: JSON.stringify({
      title: '全栈验收图表',
      viz_type: 'trend',
      datasource: { lineId: c.lineId, nodeIds: twoNodes, preset: '60', agg: 'avg' },
      encoding: { y: twoNodes.map(id => ({ nodeId: id, name: id, unit: '', axis: 'L' })) },
      visibility: 'private',
    }),
  }).then(r => r.json()).catch(() => null)
  chartId = mkChart?.data?.chart?.id
}
if (chartId) {
  await fetch(c.base + '/api/workshop/eda/dashboards', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${c.adminToken}` },
    body: JSON.stringify({
      title: '全栈验收看板',
      layout: [{ chartId, x: 0, y: 0, w: 12, h: 4 }],
      line_id: c.lineId,
      visibility: 'private',
    }),
  }).catch(() => {})
}
await gotoReady(page, '/studio/board', { wait: 3000 })
await sleep(2000)
await page.evaluate(() => {
  const sel = document.querySelector('[data-test="board-sel"]')
  const wanted = Array.from(sel?.options ?? []).find(o => (o.textContent || '').includes('全栈验收看板'))
  if (sel && wanted) {
    sel.value = wanted.value
    sel.dispatchEvent(new Event('change'))
  }
})
await sleep(6000)
const boardCells = await page.evaluate(() => document.querySelectorAll('[data-test="board-grid"] .cell')?.length ?? 0)
console.log(`  board cells=${boardCells}`)
await shot('fs-7-board')
// 分析台账
await gotoReady(page, '/analysis', { wait: 4000 })
await shot('fs-8-analysis')
// Channel 群聊页:建 workspace→挂载 channel→进入 /workshop/w/<wsId>(群聊页在 workspace 内)
const wsRes = await fetch(c.base + '/api/workshop/workspaces', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'authorization': `Bearer ${c.adminToken}` },
  body: JSON.stringify({ name: '全栈验收工作区' }),
})
const wsJson = await wsRes.json().catch(() => ({}))
const wsId = wsJson?.data?.id ?? wsJson?.data?.workspace?.id
if (wsId && c.channelId) {
  await fetch(c.base + `/api/workshop/workspaces/${wsId}/channels/${c.channelId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${c.adminToken}` },
  })
}
await gotoReady(page, `/workshop/w/${wsId}`, { wait: 6000 })
await sleep(3000)
await shot('fs-9-channel')

await browser.close()
writeFileSync(join(EVID, 'shots-manifest.json'), JSON.stringify({ at: new Date().toISOString(), shots }, null, 2))
console.log(`\n═══ 截图包: ${shots.length} 张 ═══`)
