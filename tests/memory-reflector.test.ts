/**
 * RSI 经验反射器（WP-A2）：确定性蒸馏 / 证据锚点 / 作用域与状态 / 采集器只读聚合。
 * 纯内存 DB；验证「经验进库看 verdict，不看自述」与「学习环失败不影响主链路」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-rsi-reflect-'))
delete process.env.AW_BENCH_MODE

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { distillExperience, distillTaskFact, distillReviewFact, distillInterventionFact, reflectExperience } = await import('../server/services/workshop/runtime/memory/reflector')
const { collectTaskFact, collectReviewFact, collectInterventionFact, listUnreflectedInterventions } = await import('../server/services/workshop/runtime/memory/reflect-collector')

function fixture() {
  const db = openWorkshopDb(':memory:')
  // 单测只验证读取路径：关外键以便构造最小 fact 行（生产库外键恒开）
  db.exec('PRAGMA foreign_keys = OFF')
  const repo = createMemoryRepo(db)
  return { db, repo }
}

/** 存储文本是 CJK 切分副本；断言前去掉切分空白 */
function plain(s: string): string {
  return s.replace(/\s+/g, '')
}

const now = new Date().toISOString()

test('任务蒸馏：完成+判据通过 → positive/active/channel；证据含 taskId', async () => {
  const { db, repo } = fixture()
  try {
    const r = await reflectExperience(repo, null, {
      source: 'task',
      channelId: 'ch-1',
      agentId: 'agent-a',
      taskId: 't-1',
      title: '整定均热段',
      state: 'COMPLETED',
      deliverable: '温差收窄到 ±3℃，IAE 下降 12%',
      criteria: { ok: true, checks: [{ id: 'deliverable.present', ok: true }] },
    })
    assert.equal(r.written, true)
    const row = repo.getById(r.id!)!
    assert.equal(row.kind, 'experience')
    assert.equal(row.outcome, 'positive')
    assert.equal(row.status, 'active')
    assert.equal(row.scopeKind, 'channel')
    assert.equal(row.dedupKey, 'exp:task:t-1')
    assert.deepEqual(JSON.parse(row.evidenceJson!).taskIds, ['t-1'])
    assert.match(row.title, /完成：整定均热段/)
  }
  finally {
    db.close()
  }
})

test('任务蒸馏：判据失败 → negative 且内容列出失败项；失败分类入库', () => {
  const d = distillTaskFact({
    source: 'task',
    channelId: 'ch-1',
    agentId: 'agent-a',
    taskId: 't-2',
    title: '配方下发',
    state: 'COMPLETED',
    deliverable: '已下发',
    criteria: { ok: false, checks: [{ id: 'metric.within', ok: false }, { id: 'artifact.present', ok: true }] },
    failureClass: 'CONTENT',
  })!
  assert.equal(d.outcome, 'negative')
  assert.match(plain(d.content), /判据未通过/)
  assert.match(plain(d.content), /metric\.within/)
  assert.match(plain(d.content), /失败分类CONTENT/)
  assert.doesNotMatch(plain(d.content), /artifact\.present/, '只列失败项')
})

test('任务蒸馏：无交付物且无判据 → 不产经验（宁缺毋滥）', () => {
  const d = distillTaskFact({
    source: 'task', channelId: 'ch-1', agentId: 'agent-a', taskId: 't-3', title: '空任务', state: 'COMPLETED',
  })
  assert.equal(d, null)
})

test('任务蒸馏：无 verdict 背书 → [anecdotal] + unknown（自述不算证据）', () => {
  const d = distillTaskFact({
    source: 'task', channelId: 'ch-1', agentId: 'agent-a', taskId: 't-4', title: '感受', state: 'COMPLETED', deliverable: '我觉得这样更好',
  })!
  assert.equal(d.outcome, 'positive', '完成态本身是事实性结果(positive)')
  assert.match(d.content, /^\[anecdotal\]/, '无判定背书的因果断言必须显式标记')
})

test('任务蒸馏：同频道有 identifiable_effect 判定 → 去掉 anecdotal 且证据带干预锚点', () => {
  const d = distillTaskFact({
    source: 'task', channelId: 'ch-1', agentId: 'agent-a', taskId: 't-5', title: '优化', state: 'COMPLETED',
    deliverable: '末温达标', intervention: { eventId: 'ie-1', verdict: 'identifiable_effect', effect: 0.42, recipeRunId: 'run-9' },
  })!
  assert.equal(d.outcome, 'positive')
  assert.doesNotMatch(d.content, /\[anecdotal\]/)
  assert.equal(d.evidence.interventionEventId, 'ie-1')
  assert.equal(d.evidence.recipeRunId, 'run-9')
  assert.equal(d.evidence.metrics?.effect, 0.42)
})

