import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAnswers } from '../server/services/workshop/agents/hitl-decision/answers'
import { encodeHitlAnswers } from '../server/services/workshop/agents/hitl-registry'

test('无 questions 的提问型:answers[] 优先于 value(omp 群聊单选)', () => {
  const out = resolveAnswers([], {
    answers: [{ id: '__plain', answer: 'yes' }],
  })
  assert.deepEqual(out, [{ id: '__plain', answer: 'yes' }])
})

test('无 questions 且无 answers:回退 value', () => {
  const out = resolveAnswers([], { value: 'yes' })
  assert.deepEqual(out, [{ id: '', answer: 'yes' }])
})

test('omp terminal 编码:UI answers[] → 原生 value 字符串', () => {
  const value = encodeHitlAnswers(resolveAnswers([], { answers: [{ id: '__plain', answer: 'yes' }] }), '')
  assert.equal(value, 'yes')
})

test('无 questions 且答案全空:不伪造答案', () => {
  assert.deepEqual(resolveAnswers([], { answers: [{ id: '__plain', answer: '  ' }] }), [])
  assert.deepEqual(resolveAnswers([], {}), [])
})

test('结构化 questions:按 id 对齐,缺省按下标', () => {
  const out = resolveAnswers(
    [{ id: 'q1', question: 'a' }, { id: 'q2', question: 'b' }],
    { answers: [{ id: 'q1', answer: 'A' }, { id: '', answer: 'B' }] },
  )
  assert.deepEqual(out, [{ id: 'q1', answer: 'A' }, { id: 'q2', answer: 'B' }])
})
