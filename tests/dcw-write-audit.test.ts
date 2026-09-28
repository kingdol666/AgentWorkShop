import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recordDcwWriteOps, opsWriteMemo } from '../server/services/workshop/dcw/dcw-controller/write-audit'

const base = {
  id: 'dw-audit-test',
  node: { name: '审计节点', unit: '℃', lineId: 'ln-audit' },
  prevValue: 100 as number | null,
  outcome: { ok: true, message: '写入并回读一致' },
  recipeRunId: null as string | null,
}

test('write-audit throttle: same value within 10s is deduped, new value records again', () => {
  opsWriteMemo.clear()
  recordDcwWriteOps({ ...base, eng: 160, src: 'manual', meta: { source: 'manual', actor: 'u' } })
  const first = opsWriteMemo.get('dw-audit-test')
  assert.ok(first, '首次写入必须登记节流表')

  // 同值 10s 窗内重试回执:节流表不变(未重复入册)
  recordDcwWriteOps({ ...base, eng: 160, src: 'manual', meta: { source: 'manual', actor: 'u' } })
  assert.deepEqual(opsWriteMemo.get('dw-audit-test'), first)

  // 新值立即放行
  recordDcwWriteOps({ ...base, eng: 170, src: 'manual', meta: { source: 'manual', actor: 'u' } })
  const second = opsWriteMemo.get('dw-audit-test')
  assert.equal(second?.eng, 170)
  assert.ok((second?.at ?? 0) >= (first?.at ?? 0))
})

test('write-audit throttle: registry is capped to avoid unbounded growth', () => {
  opsWriteMemo.clear()
  for (let i = 0; i < 600; i++) {
    recordDcwWriteOps({ ...base, id: `dw-cap-${i % 501}`, eng: i, src: 'agent', meta: { source: 'agent', actor: 'a' } })
  }
  assert.ok(opsWriteMemo.size <= 500, `节流表应在 500 清零后重新增长,实际 ${opsWriteMemo.size}`)
  opsWriteMemo.clear()
})

test('write-audit: recipe fallback in src resolution keeps ops log action accurate', () => {
  opsWriteMemo.clear()
  recordDcwWriteOps({ ...base, id: 'dw-src', eng: 1, src: 'recipe', meta: undefined, recipeRunId: 'run-1' })
  assert.equal(opsWriteMemo.get('dw-src')?.eng, 1)
  opsWriteMemo.clear()
})
