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

console.log('\n━━━ 3. 稳定性护栏的严重性判定(哪类异常不该退进程) ━━━')
{
  const { classifyFatalCandidate } = await import('../server/utils/stability-severity.ts')
  const err = (code, message = 'boom') => Object.assign(new Error(message), { code })

  // 外部设备不可达 → 不退进程。实测事故:一台 Modbus TCP 设备未启动
  // (connect ECONNREFUSED 127.0.0.1:1502)使整个生产实例 exit 1。
  check('ECONNREFUSED(设备未启动)→ upstream', classifyFatalCandidate(err('ECONNREFUSED')) === 'upstream')
  check('ENOTFOUND(DNS 解析失败)→ upstream', classifyFatalCandidate(err('ENOTFOUND')) === 'upstream')
  check('EHOSTUNREACH → upstream', classifyFatalCandidate(err('EHOSTUNREACH')) === 'upstream')
  check('ENETUNREACH → upstream', classifyFatalCandidate(err('ENETUNREACH')) === 'upstream')
  check('undici UND_ERR_CONNECT_TIMEOUT → upstream', classifyFatalCandidate(err('UND_ERR_CONNECT_TIMEOUT')) === 'upstream')
  check('无 code 但 message 带 ECONNREFUSED → upstream',
    classifyFatalCandidate(new Error('connect ECONNREFUSED 127.0.0.1:1502')) === 'upstream')

  // 其余既有分级不得回退
  check('ECONNRESET(客户端硬断)→ socket', classifyFatalCandidate(err('ECONNRESET')) === 'socket')
  check('EPIPE → socket', classifyFatalCandidate(err('EPIPE')) === 'socket')
  check('SQLITE_BUSY → db-busy', classifyFatalCandidate(err('SQLITE_BUSY')) === 'db-busy')
  check('database is locked(无 code)→ db-busy', classifyFatalCandidate(new Error('database is locked')) === 'db-busy')
  check('omp API 4xx → engine', classifyFatalCandidate(new Error('omp API 500: upstream failed')) === 'engine')

  // fail-fast 语义必须保住:真实缺陷仍要退进程
  check('密钥校验失败 → fatal(安全插件 fail-fast 依赖)', classifyFatalCandidate(new Error('生产环境必须设置 NUXT_SESSION_PASSWORD')) === 'fatal')
  check('任意未分类异常 → fatal', classifyFatalCandidate(new Error('unexpected token in JSON at position 0')) === 'fatal')
  check('null → fatal(不放过未知形态)', classifyFatalCandidate(null) === 'fatal')
  check('非 Error 值(字符串)→ fatal', classifyFatalCandidate('something odd') === 'fatal')
  // 引擎名只允许出现在首行:stack 里偶然含引擎名不得把真实错误降级
  check('引擎名仅在 stack 中 → 不降级',
    classifyFatalCandidate(Object.assign(new Error('TypeError: x is not a function'), { stack: 'TypeError: x is not a function\n  at omp API (x.ts:1)' })) === 'fatal')
}

console.log(`\n━━━ 结果:${pass} passed, ${fail} failed ━━━\n`)
process.exit(fail === 0 ? 0 : 1)
