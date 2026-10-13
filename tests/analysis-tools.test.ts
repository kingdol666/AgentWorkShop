/**
 * 数据分析系统单测(不联网):
 *   - 表由 SCHEMA_SQL 启动建出(analysis_reports + 两索引)
 *   - repo:insert/get 回读(结论/指标/上下文 JSON roundtrip)、过滤(lineIds 范围/
 *     lineId/recipeId/category/q LIKE/from/to)、remove/count、坏 JSON 容错
 *   - 工具(analysis_save / analysis_query):缺参拒绝、无绑线拒绝、越界产线拒绝、
 *     不存在配方拒绝;绑线端到端 save→query 回读全文与列表;归因快照断言
 *     (actor/channel_name/line_name 快照);时间窗归一
 *
 * 环境策略同 tool-profile-observer:AW_MODE=home + AW_HOME 临时目录(JSON 仓储写临时根),
 * manager 用最小 stub(channelLineBindingOf + channels.findById)—— 工具模块经 globalThis
 * 直读(与 channelBoundLineId 同模式),不依赖完整装配。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
const awHome = mkdtempSync(join(tmpdir(), 'aw-analysis-test-'))
process.env.AW_HOME = awHome
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { configureAnalysisRepo, getAnalysisRepo } = await import('../server/services/workshop/analysis/analysis.repo')
const { toolAnalysisSave, toolAnalysisQuery } = await import('../server/services/workshop/agents/industrial/analysis-tools')
const { getDcwLineRepo } = await import('../server/services/workshop/dcw/dcw-line.repo')

const db = openWorkshopDb(join(awHome, 'data', 'analysis-test.sqlite'))
configureAnalysisRepo(db)

const AGENT = 'agent-test-1'
const lineA = getDcwLineRepo().create({ name: '测试线A' })
const lineB = getDcwLineRepo().create({ name: '测试线B' })

/** 最小 manager stub:A 绑定「测试线A」;频道名固定 */
const g = globalThis as typeof globalThis & { __workshopManager?: unknown }
g.__workshopManager = {
  channelLineBindingOf: (id: string) => (id === AGENT ? lineA.id : null),
  deps: { repos: { channels: { findById: (_: string) => ({ name: '质检频道' }) } } },
}

test('repo:insert/get 全字段回读与 JSON roundtrip', () => {
  const repo = getAnalysisRepo()
  repo.insert({
    id: 'ar-roundtrip1', lineId: lineA.id, lineName: '测试线A', title: '膜厚漂移分析', category: 'quality',
    summary: '膜厚持续上漂,根因为加热环老化', conclusions: ['结论一', '结论二'],
    report: '# 正文\n详细过程', metrics: { cpk: 1.32 },
    recipeId: 'rcp-x', recipeVersion: '3', windowFrom: '2026-10-13T00:00:00.000Z', windowTo: '2026-10-13T08:00:00.000Z',
    dataSources: 'daq 窗口 + mes 批次', context: { controlMode: 'manual', activeRun: null },
    channelId: 'ch-1', channelName: '质检频道', actor: AGENT, actorName: AGENT, createdAt: '2026-10-13T09:00:00.000Z',
  })
  const r = repo.get('ar-roundtrip1')
  assert.ok(r)
  assert.equal(r.title, '膜厚漂移分析')
  assert.deepEqual(r.conclusions, ['结论一', '结论二'])
  assert.deepEqual(r.metrics, { cpk: 1.32 })
  assert.deepEqual(r.context, { controlMode: 'manual', activeRun: null })
  assert.equal(r.recipeVersion, '3')
  assert.equal(r.windowFrom, '2026-10-13T00:00:00.000Z')
  assert.equal(r.lineName, '测试线A')
  assert.equal(repo.get('ar-nope'), undefined)
})

