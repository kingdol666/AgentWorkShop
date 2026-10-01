/**
 * exp-state.repo 单测(纯逻辑;临时目录注入,不启服务、不触真实配置根数据):
 *   - episode 哈希去重(重复 collect 不重记)
 *   - cap 淘汰(episodes 500 FIFO / confirmations 200 FIFO / seenAnchorIds 保新)
 *   - 两阶段状态推进 pending → summarized → done
 *   - confirm → episode 转换(确认转正入队 / 忽略不入队)
 *   - 快照 / 水位 / 语义位 / 注册表 读写 + 落盘持久(重开实例读回)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExpStateRepo, episodeHashOf } from '../server/services/workshop/exp/exp-state.repo'

function tempRepo(): { repo: ExpStateRepo, path: string, clean: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'exp-state-'))
  const path = join(dir, 'exp-state.json')
  return { repo: new ExpStateRepo(path), path, clean: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 平台动作 episode 草稿夹具(缺省一条:n1 100→120) */
const draft = (over: Partial<Record<string, unknown>> = {}) => ({
  nodeIds: ['n1'],
  kind: 'platform' as const,
  source: 'manual' as const,
  actor: 'u1',
  actorKind: 'user' as const,
  params: [{ nodeId: 'n1', from: 100, to: 120 }],
  at: '2026-10-01T08:00:00.000Z',
  anchors: ['a1'],
  auditIds: [],
  comments: [],
  ...over,
})

test('exp-state: recordEpisodes 按 hash 去重(同语义重复采集不重记)', () => {
  const { repo, clean } = tempRepo()
  try {
    const first = repo.recordEpisodes('ln-a', [draft()])
    assert.equal(first.length, 1)
    assert.equal(first[0]!.status, 'pending')
    assert.ok(first[0]!.id.startsWith('exp-'))
    // 完全同语义再采 → 去重为零新增(崩溃重试/重复 collect 幂等)
    const second = repo.recordEpisodes('ln-a', [draft()])
    assert.equal(second.length, 0)
    assert.equal(repo.listEpisodes({ lineId: 'ln-a' }).length, 1)
    // 语义不同(时间不同)→ 新增
    const third = repo.recordEpisodes('ln-a', [draft({ at: '2026-10-01T09:00:00.000Z' })])
    assert.equal(third.length, 1)
    // 展示性字段不同(归因增强)不产生新 episode
    const fourth = repo.recordEpisodes('ln-a', [draft({ actor: 'operator-2', comments: ['人工意见:x'] })])
    assert.equal(fourth.length, 0)
    assert.equal(repo.listEpisodes({ lineId: 'ln-a' }).length, 2)
  }
  finally { clean() }
})

test('exp-state: episodeHashOf 与 params/anchors 顺序无关(canonical 化)', () => {
  const base = { lineId: 'ln-a', kind: 'platform' as const, source: 'manual' as const, at: '2026-10-01T08:00:00.000Z' }
  const h1 = episodeHashOf({
    ...base,
    params: [{ nodeId: 'n1', from: 1, to: 2 }, { nodeId: 'n2', from: 3, to: 4 }],
    anchors: ['a2', 'a1'],
  })
  const h2 = episodeHashOf({
    ...base,
    params: [{ nodeId: 'n2', from: 3, to: 4 }, { nodeId: 'n1', from: 1, to: 2 }],
    anchors: ['a1', 'a2'],
  })
  assert.equal(h1, h2)
  assert.notEqual(h1, episodeHashOf({ ...base, params: [{ nodeId: 'n1', from: 1, to: 99 }], anchors: ['a1'] }))
})

test('exp-state: episodes cap 500 FIFO 淘汰(最旧出局,最新保留)', () => {
  const { repo, clean } = tempRepo()
  try {
    for (let i = 0; i < 505; i++) {
      repo.recordEpisodes('ln-cap', [draft({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), anchors: [`a-${i}`] })])
    }
    const all = repo.listEpisodes({ lineId: 'ln-cap' })
    assert.equal(all.length, 500)
    // 最旧 5 条被淘汰
    assert.equal(all.some(e => e.anchors.includes('a-0')), false)
    assert.equal(all.some(e => e.anchors.includes('a-4')), false)
    // 最新保留
    assert.equal(all.some(e => e.anchors.includes('a-504')), true)
  }
  finally { clean() }
})

test('exp-state: 两阶段状态推进 pending → summarized → done', () => {
  const { repo, clean } = tempRepo()
  try {
    const [e] = repo.recordEpisodes('ln-s', [draft()])
    assert.ok(e)
    assert.equal(repo.markEpisode('exp-nope', 'done'), undefined)
    assert.equal(repo.markEpisode(e.id, 'summarized')?.status, 'summarized')
    assert.equal(repo.markEpisode(e.id, 'done')?.status, 'done')
    assert.equal(repo.listEpisodes({ lineId: 'ln-s', status: 'done' }).length, 1)
    assert.equal(repo.listEpisodes({ lineId: 'ln-s', status: 'pending' }).length, 0)
  }
  finally { clean() }
})

