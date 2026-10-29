/**
 * 错误台账(error-ledger)单元回归:限流去重 / 级别映射 / 4xx 不入账 / 自身不抛错。
 *
 * 台账经 recordOps → bindOpsRepos 注入的 audit.append 落账;测试用桩仓储捕获全部
 * AuditEntry 断言形状与数量,不起真实实例。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

type AuditEntry = Record<string, unknown>

const appended: AuditEntry[] = []
const stubRepos = {
  approvalHistory: { append: () => {}, list: () => [] },
  alarmEvents: { append: () => {}, ack: () => {}, list: () => [] },
  audit: { append: (e: AuditEntry) => { appended.push(e) }, query: () => [] },
  approvalRequests: { append: () => {}, list: () => [], decide: () => {} },
}

const { bindOpsRepos } = await import('../server/services/workshop/ops/ops')
const {
  captureServerError,
  captureProcessFault,
  capturePluginError,
  resetErrorLedgerForTest,
} = await import('../server/services/workshop/ops/error-ledger')

beforeEach(() => {
  appended.length = 0
  resetErrorLedgerForTest()
  bindOpsRepos(stubRepos as never)
})

const fakeEvent = (method: string, path: string) => ({ method, path })

test('5xx 入账:system 域 / level=error / 摘要带方法路径与状态', () => {
  captureServerError(fakeEvent('POST', '/api/workshop/channels'), Object.assign(new Error('boom: db corrupted'), { statusCode: 500 }))
  assert.equal(appended.length, 1)
  const row = appended[0]!
  assert.equal(row.action, 'server.error')
  assert.equal(row.level, 'error')
  assert.equal(row.scope, 'system')
  assert.equal(row.kind, 'system')
  assert.equal(row.actorKind, 'system')
  assert.match(String(row.summary), /POST \/api\/workshop\/channels → 500 Error: boom/)
  const detail = row.detail as Record<string, unknown>
  assert.equal(detail.status, 500)
  assert.match(String(detail.stack), /Error: boom/)
})

test('4xx 不入账(业务拦截语义由路由回执承载,不淹没问题) + 非 /api 路径不入账', () => {
  captureServerError(fakeEvent('POST', '/api/workshop/ops-logs'), Object.assign(new Error('bad'), { statusCode: 400 }))
  captureServerError(fakeEvent('POST', '/api/workshop/ops-logs'), Object.assign(new Error('no'), { statusCode: 404 }))
  captureServerError(fakeEvent('GET', '/_nuxt/entry.js'), new Error('render fail'))
  assert.equal(appended.length, 0)
})

test('无 statusCode 的裸抛按 500 处理', () => {
  captureServerError(fakeEvent('GET', '/api/workshop/tools'), new TypeError('Cannot read properties of undefined'))
  assert.equal(appended.length, 1)
  assert.equal((appended[0]!.detail as Record<string, unknown>).status, 500)
})

test('同源异常 10s 折叠:三条同 key 只记首条,异源各自入账', () => {
  const err = () => Object.assign(new Error('dup'), { statusCode: 500 })
  captureServerError(fakeEvent('GET', '/api/x'), err())
  captureServerError(fakeEvent('GET', '/api/x'), err())
  captureServerError(fakeEvent('GET', '/api/x'), err())
  captureServerError(fakeEvent('GET', '/api/y'), err())
  assert.equal(appended.length, 2, '同 key 折叠为 1 条 + 异源 1 条')
})

test('全局限流:超过 120 条/分钟后丢弃(用不同 path 绕过去重)', () => {
  for (let i = 0; i < 150; i++) {
    captureServerError(fakeEvent('GET', `/api/flood/${i}`), Object.assign(new Error(`flood-${i}`), { statusCode: 500 }))
  }
  const real = appended.filter(r => r.action === 'server.error')
  assert.ok(real.length <= 120, `实际入账 ${real.length} 条,应被限流到 ≤120`)
  // 超限后 60s 节流窗口内的第一条会补一条 warn 汇总(允许存在)
  assert.ok(appended.every(r => ['server.error', 'server.error.throttled'].includes(String(r.action))))
})

test('进程故障:upstream 判 error、socket 判 warn、fatal 也先落账', () => {
  captureProcessFault('unhandledRejection', new Error('connect ECONNREFUSED 127.0.0.1:1502'))
  captureProcessFault('uncaughtException', new Error('ECONNRESET read'))
  captureProcessFault('uncaughtException', new Error('ERR_MODULE_NOT_FOUND'))
  assert.equal(appended.length, 3)
  assert.equal(appended[0]!.level, 'error')
  assert.equal(appended[1]!.level, 'warn')
  assert.equal(appended[2]!.level, 'error')
  assert.match(String(appended[0]!.action), /^process\.unhandledRejection$/)
})

test('进程故障同源折叠:同消息连发只记首条', () => {
  captureProcessFault('unhandledRejection', new Error('connect ECONNREFUSED 127.0.0.1:1502'))
  captureProcessFault('unhandledRejection', new Error('connect ECONNREFUSED 127.0.0.1:1502'))
  assert.equal(appended.length, 1)
})

test('插件故障入账(plugin.error)', () => {
  capturePluginError('plugin-host-init', new Error('driver load failed'))
  assert.equal(appended.length, 1)
  assert.equal(appended[0]!.action, 'plugin.error')
  assert.match(String(appended[0]!.summary), /插件故障\[plugin-host-init\]/)
})

test('非 Error thrown 不炸台账', () => {
  captureServerError(fakeEvent('GET', '/api/weird'), 'a string thrown')
  captureProcessFault('uncaughtException', 42)
  assert.equal(appended.length, 2)
  assert.equal((appended[0]!.detail as Record<string, unknown>).name, 'NonErrorThrow')
})

test('bindOpsRepos 未装配(启动早期)也不抛', () => {
  bindOpsRepos(undefined as never)
  captureServerError(fakeEvent('GET', '/api/no-repos'), Object.assign(new Error('x'), { statusCode: 500 }))
  // 无仓储 → 静默零条,不抛
  assert.equal(appended.length, 0)
  bindOpsRepos(stubRepos as never)
})
