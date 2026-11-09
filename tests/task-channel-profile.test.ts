/**
 * WP-D5：任务实例 AML Profile 继承（降档 + 不继承模型绑定）。
 * 纯函数矩阵测试；不触 DB（inheritChannelProfile 的 I/O 由集成环境覆盖）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { instanceProfileOf } = await import('../server/services/workshop/agents/task-channel-profile')
type P = Parameters<typeof instanceProfileOf>[0]

function parent(over: Partial<P> = {}): P {
  return {
    channelId: 'ch-parent',
    profile: 'hybrid_twin',
    capability: { twin: true },
    sceneId: 'scene-1',
    sceneVersion: 'v3',
    sceneContract: { hash: 'h' },
    objective: { metric: 'iae' },
    controlPolicy: 'bounded_auto',
    providerId: 'p-1',
    providerVersion: '1.2',
    providerHash: 'ph',
    scenePackId: 'sp-1',
    providerGeneration: 4,
    boundModelId: 'model-9',
    boundAt: '2026-11-01T00:00:00.000Z',
    optimizationMode: 'aml',
    executionMode: 'auto',
    ...over,
  }
}

test('legacy 母频道 → 不继承（null,保持缺省零行为）', () => {
  assert.equal(instanceProfileOf(parent({ profile: 'legacy' })), null)
})

test('bounded_auto 降档为 hitl_governed；其余策略原样', () => {
  assert.equal(instanceProfileOf(parent({ controlPolicy: 'bounded_auto' }))!.controlPolicy, 'hitl_governed')
  assert.equal(instanceProfileOf(parent({ controlPolicy: 'recommendation_only' }))!.controlPolicy, 'recommendation_only')
  assert.equal(instanceProfileOf(parent({ controlPolicy: 'hitl_governed' }))!.controlPolicy, 'hitl_governed')
})

test('不继承模型绑定（boundModelId/boundAt 必须缺席）', () => {
  const p = instanceProfileOf(parent()) as Record<string, unknown>
  assert.equal(p.boundModelId, undefined, '实例禁止隐式携带模型绑定')
  assert.equal(p.boundAt, undefined)
  assert.equal(p.sceneId, 'scene-1', '场景契约仍继承')
  assert.equal(p.optimizationMode, 'aml')
  assert.equal(p.providerGeneration, 4)
})

test('四类 profile 均按原档继承（exp-miner/line-doctor 只读档不降级也不升级）', () => {
  for (const kind of ['hybrid_twin', 'aml_training', 'aml_optimization', 'exp-miner', 'line-doctor'] as const) {
    assert.equal(instanceProfileOf(parent({ profile: kind }))!.profile, kind)
  }
})
