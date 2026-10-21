/**
 * data-studio Phase A 单测:redact 脱敏 / data-query 护栏与缓存 / E1 run 台账 repo。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 测试隔离:临时 AW_HOME(在 import 被测模块前设置,DB 路径在模块加载时解析)
process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-data-studio-test-'))

const { redactHeaders, redactQuery } = await import('../server/services/workshop/eda/redact')
const { dataQuery, dataQueryCacheClear, dataQueryConcurrencyReset } = await import('../server/services/workshop/eda/data-query')
const { mirrorRunCreated, mirrorRunClosed, edaRunById, listEdaRuns, setRunOutcome, setRunLabels, recentRunsByOutcome } = await import('../server/services/workshop/eda/eda-run.repo')

const admin = { id: 'u-test', name: 'tester', role: 'admin' }

describe('redact(凭据脱敏)', () => {
  it('headers:authorization/cookie/api-key 值替换为 ***,普通头原样保留', () => {
    const out = redactHeaders({ 'authorization': 'Bearer sk-real-secret', 'X-API-KEY': 'k123', 'Content-Type': 'application/json', 'Cookie': 'sid=1' })
    assert.equal(out.authorization, '***')
    assert.equal(out['X-API-KEY'], '***')
    assert.equal(out.Cookie, '***')
    assert.equal(out['Content-Type'], 'application/json')
  })
  it('query:token/secret 值脱敏,from/to 原样保留', () => {
    const out = redactQuery({ from: '2026-01-01', access_token: 'x', apiKey: 'y' })
    assert.equal(out.from, '2026-01-01')
    assert.equal(out.access_token, '***')
    assert.equal(out.apiKey, '***')
  })
})

describe('dataQuery 护栏', () => {
  const expectStatus = (status: number) => (e: unknown): boolean => (e as { status?: number }).status === status

  before(() => {
    dataQueryCacheClear()
    dataQueryConcurrencyReset()
  })

  it('line_id 与 node_ids 均缺省 → 400', async () => {
    await assert.rejects(() => dataQuery(admin, {}), expectStatus(400))
  })
  it('node_ids 超 8 个 → 400', async () => {
    await assert.rejects(
      () => dataQuery(admin, { nodeIds: Array.from({ length: 9 }, (_, i) => `dn-${i}`) }),
      (e: unknown) => expectStatus(400)(e) && /8/.test((e as Error).message),
    )
  })
  it('窗口超 7 天 → 400', async () => {
    await assert.rejects(
      () => dataQuery(admin, { lineId: 'ln-x', fromMs: Date.now(), toMs: Date.now() + 8 * 24 * 3600_000 }),
      (e: unknown) => expectStatus(400)(e) && /7/.test((e as Error).message),
    )
  })
  it('from >= to → 400', async () => {
    await assert.rejects(
      () => dataQuery(admin, { lineId: 'ln-x', fromMs: 1000, toMs: 1000 }),
      expectStatus(400),
    )
  })
  it('不可读产线(admin 角色例外,普通用户需授权;此处验证空节点集 → 400)→ 400', async () => {
    await assert.rejects(
      () => dataQuery(admin, { lineId: 'ln-never-exists', fromMs: Date.now() - 1000, toMs: Date.now() }),
      (e: unknown) => expectStatus(400)(e) || expectStatus(403)(e),
    )
  },
  )
})

describe('E1 run 台账', () => {
  it('开账镜像:幂等落行,outcome=open', () => {
    mirrorRunCreated({ id: 'rr-test1', lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1', recipeName: '配方A', startedAt: '2026-10-21T01:00:00.000Z', endedAt: null })
    mirrorRunCreated({ id: 'rr-test1', lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1', recipeName: '配方A', startedAt: '2026-10-21T01:00:00.000Z', endedAt: null })
    const r = edaRunById('rr-test1')
    assert.ok(r)
    assert.equal(r!.outcome, 'open')
    assert.equal(r!.endedAt, null)
  })
  it('关账镜像:回填 ended_at;重复关账不覆盖首值', async () => {
    mirrorRunClosed({ id: 'rr-test1', lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1', recipeName: '配方A', startedAt: '2026-10-21T01:00:00.000Z', endedAt: '2026-10-21T02:00:00.000Z' })
    await new Promise(r => setTimeout(r, 50))
    const r = edaRunById('rr-test1')
    assert.equal(r!.endedAt, '2026-10-21T02:00:00.000Z')
    mirrorRunClosed({ id: 'rr-test1', lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1', recipeName: '配方A', startedAt: '2026-10-21T01:00:00.000Z', endedAt: '2026-10-21T03:00:00.000Z' })
    assert.equal(edaRunById('rr-test1')!.endedAt, '2026-10-21T02:00:00.000Z')
  })
  it('关账先于开账镜像到达(动态 import 时序)→ UPSERT 兜底建行', () => {
    mirrorRunClosed({ id: 'rr-test2', lineId: 'ln-2', productId: 'pd-2', recipeId: 'rc-2', recipeName: '配方B', startedAt: '2026-10-21T01:00:00.000Z', endedAt: '2026-10-21T01:30:00.000Z' })
    assert.ok(edaRunById('rr-test2'))
  })
  it('清单过滤:line/outcome + outcome/labels 更新 + recentRunsByOutcome', () => {
    mirrorRunCreated({ id: 'rr-test3', lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1', recipeName: '配方A', startedAt: '2026-10-21T03:00:00.000Z', endedAt: null })
    setRunOutcome('rr-test3', 'bad')
    setRunLabels('rr-test3', { lot_id: 'LOT-9' })
    const bad = listEdaRuns({ lineId: 'ln-1', outcome: 'bad' })
    assert.equal(bad.runs.length, 1)
    assert.equal(bad.runs[0]!.labels.lot_id, 'LOT-9')
    mirrorRunClosed({ id: 'rr-test3', lineId: 'ln-1', productId: 'pd-1', recipeId: 'rc-1', recipeName: '配方A', startedAt: '2026-10-21T03:00:00.000Z', endedAt: '2026-10-21T03:30:00.000Z' })
    assert.ok(recentRunsByOutcome('rc-1', 'bad').some(r => r.id === 'rr-test3'))
    const byRecipe = listEdaRuns({ recipeId: 'rc-1' })
    assert.ok(byRecipe.total >= 2)
  })
})

after(() => {
  // 留给后续断言模块复用临时 home;不做清理(mkdtemp 随系统临时目录策略回收)
})
