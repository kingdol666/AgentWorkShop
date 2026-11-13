import test from 'node:test'
import assert from 'node:assert/strict'
import type { AgentWorkspace } from '../server/services/workshop/agents/agent-interface'
import type { HostToolSessionState } from '../server/services/workshop/agents/host-tool-bridge/types'
import { evaluateGoalCompletion, parseTargetBand } from '../server/services/workshop/verify/goal-completion'
import { handleCompleteTask } from '../server/services/workshop/agents/host-tool-bridge/tools/progress'

const NOW = 1_800_000_000_000

function reading(value: number | null, ageMs = 1_000, quality = 'good') {
  return { value, atMs: NOW - ageMs, quality }
}

function baseline(overrides: Record<string, unknown> = {}) {
  return {
    title: '注塑成型质量窗口寻优:回到 32.5±0.35 g',
    description: '缩痕指数≤1.5；飞边率≤0.4',
    verification: { node_id: 'daq-weight' },
    allowedNodeIds: new Set(['daq-weight', 'daq-sink']),
    readLatest: (id: string) => id === 'daq-weight' ? reading(32.5) : reading(1.0),
    nowMs: NOW,
    ...overrides,
  }
}

test('parseTargetBand:解析 目标±容差,拒绝无目标带', () => {
  assert.deepEqual(parseTargetBand('回到 32.5±0.35 g'), { target: 32.5, tol: 0.35, raw: '32.5±0.35' })
  assert.deepEqual(parseTargetBand('DO 2.0 +/- 0.3'), { target: 2, tol: 0.3, raw: '2.0 +/- 0.3' })
  assert.equal(parseTargetBand('分析趋势并给出建议'), null)
  assert.equal(parseTargetBand('尺寸偏差 ±0.05 mm'), null)
})

test('无目标带的任务不启用完成门', () => {
  const r = evaluateGoalCompletion(baseline({ title: '分析近 24h 趋势', description: '输出报告' }))
  assert.deepEqual(r, { ok: true, skipped: true })
})

test('目标带任务缺 verification → 拒绝', () => {
  const r = evaluateGoalCompletion(baseline({ verification: undefined }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /verification/)
})

test('目标节点不在授权面 → 拒绝', () => {
  const r = evaluateGoalCompletion(baseline({ verification: { node_id: 'daq-other' } }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /授权绑定面/)
})

test('False-Done 回归:31.35 vs 32.5±0.35 → 拒绝', () => {
  const r = evaluateGoalCompletion(baseline({ readLatest: () => reading(31.35) }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /目标未达成/)
})

test('达标 → 通过并返回独立证据', () => {
  const r = evaluateGoalCompletion(baseline({ readLatest: () => reading(32.17) }))
  assert.equal(r.ok, true)
  if (r.ok && !r.skipped) {
    assert.equal(r.evidence.measured, 32.17)
    assert.equal(r.evidence.target, 32.5)
  }
})

test('读数过期 / quality 非 good → 拒绝', () => {
  const stale = evaluateGoalCompletion(baseline({ readLatest: () => reading(32.5, 120_000) }))
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.match(stale.reason, /已过期/)

  const bad = evaluateGoalCompletion(baseline({ readLatest: () => reading(32.5, 1_000, 'uncertain') }))
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.reason, /需 good/)
})

test('守卫越限 → 拒绝', () => {
  const r = evaluateGoalCompletion(baseline({
    verification: {
      node_id: 'daq-weight',
      guards: [{ node_id: 'daq-sink', max: 1.5 }],
    },
    readLatest: (id: string) => id === 'daq-weight' ? reading(32.5) : reading(2.003),
  }))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /守卫未满足/)
})

test('verification 支持 JSON 字符串(异构 LLM 常见形态)', () => {
  const r = evaluateGoalCompletion(baseline({
    verification: JSON.stringify({ node_id: 'daq-weight', guards: [{ node_id: 'daq-sink', max: 1.5 }] }),
  }))
  assert.equal(r.ok, true)
})

function fakeWs() {
  let completed = false
  const ws = {
    getTask: async () => ({
      id: 't1',
      state: 'WORKING',
      title: '回到 32.5±0.35 g',
      description: '缩痕指数≤1.5',
      assigneeId: 'worker-1',
    }),
    listTasks: async () => [],
    completeTask: async () => { completed = true },
    myQueue: async () => ({ queued: [] }),
  }
  return { ws: ws as unknown as AgentWorkspace, completed: () => completed }
}

const state: HostToolSessionState = {
  currentTaskId: 't1',
  sessionId: null,
  sourceChatMessageId: null,
  sourceChatDeliveryId: null,
  replyContext: null,
}

test('complete_task 在完成门拒绝时不落 COMPLETED', async () => {
  const { ws, completed } = fakeWs()
  const res = await handleCompleteTask({ summary: 'done' }, state, ws, undefined, () => ({
    ok: false,
    reason: '目标未达成：daq-weight 独立读数 31.35，目标 32.5±0.35',
  }))
  assert.equal(res.isError, true)
  assert.match(res.text, /拒绝收口/)
  assert.equal(completed(), false)
})

test('complete_task 在完成门通过时才落 COMPLETED', async () => {
  const { ws, completed } = fakeWs()
  const res = await handleCompleteTask({ summary: 'done' }, state, ws, undefined, () => ({
    ok: true,
    skipped: false,
    evidence: { nodeId: 'daq-weight', measured: 32.17, atMs: NOW, target: 32.5, tol: 0.35, guards: [] },
  }))
  assert.equal(res.isError, undefined)
  assert.equal(completed(), true)
})
