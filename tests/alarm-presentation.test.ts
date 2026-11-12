/**
 * 告警呈现纯函数契约(第二轮 E1)。
 * 目的:仪表盘告警卡不再外露 UUID / metric 代码,并让"设备·通道"可读;
 * 时间与阈值文案由组件按 i18n 组装,这里只钉结构与数值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alarmAge, alarmCountOf, alarmRuleView, splitAlarmNode } from '../app/utils/alarm-presentation'

test('alarmCountOf 只认数组长度(null/undefined 归零)', () => {
  assert.equal(alarmCountOf([{ id: 'a' }, { id: 'b' }]), 2)
  assert.equal(alarmCountOf([]), 0)
  assert.equal(alarmCountOf(null), 0)
  assert.equal(alarmCountOf(undefined), 0)
})

test('splitAlarmNode 拆出设备与通道,去掉演示前缀与协议括号', () => {
  assert.deepEqual(splitAlarmNode('演示·出水水质检测站(HTTP)·CodOut'), {
    device: '出水水质检测站',
    channel: 'CodOut',
  })
  assert.deepEqual(splitAlarmNode('注塑主机PLC(Modbus TCP)·区2SP'), {
    device: '注塑主机PLC',
    channel: '区2SP',
  })
  assert.deepEqual(splitAlarmNode('单节点'), { device: '单节点', channel: '' })
})

test('alarmRuleView 生成上限/下限关系,未知规则保留原文', () => {
  assert.deepEqual(alarmRuleView('gt-max', 308.8, 300), {
    relation: 'high',
    operator: '>',
    value: '308.8',
    threshold: '300',
  })
  assert.deepEqual(alarmRuleView('lt-min', 12, 20), {
    relation: 'low',
    operator: '<',
    value: '12',
    threshold: '20',
  })
  const other = alarmRuleView('range', null, null)
  assert.equal(other.relation, 'other')
  assert.equal(other.operator, '')
  assert.equal(other.value, '—')
})

test('alarmAge 输出相对时间单位与数值', () => {
  const now = Date.parse('2026-11-12T12:00:00+08:00')
  assert.deepEqual(alarmAge('2026-11-12T11:59:40+08:00', now), { unit: 'now', n: 0 })
  assert.deepEqual(alarmAge('2026-11-12T11:55:00+08:00', now), { unit: 'minute', n: 5 })
  assert.deepEqual(alarmAge('2026-11-12T09:00:00+08:00', now), { unit: 'hour', n: 3 })
  assert.deepEqual(alarmAge('2026-11-11T09:00:00+08:00', now), { unit: 'day', n: 1 })
  assert.deepEqual(alarmAge('bad-date', now), { unit: 'unknown', n: 0 })
})
