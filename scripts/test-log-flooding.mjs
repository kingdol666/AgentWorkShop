/**
 * 回归测试 —— 日志同指纹限流(server/services/workshop/logger.ts)。
 *
 * P0 背景:daq/drivers.ts 的 OPC UA securityMode=None 告警原先每次建连写一行,
 * 实测约 7 行/秒把生产日志灌到 18MB,且归一化后 100% 是同一句,真实错误被淹没。
 * 覆盖:同指纹洪水折叠 + 抑制摘要、异指纹不误伤、窗口关闭自动结算、指纹表有界、
 * 输出可注入 sink 且既有 debug/info/warn/error 语义不变(生产 stdout/stderr 行为不变)。
 *
 * 运行:node scripts/test-log-flooding.mjs(退出码非 0 = 有失败)
 * 注:logger.ts 经 ./settings 使用 '@/' 别名,纯 node 运行需注册省略扩展名/别名解析钩子
 * (与 scripts/_audit/run.mjs 同一机制;本沙箱内 tsx 会因 spawn 被拒而不可用)。
 */
import { register } from 'node:module'

register(new URL('./_audit/ts-resolve-hook.mjs', import.meta.url).href)

// 级别固定 debug:限流断言只关心"是否输出",不受运行环境 log.level(默认 info)影响
process.env.AW_LOG_LEVEL = 'debug'

const { createLogger, THROTTLE_MAX_FINGERPRINTS, THROTTLE_WINDOW_MS } = await import('../server/services/workshop/logger.ts')

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1
    console.log('  PASS  ' + name)
    return
  }
  fail += 1
  console.log('  FAIL  ' + name + (detail ? '  — ' + detail : ''))
}

/** 自有 sink(需求 4):out ← 非 error/warn,err ← error/warn */
function mkSink() {
  const out = []
  const err = []
  return { out, err, sink: { out: line => out.push(line), err: line => err.push(line) } }
}

const all = s => [...s.out, ...s.err].map(line => JSON.parse(line))
const text = s => all(s).map(line => String(line.msg))
const count = s => s.out.length + s.err.length

console.log('\n━━━ 1. 同指纹洪水:1000 条 → 窗口内 1 行 + 抑制摘要 ━━━')
{
  const s = mkSink()
  const log = createLogger('flood.same', s.sink)
  for (let i = 0; i < 1000; i++) {
    log.warnThrottled(`[daq-opcua] WARN:节点 endpoint=opc.tcp://10.0.0.${i}:4840 使用 securityMode=None,耗时 ${i} ms`)
  }
  check('窗口内只输出首条', count(s) === 1, 'lines=' + count(s))
  log.flushThrottled(true)
  const lines = all(s)
  const summary = text(s).find(m => m.includes('被抑制'))
  check('总输出 ≤ 5 行', lines.length <= 5, 'lines=' + lines.length)
  check('窗口关闭补一条抑制摘要', Boolean(summary), text(s).join(' | '))
  check('摘要报告剩余 999 条', Boolean(summary && summary.includes('被抑制 999 条')), String(summary))
  check('摘要带 scope 且为 [log-throttle] 标记', Boolean(summary && summary.startsWith('[log-throttle]') && summary.includes('scope=flood.same')), String(summary))
  check('摘要与业务消息同流(warn → err)', s.err.some(line => line.includes('被抑制')))
  log.flushThrottled(true)
  check('无新增抑制时不重复补摘要', count(s) === lines.length, 'lines=' + count(s))
  const first = lines.find(line => String(line.msg).startsWith('[daq-opcua] WARN:节点 endpoint='))
  check('首条为 warn 级且消息文本未被改写',
    Boolean(first && first.level === 'warn' && first.msg.startsWith('[daq-opcua] WARN:节点 endpoint=opc.tcp://10.0.0.0:4840')),
    first ? first.msg : '首条缺失')
  check('行结构不变(t/level/scope/msg)', Boolean(first && typeof first.t === 'string' && first.scope === 'flood.same'))
}