test('任务蒸馏：line 绑定 → scopeKind=line + candidate（ADR-7 先验证再晋级）', () => {
  const d = distillTaskFact({
    source: 'task', channelId: 'ch-1', agentId: 'agent-a', taskId: 't-6', title: '产线经验', state: 'COMPLETED',
    deliverable: '某参数最优', lineId: 'line-9',
  })!
  assert.equal(d.scopeKind, 'line')
  assert.equal(d.scopeKey, 'line-9')
  assert.equal(d.status, 'candidate')
})

test('评审蒸馏：通过/驳回 → positive/negative + 作用域映射（product:<id>）', () => {
  const ok = distillReviewFact({
    source: 'review', channelId: 'ch-1', agentId: 'a', resultId: 'r-1', verdict: 'approved', title: '调参报告',
    summary: 'IAE 改善显著', validityScope: { kind: 'product', key: 'prod-7' },
  })
  assert.equal(ok.outcome, 'positive')
  assert.equal(ok.scopeKind, 'product')
  assert.equal(ok.scopeKey, 'prod-7')
  assert.equal(ok.status, 'candidate')
  assert.equal(ok.dedupKey, 'exp:review:r-1:approved')
  assert.equal(ok.evidence.resultId, 'r-1')

  const bad = distillReviewFact({
    source: 'review', channelId: 'ch-1', agentId: 'a', resultId: 'r-1', verdict: 'rejected', title: '调参报告', summary: '证据不足',
  })
  assert.equal(bad.outcome, 'negative')
  assert.equal(bad.scopeKind, 'channel')
  assert.equal(bad.status, 'active')
  assert.equal(bad.dedupKey, 'exp:review:r-1:rejected', '不同结论各自成行，负面信号不被覆盖')
})

test('干预蒸馏：identifiable_effect → positive/line/candidate，内容含数值与 CI', () => {
  const d = distillInterventionFact({
    source: 'intervention', channelId: 'ch-1', agentId: 'system:ledger', eventId: 'ie-2',
    verdict: 'identifiable_effect', nodeName: '均热段温度', fromValue: 220, toValue: 218.5,
    actualValue: 218.52, ack: 'readback-verified', recipeRunId: 'run-1',
    effect: -1.48, ciLow: -2.1, ciHigh: -0.8, mde: 0.6,
    criterion: { metric: 'iae', op: '<', threshold: 12 },
    lineId: 'line-1',
  })!
  assert.equal(d.outcome, 'positive')
  assert.equal(d.scopeKind, 'line')
  assert.equal(d.status, 'candidate')
  assert.match(d.content, /220→218\.5/)
  assert.match(d.content, /readback-verified/)
  assert.match(d.content, /iae<12/)
  assert.match(d.content, /CI\[-2\.1, -0\.8\]/)
  assert.equal(d.evidence.interventionEventId, 'ie-2')
  assert.equal(d.evidence.metrics?.effect, -1.48)
})

test('干预蒸馏：no_resolvable_effect → negative；underpowered/confounded → unknown；unassessed 不产经验', () => {
  const base = { source: 'intervention' as const, channelId: 'ch-1', agentId: 'x', eventId: 'ie-3', nodeName: 'n' }
  assert.equal(distillInterventionFact({ ...base, verdict: 'no_resolvable_effect' })!.outcome, 'negative')
  assert.equal(distillInterventionFact({ ...base, verdict: 'underpowered' })!.outcome, 'unknown')
  assert.equal(distillInterventionFact({ ...base, verdict: 'confounded' })!.outcome, 'unknown')
  assert.equal(distillInterventionFact({ ...base, verdict: 'unassessed' }), null, '无判定上下文 ≠ 可学习经验')
})

test('统一蒸馏入口：未知 source 防御性返回 null', () => {
  assert.equal(distillExperience({ source: 'nope' } as never), null)
})

test('反射失败不影响调用方：非法证据（无锚点）→ written=false 且不落行', async () => {
  const { db, repo } = fixture()
  try {
    // 构造一个证据锚点为空的蒸馏物：评审 fact 恒有 resultId，这里用 task 但 taskId 为空串
    const r = await reflectExperience(repo, null, {
      source: 'task', channelId: 'ch-1', agentId: 'a', taskId: '', title: 'x', state: 'COMPLETED', deliverable: 'y',
    })
    assert.equal(r.written, false)
    assert.match(String(r.reason), /no anchor/)
    assert.equal(repo.listByAgentChannel('ch-1', 'a', 10).length, 0)
  }
  finally {
    db.close()
  }
})

