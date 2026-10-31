/**
 * MQTT 写载荷模板(jsonTemplate)纯函数单测 —— 不依赖 broker/平台实例。
 * 覆盖:嵌套多字段、多处占位符、规范化、坏模板拒绝、jsonKey/裸值兼容、互斥与长度上限。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMqttWritePayload, validateMqttWriteConfig } from '../server/services/workshop/dcw/mqtt-payload'

test('jsonTemplate:嵌套多字段 + 静态字段,渲染出合法 JSON', () => {
  const out = renderMqttWritePayload({
    jsonTemplate: '{"cmd":"set","params":{"temp":{{value}},"hold":8},"ts":123}',
  }, 230)
  assert.deepEqual(JSON.parse(out), { cmd: 'set', params: { temp: 230, hold: 8 }, ts: 123 })
})

test('jsonTemplate:多处 {{value}} 全部替换 + 小数精度保持', () => {
  const out = renderMqttWritePayload({ jsonTemplate: '{"sp":{{value}},"echo":{{value}}}' }, 26.5)
  assert.deepEqual(JSON.parse(out), { sp: 26.5, echo: 26.5 })
})

test('jsonTemplate:数组形态也允许', () => {
  const out = renderMqttWritePayload({ jsonTemplate: '[{{value}},1,2]' }, 7)
  assert.deepEqual(JSON.parse(out), [7, 1, 2])
})

test('jsonTemplate:缺占位符 / 渲染后非 JSON / 同时配 jsonKey → 400', () => {
  assert.throws(() => renderMqttWritePayload({ jsonTemplate: '{"sp":1}' }, 1), /缺少 \{\{value\}\}/)
  assert.throws(() => renderMqttWritePayload({ jsonTemplate: '{"sp":{{value}},}' }, 1), /不是合法 JSON/)
  assert.throws(() => renderMqttWritePayload({ jsonTemplate: '{"sp":{{value}}}', jsonKey: 'sp' }, 1), /互斥/)
})

test('jsonTemplate:非有限数字拒绝', () => {
  assert.throws(() => renderMqttWritePayload({ jsonTemplate: '{"sp":{{value}}}' }, Number.NaN), /有限数字/)
  assert.throws(() => renderMqttWritePayload({ jsonTemplate: '{"sp":{{value}}}' }, Number.POSITIVE_INFINITY), /有限数字/)
})

test('jsonTemplate:长度上限', () => {
  const long = `{"sp":{{value}},"pad":"${'x'.repeat(5000)}"}`
  assert.throws(() => renderMqttWritePayload({ jsonTemplate: long }, 1), /过长/)
})

test('兼容:jsonKey 单键 / 无配置裸数值', () => {
  assert.equal(renderMqttWritePayload({ jsonKey: 'setpoint' }, 26), '{"setpoint":26}')
  assert.equal(renderMqttWritePayload({}, 26), '26')
  assert.equal(renderMqttWritePayload({ jsonKey: '' }, 26), '26')
})

test('配置期校验与写入期同源(validateMqttWriteConfig)', () => {
  assert.doesNotThrow(() => validateMqttWriteConfig({ jsonTemplate: '{"sp":{{value}}}' }))
  assert.doesNotThrow(() => validateMqttWriteConfig({ jsonKey: 'sp' }))
  assert.throws(() => validateMqttWriteConfig({ jsonTemplate: '{"sp":1}' }), /缺少 \{\{value\}\}/)
})
