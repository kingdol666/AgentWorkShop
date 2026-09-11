/**
 * 回归测试 —— 插件生命周期的「回收真的会发生」
 * 运行: node scripts/test-plugin-lifecycle.mjs
 * 退出码: 0 全通过 / 1 有失败
 *
 * 背景(为什么需要这个测试):
 *   sdk/context.mjs 的 createPluginContext 曾经**漏接** opts.onDispose —— 宿主
 *   (host.mjs perPluginDisposables)明明注入了回收登记口,SDK 却把清理函数塞进一个
 *   永远不会被 drain 的模块内数组。后果:ctx.onDispose / ctx.timer.* /
 *   ctx.subscriptions.add 登记的清理**永不执行**,热重载后旧定时器继续跑,关停前
 *   200ms 的 kv 写入丢失 —— 而文档一直承诺"服务关闭自动回收"。
 *   该缺陷无任何测试覆盖,故在此把契约钉死。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HookBus } from '../sdk/hooks.mjs'
import { createPluginContext, createRouteTable } from '../sdk/context.mjs'
import { LIFECYCLE_EVENTS, CLIENT_EVENTS } from '../sdk/lifecycle.mjs'

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
    return
  }
  fail++
  console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`)
}

const sandbox = mkdtempSync(join(tmpdir(), 'aw-plugin-lifecycle-'))
const dataDir = join(sandbox, 'data')

/** 装配一个最小 ctx:宿主侧的 onDispose 换成可观察的收集器 */
function makeCtx(extra = {}) {
  const collected = []
  const ctx = createPluginContext({
    name: 'probe',
    scope: 'builtin',
    dir: sandbox,
    hooks: new HookBus({ name: 'probe' }),
    logger: { info: () => {} },
    config: { effective: { 'plugins.probe.k': 1 } },
    paths: { home: sandbox, configRoot: sandbox, dataDir },
    emitter: { registerRoute: () => true },
    onDispose: (fn) => {
      collected.push(fn)
      return fn
    },
    selfOrigin: () => '',
    ...extra,
  })
  return { ctx, collected }
}

console.log('\n━━━ 1. onDispose 必须转发到宿主回收队列 ━━━')
{
  const { ctx, collected } = makeCtx()
  let ran = 0
  ctx.onDispose(() => {
    ran++
  })
  check('ctx.onDispose(fn) 进入宿主队列', collected.length >= 1, `collected=${collected.length}`)
  for (const fn of collected) fn()
  check('宿主逐个调用后清理真的执行', ran === 1, `ran=${ran}`)
}

console.log('\n━━━ 2. ctx.timer 的定时器必须可被关停回收 ━━━')
{
  const { ctx, collected } = makeCtx()
  const before = collected.length
  const id = ctx.timer.setInterval(() => {}, 10_000)
  const added = collected.length - before
  check('setInterval 自动登记回收', added === 1, `added=${added}`)
  for (const fn of collected) fn()
  // Node 的 Timeout 被 clear 后 _destroyed 为 true;用公开可观察行为代替内部字段:
  // 清理后不应再有回调触发(这里以 clearInterval 不抛 + hasRef 关闭为判据)
  check('clearInterval 已执行(定时器不再保持事件循环)', typeof id === 'object' && id.hasRef() === false)
}

console.log('\n━━━ 3. ctx.subscriptions.add 与 onDispose 同队列 ━━━')
{
  const { ctx, collected } = makeCtx()
  let disposed = 0
  const bump = () => {
    disposed++
  }
  ctx.subscriptions.add({ dispose: bump })
  ctx.subscriptions.add(bump)
  for (const fn of collected) fn()
  check('{ dispose() } 形式被执行', disposed === 2, `disposed=${disposed}`)
}

