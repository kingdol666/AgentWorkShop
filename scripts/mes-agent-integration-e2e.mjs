#!/usr/bin/env node
/**
 * 数采/配方/MES 全链 Agent 集成验收(隔离实例,真实 HTTP + Agent 工具桥 + MES 模拟器)。
 *
 * 覆盖:
 *  G1 隔离实例 + admin + MES 模拟器
 *  G2 产线/数控节点/产品/配方/频道/配方绑定/开跑
 *  G3 Agent recipe_catalog 解析当前配方;recipe_apply(仅 line_id)经 HITL 下发
 *  G4 Agent recipe_create 从活动批次冻结参数另存新配方(经 HITL);审计带 product_id
 *  G5 Agent recipe_log 按 recipe_id/product_id 可查下发/试验/创建/开跑
 *  G6 外部 API 推送 DAQ 数组/图像 → daq_frames 在线读取(带点位语义)→ daq_export manifest/README
 *  G7 MES 向量历史 + dictionaryPath:mes_fetch 返回字段字典与数组采样;mes_export 落目录+manifest/README
 *
 * 运行:node scripts/mes-agent-integration-e2e.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync, rmSync, existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(tmpdir(), 'aw-mes-agent-e2e')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'home'), { recursive: true })
mkdirSync(join(ROOT, 'exports'), { recursive: true })
const TAG = `ma${Date.now().toString(36).slice(-5)}`
const MES_PORT = 15061
const MES_TOKEN = `mes-e2e-${TAG}-token`
const INGEST_TOKEN = `daq-e2e-${TAG}-token`
const results = []
const ok = (id, name, cond, detail = '') => {
  results.push({ id, name, pass: Boolean(cond), detail: String(detail).slice(0, 500) })
  console.log(`${cond ? '✔' : '✖'} [${id}] ${name}${cond ? '' : ` — ${String(detail).slice(0, 500)}`}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

let port = 0
for (const p of [3999, 3998, 3997, 3996]) {
  try {
    const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1200) })
    if (r.ok) continue
  }
  catch { /* 空闲 */ }
  port = p
  break
}
if (!port) {
  console.error('无空闲端口')
  process.exit(1)
}
const BASE = `http://127.0.0.1:${port}`
process.env.NO_PROXY = '127.0.0.1,localhost'

const mesLog = openSync(join(ROOT, 'mes-sim.log'), 'a')
const mesSim = spawn(process.execPath, [join(REPO, 'scripts', 'dev-mes-simulator.mjs'), '--port', String(MES_PORT)], {
  cwd: REPO,
  env: { ...process.env, MES_SIM_PORT: String(MES_PORT), MES_SIM_TOKEN: MES_TOKEN, NO_PROXY: '127.0.0.1,localhost' },
  stdio: ['ignore', mesLog, mesLog],
  windowsHide: true,
})

const logFd = openSync(join(ROOT, 'dev.log'), 'a')
const child = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'dev', '--port', String(port)], {
  cwd: REPO,
  env: {
    ...process.env,
    AW_MODE: 'home',
    AW_HOME: join(ROOT, 'home'),
    AW_RATE_LIMIT_OFF: '1',
    AW_TRIAL_INTERVAL_MS: '0',
    AW_DAQ_INGEST_TOKEN: INGEST_TOKEN,
    AW_MES_E2E_TOKEN: MES_TOKEN,
    AW_MES_EXPORT_ROOT: join(ROOT, 'exports'),
    NUXT_SESSION_PASSWORD: 'MesAgent#2026-e2e-session-key',
    NO_PROXY: '127.0.0.1,localhost',
  },
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
})

async function api(method, path, body, token, timeoutMs = 180_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  let json = null
  try {
    json = await res.json()
  }
  catch { /* 非 JSON */ }
  return { status: res.status, ...json }
}
const data = r => r?.data ?? null
const invText = r => String(r?.data?.result?.text ?? r?.data?.text ?? '')
const invErr = r => Boolean(r?.data?.result?.isError ?? r?.data?.isError)
const invoke = (agentId, tool, args, token) => api('POST', '/api/workshop/agent-tools/invoke', { agentId, tool, args }, token)
const pendingIds = async token => new Set((data(await api('GET', '/api/workshop/hitl/pending', undefined, token))?.items ?? []).map(x => x.id))
const approve = (card, token, comment) => api('POST', '/api/workshop/hitl/respond', { kind: 'dcw-approval', id: card.id, confirmed: true, comment }, token)

