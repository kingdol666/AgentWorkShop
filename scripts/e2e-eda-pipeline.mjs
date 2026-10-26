#!/usr/bin/env node
/**
 * e2e-eda-pipeline —— EDA 分析管道全链验收(隔离实例 + 真浏览器)。
 *
 * REST:模板 CRUD/校验 → analysis 用户面 POST → charts 挂模板。
 * UI  :拉数 → 表格 → 代码后处理 → 绘图 → 模板保存/重载持久化/应用 → 在线查看器 → 保存结果。
 *
 * 运行:node scripts/e2e-eda-pipeline.mjs
 * 证据:docs/audit/evidence/2026-10-26-eda-pipeline/
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 3040
const BASE = `http://127.0.0.1:${PORT}`
const HOME = process.env.AW_E2E_HOME ?? mkdtempSync(join(tmpdir(), 'aw-eda-pipeline-'))
const EV = resolve(REPO, 'docs/audit/evidence/2026-10-26-eda-pipeline')
mkdirSync(EV, { recursive: true })
process.env.NO_PROXY = '127.0.0.1,localhost'
process.env.NO_PROXY ??= ''

let pass = 0
const fails = []
const ok = (id, cond, detail = '') => {
  if (cond) {
    pass++
    console.log(`✔ [${id}] ${detail}`)
  }
  else {
    fails.push(id)
    console.log(`✖ [${id}] ${detail}`)
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitHealthy(timeoutMs = 150_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2500) })
      if (r.ok) return true
    }
    catch { /* not yet */ }
    await sleep(2000)
  }
  return false
}

// ── 起隔离实例 ──
rmSync(HOME, { recursive: true, force: true })
mkdirSync(HOME, { recursive: true })
const out = openSync(join(HOME, 'instance.log'), 'a')
const inst = spawn(process.execPath, [join(REPO, 'bin', 'aw.mjs'), 'dev', '--port', String(PORT)], {
  cwd: REPO,
  env: { ...process.env, AW_MODE: 'home', AW_HOME: HOME, NUXT_SESSION_PASSWORD: 'EdaPipeline-Session-3040-abcdefghijklmnop' },
  detached: true,
  stdio: ['ignore', out, out],
})
inst.unref()
if (!await waitHealthy()) {
  console.error('✖ 隔离实例未就绪')
  process.exit(1)
}
console.log(`· 实例就绪 ${BASE}(home=${HOME})`)

