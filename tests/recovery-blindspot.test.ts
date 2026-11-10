/**
 * 恢复盲区守卫(2026-11-10 P1)。
 *
 * 现场:群聊消息 delivered、consumed,但没有任何回合。根因是三处恢复盲区叠加:
 *  ① D1 救援用 unloadAgent,五重闸门 hasAssignedWork 看到"滞留 root 就是 lead 的
 *    非终态任务"直接 return → 注释里的"卸载重组"是空操作;
 *  ② ensureAgentRuntime 命中 agentIndex 里的已停止实例时无条件返回,route 只
 *    enqueue/wake,永远不会再 start(AgentRuntime.start 在 started=true 时早退);
 *  ③ unloadAgent 的检查→卸载之间有 await 窗口,pending 复查缺失(TOCTOU)。
 * 另外 WAITING 且无开放子任务/无在飞监督的 root 不在任何停滞检测内。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(
  fileURLToPath(new URL('../server/services/workshop/runtime/manager/runtime-wiring.ts', import.meta.url)),
  'utf-8',
)

test('D1 救援必须强制摘除(不能走五重闸门的 unloadAgent)', () => {
  const rescue = SRC.slice(SRC.indexOf('protected async rescueStaleRoots'), SRC.indexOf('protected async ', SRC.indexOf('protected async rescueStaleRoots') + 10))
  assert.match(rescue, /await this\.stopAndDetach\(channel\.id, channel\.leadAgentId\)/, '救援重组必须用 stopAndDetach')
  assert.ok(!/await this\.unloadAgent\(channel\.id, channel\.leadAgentId\)/.test(rescue), '不得再用会被 hasAssignedWork 挡住的 unloadAgent')
})

test('D1 覆盖 WAITING 孤儿(无开放子任务 + 无在飞监督)', () => {
  assert.match(SRC, /const orphanWaiting = head\.state === 'WAITING'/, 'WAITING 孤儿必须进入救援视野')
  assert.match(SRC, /openChildren\.length === 0/, '必须有"无开放子任务"判据')
  assert.match(SRC, /hasActiveSupervisionAttempt/, '必须有"无在飞监督"判据')
  assert.match(SRC, /head\.state !== 'SUBMITTED' && !orphanWaiting/, '两种形态都要放行')
})

test('ensureAgentRuntime 对已停止实例必须重装配', () => {
  assert.match(SRC, /existing\.getState\?\.\(\) \?\? ''\) !== 'stopped'/, '必须判 stopped 才复用')
  assert.match(SRC, /命中已停止的运行时,摘除后重装配/, '必须有摘除日志(可观测)')
  assert.match(SRC, /this\.agentIndex\.delete\(key\)/, '必须先摘索引再重装配')
})

test('unloadAgent 在 await 之后复查 pending(关闭检查-卸载竞态)', () => {
  const unload = SRC.slice(SRC.indexOf('async unloadAgent('), SRC.indexOf('async unloadIdleAgents'))
  const awaitIdx = unload.indexOf('await import(\'../../agents/tool-approvals\')')
  const recheckIdx = unload.indexOf('listPendingByChannelAgent', awaitIdx)
  assert.ok(awaitIdx > 0 && recheckIdx > awaitIdx, 'await 之后必须复查 pending')
})
