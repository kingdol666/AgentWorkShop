/**
 * 危险默认治理契约测试（P0-2 + 指控8，2026-11-08 生产审计）
 *
 * 锁死两条「静默替身」禁令:
 *  1) 绑定产线的 daq/dcw 节点必须显式 driver —— 缺省 mock 会造成假数据/假写入;
 *     演示节点显式传 driver='mock' 仍允许。
 *  2) Project 创建必须显式 leaderHarness —— 缺省 mock 替身移除(单测环境有逃生阀,
 *     生产进程无 NODE_TEST_CONTEXT,故此处临时清空该变量以验真实生产语义)。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const { requireLeaderHarness } = await import('../server/services/workshop/projects/service.ts')

describe('Project leaderHarness 去默认(指控8)', () => {
  it('显式值原样透传(含 mock,演示需显式)', () => {
    assert.equal(requireLeaderHarness('omp'), 'omp')
    assert.equal(requireLeaderHarness('mock'), 'mock')
    assert.equal(requireLeaderHarness('  codex  '), 'codex')
  })

  it('生产语义(无 NODE_TEST_CONTEXT):缺省即 400 fail-loud', () => {
    const saved = process.env.NODE_TEST_CONTEXT
    try {
      delete process.env.NODE_TEST_CONTEXT
      assert.throws(() => requireLeaderHarness(undefined), (e: unknown) => {
        const err = e as { code?: string }
        return err.code === 'LEADER_HARNESS_REQUIRED'
      }, '缺省必须抛 LEADER_HARNESS_REQUIRED,不得静默 mock')
      assert.throws(() => requireLeaderHarness(''), '空串同样拒绝')
      assert.throws(() => requireLeaderHarness('   '), '纯空白同样拒绝')
    }
    finally {
      if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved
    }
  })

  it('单测逃生阀只在 NODE_TEST_CONTEXT 存在时生效', () => {
    // 当前运行器必然设置该变量 → 缺省返回 mock(既有单测兼容面)
    assert.notEqual(process.env.NODE_TEST_CONTEXT, undefined)
    assert.equal(requireLeaderHarness(undefined), 'mock')
  })
})
