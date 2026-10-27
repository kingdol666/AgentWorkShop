/**
 * MQTT 驱动纯函数/指纹契约单测(2026-10-27 审计配套)。
 * 重点:指纹计算在 CA 文件缺失时**不能抛错**(它在 250ms sweep 定时器里执行,
 * 抛错会被稳定性守卫判 fatal 退出进程);凭据不同 → 池键不同。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AGENTWORKSHOP_TEST = '1'
process.env.AW_MODE = 'home'
process.env.AW_HOME = mkdtempSync(join(tmpdir(), 'aw-mqtt-driver-test-'))
delete process.env.AW_BENCH_MODE

const { mqttDaqDriver, mqttKey, extractNumeric } = await import('../server/services/workshop/daq/drivers/mqtt')

test('fingerprint:CA 文件缺失只编码进键,绝不抛错', () => {
  const cfg = { host: '127.0.0.1', port: 1883, topic: 'a/b', jsonPath: 'data.temp', secure: true, caFile: join(tmpdir(), 'definitely-missing-ca.pem') }
  assert.throws(() => mqttKey(cfg), /CA 证书文件不存在/)
  const fp = mqttDaqDriver.fingerprint!(cfg)
  assert.equal(typeof fp, 'string')
  assert.match(fp, /missing-ca|CA/i)
  assert.match(fp, /topic=a\/b/)
})

test('mqttKey:密码/用户名不同 → 池键不同(凭据隔离)', () => {
  const base = { host: '127.0.0.1', port: 1883 }
  assert.notEqual(mqttKey({ ...base, password: 'p1' }), mqttKey({ ...base, password: 'p2' }))
  assert.notEqual(mqttKey({ ...base, username: 'u1' }), mqttKey({ ...base, username: 'u2' }))
  assert.match(mqttKey({ ...base, username: 'u1', password: 'p1' }), /u=u1\|p=[0-9a-f]{12}/)
})

test('extractNumeric:纯数字 / JSON jsonPath', () => {
  assert.equal(extractNumeric(' 42.5 '), 42.5)
  assert.equal(extractNumeric('{"data":{"temp":12.5}}', 'data.temp'), 12.5)
  assert.throws(() => extractNumeric('{"data":{}}', 'data.temp'), /无法提取数值/)
})
