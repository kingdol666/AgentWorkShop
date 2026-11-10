/**
 * 监管停滞守卫(2026-11-10 P1:项目 root 每 6 分钟被 external cancel、40 分钟不推进)。
 *
 * 根因链:base 策略硬编码 hardTimeoutMs=max(300s, watchdog*4)=360s(架空配置项
 * supervise_hard_timeout_ms=900s)→ 真实 supervise 超 6 分钟必被 abort → omp 把原因
 * 记成 "external cancel" → abortToCancelDecision 合成 cancel → 项目 root 被治理护栏
 * 拦截 → cancel-blocked 事件没有映射被静默丢弃 → 循环不可见。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

process.env.AGENTWORKSHOP_TEST = '1'

const { abortToCancelDecision, isHardAbortReason } = await import('../server/services/workshop/agents/omp-agent/supervision-decision')
const { createAgentImpl } = await import('../server/services/workshop/agents/factory')

const g = globalThis as { __systemConfig?: unknown }

test('硬超时不再合成 cancel(慢回合不是"任务该被取消"的理由)', () => {
  assert.equal(isHardAbortReason('hard timeout(360000ms)'), false)
  assert.equal(abortToCancelDecision({ reason: 'hard timeout(360000ms)', activeTaskId: 't-1' }), null)
  // 外部取消仍按原语义收口(调度器主动取消)
  assert.equal(isHardAbortReason('external cancel'), true)
  assert.equal(abortToCancelDecision({ reason: 'external cancel', activeTaskId: 't-1' })?.kind, 'cancel')
  // 无在办任务 → 不出决策
  assert.equal(abortToCancelDecision({ reason: 'external cancel' }), null)
})

test('supervise 硬超时读运行期设置(不再硬编码 360s)', () => {
  const prev = g.__systemConfig
  try {
    g.__systemConfig = {
      ready: true,
      snapshot: () => ({
        effective: {
          'workshop.supervise_watchdog_ms': 120_000,
          'workshop.supervise_hard_timeout_ms': 780_000,
        },
      }),
    }
    const impl = createAgentImpl({
      id: 't-stall', agentId: 'agent-stall', channelId: 'ch-stall',
      name: 'stall', role: 'lead', harness: 'omp',
    } as never) as unknown as { getSupervisionPolicy?: () => { watchdogMs: number, hardTimeoutMs: number } }
    assert.equal(typeof impl.getSupervisionPolicy, 'function')
    const policy = impl.getSupervisionPolicy!()
    assert.equal(policy.watchdogMs, 120_000, 'watchdog 必须读设置')
    assert.equal(policy.hardTimeoutMs, 780_000, '硬超时必须读设置(旧实现恒 360000)')
  }
  finally {
    g.__systemConfig = prev
  }
})

test('per-agent config 覆盖优先于运行期设置', () => {
  const prev = g.__systemConfig
  try {
    g.__systemConfig = {
      ready: true,
      snapshot: () => ({ effective: { 'workshop.supervise_watchdog_ms': 120_000, 'workshop.supervise_hard_timeout_ms': 780_000 } }),
    }
    const impl = createAgentImpl({
      id: 't-ovr', agentId: 'agent-ovr', channelId: 'ch-ovr',
      name: 'ovr', role: 'lead', harness: 'omp',
      // per-agent 覆盖走 agent.config(registry: def.create(agent.config, agent))
      config: { superviseWatchdogMs: 60_000, superviseHardTimeoutMs: 600_000 },
    } as never) as unknown as { getSupervisionPolicy?: () => { watchdogMs: number, hardTimeoutMs: number } }
    const policy = impl.getSupervisionPolicy!()
    assert.equal(policy.watchdogMs, 60_000)
    assert.equal(policy.hardTimeoutMs, 600_000)
  }
  finally {
    g.__systemConfig = prev
  }
})

test('cancel-blocked 进记忆事件映射(拦截可见,不静默)', () => {
  // 源码契约:旧实现 noteLeadDecision 对未知 decision 直接 return,cancel-blocked 不可见
  const src = readFileSync(fileURLToPath(new URL('../server/services/workshop/runtime/manager/state.ts', import.meta.url)), 'utf-8')
  assert.match(src, /'cancel-blocked': 'lead\.cancel_blocked'/, 'cancel-blocked 必须有事件映射')
})