test('repo:过滤面(lineIds 范围/配方/类别/关键词/时间窗/limit 封顶)与 remove/count', () => {
  const repo = getAnalysisRepo()
  repo.insert({
    id: 'ar-f1', lineId: lineA.id, lineName: '测试线A', title: 'OEE 晨会报告', category: 'oee', summary: 'OEE 上升 3pt',
    conclusions: [], report: '', metrics: {}, recipeId: 'rcp-y', recipeVersion: '', windowFrom: null, windowTo: null,
    dataSources: '', context: {}, channelId: '', channelName: '', actor: AGENT, actorName: '', createdAt: '2026-10-13T10:00:00.000Z',
  })
  repo.insert({
    id: 'ar-f2', lineId: lineB.id, lineName: '测试线B', title: 'B 线趋势', category: 'trend', summary: '温度缓升',
    conclusions: [], report: '', metrics: {}, recipeId: '', recipeVersion: '', windowFrom: null, windowTo: null,
    dataSources: '', context: {}, channelId: '', channelName: '', actor: AGENT, actorName: '', createdAt: '2026-10-13T11:00:00.000Z',
  })

  // lineIds 范围 = 作用域查询
  assert.equal(repo.list({ lineIds: [lineA.id] }).every(r => r.lineId === lineA.id), true)
  assert.equal(repo.list({ lineIds: [lineA.id, lineB.id] }).length >= 2, true)
  // 单线/配方/类别
  assert.equal(repo.list({ lineId: lineB.id })[0]?.id, 'ar-f2')
  assert.equal(repo.list({ recipeId: 'rcp-y' })[0]?.id, 'ar-f1')
  assert.equal(repo.list({ category: 'trend' })[0]?.id, 'ar-f2')
  // 关键词命中标题与结论列(LIKE)
  assert.equal(repo.list({ q: 'OEE' })[0]?.id, 'ar-f1')
  assert.equal(repo.list({ q: '缓升' })[0]?.id, 'ar-f2')
  // 时间窗(created_at ISO 比较)
  assert.equal(repo.list({ from: '2026-10-13T10:30:00.000Z' }).some(r => r.id === 'ar-f1'), false)
  assert.equal(repo.list({ from: '2026-10-13T10:30:00.000Z' }).some(r => r.id === 'ar-f2'), true)
  // 新→旧 + limit
  const desc = repo.list({})
  assert.ok(desc[0]!.createdAt >= desc[desc.length - 1]!.createdAt)
  assert.equal(repo.list({ limit: 1 }).length, 1)
  assert.equal(repo.list({ limit: 9999 }).length, repo.list({ limit: 500 }).length)

  assert.equal(repo.remove('ar-f2'), true)
  assert.equal(repo.remove('ar-f2'), false)
  assert.ok(repo.count() >= 1)
})

test('repo:坏 JSON 列容错(解析失败回退 []/{})', () => {
  db.prepare(
    `INSERT INTO analysis_reports (id, line_id, line_name, title, category, summary, conclusions_json,
       report, metrics_json, recipe_id, recipe_version, data_sources, context_json,
       channel_id, channel_name, actor, actor_name, created_at)
     VALUES ('ar-bad', '', '', '坏JSON', 'general', '', '{bad json', '', '{also bad', '', '', '', '{ctx', '', '', '', '', '2026-10-13T00:00:00.000Z')`,
  ).run()
  const r = getAnalysisRepo().get('ar-bad')
  assert.ok(r)
  assert.deepEqual(r.conclusions, [])
  assert.deepEqual(r.metrics, {})
  getAnalysisRepo().remove('ar-bad')
})

test('analysis_save:缺参拒绝(title/summary 必填)', async () => {
  const noTitle = await toolAnalysisSave(AGENT, { summary: 'x' })
  assert.equal(noTitle.isError, true)
  const noSummary = await toolAnalysisSave(AGENT, { title: 't' })
  assert.equal(noSummary.isError, true)
})

test('analysis_save:无绑线且未指定 line_id → 拒绝', async () => {
  const res = await toolAnalysisSave('agent-no-binding', { title: 't', summary: 's' })
  assert.equal(res.isError, true)
  assert.match(res.text, /无法确定目标产线/)
})

test('analysis_save:越界产线(存在但不可见)→ 拒绝', async () => {
  const res = await toolAnalysisSave(AGENT, { title: 't', summary: 's', line_id: lineB.id })
  assert.equal(res.isError, true)
  assert.match(res.text, /不在你的可见范围/)
})