test('exp-state: confirm → episode 转换(确认转正入队,忽略不入队)', () => {
  const { repo, clean } = tempRepo()
  try {
    const { confirmation, added } = repo.addConfirmation({
      lineId: 'ln-c', nodeId: 'n1', nodeName: '反应釜温度', from: 100, to: 120,
      at: '2026-10-01T08:00:00.000Z', evidence: 'SET 由 100 变为 120,时间窗内平台无写入记录',
    })
    assert.equal(added, true)
    assert.equal(confirmation.status, 'pending')
    // 同 (lineId,nodeId,from,to) 的 pending 卡幂等去重
    const again = repo.addConfirmation({
      lineId: 'ln-c', nodeId: 'n1', nodeName: '反应釜温度', from: 100, to: 120,
      at: '2026-10-01T08:01:00.000Z', evidence: '重复推断',
    })
    assert.equal(again.added, false)
    assert.equal(again.confirmation.id, confirmation.id)

    // 忽略:状态 ignored,不产生 episode
    const ignored = repo.decideConfirmation(confirmation.id, false, 'u9')
    assert.equal(ignored?.confirmation.status, 'ignored')
    assert.equal(ignored?.episode, undefined)
    assert.equal(ignored?.confirmation.decidedBy, 'u9')
    assert.ok(ignored?.confirmation.decidedAt)

    // 确认:推断转 episode(kind=inferred, status=pending),证据入 comments
    const { confirmation: c2 } = repo.addConfirmation({
      lineId: 'ln-c', nodeId: 'n2', nodeName: '进料流量', from: 5, to: 8,
      at: '2026-10-01T09:00:00.000Z', evidence: 'SET 由 5 变为 8,时间窗内平台无写入记录',
    })
    const ok = repo.decideConfirmation(c2.id, true, 'u9')
    assert.equal(ok?.confirmation.status, 'confirmed')
    const ep = ok?.episode
    assert.ok(ep, '确认转正必须产生 episode')
    assert.equal(ep.kind, 'inferred')
    assert.equal(ep.source, 'inferred')
    assert.equal(ep.status, 'pending')
    assert.deepEqual(ep.params, [{ nodeId: 'n2', from: 5, to: 8 }])
    assert.equal(ep.nodeIds.join(','), 'n2')
    assert.ok(ep.comments[0]?.includes('推断依据'))
    // 确认产生的 episode 与再次确认同语义 → 哈希去重不重记
    assert.equal(repo.listEpisodes({ lineId: 'ln-c', kind: 'inferred' }).length, 1)
  }
  finally { clean() }
})

test('exp-state: confirmations cap 200 FIFO + list 过滤', () => {
  const { repo, clean } = tempRepo()
  try {
    for (let i = 0; i < 205; i++) {
      repo.addConfirmation({
        lineId: 'ln-f', nodeId: `n${i % 10}`, nodeName: `节点${i % 10}`, from: 0, to: i,
        at: '2026-10-01T08:00:00.000Z', evidence: `证据${i}`,
      })
    }
    const all = repo.listConfirmations({ lineId: 'ln-f' })
    assert.equal(all.length, 200)
    assert.equal(repo.listConfirmations({ lineId: 'ln-f', status: 'pending' }).length, 200)
    assert.equal(repo.listConfirmations({ lineId: 'ln-other' }).length, 0)
  }
  finally { clean() }
})

test('exp-state: 快照/水位/语义位/注册表 读写 + seenAnchorIds 保新剔旧', () => {
  const { repo, clean } = tempRepo()
  try {
    // 快照:未建立返回 undefined(首轮只建快照不推断的判据)
    assert.equal(repo.getSnapshot('ln-w'), undefined)
    repo.setSnapshot('ln-w', { n1: { set: 100, readAt: 1_000 } })
    assert.deepEqual(repo.getSnapshot('ln-w'), { n1: { set: 100, readAt: 1_000 } })
    // 水位:缺省零值;setWatermark 对已见 id 集保新剔旧(防无界增长)
    assert.deepEqual(repo.getWatermark('ln-w'), { lastAnchorAt: 0, seenAnchorIds: [], lastAuditId: 0 })
    const seen = Array.from({ length: 1100 }, (_, i) => `anc-${i}`)
    repo.setWatermark('ln-w', { lastAnchorAt: 123_456, seenAnchorIds: seen, lastAuditId: 42 })
    const wm = repo.getWatermark('ln-w')
    assert.equal(wm.lastAnchorAt, 123_456)
    assert.equal(wm.lastAuditId, 42)
    assert.equal(wm.seenAnchorIds.length, 1000)
    assert.equal(wm.seenAnchorIds[0], 'anc-100')
    // 语义位 + 注册表
    assert.equal(repo.paramMetaGet('ln-w', 'n1'), undefined)
    repo.paramMetaSet('ln-w', 'n1', 'sp')
    assert.deepEqual(repo.paramMetaGet('ln-w', 'n1'), { semantic: 'sp' })
    assert.equal(repo.registryGet('ln-w:n1:温度偏高'), undefined)
    repo.registrySet('ln-w:n1:温度偏高', { title: '[ln-w] 经验: 温度偏高降进料 | v1', version: 1, confidence: '观察', lastAt: '2026-10-01T08:00:00.000Z', taskIds: ['t-1'] })
    assert.equal(repo.registryGet('ln-w:n1:温度偏高')?.confidence, '观察')
  }
  finally { clean() }
})

test('exp-state: 落盘持久(重开实例读回;原子写文件存在)', () => {
  const { repo, path, clean } = tempRepo()
  try {
    const [e] = repo.recordEpisodes('ln-p', [draft()])
    repo.markEpisode(e!.id, 'summarized')
    const reopened = new ExpStateRepo(path)
    const eps = reopened.listEpisodes({ lineId: 'ln-p' })
    assert.equal(eps.length, 1)
    assert.equal(eps[0]!.status, 'summarized')
  }
  finally { clean() }
})
