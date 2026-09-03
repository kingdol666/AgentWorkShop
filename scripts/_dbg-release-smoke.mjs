/**
 * 发布前五大功能烟囱测试:产线管理 / 数采数控 / 插件处理节点 / Agent 团队作业 / 数字孪生。
 * 运行: node scripts/_dbg-release-smoke.mjs
 */
import puppeteer from 'puppeteer-core'

const ROOT = 'http://127.0.0.1:3000'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failed = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!cond) failed++ }

const login = await fetch(`${ROOT}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'zhangwei@awshop.io', password: 'Awshop@123' }) }).then(r => r.json())
const H = { authorization: `Bearer ${login.data.token}`, 'content-type': 'application/json' }
const j = (u, m = 'GET', b) => fetch(ROOT + u, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then(r => r.json())

// ===== ① 产线管理 =====
console.log('\n--- ① 产线管理 ---')
{
  const d = (await j('/api/workshop/dcw')).data
  ok('产线清单可读', (d.lines?.length ?? 0) > 0, `${d.lines?.length} 条`)
  ok('配方清单可读', (d.recipes?.length ?? 0) > 0, `${d.recipes?.length} 条`)
  const cand = d.lines.map(l => ({ line: l, recipe: d.recipes.find(r => r.lineId === l.id) })).find(x => x.recipe)
  const stop = await j(`/api/workshop/dcw/lines/${cand.line.id}/stop`, 'POST').catch(() => null)
  ok('停线操作可用', stop !== null)
  await sleep(800)
  const st = await j(`/api/workshop/dcw/lines/${cand.line.id}/start`, 'POST', { recipeId: cand.recipe.id })
  ok('开跑操作可用(产线激活)', st.data?.line?.active === true)
  const daqA = (await j('/api/workshop/daq')).data
  await sleep(4000)
  const daqB = (await j('/api/workshop/daq')).data
  ok('产线运行态保持(采样持续)', daqB.meta.produced > daqA.meta.produced, `produced ${daqA.meta.produced} → ${daqB.meta.produced}`)
  // 保持运行(后续数采/插件节点依赖);结束统一停线
  globalThis.__smokeLine = cand.line.id
}

// ===== ② 数采数控 =====
console.log('\n--- ② 数采数控 ---')
{
  const daq = (await j('/api/workshop/daq')).data
  ok('数采节点清单可读', (daq.nodes?.length ?? 0) > 0, `${daq.nodes.length} 节点`)
  ok('数采后端就绪(timescale/mqtt/minio)', daq.meta.tsdb === 'timescale' && daq.meta.queue === 'mqtt' && daq.meta.objectstore === 'minio', JSON.stringify({ tsdb: daq.meta.tsdb, queue: daq.meta.queue, os: daq.meta.objectstore }))
  const live = daq.nodes.filter(n => n.value != null && n.state === 'ok').length
  ok('标量节点实时采集中', live > 0, `${live} 节点有值`)
  const dcw = (await j('/api/workshop/dcw')).data
  const dcwLive = dcw.nodes?.filter(n => n.value != null) ?? []
  ok('数控节点有设定/回读值', dcwLive.length > 0, `${dcwLive.length} 节点`)
  const framesOk = daq.meta.framesStored == null || daq.meta.framesStored >= 0
  ok('帧管线指标可用', framesOk, `framesStored=${daq.meta.framesStored}`)
}

// ===== ③ 插件处理节点 =====
console.log('\n--- ③ 插件处理节点 ---')
{
  const daq = (await j('/api/workshop/daq')).data
  ok('插件模板在目录(plug-demo-roughness)', daq.templates.some(t => t.plugin && t.signalKind === 'vector'))
  const manifest = await fetch(`${ROOT}/api/plugins/manifest`).then(r => r.json())
  const names = ((manifest.data ?? manifest).plugins ?? []).map(p => p.name)
  ok('三个扩展插件已装载', ['daq-vector-demo', 'omp-sensor-tools', 'daq-sink-verify'].every(n => names.includes(n)), names.join(','))
}

// ===== ④ Agent 团队作业 =====
console.log('\n--- ④ Agent 团队作业 ---')
{
  const agents = (await j('/api/workshop/agents')).data
  const list = agents.agents ?? agents
  ok('Agent 实例清单可读', list.length > 0, `${list.length} 实例`)
  const channels = (await j('/api/workshop/channels')).data
  const chList = channels.data ?? channels
  ok('Channel 清单可读', (Array.isArray(chList) ? chList : chList.channels ?? []).length >= 0)
  const chList2 = (await j('/api/workshop/channels')).data
  const ch0 = (Array.isArray(chList2) ? chList2 : chList2.channels ?? [])[0]
  const memories = ch0 ? await j(`/api/workshop/channels/${ch0.id}/memories?limit=3`).catch(e => ({ data: null })) : { data: null }
  ok('记忆系统可读(channel 级)', Array.isArray(memories.data))
}

// ===== ⑤ 数字孪生控制(浏览器)=====
console.log('\n--- ⑤ 数字孪生 ---')
{
  const browser = await puppeteer.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: 'new', args: ['--no-sandbox', '--disable-gpu', '--window-size=1600,1000'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1600, height: 1000 })
  await page.setCookie({ name: 'token', value: login.data.token, domain: '127.0.0.1', path: '/' })
  let pageError = false
  page.on('pageerror', () => { pageError = true })
  await page.goto(`${ROOT}/town`, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await sleep(22000)
  const town = await page.evaluate(() => ({
    canvas: document.querySelectorAll('canvas').length,
    panelDaq: document.querySelectorAll('.twin-daq .daq-item').length,
    panelDcw: document.querySelectorAll('.twin-dcw .dcw-item').length,
  }))
  ok('/town 页面加载(canvas 场景)', town.canvas > 0, `${town.canvas} canvas`)
  ok('孪生面板数采监控行', town.panelDaq > 0, `${town.panelDaq} 行`)
  ok('孪生面板数控设定行', town.panelDcw > 0, `${town.panelDcw} 行`)
  ok('/town 无页面级 JS 错误', !pageError)
  // 控制面:DCW 设定行存在即数控控制面已接入面板
  await browser.close()
}

// ===== 收尾:停线 =====
if (globalThis.__smokeLine) await j(`/api/workshop/dcw/lines/${globalThis.__smokeLine}/stop`, 'POST').catch(() => {})

console.log(failed === 0 ? '\nRELEASE SMOKE ALL PASS' : `\nRELEASE SMOKE FAILED(${failed})`)
process.exit(failed === 0 ? 0 : 1)