test('analysis_save:不存在的配方 → 拒绝', async () => {
  const res = await toolAnalysisSave(AGENT, { title: 't', summary: 's', recipe_id: 'rcp-nope' })
  assert.equal(res.isError, true)
  assert.match(res.text, /不存在/)
})

test('analysis_save→analysis_query:绑线端到端留痕与回读(归因快照断言)', async () => {
  const save = await toolAnalysisSave(
    AGENT,
    {
      title: '端到端根因分析',
      summary: '压辊压力漂移是主因',
      conclusions: ['压力传感器读数漂移 4%', '建议校准并复测'],
      report: '## 过程\n取 24h 窗口分析…',
      category: 'quality',
      window_from: 1760000000000,
      data_sources: 'daq_query 24h 窗',
      metrics: { drift: 0.04 },
    },
    'ch-e2e',
  )
  assert.equal(save.isError, undefined)
  const id = save.text.match(/ar-[0-9a-f]{8}/)?.[0]
  assert.ok(id, 'save 返回文本应含报告 id(ar-xxxxxxxx 格式)')

  const row = getAnalysisRepo().get(id!)
  assert.ok(row)
  assert.equal(row.lineId, lineA.id)
  assert.equal(row.lineName, '测试线A')
  assert.equal(row.channelName, '质检频道')
  assert.equal(row.channelId, 'ch-e2e')
  assert.equal(row.actor, AGENT)
  assert.deepEqual(row.conclusions, ['压力传感器读数漂移 4%', '建议校准并复测'])
  assert.equal(row.windowFrom, new Date(1760000000000).toISOString())
  assert.equal(row.category, 'quality')

  // 精确回读全文
  const full = await toolAnalysisQuery(AGENT, { report_id: id })
  assert.equal(full.isError, undefined)
  assert.match(full.text, /端到端根因分析/)
  assert.match(full.text, /压辊压力漂移是主因/)
  assert.match(full.text, /建议校准并复测/)
  assert.match(full.text, /取 24h 窗口分析/)

  // 不存在的 id
  const missing = await toolAnalysisQuery(AGENT, { report_id: 'ar-missing' })
  assert.equal(missing.isError, true)

  // 列表(默认全可见线)含该报告
  const list = await toolAnalysisQuery(AGENT, { limit: 50 })
  assert.match(list.text, /端到端根因分析/)

  // 关键词与类别过滤
  assert.match((await toolAnalysisQuery(AGENT, { q: '压辊' })).text, /端到端根因分析/)
  const other = await toolAnalysisQuery(AGENT, { category: 'oee', q: '压辊' })
  assert.match(other.text, /暂无匹配的分析报告/)

  // 越界线查询拒绝
  const cross = await toolAnalysisQuery(AGENT, { line_id: lineB.id })
  assert.equal(cross.isError, true)
  assert.match(cross.text, /不在你的可见范围/)
})

test('注册面:host-tools.json 注入面已收录(轻量 catalog;分发表源码行冒烟)', async () => {
  // 注入面:catalog 装配(host-tools.json 经 loader 加载)含两工具 —— Channel 可见
  const { HOST_TOOLS } = await import('../server/services/workshop/agents/host-tool-bridge/catalog')
  const names = new Set(HOST_TOOLS.map(t => t.name))
  assert.equal(names.has('analysis_save'), true)
  assert.equal(names.has('analysis_query'), true)
  // 分发表:INDUSTRIAL_HANDLERS 的重闭包在本测试环境不可加载(存量 #imports 链,见
  // tool-profile-observer 同款失败),以源码行冒烟兜底「有定义必有处理器」
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../server/services/workshop/agents/host-tool-bridge/tools/industrial.ts', import.meta.url), 'utf8')
  assert.match(src, /\['analysis_save'/)
  assert.match(src, /\['analysis_query'/)
})

test.after?.(() => {
  try {
    rmSync(awHome, { recursive: true, force: true })
  }
  catch { /* Windows 句柄延迟,留给系统清理 */ }
})