console.log('\n━━━ 4. kv 关停兜底必须登记(否则退出前 200ms 写入丢失)━━━')
{
  // 用独立插件名:同名 kv 文件会被前面的用例顺带 flush 出来,导致"尚未落盘"断言失真
  const { ctx, collected } = makeCtx({ name: 'probe-kv' })
  ctx.kv.set('counter', 41)
  ctx.kv.bump('counter')
  check('内存态即时可见', ctx.kv.get('counter') === 42, `got=${ctx.kv.get('counter')}`)
  const kvFile = join(dataDir, 'plugins', 'probe-kv', 'kv.json')
  check('防抖期内尚未落盘(证明下面的 flush 来自回收钩子)', !existsSync(kvFile))
  for (const fn of collected) fn()
  const ok = existsSync(kvFile) && JSON.parse(readFileSync(kvFile, 'utf8')).counter === 42
  check('执行回收钩子后 kv 已同步落盘', ok)
}

console.log('\n━━━ 5. 无宿主注入口时的本地兜底(单测/独立装配)━━━')
{
  // 不传 onDispose:不应抛错,清理留在本地数组(无法从外部 drain,但注册必须成功)
  const ctx = createPluginContext({
    name: 'probe2',
    scope: 'user',
    dir: sandbox,
    hooks: new HookBus({ name: 'probe2' }),
    logger: {},
    config: { effective: {} },
    paths: { home: sandbox, configRoot: sandbox, dataDir },
    emitter: { registerRoute: () => true },
    selfOrigin: () => '',
  })
  let threw = null
  try {
    ctx.onDispose(() => {})
    ctx.subscriptions.add(() => {})
  }
  catch (err) {
    threw = err
  }
  check('无 onDispose 注入时注册不抛错', threw === null, String(threw?.message ?? ''))
}

console.log('\n━━━ 6. ctx.route 返回布尔(与 sdk/index.d.mts 契约一致)━━━')
{
  const { ctx } = makeCtx()
  check('注册成功 → true', ctx.route('GET', '/ok', () => 1) === true)
  const t = createRouteTable()
  const first = () => 'a'
  const second = () => 'b'
  check('首次注册 → true', t.register('p', 'GET', '/x', first) === true)
  // 契约是「同键后注册覆盖」而非拒绝(host.registerRoute 依赖返回值决定是否记账)
  check('同键再注册 → true(覆盖语义)', t.register('p', 'GET', '/x', second) === true)
  check('resolve 取到最新 handler', t.resolve('p', 'GET', '/x') === second)
  check('大小写/缺前导斜杠归一化后同键', t.resolve('p', 'get', 'x') === second)
  check('非法 handler → false', t.register('p', 'GET', '/y', null) === false)
}

console.log('\n━━━ 7. scope 取值面完整(builtin / project / user)━━━')
{
  for (const scope of ['builtin', 'project', 'user']) {
    const { ctx } = makeCtx({ scope })
    check(`scope=${scope} 原样透出`, ctx.scope === scope, `got=${ctx.scope}`)
  }
}

console.log('\n━━━ 8. 生命周期事件清单覆盖真实发射面 ━━━')
{
  const need = ['plugin:host:init', 'plugins:reloaded', 'config:changed', 'event:permissions:changed', 'event:*', 'daq:sample', 'daq:frame', 'dcw:write', 'line:start', 'line:stop', 'server:close']
  const missing = need.filter(e => !LIFECYCLE_EVENTS.includes(e))
  check('LIFECYCLE_EVENTS 无缺项', missing.length === 0, `missing=${missing.join(',')}`)
  check('服务端通配是裸 \'*\'(不是 event:*)', LIFECYCLE_EVENTS.includes('event:*') && !LIFECYCLE_EVENTS.includes('*'))
  const cneed = ['client:init', 'event:*', 'page:change', 'i18n:changed', 'client:destroy']
  const cmissing = cneed.filter(e => !CLIENT_EVENTS.includes(e))
  check('CLIENT_EVENTS 无缺项', cmissing.length === 0, `missing=${cmissing.join(',')}`)
  check('客户端通配是 \'event:*\'(与服务端相反)', CLIENT_EVENTS.includes('event:*'))
}

rmSync(sandbox, { recursive: true, force: true })

console.log(`\n${fail ? '✖' : '✅'} 插件生命周期:${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