console.log('\n━━━ 2. 不同 scope / 明显不同文本:不得被抑制 ━━━')
{
  const s = mkSink()
  const a = createLogger('flood.scope-a', s.sink)
  const b = createLogger('flood.scope-b', s.sink)
  const distinct = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
  for (const word of distinct) a.warnThrottled('同文本不同作用域 ' + word)
  for (const word of distinct) b.warnThrottled('同文本不同作用域 ' + word)
  check('不同 scope 的同文本 10 条全部输出', count(s) === 10, 'lines=' + count(s))
  check('无抑制摘要', !text(s).some(m => m.includes('被抑制')))
  const c = createLogger('flood.scope-c', s.sink)
  for (const word of distinct) c.warnThrottled('不同文本 ' + word)
  check('同 scope 不同文本不被折叠', count(s) === 15, 'lines=' + count(s))
  c.warnThrottled('不同文本 alpha')
  check('同 scope 同文本重复才折叠', count(s) === 15, 'lines=' + count(s))
  const d = createLogger('flood.scope-d', s.sink)
  d.warnThrottled('数字变化 poll 1234 ms')
  d.warnThrottled('数字变化 poll 5678 ms')
  check('数字串归一化后同指纹(第二条折叠)', count(s) === 16, 'lines=' + count(s))
  d.warnThrottled('ISO 2026-09-11T03:12:22.466Z 同文案')
  d.warnThrottled('ISO 2027-01-02T04:00:00.000Z 同文案')
  check('ISO 时间戳归一化后同指纹(第二条折叠)', count(s) === 17, 'lines=' + count(s))
}

console.log('\n━━━ 3. 窗口关闭自动结算:摘要 + 新窗口首条全量 ━━━')
{
  const s = mkSink()
  const log = createLogger('flood.window', s.sink)
  for (let i = 0; i < 5; i++) log.warnThrottled('窗口测试 poll ' + i + ' ms')
  check('窗口内 1 行', count(s) === 1, 'lines=' + count(s))
  const realNow = Date.now
  Date.now = () => realNow() + THROTTLE_WINDOW_MS + 1000
  try {
    log.warnThrottled('窗口测试 poll 9999 ms')
  }
  finally {
    Date.now = realNow
  }
  const lines = all(s)
  const summary = text(s).find(m => m.includes('被抑制'))
  check('窗口关闭后共 3 行(首条 + 摘要 + 新首条)', lines.length === 3, 'lines=' + lines.length)
  check('自动摘要报告 4 条', Boolean(summary && summary.includes('被抑制 4 条')), String(summary))
  check('新窗口首条全量输出', text(s).some(m => m === '窗口测试 poll 9999 ms'))
  check('已结算窗口计数=1', log.throttleStats().windows === 1, 'windows=' + log.throttleStats().windows)
  check('已结算指纹不再占表', log.throttleStats().size === 1, 'size=' + log.throttleStats().size)
}

console.log('\n━━━ 4. 指纹表有界:5000 个不同指纹不得越界 ━━━')
{
  const s = mkSink()
  const log = createLogger('flood.bounded', s.sink)
  let maxSeen = 0
  let over = 0
  for (let i = 0; i < 5000; i++) {
    // 无数字文本:确保 5000 条归为 5000 个不同指纹
    log.warnThrottled('指纹 ' + String.fromCharCode(0x4e00 + i))
    const size = log.throttleStats().size
    if (size > maxSeen) maxSeen = size
    if (size > THROTTLE_MAX_FINGERPRINTS) over += 1
  }
  const st = log.throttleStats()
  check('表大小恒 ≤ 上限', over === 0 && maxSeen <= THROTTLE_MAX_FINGERPRINTS, `max=${maxSeen} cap=${THROTTLE_MAX_FINGERPRINTS}`)
  check('表顶到上限(容量被用满)', st.size === THROTTLE_MAX_FINGERPRINTS, 'size=' + st.size)
  check('发生过逐出(不是整体 clear)', st.evictions > 0, 'evictions=' + st.evictions)
  check('5000 个不同指纹均全量输出(未误折叠)', count(s) === 5000, 'lines=' + count(s))
}

console.log('\n━━━ 5. 既有 debug/info/warn/error 语义不变 ━━━')
{
  const s = mkSink()
  const log = createLogger('flood.base', s.sink)
  log.debug('debug')
  log.info('info')
  log.warn('warn')
  log.error('error')
  const lines = all(s)
  check('四法各输出一次(不经限流)', lines.length === 4, 'lines=' + lines.length)
  check('debug/info → out,warn/error → err', s.out.length === 2 && s.err.length === 2, `out=${s.out.length} err=${s.err.length}`)
  log.warn('warn')
  check('基础 warn 重复不折叠', count(s) === 5, 'lines=' + count(s))
  check('基础四法不写限流表', log.throttleStats().size === 0, 'size=' + log.throttleStats().size)
  const warnLine = all(s).find(line => line.level === 'warn')
  check('scope/msg 原样落盘', Boolean(warnLine && warnLine.scope === 'flood.base' && warnLine.msg === 'warn'))
  const extra = createLogger('flood.api', mkSink().sink)
  check('限流 API 为显式 opt-in 方法',
    typeof extra.rateLimited === 'function' && typeof extra.warnThrottled === 'function'
    && typeof extra.flushThrottled === 'function' && typeof extra.throttleStats === 'function')
}

console.log(`\n━━━ 结果:${pass} passed, ${fail} failed ━━━\n`)
process.exit(fail === 0 ? 0 : 1)
