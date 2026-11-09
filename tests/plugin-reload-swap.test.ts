/**
 * 插件热重载原子化（WP-C0）：load-then-prune 纯函数语义。
 * 验证「装载前不清空 → 窗口内始终有可用驱动」「装载失败回滚旧插件表」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { staleNames, pruneRegistry, snapshotPluginState, restorePluginState } = await import('../server/services/workshop/plugins/host/reload-swap.mjs')

test('staleNames：只剪「装载前有、装载后无」的名字（同名重注册保留）', () => {
  assert.deepEqual(staleNames(['a', 'b', 'c'], ['a', 'b', 'd']).sort(), ['c'])
  assert.deepEqual(staleNames(['a'], ['a']), [], '全量重注册不剪')
  assert.deepEqual(staleNames([], ['x']), [], '新增不剪')
  assert.deepEqual(staleNames(['a', 'a', 'b'], []).sort(), ['a', 'b'], '去重')
})

test('pruneRegistry：按名删除并返回删除数；不存在/异常安全', () => {
  const reg = new Map([['a', 1], ['b', 2], ['c', 3]])
  assert.equal(pruneRegistry(reg, ['a', 'c', 'missing']), 2)
  assert.deepEqual([...reg.keys()], ['b'])
  assert.equal(pruneRegistry(reg, []), 0)
})

test('快照/回滚：装载失败恢复旧插件表（不留半装载状态）', () => {
  const host = { plugins: new Map([['p1', { name: 'p1' }], ['p2', { name: 'p2' }]]), failures: [{ name: 'x' }], routes: { old: true } }
  const snap = snapshotPluginState(host)
  // 模拟装载:清空 + 只装回一个(随后失败)
  host.plugins.clear()
  host.plugins.set('p1-new', { name: 'p1-new' })
  host.failures = []
  host.routes = { new: true }
  restorePluginState(host, snap)
  assert.deepEqual([...host.plugins.keys()], ['p1', 'p2'], '旧版插件表恢复')
  assert.deepEqual(host.failures, [{ name: 'x' }])
  assert.deepEqual(host.routes, { old: true }, '旧路由表恢复')
})

test('快照是深拷贝:回滚后再改 host 不影响快照', () => {
  const host = { plugins: new Map([['p', {}]]), failures: [], routes: null }
  const snap = snapshotPluginState(host)
  host.plugins.clear()
  host.failures.push({ bad: true })
  assert.equal(snap.plugins.size, 1)
  assert.equal(snap.failures.length, 0)
})
