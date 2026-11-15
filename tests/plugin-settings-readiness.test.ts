/**
 * 插件设置写入就绪闸门(2026-11-15 测评 P1-5 回归):
 *  - 非插件键立即放行;
 *  - 描述符已注册 → ready;
 *  - 宿主装载中 → pending(调用方 503 可重试,客户端无需轮询);
 *  - 宿主已落定但键不存在 → unknown(精确未知项错误)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { pluginSettingKeys, awaitPluginSettings } = await import('../server/services/system-config/readiness')

test('pluginSettingKeys 只保留 plugins.* 命名空间键', () => {
  assert.deepEqual(
    pluginSettingKeys(['plugins.diag-bridge.base_url', 'server.port', 'plugins.rag-bridge.token']),
    ['plugins.diag-bridge.base_url', 'plugins.rag-bridge.token'],
  )
})

test('非插件键不等待宿主,立即放行', async () => {
  const result = await awaitPluginSettings(['server.port', 'daq.enabled'], { timeoutMs: 1 }, {
    listRegisteredKeys: () => { throw new Error('不应读取设置快照') },
    hostSettled: () => { throw new Error('不应检查宿主') },
  })
  assert.equal(result.status, 'not-plugin')
})

test('插件设置描述符已注册 → ready', async () => {
  const result = await awaitPluginSettings(['plugins.diag-bridge.base_url'], { timeoutMs: 1 }, {
    listRegisteredKeys: () => ['plugins.diag-bridge.base_url'],
    hostSettled: () => true,
  })
  assert.equal(result.status, 'ready')
  assert.deepEqual(result.missing, [])
})

test('宿主仍在装载 → pending(可重试,不误报未知项)', async () => {
  const result = await awaitPluginSettings(['plugins.diag-bridge.base_url'], { timeoutMs: 40, pollMs: 10 }, {
    listRegisteredKeys: () => [],
    hostSettled: () => false,
  })
  assert.equal(result.status, 'pending')
  assert.deepEqual(result.missing, ['plugins.diag-bridge.base_url'])
})

test('宿主已落定但键不存在 → unknown', async () => {
  const result = await awaitPluginSettings(['plugins.not-installed.key'], { timeoutMs: 1000, pollMs: 10 }, {
    listRegisteredKeys: () => [],
    hostSettled: () => true,
  })
  assert.equal(result.status, 'unknown')
  assert.deepEqual(result.missing, ['plugins.not-installed.key'])
})

test('等待期间描述符注册完成 → ready', async () => {
  let calls = 0
  const result = await awaitPluginSettings(['plugins.rag-bridge.base_url'], { timeoutMs: 500, pollMs: 20 }, {
    listRegisteredKeys: () => (++calls >= 2 ? ['plugins.rag-bridge.base_url'] : []),
    hostSettled: () => false,
  })
  assert.equal(result.status, 'ready')
})
