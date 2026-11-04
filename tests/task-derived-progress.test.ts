/**
 * PR19-P1：派生进度回归 —— 叶子 null / 等权终态锚定聚合 / 递归 / 在飞参考自报。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-derived-progress-'))
delete process.env.AW_BENCH_MODE

const { deriveProgressMap } = await import('../server/services/workshop/runtime/task-engine/derived-progress')

type T = { id: string, parentId?: string, state: string, progress: number }

function mk(id: string, state: string, progress: number, parentId?: string): T {
  return { id, parentId, state, progress }
}

test('叶子任务 progressDerived = null（不适用）', () => {
  const m = deriveProgressMap([mk('a', 'WORKING', 78)])
  assert.equal(m.get('a'), null)
})

test('父任务等权聚合：1 完成 + 1 在飞自报 78 → 89', () => {
  const tasks = [mk('p', 'WORKING', 78, undefined), mk('c1', 'COMPLETED', 100, 'p'), mk('c2', 'WORKING', 78, 'p')]
  const m = deriveProgressMap(tasks)
  assert.equal(m.get('p'), 89)
  assert.equal(m.get('c1'), null)
  assert.equal(m.get('c2'), null)
})

test('终态锚定：FAILED/CANCELED 子任务计 0', () => {
  const tasks = [mk('p', 'WORKING', 50, undefined), mk('c1', 'COMPLETED', 100, 'p'), mk('c2', 'FAILED', 90, 'p')]
  const m = deriveProgressMap(tasks)
  assert.equal(m.get('p'), 50)
})

test('递归：孙任务终态经子任务聚合到根', () => {
  const tasks = [
    mk('root', 'WORKING', 0, undefined),
    mk('mid', 'WORKING', 10, 'root'),
    mk('g1', 'COMPLETED', 100, 'mid'),
    mk('g2', 'COMPLETED', 100, 'mid'),
  ]
  const m = deriveProgressMap(tasks)
  assert.equal(m.get('mid'), 100)
  assert.equal(m.get('root'), 100)
})

test('父任务自报与派生并列：自报 100 而子任务未完成 → 派生 0（暴露假完成）', () => {
  const tasks = [mk('p', 'WORKING', 100, undefined), mk('c1', 'WORKING', 0, 'p')]
  const m = deriveProgressMap(tasks)
  assert.equal(m.get('p'), 0)
})

