/**
 * exp-collector 纯逻辑单测(不启服务、不触真实配置根数据):
 *   - 锚水位过滤(at 水位 + seenAnchorIds 双剔重;重复 collect 幂等 = 第二轮零新增)
 *   - episode 聚合(recipeRunId 归并 / 无 runId 按 nodeId+±60s 簇归并 / 来源归因)
 *   - listAnchorsSince 纯过滤(lineId + sinceMs 边界 + limit)
 *   - 快照 diff(首轮只建快照 / SET 变化无锚 → 候选确认 / 有锚 → 不推断)
 *   - SP 语义位冷启动推断(模板 key 含 '-sp')
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateAnchorsToEpisodes, CLUSTER_MS, diffSnapshot, inferSemantic, unseenAnchorsSince } from '../server/services/workshop/exp/exp-collector'
import { anchorsSince } from '../server/services/workshop/dcw/recipe-rollback.repo'
import type { DcwJournalAnchor } from '../shared/dcw-protocol'

const T0 = Date.UTC(2026, 9, 1, 8, 0, 0)

/** 锚夹具(缺省:ln-x / n1 / manual / 100→120) */
const anc = (id: string, atMs: number, over: Partial<DcwJournalAnchor> = {}): DcwJournalAnchor => ({
  id,
  lineId: 'ln-x',
  nodeId: 'n1',
  prevValue: 100,
  newValue: 120,
  source: 'manual',
  actor: 'u1',
  at: new Date(atMs).toISOString(),
  ...over,
})

const iso = (ms: number): string => new Date(ms).toISOString()

// ---------- listAnchorsSince 纯过滤 ----------

test('anchorsSince: lineId + sinceMs 过滤(含边界),保持时间正序,limit 短路', () => {
  const all = [
    anc('a1', T0 - 10_000, { lineId: 'ln-other' }),
    anc('a2', T0 - 5_000),
    anc('a3', T0), // 恰在边界:含等号保留(同 ms 锚不漏,由 seenAnchorIds 剔重)
    anc('a4', T0 + 5_000, { lineId: 'ln-other' }),
    anc('a5', T0 + 10_000),
  ]
  const got = anchorsSince(all, 'ln-x', T0)
  assert.deepEqual(got.map(a => a.id), ['a3', 'a5'])
  // limit 提前短路(正序取最先命中的)
  assert.deepEqual(anchorsSince(all, 'ln-x', T0, 1).map(a => a.id), ['a3'])
  assert.equal(anchorsSince(all, 'ln-none', 0).length, 0)
})

// ---------- 水位剔重 / 重复 collect 幂等 ----------

test('unseenAnchorsSince: at 水位 + 已见 id 双剔重;推进水位后第二轮零新增(幂等)', () => {
  const all = [
    anc('a1', T0),
    anc('a2', T0 + 1_000),
    anc('a3', T0 + 2_000),
  ]
  const wm0 = { lastAnchorAt: 0, seenAnchorIds: [], lastAuditId: 0 }
  const first = unseenAnchorsSince(all, wm0)
  assert.equal(first.length, 3)

  // 第一轮消费后的水位(max at + 全部已见 id)
  const wm1 = {
    lastAnchorAt: Math.max(...first.map(a => Date.parse(a.at))),
    seenAnchorIds: first.map(a => a.id),
    lastAuditId: 0,
  }
  // 模拟锚账本里仍能读到全部历史锚(cap 滚动/UUID 非单调)→ 水位双字段保证不重采
  assert.equal(unseenAnchorsSince(all, wm1).length, 0)

  // 同 ms 新锚(id 未见过):at 水位放行,靠已见 id 精剔不会误伤新锚
  const all2 = [...all, anc('a4', T0 + 2_000)]
  assert.deepEqual(unseenAnchorsSince(all2, wm1).map(a => a.id), ['a4'])
  // 已见 id 但水位之前的不重复;水位回退(时钟偏移)场景下已见 id 兜底
  assert.equal(unseenAnchorsSince(all, { lastAnchorAt: 0, seenAnchorIds: ['a1'], lastAuditId: 0 }).length, 2)
})

// ---------- episode 聚合 ----------

test('aggregate: 同 recipeRunId 归一个 episode(跨节点/跨时刻),params 全量在册', () => {
  const drafts = aggregateAnchorsToEpisodes('ln-x', [
    anc('a1', T0, { nodeId: 'n1', recipeRunId: 'run-1' }),
    anc('a2', T0 + 30_000, { nodeId: 'n2', recipeRunId: 'run-1', prevValue: 5, newValue: 8, source: 'recipe' }),
    anc('a3', T0 + 90_000, { nodeId: 'n3', recipeRunId: 'run-1' }),
  ])
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0]!.nodeIds.join(','), 'n1,n2,n3')
  assert.equal(drafts[0]!.params.length, 3)
  assert.equal(drafts[0]!.anchors.join(','), 'a1,a2,a3')
  // 簇首时间 = 最早锚;untilAt 只用于归因窗,不进持久化字段之外的必填面
  assert.equal(drafts[0]!.at, iso(T0))
  assert.equal(drafts[0]!.untilAt, iso(T0 + 90_000))
})

