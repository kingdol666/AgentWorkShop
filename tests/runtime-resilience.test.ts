/**
 * 运行时韧性守卫(2026-11-10 审计 C7/C8/D3)。
 *
 * C7:project_effects 的 running 行在"claim 之后、mark 之前"崩溃时,旧实现没有任何
 *     路径会再碰它(due 只选 pending、mark 只认 running)→ 该 effect 永不重放。
 *     修复=启动时 resetRunningToPending,本文件验证"退回后能被 due 选中且 attempts 保留"。
 * C8:manager.shutdown 漏清 chat 投递定时器;workshop 插件裸调 async restore(),
 *     异常会变成 unhandledRejection 打崩启动。源码契约断言。
 * D3:DCW 未知驱动曾降级 mock(mock 写恒 ok + 回读同一 Map = 假闭环),对齐 DAQ 后
 *     必须保留原名并让 resolveDcwDriver 落到显式失败的占位驱动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-runtime-resilience-'))

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const { openWorkshopDb } = await import('../server/services/workshop/db/database')
const { createProjectKernelRepo } = await import('../server/services/workshop/db/project-kernel.repo')
const { migrateDcwDriverKind, resolveDcwDriver } = await import('../server/services/workshop/dcw/drivers')

const db = openWorkshopDb(join(process.env.AW_HOME!, 'runtime-resilience.sqlite'))
// 本测试只验证 effects 状态机,不需要真实 project 行(FK 在测试进程内临时关闭)
db.exec('PRAGMA foreign_keys = OFF')
const repo = createProjectKernelRepo(db)

test('C7:claim 后崩溃的 running effect 在启动恢复时退回 pending 并可重放', () => {
  const { id } = repo.effects.enqueue({ projectId: 'p-recover', dedupeKey: 'k-recover', kind: 'reconcile' })
  assert.equal(repo.effects.claim(id), true, 'claim 应成功(pending → running)')
  assert.equal(repo.effects.due(new Date().toISOString()).length, 0, 'running 行不在 due 里(旧实现因此永久卡死)')

  const recovered = repo.effects.resetRunningToPending()
  assert.equal(recovered, 1, 'running 行必须被退回 pending')

  const due = repo.effects.due(new Date().toISOString())
  assert.equal(due.length, 1)
  assert.equal(due[0]!.id, id)
  assert.equal(due[0]!.attempts, 1, 'attempts 必须保留(达上限的下次失败直接 dead,不会无限重放)')
})

test('C7:resetRunningToPending 不误伤 pending/done 行', () => {
  const a = repo.effects.enqueue({ projectId: 'p-keep', dedupeKey: 'k-pending', kind: 'notify' })
  const b = repo.effects.enqueue({ projectId: 'p-keep', dedupeKey: 'k-done', kind: 'notify' })
  assert.equal(repo.effects.claim(b.id), true)
  assert.equal(repo.effects.markDone(b.id), true)

  const recovered = repo.effects.resetRunningToPending()
  assert.equal(recovered, 0, '没有 running 行时不应改动任何状态')

  const dueIds = repo.effects.due(new Date().toISOString(), 50).map(r => r.id)
  assert.ok(dueIds.includes(a.id), 'pending 行保持可选')
  assert.ok(!dueIds.includes(b.id), 'done 行不得被退回')
})

test('C8:shutdown 必须清 chat 投递定时器;restore 必须 catch', () => {
  const observe = readFileSync(join(ROOT, 'server/services/workshop/runtime/manager/runtime-observe.ts'), 'utf-8')
  assert.match(observe, /clearInterval\(this\.chatDeliveryTimer\)/, 'shutdown 漏清 chatDeliveryTimer 会让停服后继续跑恢复循环')

  const plugin = readFileSync(join(ROOT, 'server/plugins/workshop.ts'), 'utf-8')
  assert.match(plugin, /manager\.restore\(\)\.catch/, 'restore 是 async:裸调会把异常变成 unhandledRejection,可致启动崩溃循环')
})

test('D3:DCW 未知驱动保留原名并显式失败,绝不降级 mock', async () => {
  const unknown = migrateDcwDriverKind('definitely-not-a-driver')
  assert.equal(unknown.kind, 'definitely-not-a-driver')
  assert.equal(unknown.unknown, true)
  assert.notEqual(unknown.kind, 'mock', '降级 mock 会让"坏驱动配置"表现为写成功且设备证实')

  // 别名归一仍然生效
  const alias = migrateDcwDriverKind('modbus')
  assert.equal(alias.kind, 'modbus-tcp')
  assert.equal(alias.unknown, undefined)

  // 写路径落到 unavailable 占位:available=false 且 test 显式失败(mock 会返回 ok:true)
  const driver = resolveDcwDriver('definitely-not-a-driver' as never)
  assert.equal(await driver.available(), false)
  const probe = await driver.test({})
  assert.equal(probe.ok, false)
  assert.match(probe.message, /未注册|已拒绝/)
})
