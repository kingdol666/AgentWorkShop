/**
 * 失败/取消任务的记忆沉淀回归（2026-11-28 遗留项闭环）：
 * - 终态沉淀判定：FAILED 一律沉淀；CANCELED 仅沉淀开工过的；非终态不沉淀；
 * - 运行时解析：assignee 优先、lead 兜底、无运行时/抛错静默；
 * - recordTaskOutcome 失败/取消行必须携带收口原因与失败回执（教训可被整理与召回）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-memory-terminal-'))
delete process.env.AW_BENCH_MODE

const { shouldHarvestTerminalTaskMemory, harvestTerminalTaskMemory } = await import('../server/services/workshop/runtime/manager/terminal-harvest')
const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createMemoryRepo } = await import('../server/services/workshop/db/memory.repo')
const { AgentMemory, unsegmentCJK } = await import('../server/services/workshop/runtime/memory')

const db = openWorkshopDb(':memory:')
const repo = createMemoryRepo(db)
const now = new Date().toISOString()
db.prepare(`INSERT INTO channels (id, name, description, scenario_prompt, llm_json, workspace, enabled, version, line_id, owner_user_id, memory_access_mode, created_at, updated_at)
  VALUES ('c1', 'c1', '', '', '', '{}', 1, 1, '', 'u1', 'inherit', ?, ?)`).run(now, now)

test('terminal harvest gate: FAILED always, CANCELED only when started, non-terminal never', () => {
  const started = { history: [{ messageId: 'm1' }] }
  const fresh = { history: [] }
  assert.equal(shouldHarvestTerminalTaskMemory('FAILED', fresh), true, 'FAILED 即使从未开工也要留痕(超时/预算耗尽是教训)')
  assert.equal(shouldHarvestTerminalTaskMemory('CANCELED', started), true, '开工后取消必须沉淀')
  assert.equal(shouldHarvestTerminalTaskMemory('CANCELED', fresh), false, '整树取消的未开工任务不得批量入库')
  assert.equal(shouldHarvestTerminalTaskMemory('COMPLETED', started), false)
  assert.equal(shouldHarvestTerminalTaskMemory('WORKING', started), false)
  assert.equal(shouldHarvestTerminalTaskMemory(undefined, started), false)
})

test('terminal harvest runtime resolution: assignee preferred, lead fallback, failures silent', async () => {
  const calls: Array<{ agentId: string, taskTitle: string }> = []
  const mk = (id: string, role: string, fail = false) => ({
    agentId: id,
    role,
    recordTaskMemory: (task: { title: string }) => {
      if (fail) return Promise.reject(new Error('memory down'))
      calls.push({ agentId: id, taskTitle: task.title })
      return Promise.resolve()
    },
  })
  const task = {
    id: 't1', channelId: 'c1', title: '取消任务', state: 'CANCELED',
    assigneeId: 'w1', history: [{ messageId: 'm1' }],
  } as never

  harvestTerminalTaskMemory([mk('lead1', 'lead'), mk('w1', 'worker')], task, 'CANCELED')
  await new Promise(r => setTimeout(r, 10))
  assert.equal(calls.length, 1, '恰好沉淀一次')
  assert.equal(calls[0]!.agentId, 'w1', 'assignee 运行时优先')

  harvestTerminalTaskMemory([mk('lead1', 'lead')], task, 'CANCELED')
  await new Promise(r => setTimeout(r, 10))
  assert.equal(calls[1]!.agentId, 'lead1', '成员已卸载时回退 lead')

  harvestTerminalTaskMemory([], task, 'CANCELED')
  harvestTerminalTaskMemory(undefined, task, 'CANCELED')
  harvestTerminalTaskMemory([{ agentId: 'x', role: 'worker' }], task, 'CANCELED')
  harvestTerminalTaskMemory([{
    agentId: 'x',
    role: 'worker',
    recordTaskMemory: () => { throw new Error('sync boom') },
  }] as never, task, 'CANCELED')
  harvestTerminalTaskMemory([mk('x', 'worker', true)], task, 'CANCELED')
  harvestTerminalTaskMemory([mk('x', 'worker')], task, 'COMPLETED')
  await new Promise(r => setTimeout(r, 10))
  assert.equal(calls.length, 2, '以上分支都必须静默,不新增沉淀')
})

test('recordTaskOutcome embeds close reason and failure receipt for FAILED/CANCELED rows', async () => {
  const mem = new AgentMemory(repo, { channelId: 'c1', agentId: 'a1', sessionId: null })
  await mem.recordTaskOutcome({
    id: 'task-f1', channelId: 'c1', title: '保压调优任务', description: '调到 60MPa',
    state: 'FAILED', closeReason: 'ROOT_TIMEOUT', assigneeId: 'a1', sessionId: '',
    artifacts: [],
    history: [
      { messageId: 'm0', parts: [{ text: '开始执行' }], metadata: {} },
      {
        messageId: 'm1', parts: [{ text: '执行失败(ROOT_TIMEOUT): 15 分钟无推进' }],
        metadata: { 'x-aw-system': 'task-failure', 'x-aw-error-code': 'ROOT_TIMEOUT' },
      },
    ],
  } as never)
  const failedRow = db.prepare(`SELECT content, importance FROM agent_memories WHERE dedup_key = 'task:task-f1'`).get() as { content: string, importance: number }
  assert.ok(failedRow, 'FAILED 任务必须沉淀')
  // 存储层是 CJK 单字切分形态,断言前先还原原文
  const failed = { content: unsegmentCJK(failedRow.content), importance: failedRow.importance }
  assert.ok(failed.content.includes('收口原因:ROOT_TIMEOUT'), '必须携带收口原因')
  assert.ok(/失败回执:执行失败\s*\(ROOT_TIMEOUT\)/.test(failed.content), '必须携带失败回执正文')
  assert.ok(failed.content.includes('调到 60MPa'), '原始描述保留')
  assert.equal(failed.importance, 0.55)

  await mem.recordTaskOutcome({
    id: 'task-ok', channelId: 'c1', title: '成功任务', description: '正常完成',
    state: 'COMPLETED', assigneeId: 'a1', sessionId: '', artifacts: [], history: [],
  } as never)
  const okRow = db.prepare(`SELECT content FROM agent_memories WHERE dedup_key = 'task:task-ok'`).get() as { content: string }
  assert.ok(!unsegmentCJK(okRow.content).includes('收口原因'), '成功任务不得添加失败前缀')
})
