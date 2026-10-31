/**
 * MQTT 单 topic 多字段展开(纯构建)单测 —— 不依赖平台实例/真实 broker。
 * 覆盖:对象/数组写法、fieldsBase 前缀、per-field 量程/告警、scalar 模板约束、
 * 互斥项、重复/超限拒绝、子节点 driverConfig 清理。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMqttFieldGroup, parseMqttFieldSpecs, hasMqttFieldSpecs } from '../server/services/workshop/daq/field-group'
import type { DaqCreateInput } from '../server/services/workshop/daq/daq-controller/types'
import type { DaqTemplateDef } from '../shared/daq-protocol'

const scalarTpl: DaqTemplateDef = {
  key: 'temp-tc', name: '温度传感器', code: 'TEMP · TC', ch: '熔体/箱体温度', unit: '℃',
  base: 168, amp: 3.2, min: 150, max: 185, decimals: 1, icon: 'thermo',
}
const vectorTpl: DaqTemplateDef = {
  ...scalarTpl, key: 'thickness-scan', name: '测厚扫描仪', signalKind: 'vector', unit: 'mm',
}
const lookup = (ref: string): DaqTemplateDef | undefined => {
  const key = ref.replace(/^daq-/, '')
  if (key === 'temp-tc') return scalarTpl
  if (key === 'thickness-scan') return vectorTpl
  return undefined
}
const baseInput = (driverConfig: Record<string, unknown>, extra: Partial<DaqCreateInput> = {}): DaqCreateInput => ({
  templateRef: 'daq-temp-tc',
  name: '环境站',
  driver: 'mqtt',
  lineId: 'ln-test',
  driverConfig: { host: '127.0.0.1', port: 1883, topic: 'aw/e2e/env', qos: 0, ...driverConfig } as DaqCreateInput['driverConfig'],
  ...extra,
})

test('对象写法:每字段一个子节点,独立单位/量程/告警,组内共享 topic', () => {
  const plan = buildMqttFieldGroup(baseInput({
    fields: {
      temp: 'data.temp',
      humidity: { path: 'data.humidity', unit: '%', min: 0, max: 100, warnLow: 20, warnHigh: 80, decimals: 1 },
    },
  }), { lookup, groupId: 'dg-test' })
  assert.ok(plan)
  assert.equal(plan.inputs.length, 2)
  const [temp, hum] = plan.inputs
  assert.equal(temp.driverConfig?.jsonPath, 'data.temp')
  assert.equal(hum.driverConfig?.jsonPath, 'data.humidity')
  assert.equal(hum.unit, '%')
  assert.equal(hum.min, 0)
  assert.equal(hum.max, 100)
  assert.equal(hum.warnLow, 20)
  assert.equal(hum.warnHigh, 80)
  assert.equal(temp.name, '环境站·temp')
  assert.equal(temp.driverConfig?.fieldGroup, 'dg-test')
  assert.equal(temp.driverConfig?.fieldLabel, 'temp')
  // 父级 fields/jsonPath 不落子节点
  assert.equal((temp.driverConfig as Record<string, unknown>).fields, undefined)
  // 共享同一 topic(驱动侧按 broker+topic 复用一次订阅)
  assert.equal(temp.driverConfig?.topic, 'aw/e2e/env')
  assert.equal(hum.driverConfig?.topic, 'aw/e2e/env')
})

test('fieldsBase 前缀只拼一次(已含前缀不重复)', () => {
  const specs = parseMqttFieldSpecs({ a: 'temp', b: 'data.humidity' }, 'data')
  assert.ok(specs)
  assert.equal(specs[0].path, 'data.temp')
  assert.equal(specs[1].path, 'data.humidity')
})

test('数组写法:路径末段作字段名;对象项可显式 name/unit', () => {
  const plan = buildMqttFieldGroup(baseInput({
    fields: ['data.temp', { path: 'data.pressure', name: '压力', unit: 'kPa', min: 0, max: 200 }],
  }), { lookup, groupId: 'dg-arr' })
  assert.ok(plan)
  assert.equal(plan.inputs.length, 2)
  assert.equal(plan.inputs[0].name, '环境站·temp')
  // 显式 name 视为完整节点名(不再拼接父名)
  assert.equal(plan.inputs[1].name, '压力')
  assert.equal(plan.inputs[1].unit, 'kPa')
})

test('字段名重复 / 量程非法 / 预警带非法 → 400', () => {
  assert.throws(() => parseMqttFieldSpecs(JSON.stringify({ 'temp': 'data.a', ' temp ': 'data.b' })), /字段名重复/)
  assert.throws(() => parseMqttFieldSpecs({ temp: { path: 'data.a', min: 10, max: 10 } }), /量程非法/)
  assert.throws(() => parseMqttFieldSpecs({ temp: { path: 'data.a', warnLow: 80, warnHigh: 20 } }), /预警带非法/)
  assert.throws(() => parseMqttFieldSpecs({ temp: '' }), /缺少取值路径/)
  assert.throws(() => parseMqttFieldSpecs('{bad json'), /不是合法 JSON/)
})

test('非 mqtt / 向量模板 / 与 vector-image 配置互斥 → 400', () => {
  assert.throws(() => buildMqttFieldGroup(baseInput({ fields: { a: 'data.a' } }, { driver: 'opcua' }), { lookup }), /仅支持 mqtt/)
  assert.throws(() => buildMqttFieldGroup(baseInput({ fields: { a: 'data.a' } }, { templateRef: 'daq-thickness-scan' }), { lookup }), /仅支持 scalar/)
  assert.throws(() => buildMqttFieldGroup(baseInput({ fields: { a: 'data.a' }, pointsPath: 'data.points' }), { lookup }), /互斥/)
  assert.throws(() => buildMqttFieldGroup(baseInput({ fields: { a: 'data.a' }, decoder: 'custom' }), { lookup }), /互斥/)
})

test('字段数量上限 64', () => {
  const many: Record<string, string> = {}
  for (let i = 0; i < 65; i++) many[`f${i}`] = `data.f${i}`
  assert.throws(() => parseMqttFieldSpecs(many), /超过上限/)
})

test('hasMqttFieldSpecs 分流:driverConfig.fields 或顶层 fields', () => {
  assert.equal(hasMqttFieldSpecs({ fields: '{"a":"data.a"}' }), true)
  assert.equal(hasMqttFieldSpecs({}, { a: 'data.a' }), true)
  assert.equal(hasMqttFieldSpecs({ topic: 'x' }), false)
  assert.equal(hasMqttFieldSpecs({ fields: '' }), false)
})