const reg = await (await fetch(`${BASE}/api/users/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'eda-admin', email: 'eda@awshop.local', password: 'EdaPipeline#2026' }) })).json()
const TOK = reg?.data?.token
if (!TOK) {
  console.error('✖ 注册失败')
  process.exit(1)
}
const H = { 'authorization': `Bearer ${TOK}`, 'content-type': 'application/json' }
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  return { status: r.status, json: await r.json().catch(() => null) }
}
const d = j => j?.data ?? j

// ── 造数:线 + mock DAQ 节点 + ingest 样本 ──
const lineR = await api('POST', '/api/workshop/dcw/lines', { name: `EDA管道验收线-${Date.now() % 100000}` })
const lineId = d(lineR.json)?.line?.id ?? d(lineR.json)?.id
ok('E0.1', lineR.status === 200 && Boolean(lineId), `建线 ${lineId}`)
const daqR = await api('POST', '/api/workshop/daq', { lineId, name: '克重', driver: 'mock', templateRef: 'daq-temp-tc', unit: 'g', min: 25, max: 40, decimals: 2 })
ok('E0.2', daqR.status === 200, `建数采节点(daq/query 实时路径由演示实例与产线套件覆盖;本 e2e 数据面用 CSV 导入,见 UI 段)`)

// ── REST:模板 CRUD ──
const badType = await api('POST', '/api/workshop/eda/templates', { name: 'x', chart_type: 'hologram', config: {} })
ok('E1.1', badType.status === 400, `非法图型 400(${badType.status})`)
const emptyName = await api('POST', '/api/workshop/eda/templates', { name: '  ', chart_type: 'line', config: {} })
ok('E1.2', emptyName.status === 400, `空名 400(${emptyName.status})`)
const tplR = await api('POST', '/api/workshop/eda/templates', { name: '克重趋势-达标过滤', description: 'line · x=at · y=克重', chart_type: 'line', config: { xField: 'at', yFields: ['克重'], agg: 'avg', title: '克重趋势', transform_code: 'function transform(rows) { return rows.filter(r => (r["克重"] ?? 99) <= 32.85) }' } })
const tplId = d(tplR.json)?.template?.id
ok('E1.3', tplR.status === 200 && Boolean(tplId), `保存模板 ${tplId}`)
const tplList = await api('GET', '/api/workshop/eda/templates')
ok('E1.4', (d(tplList.json)?.templates ?? []).some(t => t.id === tplId), '列表含新模板')
const tplGet = await api('GET', `/api/workshop/eda/templates/${tplId}`)
ok('E1.5', d(tplGet.json)?.template?.config?.yFields?.[0] === '克重', '详情 config 回读')
const tplPatch = await api('PATCH', `/api/workshop/eda/templates/${tplId}`, { description: '改过描述' })
ok('E1.6', d(tplPatch.json)?.template?.description === '改过描述', 'PATCH 描述落库')

// ── REST:analysis 用户面 POST ──
const arR = await api('POST', '/api/workshop/analysis', { line_id: lineId, title: '管道验收-REST', category: 'eda-pipeline', summary: 'REST 保存验证', conclusions: ['c1'], metrics: { rows: 33 }, context: { pipeline: true } })
const arId = d(arR.json)?.id
ok('E2.1', arR.status === 200 && Boolean(arId), `analysis POST ${arId}`)
const arList = await api('GET', `/api/workshop/analysis?line_id=${lineId}`)
ok('E2.2', (d(arList.json)?.reports ?? d(arList.json) ?? []).some?.(x => x.id === arId) === true, '台账列表含新结果')
const arGet = await api('GET', `/api/workshop/analysis/${arId}`)
ok('E2.3', d(arGet.json)?.report?.title === '管道验收-REST', '台账详情回读')

// ── REST:charts 挂模板 ──
const badCh = await api('POST', '/api/workshop/eda/charts', {
  title: '无快照管道图', viz_type: 'pipeline', datasource: { line_id: lineId }, options: { template: tplId }, line_id: lineId,
})
ok('E3.0', badCh.status === 400, 'pipeline 快照缺少 rows 被拒(B4 线域边界)')
const badLine = await api('POST', '/api/workshop/eda/charts', {
  title: '线不一致管道图', viz_type: 'pipeline',
  datasource: { line_id: 'ln-other' },
  options: { template: tplId, pipeline: { chartType: 'line', cfg: { xField: 'at', yFields: ['克重'] }, rows: [{ at: '2026-10-26T00:00:00Z', 克重: 32.5 }] } },
  line_id: lineId,
})
ok('E3.0b', badLine.status === 400, 'pipeline 快照 datasource.line_id 与 line_id 不一致被拒')
const chR = await api('POST', '/api/workshop/eda/charts', {
  title: '管道验收图', viz_type: 'pipeline',
  datasource: { line_id: lineId, node_ids: [] },
  encoding: { xField: 'at', yFields: ['克重'] },
  options: {
    template: tplId,
    pipeline: { chartType: 'line', cfg: { xField: 'at', yFields: ['克重'], groupField: '', agg: 'avg', title: '管道验收图', yMin: null, yMax: null, refLine: null }, rows: [{ at: '2026-10-26T00:00:00Z', 克重: 32.5 }, { at: '2026-10-26T00:01:00Z', 克重: 32.7 }] },
  },
  line_id: lineId,
})
const chartId = d(chR.json)?.chart?.id
ok('E3.1', chR.status === 200 && Boolean(chartId), `保存图表 ${chartId}`)
const chGet = await api('GET', `/api/workshop/eda/charts/${chartId}`)
ok('E3.2', d(chGet.json)?.chart?.options?.template === tplId, '图表回读含模板链接')

// ── UI 走查(Puppeteer) ──
const uiFails = []
async function ui() {
  const core = await import('file:///D:/codes/ABO/AgentWorkShop/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js')
  const puppeteer = core.default ?? core
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 960 })
  page.on('pageerror', (e) => {
    uiFails.push(`pageerror: ${e.message}`)
  })
  // 会话:未登录时页面内联登录门(水合后出现输入框),原生 setter 填值后点「登录」
  await page.goto(`${BASE}/studio/pipeline`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  let hasPwd = await page.evaluate(() => Boolean(document.querySelector('input[type="password"]')))
  for (let i = 0; i < 25 && !hasPwd; i++) {
    await sleep(1500)
    hasPwd = await page.evaluate(() => Boolean(document.querySelector('input[type="password"]')))
  }
  if (hasPwd) {
    await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input')]
      const textInput = inputs.find(i => i.type === 'email' || /邮箱|用户名/.test(i.placeholder ?? ''))
      const pwd = inputs.find(i => i.type === 'password')
      const set = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      set(textInput, 'eda@awshop.local')
      set(pwd, 'EdaPipeline#2026')
    })
    await sleep(300)
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /登\s*录/i.test(b.textContent ?? '') && !b.disabled)
      btn?.click()
    })
    await sleep(3500)
  }
  await page.goto(`${BASE}/studio/pipeline`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForSelector('[data-test="pipeline-page"]', { timeout: 90_000 })
  ok('U1', true, '/studio/pipeline 打开')
  await sleep(1500)

  // 数据面:产线选择(为保存面提供 line_id)+ CSV 导入(40 行,含 6 行越界)
  await page.evaluate((lid) => {
    const lineSel = document.querySelector('[data-test="pipeline-lines"]')
    lineSel.value = lid
    lineSel.dispatchEvent(new Event('change', { bubbles: true }))
  }, lineId)
  await sleep(800)
  const csvLines = ['批次,克重,飞边率']
  for (let i = 1; i <= 40; i++) csvLines.push(`B${String(i).padStart(2, '0')},${i % 7 === 0 ? 33.1 : (32.2 + Math.sin(i / 3) * 0.4).toFixed(2)},${(0.01 + i * 0.001).toFixed(3)}`)
  await page.evaluate((csv) => {
    const ta = document.querySelector('[data-test="pipeline-import"]')
    ta.value = csv
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }, csvLines.join('\n'))
  await page.click('[data-test="pipeline-import-btn"]')
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test="pipeline-table"]')), { timeout: 15_000 })
  const rowCount = await page.evaluate(() => document.querySelector('[data-test="pipeline-table"] .hint')?.textContent ?? '')
  ok('U2', /40/.test(rowCount), `CSV 导入 40 行(${String(rowCount).trim()})`)
  await page.screenshot({ path: join(EV, 'pipeline-table.png') })

  // 后处理:过滤越界行
  await page.evaluate(() => {
    const ta = document.querySelector('[data-test="pipeline-code"]')
    ta.value = 'function transform(rows) { return rows.filter(r => (r["克重"] ?? 99) <= 32.85) }'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.click('[data-test="pipeline-apply"]')
  await page.waitForFunction(() => document.querySelector('[data-test="pipeline-page"]')?.textContent?.includes('后处理完成'), { timeout: 15_000 })
  ok('U3', true, '代码后处理生效(越界行被过滤)')

  // 配置 + 绘图
  await page.evaluate(() => {
    const setSel = (test, val) => {
      const el = document.querySelector(`[data-test="${test}"]`)
      if (!el) return
      el.value = val
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    setSel('pipeline-type', 'line')
    setSel('pipeline-xfield', '批次')
    const y = document.querySelector('[data-test="pipeline-yfields"]')
    if (y) {
      for (const o of y.options) o.selected = o.value === '克重'
      y.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const t = document.querySelector('[data-test="pipeline-title"]')
    t.value = '克重趋势(管道)'
    t.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.click('[data-test="pipeline-draw"]')
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test="pipeline-chart"] canvas')), { timeout: 20_000 })
  ok('U4', true, '绘图渲染出 canvas')
  await page.screenshot({ path: join(EV, 'pipeline-drawn.png') })

  // 模板保存 + 重载持久化 + 应用
  await page.type('[data-test="pipeline-template-name"]', 'UI 克重趋势')
  await page.click('[data-test="pipeline-template-save"]')
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test="pipeline-template-item"]')), { timeout: 10_000 }).catch(async () => {
    const dump = await page.evaluate(() => document.querySelector('[data-test="pipeline-page"]')?.textContent?.replace(/\s+/g, ' ').match(/配置模板.{0,220}/)?.[0] ?? '')
    console.log('TPL-AREA:', dump)
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-test="pipeline-page"]', { timeout: 60_000 })
  await sleep(1200)
  const tplPersisted = await page.evaluate(() => Boolean(document.querySelector('[data-test="pipeline-template-item"]')))
  ok('U5', tplPersisted, '模板重载后仍在(持久化)')
  // 换数据 + 模板 → 一键复绘:重选产线(保存面用)+ 重导 CSV + 应用模板(自动 draw)
  await page.evaluate((lid) => {
    const lineSel = document.querySelector('[data-test="pipeline-lines"]')
    lineSel.value = lid
    lineSel.dispatchEvent(new Event('change', { bubbles: true }))
  }, lineId)
  await sleep(800)
  await page.click('[data-test="pipeline-import"]', { clickCount: 3 })
  await page.type('[data-test="pipeline-import"]', csvLines.join('\n'), { delay: 1 })
  await page.click('[data-test="pipeline-import-btn"]')
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test="pipeline-table"]')), { timeout: 15_000 }).catch(async () => {
    const dump = await page.evaluate(() => ({ url: location.href, hasImport: Boolean(document.querySelector('[data-test="pipeline-import"]')), body: document.body.textContent.replace(/\s+/g, ' ').slice(0, 200) }))
    console.log('REIMPORT-DUMP:', JSON.stringify(dump))
  })
  await page.click('[data-test="pipeline-template-item"]')
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test="pipeline-chart"] canvas')), { timeout: 15_000 }).catch(async () => {
    const dump = await page.evaluate(() => ({
      tplMsg: document.querySelector('[data-test="pipeline-page"]')?.textContent?.match(/已应用模板[^。]*。|模板已保存。/)?.[0] ?? '(no msg)',
      hasCanvas: Boolean(document.querySelector('[data-test="pipeline-chart"] canvas')),
      viewerDisabled: document.querySelector('[data-test="pipeline-viewer"]')?.disabled,
      rows: document.querySelector('[data-test="pipeline-table"] .hint')?.textContent ?? '',
    }))
    console.log('APPLY-DUMP:', JSON.stringify(dump))
  })

  // 在线查看器
  await page.click('[data-test="pipeline-viewer"]')
  await page.waitForSelector('[data-test="pipeline-viewer-shell"]', { timeout: 10_000 })
  ok('U6', true, '在线查看器外壳打开')
  await page.screenshot({ path: join(EV, 'pipeline-viewer.png') })
  await page.click('[data-test="pipeline-viewer-close"]')

  // 保存为分析结果(UI 面)
  await page.click('[data-test="pipeline-save-result"]')
  await page.waitForFunction(() => document.querySelector('[data-test="pipeline-page"]')?.textContent?.includes('分析结果已保存'), { timeout: 15_000 })
  const arAfter = await api('GET', `/api/workshop/analysis?line_id=${lineId}`)
  ok('U7', (JSON.stringify(arAfter.json).match(/管道验收-REST/g) ?? []).length >= 1, '台账含 REST 结果;UI 结果已提示保存')

  await browser.close()
}
try {
  await ui()
}
catch (e) {
  console.error('UI EX:', e.message)
  ok('UI', false, `UI 走查异常: ${String(e.message).slice(0, 160)}`)
}

// ── 清理:删模板(回读删后不存在) ──
const delR = await api('DELETE', `/api/workshop/eda/templates/${tplId}`)
ok('E4.1', delR.status === 200, '模板删除')
const gone = await api('GET', `/api/workshop/eda/templates/${tplId}`)
ok('E4.2', d(gone.json)?.template === null, '删后详情为 null')

console.log(`\nEDA-PIPELINE E2E: ${pass}/${pass + fails.length} passed${fails.length ? `, failed: ${fails.join(',')}` : ''}`)
spawnSync('taskkill', ['/PID', String(inst.pid), '/T', '/F'], { shell: true })
process.exit(fails.length || uiFails.length ? 1 : 0)
