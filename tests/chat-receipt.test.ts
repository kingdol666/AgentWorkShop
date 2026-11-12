/**
 * 群聊回执解析契约(第二轮 E8)。
 * 只认 mock/Agent 回执签名;真实 Markdown 回答必须原样返回 null。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseChatReceipt } from '../app/utils/chat-receipt'

const SAMPLE = '@visual mock 群聊回复(4b841f2e-f271-4d01-80f9-cd8ece9ae830):已处理「[群聊] visual 提问:分析 1 号挤出线近 24h 的熔体温度趋势,给出把温控设定值下调 5°C 的依据,并说明风险。\n(请回复内容;系统会把你的回复作为群聊消息发出并自动」;source=8572b775'

test('解析真实回执:提问与系统指令分离', () => {
  const r = parseChatReceipt(SAMPLE)
  assert.ok(r)
  assert.equal(r.agent, 'visual')
  assert.equal(r.correlation.startsWith('4b841f2e'), true)
  assert.match(r.question, /分析 1 号挤出线近 24h 的熔体温度趋势/)
  assert.equal(r.question.includes('[群聊]'), false)
  assert.equal(r.question.includes('visual 提问'), false)
  assert.match(r.instruction, /请回复内容/)
  assert.equal(r.question.includes('source='), false)
})

test('截断回执(无收尾引号/source)仍可解析提问', () => {
  const r = parseChatReceipt('@melt-lead mock 群聊回复(3bfc6b35-6de0-48c5-98d1-61cfc0bd76c9):已处理「[群聊] visual 提问:先拉近 24 小时的机筒四区温度,做 5 分钟均值')
  assert.ok(r)
  assert.match(r.question, /先拉近 24 小时的机筒四区温度/)
  assert.equal(r.instruction, '')
})

test('普通 Markdown 回答不被改写', () => {
  assert.equal(parseChatReceipt('## 结论\n\n- 区 2 均值 227.9℃\n- 建议下调 5℃'), null)
  assert.equal(parseChatReceipt('已处理,稍后同步。'), null)
  assert.equal(parseChatReceipt(''), null)
})

test('仅有协议头没有提问内容时返回 null,避免渲染空回执', () => {
  assert.equal(parseChatReceipt('@visual mock 群聊回复(4b841f2e-f271-4d01-80f9-cd8ece9ae830):已处理'), null)
})
