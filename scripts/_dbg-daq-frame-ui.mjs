/** 前端 smoke:frame 节点详情页渲染(向量轮廓 SVG + 图像画廊)+ 插件 manifest */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failed = 0
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failed++ }

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const cookie = { name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())

const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 1000 })
await page.setCookie(cookie)
page.on('pageerror', (e) => { console.log('PAGEERROR:', String(e).slice(0, 200)); failed++ })

try {
  // 开跑 + 建向量/图像节点
  const d = (await j('/api/workshop/dcw')).data
  const cand = d.lines.map(l => ({ line: l, recipe: d.recipes.find(r => r.lineId === l.id) })).find(x => x.recipe)
  await j(`/api/workshop/dcw/lines/${cand.line.id}/stop`, 'POST').catch(() => {})
  await sleep(800)
  await j(`/api/workshop/dcw/lines/${cand.line.id}/start`, 'POST', { recipeId: cand.recipe.id })
  const vec = (await j('/api/workshop/daq', 'POST', { templateRef: 'thickness-scan', lineId: cand.line.id, name: 'UI 向量' })).data.node
  const img = (await j('/api/workshop/daq', 'POST', { templateRef: 'ccd-image', lineId: cand.line.id, name: 'UI 图像' })).data.node
  await sleep(6000)

  // 向量详情页
  await page.goto(`${ROOT}/daq/${vec.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(6000)
  const vecTile = await page.evaluate(() => ({ frames: !!document.querySelector('.frames-tile'), svg: !!document.querySelector('.vec-svg polyline'), rows: document.querySelectorAll('.frames-tile tbody tr').length }))
  check('向量页:帧视图渲染', vecTile.frames && vecTile.svg, JSON.stringify(vecTile))

  // 图像详情页(画廊 + 缩略图实际加载)
  await page.goto(`${ROOT}/daq/${img.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(8000)
  const imgTile = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.gal-item img')]
    return { gal: !!document.querySelector('.gal'), n: imgs.length, loaded: imgs.filter(i => i.naturalWidth > 0).length }
  })
  check('图像页:画廊渲染', imgTile.gal, JSON.stringify(imgTile))
  check('图像页:缩略图实际加载(naturalWidth>0)', imgTile.loaded > 0, `loaded=${imgTile.loaded}/${imgTile.n}`)

  // /daq 列表页无回归
  await page.goto(`${ROOT}/daq`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(4000)
  const listRows = await page.evaluate(() => document.querySelectorAll('tbody tr').length)
  check('/daq 列表页正常(有节点行)', listRows > 0, `rows=${listRows}`)
} finally {
  await browser.close().catch(() => {})
  // 清理
  const nodes = (await j('/api/workshop/daq')).data.nodes.filter(n => n.name.startsWith('UI '))
  for (const n of nodes) await j(`/api/workshop/daq/${n.id}`, 'DELETE').catch(() => {})
  const d = (await j('/api/workshop/dcw')).data
  for (const l of d.lines) await j(`/api/workshop/dcw/lines/${l.id}/stop`, 'POST').catch(() => {})
}

console.log(failed === 0 ? '\nUI SMOKE PASS' : `\nUI SMOKE FAILED(${failed})`)
process.exit(failed === 0 ? 0 : 1)