test('采集器：任务事实含判据/失败分类/产线锚点（只读聚合）', async () => {
  const { db, repo } = fixture()
  try {
    db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, created_at, updated_at)
      VALUES ('ch-1','C','','','','{}',1,1,'line-5',?,?)`).run(now, now)
    db.prepare(`INSERT INTO tasks (id, channel_id, title, description, state, assignee_id, artifacts_json, created_at, updated_at)
      VALUES ('t-9','ch-1','整定','描述','COMPLETED','agent-a',?,?,?)`).run(JSON.stringify([
      { name: 'deliverable', parts: [{ text: '温差 ±2℃' }] },
    ]), now, now)
    db.prepare(`INSERT INTO project_results (id, project_id, deliverable_id, channel_id, line_id, work_item_id, attempt_no, version,
      title, summary, status, source_task_id, criteria_check_json, created_at)
      VALUES ('r-9','p-1','d-1','ch-1','line-5','w-1',1,1,'整定成果','ok','draft','t-9',?,?)`)
      .run(JSON.stringify({ ok: false, checks: [{ id: 'metric.within', ok: false }] }), now)
    db.prepare(`INSERT INTO project_work_item_attempts (id, project_id, work_item_id, attempt_no, channel_id, channel_task_id, source_key, state, failure_class, created_at)
      VALUES ('a-1','p-1','w-1',1,'ch-1','t-9','k',  'CLOSED','CONTENT',?)`).run(now)

    const fact = collectTaskFact(db, { channelId: 'ch-1', taskId: 't-9', agentId: 'agent-a' })!
    assert.equal(fact.deliverable, '温差 ±2℃')
    assert.equal(fact.criteria?.ok, false)
    assert.equal(fact.failureClass, 'CONTENT')
    assert.equal(fact.lineId, 'line-5')

    // 端到端：采集 → 蒸馏 → 落库，内容反映判据失败
    const r = await reflectExperience(repo, null, fact)
    assert.equal(r.written, true)
    assert.match(plain(repo.getById(r.id!)!.content), /判据未通过/)
  }
  finally {
    db.close()
  }
})

test('故障注入：仓储写入抛错 → 反射返回 written=false 且不向调用方抛出', async () => {
  const brokenRepo = {
    upsertExperience: () => {
      throw new Error('db down')
    },
  } as never
  const r = await reflectExperience(brokenRepo, null, {
    source: 'task', channelId: 'ch-1', agentId: 'a', taskId: 't-fault', title: '故障', state: 'COMPLETED', deliverable: '值',
  })
  assert.equal(r.written, false)
  assert.match(String(r.reason), /db down/)
})

test('采集器：评审事实按 validity_scope 解析 line/product；干预补扫幂等', () => {
  const { db } = fixture()
  try {
    db.prepare(`INSERT INTO project_results (id, project_id, deliverable_id, channel_id, line_id, work_item_id, attempt_no, version,
      title, summary, status, source_task_id, validity_scope, trace_id, author_agent_id, created_at)
      VALUES ('r-8','p-1','d-1','ch-2','','w-1',1,1,'报告','摘要','approved','t-8','line:line-3','tr-1','agent-z',?)`).run(now)
    const fact = collectReviewFact(db, { resultId: 'r-8', verdict: 'approved' })!
    assert.deepEqual(fact.validityScope, { kind: 'line', key: 'line-3' })
    assert.equal(fact.agentId, 'agent-z')
    assert.equal(fact.traceId, 'tr-1')

    db.prepare(`INSERT INTO intervention_events (id, ts, line_id, node_id, node_name, ack, path, channel_id, verdict, created_at, updated_at)
      VALUES ('ie-9', ?, 'line-1','n-1','节点','readback-verified','agent','ch-1','identifiable_effect',?,?)`).run(now, now, now)
    const ids = listUnreflectedInterventions(db, { sinceIso: new Date(Date.now() - 3600_000).toISOString() })
    assert.deepEqual(ids, ['ie-9'])
    const factI = collectInterventionFact(db, 'ie-9')!
    assert.equal(factI.verdict, 'identifiable_effect')
    assert.equal(factI.lineId, 'line-1')
  }
  finally {
    db.close()
  }
})
