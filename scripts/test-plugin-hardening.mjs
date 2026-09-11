/**
 * 回归测试 —— 插件宿主加固(P0-2 路径包含判定 + P0-1 回滚所需的路由卸下能力)
 * 运行: node scripts/test-plugin-hardening.mjs
 * 退出码: 0 全通过 / 1 有失败
 *
 * 说明:半注册回滚(P0-1)的端到端验证需要 Nitro 运行时(host.mjs 依赖 @/ 别名),
 * 由 scripts/test-plugin-live.mjs 打真实服务器完成。
 */
import { isPathInside, createRouteTable } from '../sdk/context.mjs'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
    return
  }
  fail++
  console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`)
}

console.log('\n━━━ 1. 路径包含判定(P0-2) ━━━')
{
  const d = 'C:/repo/server/plugins-builtin/rag-bridge'
  check('目录内文件 → 允许', isPathInside(d, d + '/client.mjs') === true)
  check('目录自身 → 允许', isPathInside(d, d) === true)
  check('同前缀兄弟目录 → 拒绝(旧 startsWith 实现会放行)', isPathInside(d, 'C:/repo/server/plugins-builtin/rag-bridge-evil/x.mjs') === false)
  check('../ 逃逸到仓库根 → 拒绝', isPathInside(d, 'C:/repo/.env') === false)
  check('../ 逃逸到上级 → 拒绝', isPathInside(d, 'C:/repo/server/plugins-builtin/other.mjs') === false)
  check('含 .. 的相对写法仍判定为内', isPathInside(d, d + '/sub/../client.mjs') === true)
}

console.log('\n━━━ 2. 路由表按插件卸下(P0-1 回滚所需) ━━━')
{
  const t = createRouteTable()
  t.register('alpha', 'GET', '/a', () => 1)
  t.register('alpha', 'POST', '/b', () => 2)
  t.register('beta', 'GET', '/c', () => 3)
  check('注册后 size=3', t.size === 3, 'size=' + t.size)
  check('byPlugin(alpha) 2 条', t.byPlugin('alpha').length === 2)
  const removed = t.unregisterPlugin('alpha')
  check('unregisterPlugin 返回 2', removed === 2, 'removed=' + removed)
  check('alpha 路由已清空', t.byPlugin('alpha').length === 0)
  check('beta 路由不受影响', t.byPlugin('beta').length === 1)
  check('resolve(alpha) 为 null', t.resolve('alpha', 'GET', '/a') === null)
  check('unregisterPlugin 幂等(再调返回 0)', t.unregisterPlugin('alpha') === 0)
}

console.log(`\n━━━ 结果:${pass} passed, ${fail} failed ━━━\n`)
process.exit(fail === 0 ? 0 : 1)