test('aggregate: 无 runId 按 nodeId + ±60s 簇归并(超窗/换节点即新 episode)', () => {
  const drafts = aggregateAnchorsToEpisodes('ln-x', [
    anc('a1', T0), // n1 簇 1
    anc('a2', T0 + 30_000), // n1 簇 1(簇首 +30s ≤ 60s)
    anc('a3', T0 + CLUSTER_MS + 1), // n1 簇 2(距簇首 > 60s)
    anc('a4', T0 + 5_000, { nodeId: 'n2' }), // n2 独立簇
  ])
  assert.equal(drafts.length, 3)
  const n1Drafts = drafts.filter(d => d.nodeIds[0] === 'n1')
  assert.equal(n1Drafts.length, 2)
  assert.deepEqual(n1Drafts[0]!.anchors, ['a1', 'a2'])
  assert.deepEqual(n1Drafts[1]!.anchors, ['a3'])
})

test('aggregate: 来源归因(簇内 manual 优先 / agent 次之 / 其余配方系统;actor 取同来源锚)', () => {
  const [mixed] = aggregateAnchorsToEpisodes('ln-x', [
    anc('a1', T0, { source: 'recipe', actor: 'system' }),
    anc('a2', T0 + 1_000, { source: 'agent', actor: 'agt-1' }),
  ])
  assert.equal(mixed!.source, 'agent')
  assert.equal(mixed!.actor, 'agt-1')
  assert.equal(mixed!.actorKind, 'agent')

  const [manualFirst] = aggregateAnchorsToEpisodes('ln-x', [
    anc('a1', T0, { source: 'agent', actor: 'agt-1' }),
    anc('a2', T0 + 1_000, { source: 'manual', actor: 'u1' }),
  ])
  assert.equal(manualFirst!.source, 'manual')
  assert.equal(manualFirst!.actor, 'u1')
  assert.equal(manualFirst!.actorKind, 'user')

  const [systemOnly] = aggregateAnchorsToEpisodes('ln-x', [
    anc('a1', T0, { source: 'rollback', actor: 'system' }),
  ])
  assert.equal(systemOnly!.source, 'recipe')
  assert.equal(systemOnly!.actorKind, 'system')
})

// ---------- 快照 diff(推断动作·主路) ----------

test('diffSnapshot: SET 变化且窗内无锚 → 候选确认;有锚/未变/单侧缺失 → 不推断', () => {
  const prev = {
    n1: { set: 100, readAt: T0 - 3_600_000 },
    n2: { set: 50, readAt: T0 - 3_600_000 },
    n3: { set: 10, readAt: T0 - 3_600_000 }, // 本轮未读到(current 缺失)→ 不比
  }
  const current = {
    n1: { set: 120, readAt: T0 }, // 变化 + 无锚 → 候选
    n2: { set: 50, readAt: T0 }, // 未变 → 不推断
    n4: { set: 7, readAt: T0 }, // 首次出现(无上轮)→ 不比
  }
  // n2 有锚:变化会被拦截 —— 单独构造一组验证"有锚 → 不推断"
  assert.deepEqual(diffSnapshot(prev, current, new Set()), [{ nodeId: 'n1', from: 100, to: 120 }])
  assert.deepEqual(diffSnapshot({ n2: prev.n2! }, { n2: { set: 66, readAt: T0 } }, new Set(['n2'])), [])
  // 浮点噪声(≤ epsilon)不产生候选
  assert.deepEqual(diffSnapshot({ n1: prev.n1! }, { n1: { set: 100 + 1e-12, readAt: T0 } }, new Set()), [])
})

test('diffSnapshot: 首轮只建快照(prev 空 → 零候选;后续轮才出推断)', () => {
  // 首轮:prev 为空对象(仓库语义:getSnapshot 返回 undefined 即首轮)→ 只建快照不出候选
  assert.deepEqual(diffSnapshot({}, { n1: { set: 100, readAt: T0 } }, new Set()), [])
  // 第二轮:同一节点再变化 → 出候选
  assert.deepEqual(
    diffSnapshot({ n1: { set: 100, readAt: T0 } }, { n1: { set: 130, readAt: T0 + 1 } }, new Set()),
    [{ nodeId: 'n1', from: 100, to: 130 }],
  )
})

// ---------- SP 语义位冷启动 ----------

test('inferSemantic: 模板 key 含 -sp 判为设定值语义,其余 PV', () => {
  assert.equal(inferSemantic('reactor-temp-sp'), 'sp')
  assert.equal(inferSemantic('Feeder-Speed-SP'), 'sp')
  assert.equal(inferSemantic('reactor-temp'), 'pv')
  assert.equal(inferSemantic('pressure-pv'), 'pv')
})
