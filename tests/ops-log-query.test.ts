/**
 * 产线日志查询口径(2026-10-19):
 *  - lineOnly 过滤全局审计(登录/备份/设置),产线日志只留 line_id 非空;
 *  - 产线 / 配方 / 时间区间 / 动作前缀可组合过滤;
 *  - limit 在仓储层收敛到 1..1000。
 *
 * 内存库只建 audit_log 一张表(DDL 为静态常量,无任何输入拼接);查询全走仓储的
 * 参数化接口,测试里不拼接 SQL。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createAuditRepo } from '../server/services/workshop/db/ops.repo'

type AuditRepo = ReturnType<typeof createAuditRepo>
type QueryOpts = Parameters<AuditRepo['query']>[0]

const AUDIT_TABLE_DDL = `CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL DEFAULT '',
  actor_name TEXT NOT NULL DEFAULT '',
  actor_kind TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  target_kind TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL,
  line_id TEXT NOT NULL DEFAULT '',
  product_id TEXT NOT NULL DEFAULT '',
  recipe_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT 'info',
  scope TEXT NOT NULL DEFAULT 'system'
)`

function openFixture(): { db: DatabaseSync, run: (opts: QueryOpts) => Array<Record<string, unknown>> } {
  const db = new DatabaseSync(':memory:')
  db.prepare(AUDIT_TABLE_DDL).run()
  const audit = createAuditRepo(db)
  const add = (e: Parameters<typeof audit.append>[0]) => audit.append(e)
  add({ actor: 'visual', actorName: 'visual', actorKind: 'user', action: 'auth.login', kind: 'system', at: '2026-10-19T08:00:00.000+08:00', summary: '登录成功' })
  add({ actor: 'system', actorName: 'backup', actorKind: 'system', action: 'system.backup.run', kind: 'system', at: '2026-10-19T08:01:00.000+08:00', summary: '备份完成' })
  add({ actor: 'u1', actorName: '张工', actorKind: 'user', action: 'line.start', kind: 'line', targetKind: 'line', targetId: 'ln-a', lineId: 'ln-a', recipeId: 'rc-1', at: '2026-10-19T09:00:00.000+08:00', summary: '开线' })
  add({ actor: 'ag-1', actorName: 'Channel/优化员', actorKind: 'agent', action: 'recipe.apply', kind: 'recipe', targetKind: 'recipe', targetId: 'rc-1', lineId: 'ln-a', recipeId: 'rc-1', at: '2026-10-19T09:05:00.000+08:00', summary: '整批下发' })
  add({ actor: 'system', actorName: '产线系统', actorKind: 'system', action: 'recipe.dispatch.ack', kind: 'write', targetKind: 'recipe', targetId: 'rc-1', lineId: 'ln-a', recipeId: 'rc-1', at: '2026-10-19T09:05:01.000+08:00', summary: '回执 3/3' })
  // 无 recipe/product 的产线事件:按线查询必须返回,按 recipe 查询必须排除
  add({ actor: 'u1', actorName: '张工', actorKind: 'user', action: 'dcw.create', kind: 'line', targetKind: 'dcw-node', targetId: 'dw-0', lineId: 'ln-a', at: '2026-10-19T09:10:00.000+08:00', summary: '创建数控节点' })
  add({ actor: 'u2', actorName: '李工', actorKind: 'user', action: 'dcw.write.manual', kind: 'write', targetKind: 'dcw-node', targetId: 'dw-1', lineId: 'ln-b', recipeId: 'rc-2', at: '2026-10-19T10:00:00.000+08:00', summary: '手动下发' })
  add({ actor: 'u2', actorName: '李工', actorKind: 'user', action: 'recipe.trial', kind: 'recipe', targetKind: 'recipe', targetId: 'rc-2', lineId: 'ln-b', recipeId: 'rc-2', at: '2026-10-19T11:00:00.000+08:00', summary: '试验' })
  return { db, run: opts => audit.query(opts) }
}

test('scope: 登录/备份为 system,产线操作为 line;line 行恒有 line_id', () => {
  const { db, run } = openFixture()
  const lineRows = run({ scope: 'line', limit: 100 })
  assert.equal(lineRows.length, 6)
  assert.ok(lineRows.every(x => x.scope === 'line' && String(x.lineId) !== ''))
  assert.ok(!lineRows.some(x => x.action === 'auth.login'), '登录不得出现')
  assert.ok(!lineRows.some(x => x.action === 'system.backup.run'), '备份不得出现')
  const systemRows = run({ scope: 'system', limit: 100 })
  assert.deepEqual(systemRows.map(x => x.action).sort(), ['auth.login', 'system.backup.run'])
  assert.ok(systemRows.every(x => x.scope === 'system'))
  assert.equal(run({ limit: 100 }).length, 8, '不传 scope = 全部')
  db.close()
})

test('lineOnly 兼容别名等价 scope=line', () => {
  const { db, run } = openFixture()
  const rows = run({ lineOnly: true, limit: 100 })
  assert.equal(rows.length, 6)
  assert.ok(rows.every(x => x.scope === 'line'))
  db.close()
})

test('无 recipe/product 的产线事件:按线返回,按 recipe 排除', () => {
  const { db, run } = openFixture()
  const byLine = run({ scope: 'line', lineId: 'ln-a', limit: 100 })
  assert.equal(byLine.length, 4)
  assert.ok(byLine.some(x => x.action === 'dcw.create' && x.recipeId === '' && x.productId === ''), '无 recipe 的产线事件必须按线返回')
  const byRecipe = run({ scope: 'line', recipeId: 'rc-1', limit: 100 })
  assert.ok(byRecipe.length > 0)
  assert.ok(byRecipe.every(x => x.recipeId === 'rc-1'))
  assert.ok(!byRecipe.some(x => x.action === 'dcw.create'), '按 recipe 过滤时必须排除无 recipe 记录')
  db.close()
})

test('scope=line + lineId + recipeId + 时间区间组合过滤', () => {
  const { db, run } = openFixture()
  assert.equal(run({ scope: 'line', lineId: 'ln-a', limit: 100 }).length, 4)
  assert.equal(run({ scope: 'line', recipeId: 'rc-2', limit: 100 }).length, 2)
  const win = run({
    scope: 'line',
    lineId: 'ln-a',
    recipeId: 'rc-1',
    from: '2026-10-19T09:04:00.000+08:00',
    to: '2026-10-19T09:06:00.000+08:00',
    limit: 100,
  })
  assert.deepEqual(win.map(x => x.action).sort(), ['recipe.apply', 'recipe.dispatch.ack'])
  db.close()
})

test('actionPrefix 跨 kind 取配方全族(含 kind=write 的下发回执)', () => {
  const { db, run } = openFixture()
  const rows = run({ lineOnly: true, lineId: 'ln-a', recipeId: 'rc-1', actionPrefix: 'recipe.', limit: 100 })
  assert.deepEqual(rows.map(x => x.action).sort(), ['recipe.apply', 'recipe.dispatch.ack'])
  db.close()
})

test('limit 仓储层收敛:负数→1,超大→1000', () => {
  const { db, run } = openFixture()
  assert.equal(run({ lineOnly: true, limit: -5 }).length, 1)
  assert.equal(run({ lineOnly: true, limit: 99999 }).length, 6)
  db.close()
})

test('跨时区偏移按绝对时刻过滤与排序(julianday)', () => {
  const { db, run } = openFixture()
  // 09:00+08:00 = 01:00Z;02:00Z 更晚。字符串比较会把 +08 行排到前面,绝对时刻不会。
  const rows = run({
    lineOnly: true,
    from: '2026-10-19T01:30:00.000Z',
    to: '2026-10-19T02:30:00.000Z',
    limit: 100,
  })
  assert.deepEqual(rows.map(x => x.action), ['dcw.write.manual'])
  db.close()
})

test('空维度不误伤:lineOnly + q 可搜摘要与操作者', () => {
  const { db, run } = openFixture()
  const rows = run({ lineOnly: true, q: '李工', limit: 100 })
  assert.equal(rows.length, 2)
  assert.ok(rows.every(x => x.lineId === 'ln-b'))
  db.close()
})

test('fail-closed:scope=line 但无 lineId 的写入降级为 system', () => {
  const { db, run } = openFixture()
  const audit = createAuditRepo(db)
  audit.append({
    actor: 'agent-x', actorName: 'agent-x', actorKind: 'agent',
    action: 'line.start', kind: 'line', scope: 'line', lineId: '',
    at: '2026-10-19T12:00:00.000+08:00', summary: '缺锚点',
  })
  const rows = run({ q: '缺锚点', limit: 10 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.scope, 'system')
  assert.equal(run({ scope: 'line', q: '缺锚点', limit: 10 }).length, 0)
  db.close()
})