async function invokeApproved(agentId, tool, args, token, label) {
  const known = await pendingIds(token)
  const p = invoke(agentId, tool, args, token)
  let card = null
  for (let i = 0; i < 60 && !card; i++) {
    await sleep(500)
    const items = data(await api('GET', '/api/workshop/hitl/pending', undefined, token))?.items ?? []
    card = items.find(x => !known.has(x.id) && String(x.nodeId ?? '').startsWith('recipe:')) ?? null
  }
  if (card) await approve(card, token, `${label} E2E 人工批准`)
  const r = await p
  console.log(`  [${label}] hitl=${card?.id ?? '(无)'} isError=${invErr(r)} ${invText(r).slice(0, 240)}`)
  return { r, card }
}

async function waitHealth() {
  for (let i = 0; i < 120; i++) {
    await sleep(1500)
    try {
      const h = await api('GET', '/api/health', undefined, undefined, 3000)
      if (h?.data?.status === 'ok' && h?.data?.workshop === 'ready') return true
    }
    catch { /* 未就绪 */ }
  }
  return false
}

try {
  const healthy = await waitHealth()
  ok('G1a', '隔离实例启动 + workshop ready', healthy, `port=${port}`)
  if (!healthy) throw new Error('实例未就绪')
  // MES 模拟器健康
  let mesReady = false
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${MES_PORT}/health`, { signal: AbortSignal.timeout(1200) })
      if (r.ok) {
        mesReady = true
        break
      }
    }
    catch { /* 未就绪 */ }
    await sleep(300)
  }
  ok('G1b', 'MES 模拟器就绪', mesReady, `port=${MES_PORT}`)
  if (!mesReady) throw new Error('MES 模拟器未就绪')

  const email = `ma-${TAG}@awshop.local`
  const token = data(await api('POST', '/api/users/register', { name: `ma-admin-${TAG}`, email, password: 'MesAgent#2026' }))?.token
  ok('G1c', 'admin 注册/登录', Boolean(token))

  // ── G2 场景 ──
  const line = data(await api('POST', '/api/workshop/dcw/lines', { name: `MES集成线-${TAG}` }, token))?.line?.id
  const tpl = data(await api('POST', '/api/workshop/dcw/templates', { name: `MES参数-${TAG}`, ch: '膜厚', unit: 'um', min: 30, max: 40, decimals: 3 }, token))?.template?.key
  const ctrlNode = data(await api('POST', '/api/workshop/dcw', {
    templateRef: tpl, name: `控制节点-${TAG}`, driver: 'mock', lineId: line, stepLimit: 2,
    driverConfig: { key: `ma-${TAG}` },
  }, token))?.node?.id
  const product = data(await api('POST', '/api/workshop/dcw/products', { lineId: line, name: `MES产品-${TAG}` }, token))?.product?.id
  const recipe = data(await api('POST', '/api/workshop/dcw/recipes', {
    productId: product, name: `主配方-${TAG}`,
    params: [{ nodeId: ctrlNode, value: 35, min: 31, max: 39 }],
  }, token))?.recipe?.id
  const ch = data(await api('POST', '/api/workshop/channels', { name: `MES频道-${TAG}`, leadAgent: { name: `MESlead-${TAG}`, harness: 'omp' } }, token))
  const channelId = ch?.channelId
  const lead = ch?.leadAgentId
  const bindLine = await api('PUT', `/api/workshop/channels/${channelId}/line`, { lineId: line }, token)
  const bindRecipe = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: lead, nodeId: recipe, kind: 'recipe' }, token)
  const lineStart = await api('POST', `/api/workshop/dcw/lines/${line}/start`, { recipeId: recipe }, token)
  ok('G2', '建线/节点/产品/配方/频道/配方绑定/开跑',
    Boolean(line && tpl && ctrlNode && product && recipe && channelId && lead)
    && bindLine.status === 200 && bindRecipe.status === 200 && lineStart.status === 200,
    JSON.stringify({ line, ctrlNode, recipe, channelId, lead, bindLine: bindLine.status, bindRecipe: bindRecipe.status, lineStart: lineStart.status }))

  // MES 点位 + 仅用于授权可见性的 MES 配方(不启动)
  const mesNode = data(await api('POST', '/api/workshop/dcw', {
    templateRef: tpl, name: `MES膜厚-${TAG}`, driver: 'mes-rest', lineId: line, unit: 'um', min: 30, max: 40, decimals: 4,
    readIntervalMs: 60_000,
    driverConfig: {
      baseUrl: `http://127.0.0.1:${MES_PORT}`,
      allowPrivateHost: 'true',
      authType: 'header',
      authHeaderName: 'x-api-token',
      secretRef: 'E2E',
      desc: 'MES 膜厚断面(48 道)',
      semantics: '沿模头横向的膜厚分布',
      historyMap: JSON.stringify({
        path: '/api/v1/quality/thickness',
        query: {},
        response: {
          rowsPath: 'data.rows[*]',
          tsPath: 'ts',
          format: 'vector',
          valuesPath: 'profile',
          dictionaryPath: 'data.fields',
          nextCursorPath: 'data.nextCursor',
        },
        pageSize: 50,
        maxPages: 5,
      }),
    },
  }, token))?.node?.id
  const mesRecipe = data(await api('POST', '/api/workshop/dcw/recipes', {
    productId: product, name: `MES数据配方-${TAG}`,
    params: [{ nodeId: mesNode, value: 35, min: 30, max: 40 }],
  }, token))?.recipe?.id
  const bindMesRecipe = await api('POST', '/api/workshop/agent-tools/bindings', { agentId: lead, nodeId: mesRecipe, kind: 'recipe' }, token)
  ok('G2b', 'MES 点位与数据配方绑定', Boolean(mesNode && mesRecipe) && bindMesRecipe.status === 200, JSON.stringify({ mesNode, mesRecipe, status: bindMesRecipe.status }))

  // ── G3 当前配方目录 + 仅 line_id 下发(HITL) ──
  const cat = await invoke(lead, 'recipe_catalog', { line_id: line }, token)
  const catText = invText(cat)
  ok('G3a', 'Agent recipe_catalog 解析当前配方', !invErr(cat) && catText.includes(recipe) && catText.includes('当前执行中'), catText.slice(0, 260))
  const apply = await invokeApproved(lead, 'recipe_apply', { line_id: line, reason: `E2E 验证仅 line_id 解析当前配方下发 (${TAG})` }, token, 'recipe_apply(line_id)')
  ok('G3b', 'recipe_apply 仅 line_id + manual HITL 下发成功', !invErr(apply.r) && Boolean(apply.card) && /已整批下发|设备证实/.test(invText(apply.r)), invText(apply.r).slice(0, 320))

  // ── G4 从活动批次另存新配方(HITL) ──
  const copyName = `另存配方-${TAG}`
  const create = await invokeApproved(lead, 'recipe_create', {
    name: copyName,
    product_id: product,
    use_active_run: true,
    reason: `把当前活动批次冻结参数固化为新基线 (${TAG})`,
  }, token, 'recipe_create(use_active_run)')
  const createText = invText(create.r)
  const newRecipeId = createText.match(/id=(rc-[A-Za-z0-9]+)/)?.[1] ?? ''
  ok('G4a', 'recipe_create 从活动批次冻结参数另存新配方', !invErr(create.r) && Boolean(create.card) && Boolean(newRecipeId), createText.slice(0, 320))
  const cat2 = invText(await invoke(lead, 'recipe_catalog', { line_id: line, q: copyName }, token))
  ok('G4b', '新配方出现在 recipe_catalog(未自动绑定提示)', cat2.includes(copyName) && /尚未绑定|绑定/.test(createText), cat2.slice(0, 260))

  // ── G5 配方下发历史(Agent 工具) ──
  const logByRecipe = invText(await invoke(lead, 'recipe_log', { recipe_id: recipe, limit: 50 }, token))
  const logByProduct = invText(await invoke(lead, 'recipe_log', { product_id: product, limit: 50 }, token))
  ok('G5a', 'recipe_log 按 recipe_id 返回下发/开跑记录', /配方下发|开跑整批下发/.test(logByRecipe) && logByRecipe.includes(recipe), logByRecipe.slice(0, 320))
  ok('G5b', 'recipe_log 按 product_id 仍能看到 Agent 下发记录(审计 product_id 已补)', /配方下发/.test(logByProduct) && logByProduct.includes(product), logByProduct.slice(0, 320))
  const ops = data(await api('GET', `/api/workshop/ops-logs?scope=line&recipeId=${encodeURIComponent(recipe)}&limit=100`, undefined, token))
  const rows = ops?.logs ?? []
  ok('G5c', '产线日志 API(UI 下发历史同源)含下发与回执', rows.some(r => r.action === 'recipe.apply') && rows.some(r => r.action === 'recipe.dispatch.ack'), `rows=${rows.length}`)

  // ── G6 外部 API 推送 DAQ 数组/图像 ──
  const vecNode = data(await api('POST', '/api/workshop/daq', {
    templateRef: 'thickness-scan', name: `外部数组-${TAG}`, driver: 'mock', lineId: line, intervalMs: 60000, enabled: true,
  }, token))?.node?.id
  const imgNode = data(await api('POST', '/api/workshop/daq', {
    templateRef: 'ccd-image', name: `外部图像-${TAG}`, driver: 'mock', lineId: line, intervalMs: 60000, enabled: true,
  }, token))?.node?.id
  await api('POST', '/api/workshop/daq/controller', { action: 'start' }, token)
  await sleep(800)
  const nowIso = new Date().toISOString()
  const points = Array.from({ length: 8 }, (_, i) => Number((35.1 + i * 0.05).toFixed(3)))
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII='
  const pushVec = await fetch(`${BASE}/api/workshop/daq/${vecNode}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aw-daq-token': INGEST_TOKEN },
    body: JSON.stringify({ at: nowIso, points, metrics: { avg: 35.275, max: 35.45 } }),
  }).then(r => r.json().catch(() => ({})))
  const pushImg = await fetch(`${BASE}/api/workshop/daq/${imgNode}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aw-daq-token': INGEST_TOKEN },
    body: JSON.stringify({ at: nowIso, image: { base64: png, mime: 'image/png', width: 1, height: 1 }, metrics: { brightness: 128 } }),
  }).then(r => r.json().catch(() => ({})))
  ok('G6a', '外部 API 推送向量/图像被受理', pushVec?.data?.accepted === true && pushImg?.data?.accepted === true, JSON.stringify({ vec: pushVec?.data, img: pushImg?.data }).slice(0, 300))
  await sleep(1200)
  const fromMs = Date.parse(nowIso) - 5000
  const toMs = Date.parse(nowIso) + 5000
  const frames = data(await api('GET', `/api/workshop/daq/${vecNode}/frames?from=${fromMs}&to=${toMs}&limit=20`, undefined, token))?.frames ?? []
  const hit = frames.find(f => Array.isArray(f.points) && f.points.length === points.length && f.points.every((v, i) => Math.abs(v - points[i]) < 1e-9))
  ok('G6b', '数组样本落入 daq_frames 且点列完整', Boolean(hit), `frames=${frames.length}`)
  const agentFrames = invText(await invoke(lead, 'daq_frames', { node_id: vecNode, include_points: true, point_limit: 16, last_minutes: 5 }, token))
  ok('G6c', 'Agent daq_frames 在线读取数组(带模头点语义)', agentFrames.includes('35.1') && agentFrames.includes('模头点1') && agentFrames.includes('横向位置'), agentFrames.slice(0, 320))
  const exportRes = await invoke(lead, 'daq_export', { node_ids: [vecNode], last_minutes: 5 }, token)
  const exportText = invText(exportRes)
  const exportDir = exportText.match(/目录:\s*([^\n]+)/)?.[1]?.trim() ?? ''
  const daqManifest = exportDir && existsSync(join(exportDir, 'manifest.json')) ? JSON.parse(readFileSync(join(exportDir, 'manifest.json'), 'utf8')) : null
  const vecMeta = daqManifest?.nodes?.find(n => n.id === vecNode)
  ok('G6d', 'daq_export manifest/README 携带向量布局与逐点语义', Boolean(vecMeta?.vector?.axis) && existsSync(join(exportDir, 'README.md')) && readFileSync(join(exportDir, 'README.md'), 'utf8').includes('模头点'), exportText.slice(0, 280))
  const imgFrames = data(await api('GET', `/api/workshop/daq/${imgNode}/frames?from=${fromMs}&to=${toMs}&limit=20`, undefined, token))?.frames ?? []
  const imgHit = imgFrames.find(f => f.kind === 'image' && f.meta?.width === 1 && f.meta?.height === 1)
  ok('G6e', '图像帧元数据入库(像素对象存储引用)', Boolean(imgHit?.meta?.objectKey), JSON.stringify(imgFrames.slice(0, 1)).slice(0, 300))

  // ── G7 MES 字段字典 + 在线数组 + 导出目录 ──
  const mesFrom = new Date(Date.now() - 30 * 60_000).toISOString()
  const mesTo = new Date().toISOString()
  const mesFetch = invText(await invoke(lead, 'mes_fetch', { ids: [mesNode], from: mesFrom, to: mesTo, max_rows: 50, include_data: true }, token))
  ok('G7a', 'mes_fetch 返回字段字典(单位/物理意义/逐点)', mesFetch.includes('字段字典') && mesFetch.includes('膜厚') && mesFetch.includes('模头点1') && mesFetch.includes('um'), mesFetch.slice(0, 400))
  ok('G7b', 'mes_fetch include_data 返回实际数组采样', /values=\[/.test(mesFetch) && /模头点\d+=/.test(mesFetch), mesFetch.slice(0, 500))
  const mesExport = await invoke(lead, 'mes_export', {
    ids: [mesNode], from: mesFrom, to: mesTo, max_rows: 1000,
    folder: `line-${line}/${TAG}`, title: `MES导出-${TAG}`, note: '字段语义验收',
  }, token)
  const mesExportText = invText(mesExport)
  const mesDir = mesExportText.match(/目录:\s*([^\n]+)/)?.[1]?.trim() ?? ''
  const mesManifest = mesDir && existsSync(join(mesDir, 'manifest.json')) ? JSON.parse(readFileSync(join(mesDir, 'manifest.json'), 'utf8')) : null
  const mesFields = mesManifest?.nodes?.[0]?.fields ?? []
  ok('G7c', 'mes_export 落指定目录并生成 manifest/README', !invErr(mesExport) && Boolean(mesManifest) && existsSync(join(mesDir, 'README.md')), mesExportText.slice(0, 320))
  ok('G7d', 'MES manifest 字段字典含单位与逐点语义', mesFields[0]?.unit === 'um' && mesFields[0]?.points?.length === 48 && mesFields[0]?.points?.[0]?.label === '模头点1', JSON.stringify(mesFields[0]).slice(0, 320))
  // 导出目录结构: <dir>/<nodeId>/data.csv
  const mesCsv2 = mesDir ? readFileSync(join(mesDir, mesNode, 'data.csv'), 'utf8').split(/\r?\n/) : []
  ok('G7e', 'MES 向量宽表可离线读(v0..v47)', mesCsv2[0]?.startsWith('ts,v0,') === true && mesCsv2[1]?.split(',').length === 49, `${mesCsv2[0]?.slice(0, 80)}`)
  // 在线镜像:大 max_rows 走异步 CSV 数据集,Agent 可读回(manifest 路径/字典)
  const asyncFetch = await invoke(lead, 'mes_fetch', { ids: [mesNode], from: mesFrom, to: mesTo, max_rows: 3000 }, token)
  let datasetList = ''
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    datasetList = invText(await invoke(lead, 'mes_datasets', { limit: 10 }, token))
    if (/就绪\(/.test(datasetList)) break
  }
  ok('G7f', 'MES 异步数据集镜像完成(可读回)', /就绪\(/.test(datasetList) && /mesds-/.test(datasetList), `${invText(asyncFetch).slice(0, 160)} | ${datasetList.slice(0, 260)}`)
  const catalogAfter = invText(await invoke(lead, 'mes_catalog', { line_id: line, q: 'MES膜厚' }, token))
  ok('G7g', 'mes_catalog 复用响应字典显示字段标签/单位/点数', catalogAfter.includes('字段:') && catalogAfter.includes('膜厚') && catalogAfter.includes('48 点'), catalogAfter.slice(0, 320))

  // ── G8 配方管理 UI:下发历史按钮/弹窗(浏览器实测) ──
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  if (existsSync(chrome)) {
    const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    try {
      const page = await browser.newPage()
      await page.setViewport({ width: 1440, height: 1000 })
      await page.setCookie({ name: 'token', value: token, domain: '127.0.0.1', path: '/' })
      await page.goto(`${BASE}/dcw/${line}`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
      await page.waitForFunction(() => document.body.innerText.includes('下发历史'), { timeout: 60_000 })
      const clicked = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(x => String(x.textContent ?? '').includes('下发历史'))
        if (!btn) return false
        btn.click()
        return true
      })
      await sleep(1500)
      const bodyText = await page.evaluate(() => document.body.innerText)
      await page.screenshot({ path: join(ROOT, 'recipe-dispatch-history.png'), fullPage: true })
      ok('G8', '配方管理 UI 下发历史弹窗可见(与 API 同源)', clicked && bodyText.includes('配方下发历史') && /配方下发|下发回执|开跑整批下发/.test(bodyText), bodyText.slice(0, 320))
    }
    finally {
      await browser.close()
    }
  }
  else {
    ok('G8', '配方管理 UI 下发历史弹窗可见(与 API 同源)', false, `Chrome 不可用:${chrome}`)
  }
}
catch (err) {
  ok('FATAL', '脚本异常', false, err instanceof Error ? err.stack ?? err.message : String(err))
}
finally {
  try {
    child.kill()
  }
  catch { /* ignore */ }
  try {
    mesSim.kill()
  }
  catch { /* ignore */ }
  await sleep(800)
  const pass = results.filter(r => r.pass).length
  console.log(`\n===== ${pass}/${results.length} PASS =====`)
  for (const r of results.filter(x => !x.pass)) console.log(`FAIL [${r.id}] ${r.name} — ${r.detail}`)
  process.exit(pass === results.length ? 0 : 1)
}
